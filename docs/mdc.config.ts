import type { transformerTwoslash } from '@shikijs/twoslash'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

type Transformer = ReturnType<typeof transformerTwoslash>
type Node = { type: string, tagName?: string, value?: string, properties?: Record<string, unknown>, children?: Node[], content?: Node }
type Context = 'server' | 'node'

/** The prepared Nuxt app whose types the `twoslash` blocks are checked against. */
const app = fileURLToPath(new URL('./example', import.meta.url))

const transformers = new Map<Context, Promise<Transformer>>()

/**
 * Picks the Nuxt type context of a block from its code: MDC hands transformers the meta without the block's title.
 *
 * @example
 * export default defineNuxtConfig({ … })  → 'node'
 * anything else                          → 'server' (whose types include `shared/`)
 */
function contextOf(code: string): Context {
  return code.includes('defineNuxtConfig(') ? 'node' : 'server'
}

/**
 * Creates the twoslash transformer with the compiler options of one of the app's type contexts.
 *
 * @example
 * A `// @filename: server/capsa/db/default/schema/posts.ts` in a block replaces that file of the app.
 */
async function createTwoslash(context: Context) {
  // Through a variable, so Nitro's bundler leaves TypeScript out of the server: twoslash only runs at build time.
  const load = (id: string) => import(id)
  const [{ transformerTwoslash }, { default: ts }] = await Promise.all([load('@shikijs/twoslash'), load('typescript')])
  const nuxtDir = resolve(app, '.nuxt')
  const tsconfigPath = resolve(nuxtDir, `tsconfig.${context}.json`)
  if (!existsSync(tsconfigPath))
    throw new Error(`${tsconfigPath} is missing: run \`nuxt prepare docs/example\` first.`)

  const tsconfig = ts.readConfigFile(tsconfigPath, ts.sys.readFile).config
  const { options } = ts.parseJsonConfigFileContent(tsconfig, ts.sys, nuxtDir)
  // Twoslash's files live in `app`, not in `.nuxt`, so the aliases need absolute targets.
  const paths = Object.fromEntries(Object.entries((options.paths ?? {}) as Record<string, string[]>).map(([alias, targets]) => [alias, targets.map(target => resolve(nuxtDir, target))]))
  // The `.nuxt` declarations the context includes: auto-imports, `#capsa/db`, nitro, the config's schema.
  const references: string[] = tsconfig.include.filter((path: string) => path.startsWith('./'))
  const prepend = references.map(path => `/// <reference path="${resolve(nuxtDir, path)}" />\n`).join('')

  const transformer = transformerTwoslash({
    // A pinned type (`^?`) is a line of the block, so it takes its own space instead of covering what follows.
    rendererRich: { queryRendering: 'line' },
    onTwoslashError: failBuild,
    onShikiError: failBuild,
    twoslashOptions: {
      vfsRoot: app,
      compilerOptions: { ...options, paths, pathsBasePath: undefined },
      extraFiles: { 'index.ts': { prepend } },
    },
  })
  return forMdc(transformer)
}

/**
 * Adapts twoslash's output to MDC, which appends `\n` to each line's last token and renders every `pre` and `code` as a Prose component.
 *
 * @example
 * Without it, `return rows` throws "Cannot find tokens for node" and each popup shows a copy button.
 */
function forMdc(transformer: Transformer): Transformer {
  return {
    ...transformer,
    code(codeEl) {
      const lineEnds = this.lines.map(line => (line.children.at(-1) as Node | undefined)?.children?.at(-1)).filter(text => text?.value?.endsWith('\n')) as Node[]
      lineEnds.forEach(text => text.value = text.value!.slice(0, -1))
      transformer.code?.call(this, codeEl)
      lineEnds.forEach(text => text.value += '\n')
      withoutProse(codeEl as Node)
    },
  }
}

/**
 * Fails `nuxt generate` once it is done: Nuxt Content only warns about a page it cannot parse, and leaves it out.
 *
 * @example
 * A block whose types no longer match capsa's ends the build with exit code 1.
 */
