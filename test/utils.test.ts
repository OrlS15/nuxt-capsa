import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { devDependencies, peerDependencies } from '../package.json'
import { checkPeers, log, rootAlias } from '../src/utils'

describe('rootAlias', () => {
  it('turns a project file into a #capsa/root/ specifier, with no extension', () => {
    expect(rootAlias('/app', '/app/server/capsa/db/default/schema.ts')).toBe('#capsa/root/server/capsa/db/default/schema')
    expect(rootAlias('/app', '/app/shared/capsa/abilities/post.mts')).toBe('#capsa/root/shared/capsa/abilities/post')
  })

  it('reaches a file of a layer outside the project through #capsa/root/../', () => {
    expect(rootAlias('/app', '/shared/server/capsa/db/default/schema.ts')).toBe('#capsa/root/../shared/server/capsa/db/default/schema')
  })
})

describe('checkPeers', () => {
  beforeEach(() => void vi.spyOn(log, 'warn').mockImplementation(() => {}))
  afterEach(() => vi.restoreAllMocks())

  /** A project that has each package of `versions` installed, in that version, with no `./package.json` in its exports. */
  async function project(versions: Record<string, string>) {
    const root = await mkdtemp(join(tmpdir(), 'capsa-peers-'))
    onTestFinished(() => rm(root, { recursive: true, force: true }))

    for (const [name, version] of Object.entries(versions)) {
      const dir = join(root, 'node_modules', name, 'dist')
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, 'index.js'), 'export {}')
      await writeFile(join(dir, '..', 'package.json'), JSON.stringify({ name, version, type: 'module', exports: { '.': './dist/index.js' } }))
    }

    return root
  }

  it('warns about a package installed outside the range of capsa\'s peerDependencies, naming both', async () => {
    await checkPeers(await project({ 'drizzle-orm': '1.1.0' }), ['drizzle-orm'])

    expect(log.warn).toHaveBeenCalledOnce()
    expect(log.warn).toHaveBeenCalledWith(`\`drizzle-orm@1.1.0\` is installed, but capsa supports \`drizzle-orm@${peerDependencies['drizzle-orm']}\`: install a version in that range, or a release of capsa that supports this one.`)
  })

  it('stays quiet about a package in range, and one the project does not have', async () => {
    await checkPeers(await project({ 'drizzle-orm': devDependencies['drizzle-orm'] }), ['drizzle-orm', 'files-sdk'])

    expect(log.warn).not.toHaveBeenCalled()
  })
})
