import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { ExperimentStore, hasExperience } from '../lib/store.js'
import { seedTree } from '../lib/surface.js'
import { digest } from '../lib/task.js'

async function tempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'h2-exp-store-'))
}

test('hasExperience validates cue, lesson, and evidence presence', () => {
  assert.equal(hasExperience(null), false)
  assert.equal(hasExperience({}), false)
  assert.equal(hasExperience({ cue: 'c', lesson: 'l' }), false)
  assert.equal(
    hasExperience({ cue: 'c', lesson: 'l', evidence: 'e' }),
    true,
  )
  assert.equal(
    hasExperience({ cue: '   ', lesson: 'l', evidence: 'e' }),
    false,
  )
})

test('ExperimentStore initializes, locks, writes atomic files, and detects H0 drift', async () => {
  const dir = await tempDir()
  const settings = { portVersion: '0.2.4', k: 2, mode: 'sequential' }
  const store = new ExperimentStore(dir, 'exp-1', settings)

  const h0 = await seedTree()
  await store.initialize(h0)

  // Initializing again with identical H0 succeeds
  await store.initialize(h0)

  // Initializing with altered H0 throws an error
  const driftedH0 = { ...h0, 'system.md': 'modified' }
  await assert.rejects(
    () => store.initialize(driftedH0),
    /Experiment configuration or H0 changed/,
  )

  // Atomic file writing
  const testFile = path.join(store.root, 'test.json')
  await store.atomic(testFile, { hello: 'world' })
  const content = JSON.parse(await fs.readFile(testFile, 'utf8'))
  assert.equal(content.hello, 'world')

  // Mutual exclusion lock
  const releaseLock = await store.lock()
  // Trying to acquire lock again concurrently should fail
  await assert.rejects(() => store.lock(), /EEXIST/)
  await releaseLock()

  await fs.rm(dir, { recursive: true, force: true })
})

test('ExperimentStore records, retrieves, repairs and copies domain experience', async () => {
  const dir = await tempDir()
  const settings = { portVersion: '0.2.4', k: 1, mode: 'sequential' }
  const store = new ExperimentStore(dir, 'exp-lib-test', settings)
  const h0 = await seedTree()
  await store.initialize(h0)

  const emptyLib = await store.library('finance')
  assert.deepEqual(emptyLib, [])

  const winningHarness = { ...h0, 'memory.md': 'Always record exchange rate' }
  const experience = {
    cue: 'When processing foreign invoices',
    lesson: 'Always record exchange rate in memory',
    evidence: 'Invoices missing rate caused audit failure',
  }

  const added = await store.add(
    'finance',
    'invoice-task-1',
    winningHarness,
    experience,
    { winner: 'c1', why: 'Deterministic rate resolution' },
  )
  assert.equal(added, true)

  const lib = await store.library('finance')
  assert.equal(lib.length, 1)
  assert.equal(lib[0].task, 'invoice-task-1')
  assert.equal(lib[0].experience.cue, experience.cue)
  assert.equal(lib[0].fingerprint, digest(winningHarness))

  // Copy library to destination directory
  const destDir = path.join(dir, 'copied-lib')
  await store.copyLibrary('finance', destDir)
  const copiedIndex = await fs.readFile(path.join(destDir, 'INDEX.md'), 'utf8')
  assert.match(copiedIndex, /invoice-task-1/)
  assert.match(copiedIndex, /exchange rate/)

  await fs.rm(dir, { recursive: true, force: true })
})
