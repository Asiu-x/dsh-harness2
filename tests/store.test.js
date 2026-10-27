import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { Store } from '../lib/store.js'
import { seedTree, validateTree } from '../lib/surface.js'

async function tempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'h2-store-'))
}

test('store seeds, validates, archives, reads lessons, and resets', async () => {
  const dir = await tempDir()
  const store = new Store(path.join(dir, '.dsh-harness2'))
  await store.ensure()
  const tree = await store.readHarness()
  assert.equal(validateTree(tree).ok, true)
  assert.equal(await store.isAdopted(), false)

  tree['memory.md'] += '\n\nIn this workspace, `roles.csv` uses `HR Manager`.\n'
  await store.writeHarness(tree)
  await store.writeState({ adopted: true, domain: 'hr', adoptedAt: '2026-10-27T00:00:00Z' })
  const archive = await store.archive({
    domain: 'hr',
    task: 'Reconcile roles',
    harness: tree,
    why: 'The mapping was verified.',
    edits: 'memory.md: added the verified mapping',
    experience: {
      cue: 'When joining role names across files',
      lesson: 'Record the verified mapping in memory.md.',
      evidence: 'Base runs guessed the mapping twice.',
      confidence: 'medium',
    },
    runId: 'run-1',
  })
  assert.ok(archive.startsWith(dir))
  const lessons = await store.readLessons('hr')
  assert.equal(lessons.length, 1)
  assert.match(lessons[0], /joining role names/)

  const index = await fs.readFile(path.join(store.libraryDir('hr'), 'INDEX.md'), 'utf8')
  assert.match(index, /Reconcile roles|When joining role names/)

  await store.resetHarness({ archive: true })
  assert.equal(await store.isAdopted(), false)
  const reset = await store.readHarness()
  assert.match(reset['memory.md'], /Durable workspace facts/)
  await fs.rm(dir, { recursive: true, force: true })
})
