import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { CompilerOptions } from 'typescript'
import { writeFiles } from './nuxt'

/**
 * Type-checks a set of files together, and lists each error as `<file>:<line> TS<code>`. The files sit in the
 * repo's `.tmp`, so their imports reach its node_modules; `options` adds to the compiler's.
 *
 * @example
 * await typeErrors({ 'a.ts': 'export const a: number = ""' })  // ['a.ts:1 TS2322']
 */
export async function typeErrors(files: Record<string, string>, options: CompilerOptions = {}) {
  return (await diagnose(files, options)).map(({ at, code }) => `${at} TS${code}`)
}

/**
 * Type-checks a set of files like `typeErrors`, and lists each error as `<file>:<line> <message>`: for the errors
 * whose wording is what a test is about.
 *
 * @example
 * await typeMessages({ 'a.ts': 'export const a: number = ""' })  // ["a.ts:1 Type 'string' is not assignable to type 'number'."]
 */
export async function typeMessages(files: Record<string, string>, options: CompilerOptions = {}) {
  return (await diagnose(files, options)).map(({ at, message }) => `${at} ${message}`)
}

/** Type-checks a set of files together in the repo's `.tmp`, and returns where each error is, its code and its message. */
async function diagnose(files: Record<string, string>, options: CompilerOptions) {
  // Loaded here: every test file that imports these helpers would pay for it otherwise.
  const { default: ts } = await import('typescript')
  const tmp = fileURLToPath(new URL('../../.tmp', import.meta.url))

  await mkdir(tmp, { recursive: true })
  const dir = await mkdtemp(join(tmp, 'types-'))

  try {
    await writeFiles(dir, files)

    const program = ts.createProgram(Object.keys(files).map(name => join(dir, name)), {
      strict: true,
      noEmit: true,
      target: ts.ScriptTarget.ES2022,
      // better-auth's client types use fetch's Request and Response.
      lib: ['lib.es2022.d.ts', 'lib.dom.d.ts'],
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      types: [],
      ...options,
    })

    return ts.getPreEmitDiagnostics(program).map(({ file, start, code, messageText }) => {
      const line = file!.getLineAndCharacterOfPosition(start!).line + 1

      return { at: `${file!.fileName.slice(dir.length + 1)}:${line}`, code, message: ts.flattenDiagnosticMessageText(messageText, '\n') }
    })
  }
  finally {
    await rm(dir, { recursive: true, force: true })
  }
}