function failBuild(error: unknown): never {
  process.exitCode = 1
  throw error
}

/** Marks the `pre` and `code` tags inside the popups so MDC keeps them plain. */
function withoutProse(node: Node) {
  if (node.tagName === 'pre' || node.tagName === 'code')
    node.properties!.__ignoreMap = ''
  for (const child of [...node.children ?? [], ...node.content?.children ?? []])
    withoutProse(child)
}

/** A node of a parsed page as Nuxt Content stores it: `[tag, props, ...children]`, or a text. */
type Minimark = string | [string, Record<string, unknown>, ...Minimark[]]

/**
 * Rewrites the code of every `twoslash` block for those who read the page as markdown: `/raw/*.md`, `llms-full.txt`
 * and the copy button. The notations go, and the pinned types and errors the page shows become comments.
 *
 * @example
 * // `const rows = …` followed by `//    ^?` becomes:
 * // const rows = …
 * // // const rows: {
 * // //     id: number;
 * // // }[]
 */
export function twoslashAsText(node: Minimark) {
  if (typeof node === 'string')
    return
  const [tag, props, ...children] = node

  if (tag !== 'pre' || !/\btwoslash\b/.test(String(props.meta)))
    return children.forEach(twoslashAsText)

  props.code = linesOf(children[0]!)
  props.meta = String(props.meta).replace(/\btwoslash\b/, '').trim() || undefined
}

/** The code of a rendered `twoslash` block, with its pinned types and errors as comments under their lines. */
function linesOf(code: Minimark) {
  const lines: string[] = []
  let indent = ''

  for (const line of childrenOf(code)) {
    const kind = classOf(line)

    if (kind.includes('twoslash-query-line'))
      lines.push(...commented(indent, popupLines(line).map(textOf).join('\n')))
    else if (kind.includes('twoslash-error-line'))
      lines.push(...commented(indent, `error: ${textOf(line)}`))
    else if (kind.includes('line')) {
      const text = textOf(line).replace(/\n$/, '')
      indent = /^\s*/.exec(text)![0]
      lines.push(text)
    }
  }
  return `${lines.join('\n')}\n`
}

/** The text of a node without its hover popups, which belong to the page, not to the code. */
function textOf(node: Minimark): string {
  if (typeof node === 'string')
    return node
  return classOf(node).includes('twoslash-popup-container') ? '' : childrenOf(node).map(textOf).join('')
}

/** The lines of a pinned type: its popup keeps one `.line` per line, where the page's text has none. */
function popupLines(node: Minimark): Minimark[] {
  if (classOf(node).includes('twoslash-popup-code'))
    return lineNodes(node)
  for (const child of childrenOf(node)) {
    const found = popupLines(child)
    if (found.length)
      return found
  }
  return []
}

/** The `.line` elements under a node. */
function lineNodes(node: Minimark): Minimark[] {
  return classOf(node) === 'line' ? [node] : childrenOf(node).flatMap(lineNodes)
}

/** The class of a node, empty for a text. */
function classOf(node: Minimark) {
  return typeof node === 'string' ? '' : String(node[1].class ?? '')
}

/** The children of a node, none for a text. */
function childrenOf(node: Minimark): Minimark[] {
  if (typeof node === 'string')
    return []
  const [, , ...children] = node
  return children
}

/** Turns text into comment lines at the code's indentation. */
function commented(indent: string, text: string) {
  return text.split('\n').map(line => `${indent}// ${line}`)
}

export default {
  shiki: {
    transformers: (code: string, _lang: string, _theme: unknown, { meta }: { meta?: unknown }) => {
      if (typeof window !== 'undefined' || !/\btwoslash\b/.test(String(meta)))
        return []
      const context = contextOf(code)
      if (!transformers.has(context))
        transformers.set(context, createTwoslash(context))
      return transformers.get(context)!.then(transformer => [transformer], failBuild)
    },
  },
}
