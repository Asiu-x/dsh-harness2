import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { Harness2Runtime } from '../lib/harness2.js'
import { diffTrees } from '../lib/surface.js'

async function tempWorkspace() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'h2-flow-'))
  await fs.mkdir(path.join(dir, 'data'), { recursive: true })
  await fs.writeFile(path.join(dir, 'data', 'a.txt'), 'alpha\n')
  return dir
}

function fakeRun(label, extra = {}) {
  return {
    label,
    ok: true,
    timedOut: false,
    text: `result for ${label}`,
    trajectory: `[ASSISTANT]\n${label}`,
    stopReasonText: 'completed',
    elapsedMs: 1,
    model: 'mock/model',
    changes: { files: [], deleted: [], truncated: false },
    ...extra,
  }
}

test('sequential k=2 runs the full loop and adopts the composed harness', async () => {
  const dir = await tempWorkspace()
  const runtime = new Harness2Runtime(
    {},
    {
      workspace: dir,
      dataDir: '.dsh-harness2',
      concurrency: 1,
      selection: false,
      reflection: false,
      timeoutMinutes: 1,
      maxWorkspaceMB: 10,
    },
    { log: () => {} },
  )
  await runtime.ready

  runtime.probe = async ({ label }) => fakeRun(label)
  runtime.propose = async ({ label, dim, currentTree }) => {
    const tree = { ...currentTree }
    tree['memory.md'] = `${tree['memory.md']}\n\n- ${label} (${dim})\n`
    const diff = diffTrees(currentTree, tree)
    return { label, dim, tree, notes: `edit ${label}`, diff, fellBack: false, run: null }
  }
  runtime.compose = async ({ label, currentTree, pool }) => {
    const tree = { ...(pool[0]?.tree || currentTree) }
    const diff = diffTrees(currentTree, tree)
    return { label, tree, notes: `compose ${label}`, diff, fellBack: false, run: null }
  }
  runtime.select = async ({ finals }) => ({
    winner: {
      label: finals[0].label,
      isBase: false,
      tree: finals[0].tree,
      run: finals[0].run,
    },
    why: 'test selection',
    fallback: false,
    candidates: finals.map((entry) => entry.label),
  })
  runtime.reflect = async () => ({
    experience: {
      cue: 'test cue',
      lesson: 'test lesson',
      evidence: 'test evidence',
      confidence: 'high',
      edits: 'memory.md changed',
    },
    notes: '',
  })

  const summary = await runtime.refine({ task: 'test task', domain: 'flow', k: 2, mode: 'sequential' })
  assert.equal(summary.adopted, true)
  assert.equal(summary.winner, 'c2')
  assert.equal(summary.candidatesDetailed.length, 4) // INV + DOM for two rounds
  assert.equal(summary.compositions.length, 2) // c1 + c2
  const state = await runtime.store.readState()
  assert.equal(state.adopted, true)
  assert.equal(state.domain, 'flow')
  const harness = await runtime.store.readHarness()
  assert.match(harness['memory.md'], /inv-r2|dom-r2/)
  const library = await runtime.store.listLibrary('flow')
  assert.equal(library.length, 1)
  await fs.rm(dir, { recursive: true, force: true })
})

test('a no-op winner is not adopted', async () => {
  const dir = await tempWorkspace()
  const runtime = new Harness2Runtime(
    {},
    {
      workspace: dir,
      dataDir: '.dsh-harness2',
      concurrency: 1,
      selection: false,
      reflection: false,
      timeoutMinutes: 1,
      maxWorkspaceMB: 10,
    },
    { log: () => {} },
  )
  await runtime.ready
  runtime.probe = async ({ label }) => fakeRun(label)
  runtime.propose = async ({ label, dim, currentTree }) => ({
    label,
    dim,
    tree: { ...currentTree },
    notes: 'KEEP_BASE',
    diff: diffTrees(currentTree, currentTree),
    fellBack: true,
    run: null,
  })
  runtime.compose = async ({ label, currentTree }) => ({
    label,
    tree: { ...currentTree },
    notes: 'KEEP_BASE',
    diff: diffTrees(currentTree, currentTree),
    fellBack: true,
    run: null,
  })
  runtime.select = async ({ finals }) => ({
    winner: { label: finals[0].label, isBase: false, tree: finals[0].tree, run: finals[0].run },
    why: 'test',
    fallback: false,
    candidates: [],
  })
  const summary = await runtime.refine({ task: 'no-op task', domain: 'flow', k: 1, mode: 'sequential' })
  assert.equal(summary.adopted, false)
  assert.equal(summary.noHarnessChange, true)
  assert.equal((await runtime.store.readState()).adopted, false)
  await fs.rm(dir, { recursive: true, force: true })
})

test('parallel k=2 proposes 2k candidates and composes k finals', async () => {
  const dir = await tempWorkspace()
  const runtime = new Harness2Runtime(
    {},
    {
      workspace: dir,
      dataDir: '.dsh-harness2',
      concurrency: 2,
      selection: false,
      reflection: false,
      timeoutMinutes: 1,
      maxWorkspaceMB: 10,
    },
    { log: () => {} },
  )
  await runtime.ready
  const proposals = []
  const compositions = []
  runtime.probe = async ({ label }) => fakeRun(label)
  runtime.propose = async ({ label, dim, currentTree }) => {
    proposals.push(`${label}:${dim}`)
    const tree = { ...currentTree }
    tree['guardrails.md'] = `${tree['guardrails.md']}\n\n- ${label}\n`
    return { label, dim, tree, notes: label, diff: diffTrees(currentTree, tree), fellBack: false, run: null }
  }
  runtime.compose = async ({ label, currentTree, pool }) => {
    compositions.push(label)
    const tree = { ...(pool[0]?.tree || currentTree) }
    return { label, tree, notes: label, diff: diffTrees(currentTree, tree), fellBack: false, run: null }
  }
  runtime.select = async ({ finals }) => ({
    winner: { label: finals[0].label, isBase: false, tree: finals[0].tree, run: finals[0].run },
    why: 'parallel test',
    fallback: false,
    candidates: finals.map((entry) => entry.label),
  })
  const summary = await runtime.refine({ task: 'parallel task', domain: 'flow', k: 2, mode: 'parallel' })
  assert.equal(summary.adopted, true)
  assert.equal(proposals.length, 4)
  assert.deepEqual(compositions, ['agg1', 'agg2'])
  assert.equal(summary.finals.length, 2)
  await fs.rm(dir, { recursive: true, force: true })
})
