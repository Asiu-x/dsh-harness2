import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { collectChanges, copyWorkspace, snapshotFiles } from '../lib/workspace.js'

async function tempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'h2-ws-'))
}

test('workspace copies skip repositories and local state', async () => {
  const dir = await tempDir()
  const source = path.join(dir, 'source')
  const dest = path.join(dir, 'dest')
  await fs.mkdir(path.join(source, 'notes'), { recursive: true })
  await fs.mkdir(path.join(source, '.git'), { recursive: true })
  await fs.mkdir(path.join(source, 'node_modules'), { recursive: true })
  await fs.mkdir(path.join(source, '.dsh-harness2'), { recursive: true })
  await fs.writeFile(path.join(source, 'a.md'), 'alpha\n')
  await fs.writeFile(path.join(source, 'notes', 'b.md'), 'beta\n')
  await fs.writeFile(path.join(source, '.git', 'config'), 'secret')
  await fs.writeFile(path.join(source, 'node_modules', 'x.js'), 'x')
  await fs.writeFile(path.join(source, '.dsh-harness2', 'state.json'), '{}')

  await copyWorkspace(source, dest)
  assert.equal(await fs.readFile(path.join(dest, 'a.md'), 'utf8'), 'alpha\n')
  assert.equal(await fs.readFile(path.join(dest, 'notes', 'b.md'), 'utf8'), 'beta\n')
  await assert.rejects(() => fs.access(path.join(dest, '.git')))
  await assert.rejects(() => fs.access(path.join(dest, 'node_modules')))
  await assert.rejects(() => fs.access(path.join(dest, '.dsh-harness2')))
  await fs.rm(dir, { recursive: true, force: true })
})

test('deliverable diff finds new, modified, and deleted files', async () => {
  const dir = await tempDir()
  const source = path.join(dir, 'source')
  const probe = path.join(dir, 'probe')
  await fs.mkdir(source, { recursive: true })
  await fs.writeFile(path.join(source, 'a.md'), 'alpha\n')
  await fs.writeFile(path.join(source, 'gone.md'), 'bye\n')
  await copyWorkspace(source, probe)
  const before = await snapshotFiles(probe)

  await fs.writeFile(path.join(probe, 'a.md'), 'alpha changed\n')
  await fs.writeFile(path.join(probe, 'new.md'), 'new file\n')
  await fs.rm(path.join(probe, 'gone.md'))

  const changes = await collectChanges(before, probe)
  assert.deepEqual(
    changes.files.map((file) => `${file.change}:${file.path}`),
    ['modified:a.md', 'new:new.md'],
  )
  assert.deepEqual(changes.deleted, ['gone.md'])
  await fs.rm(dir, { recursive: true, force: true })
})
