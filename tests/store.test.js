import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { ExperimentStore, hasExperience } from '../lib/store.js'
import { seedTree } from '../lib/surface.js'
import { digest } from '../lib/task.js'

async function tempDir(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'h2-exp-store-'))
  t.after(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })
  return dir
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

test('ExperimentStore initializes, locks, recovers stale dead-PID locks, and detects H0 drift', async (t) => {
  const dir = await tempDir(t)
  const settings = { portVersion: '0.2.5', k: 2, mode: 'sequential' }
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

  // Mutual exclusion lock (active PID blocks concurrent acquisition)
  const releaseLock = await store.lock()
  await assert.rejects(() => store.lock(), /EEXIST/)
  await releaseLock()

  // Stale lock from a dead process PID is automatically recovered
  const lockFile = path.join(store.root, 'run.lock')
  await fs.writeFile(
    lockFile,
    JSON.stringify({ pid: 99999999, started: '2020-01-01T00:00:00.000Z' }),
  )
  const releaseRecovered = await store.lock()
  const activeLock = JSON.parse(await fs.readFile(lockFile, 'utf8'))
  assert.equal(activeLock.pid, process.pid)
  await releaseRecovered()
})

test('ExperimentStore records, retrieves, physically repairs corrupted files, and copies domain experience', async (t) => {
  const dir = await tempDir(t)
  const settings = { portVersion: '0.2.5', k: 1, mode: 'sequential' }
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

  // Corrupt derived files on disk (tamper with harness/memory.md and delete INDEX.md)
  const domainDir = store.libraryDir('finance')
  const entryHarnessMemory = path.join(
    domainDir,
    'harnesses',
    lib[0].name,
    'harness',
    'memory.md',
  )
  const indexMd = path.join(domainDir, 'INDEX.md')
  await fs.writeFile(entryHarnessMemory, 'CORRUPTED_BY_ACCIDENT')
  await fs.rm(indexMd)

  // repairLibrary must reconstruct both derived artifacts from authoritative index.json
  await store.repairLibrary('finance')
  const restoredMemory = await fs.readFile(entryHarnessMemory, 'utf8')
  assert.equal(restoredMemory, 'Always record exchange rate')
  const restoredIndex = await fs.readFile(indexMd, 'utf8')
  assert.match(restoredIndex, /invoice-task-1/)

  // Copy library to destination directory
  const destDir = path.join(dir, 'copied-lib')
  await store.copyLibrary('finance', destDir)
  const copiedIndex = await fs.readFile(path.join(destDir, 'INDEX.md'), 'utf8')
  assert.match(copiedIndex, /invoice-task-1/)
  assert.match(copiedIndex, /exchange rate/)
})
