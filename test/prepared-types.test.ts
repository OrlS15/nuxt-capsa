import { execFile } from 'node:child_process'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { buildNuxt, loadNuxt, writeTypes } from '@nuxt/kit'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const repo = fileURLToPath(new URL('..', import.meta.url))
const fixtures = join(repo, 'test/fixtures')
const apps = ['auth-pglite', 'drive']
// Beside `src`, where the builder expects it: module code that imports a runtime file is pointed at `../<outDir>/runtime`.
const dist = join(repo, '.build-prepared-types')
const run = promisify(execFile)

/**
 * The build and types directory of a fixture, its own: the e2e suites build the fixture under `.nuxt/test/` at the same time.
 *
 * @example
 * buildDirOf('drive')  // '/nuxt-capsa/test/fixtures/drive/.nuxt/prepared'
 */
function buildDirOf(app: string) {
  return join(fixtures, app, '.nuxt', 'prepared')
}

/**
 * Prepares a fixture's types, with capsa from `src` or, given a module file, from a build of the package.
 *
 * @example
 * await prepare('drive', join(dist, 'module.mjs'))  // the types an app gets from the published package
 */
async function prepare(app: string, module?: string) {
  // The fixture's config reads it, and loads capsa from src without it.
  if (module) vi.stubEnv('CAPSA_BUILT_MODULE', module)

  const buildDir = buildDirOf(app)
  const nuxt = await loadNuxt({ cwd: join(fixtures, app), overrides: { buildDir, typesDir: buildDir, _prepare: true } })
  await buildNuxt(nuxt)
  await writeTypes(nuxt)
  await nuxt.close()
  vi.unstubAllEnvs()
}

/**
 * Type-checks the server, app and shared code of a prepared fixture, and gives back what vue-tsc printed for each.
 * One after the other: three type-checkers at once take more memory than a laptop running the e2e suites has left.
 *
 * @example
 * await typecheck('drive')  // { server: '', app: '', shared: '' } when no code has a type error
 */
async function typecheck(app: string) {
  const printed = { server: '', app: '', shared: '' }

  for (const context of Object.keys(printed) as (keyof typeof printed)[]) {
    printed[context] = await run(join(repo, 'node_modules/.bin/vue-tsc'), ['--noEmit', '-p', join(buildDirOf(app), `tsconfig.${context}.json`)])
      .then(() => '', (error: { stdout: string }) => {
        // Type errors go to stdout: with nothing there, vue-tsc itself crashed, which must not read as a clean check.
        if (!error.stdout) throw error

        return error.stdout
      })
  }

  return printed
}

describe('types of a prepared app', { timeout: 120_000 }, () => {
  afterAll(() => Promise.all([...apps.map(buildDirOf), dist].map(dir => rm(dir, { recursive: true, force: true }))))

  // A `declare module` whose re-exports do not resolve in a context turns them into `any` without an error of its
  // own: only the code that uses them shows it.
  it.each(apps)('type-checks the server, app and shared code of %s against capsa\'s declarations', async (app) => {
    await prepare(app)

    expect(await typecheck(app)).toEqual({ server: '', app: '', shared: '' })
  })

  describe('from a build of the package', () => {
    beforeAll(async () => {
      // Away from `dist`, which holds the development stub. The builder then warns that package.json's exports point at
      // files it did not write, and exits 1 for that alone: whether it built shows when Nuxt loads the module.
      await run(join(repo, 'node_modules/.bin/nuxt-module-build'), ['build', `--outDir=${dist}`], { cwd: repo }).catch(() => {})
    }, 120_000)

    // The declarations of a build are written once, in capsa's repo: a type inferred there cannot see the app's config.
    it.each(apps)('gives %s, installing the package, the same types', async (app) => {
      await prepare(app, join(dist, 'module.mjs'))

      expect(await typecheck(app)).toEqual({ server: '', app: '', shared: '' })
    })
  })
})
