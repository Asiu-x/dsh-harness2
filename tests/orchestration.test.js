import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { Harness2Runtime } from '../lib/harness2.js'

async function tempWorkspace(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'h2-orch-'))
  t.after(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })
  const realDir = await fs.realpath(dir)
  const manifestPath = path.join(realDir, 'task.json')
  const manifest = {
    experiment: 'test-exp',
    id: 'task-1',
    domain: 'test-domain',
    instruction: 'Test task instruction',
    inputs: ['data.txt'],
    outputs: [{ path: 'output.txt', format: 'text' }],
  }
  await fs.writeFile(manifestPath, JSON.stringify(manifest))
  await fs.writeFile(path.join(realDir, 'data.txt'), 'hello data\n')
  return { dir: realDir, manifest, manifestPath }
}

test('Harness2Runtime validates input parameters and reset existence', async (t) => {
  const { dir, manifest } = await tempWorkspace(t)
  const runtime = new Harness2Runtime({}, { workspace: dir })

  // Invalid k
  await assert.rejects(() => runtime.refine({ manifest, k: 0 }), /Invalid k/)
  await assert.rejects(() => runtime.refine({ manifest, k: 10 }), /Invalid k/)

  // Invalid mode
  await assert.rejects(
    () => runtime.refine({ manifest, k: 1, mode: 'invalid' }),
    /Invalid mode/,
  )

  const nonExistent = await runtime.status({
    workspace: dir,
    experiment: 'test-exp',
  })
  assert.equal(nonExistent.exists, false)

  // Reset requires explicit confirm: true
  await assert.rejects(
    () => runtime.reset({ workspace: dir, experiment: 'test-exp' }),
    /confirm: true is required/,
  )

  // Reset on non-existent experiment returns semantic error instead of raw ENOENT
  await assert.rejects(
    () =>
      runtime.reset({
        workspace: dir,
        experiment: 'missing-exp',
        confirm: true,
      }),
    /Experiment does not exist: missing-exp/,
  )
})

test('Harness2Runtime k=1 refine runs with mock runner, records v0.2.5 status, and archives on reset', async (t) => {
  const { dir, manifest } = await tempWorkspace(t)

  const mockRunner = {
    async run({ purpose, label, workspace }) {
      if (purpose === 'probe') {
        await fs.writeFile(
          path.join(workspace, 'output.txt'),
          `output for ${label}\n`,
        )
      }
      if (purpose === 'reflect') {
        return {
          ok: true,
          text: '<experience>{"cue":"When running k=1","lesson":"Deliver clean text","evidence":"c1 succeeded"}</experience><edits>none</edits>',
          events: [],
          trajectory: `[REFLECT] ${label}`,
        }
      }
      return {
        ok: true,
        text: `result text for ${label}`,
        events: [],
        trajectory: `[RUN] ${label}`,
      }
    },
  }

  const runtime = new Harness2Runtime(
    {},
    { workspace: dir, concurrency: 1 },
    { runner: mockRunner },
  )

  const result = await runtime.refine({
    manifest,
    workspace: dir,
    k: 1,
    mode: 'sequential',
    seed: 42,
  })

  assert.equal(result.ok, true)
  assert.equal(result.k, 1)
  assert.equal(result.mode, 'sequential')
  assert.equal(result.winner, 'c1')
  assert.equal(result.libraryAdded, true)
  assert.ok(result.runDir.startsWith(dir))

  const status = await runtime.status({
    workspace: dir,
    experiment: 'test-exp',
  })
  assert.equal(status.version, 2)
  assert.equal(status.settings.portVersion, '0.2.5')

  const resetRes = await runtime.reset({
    workspace: dir,
    experiment: 'test-exp',
    confirm: true,
  })
  assert.ok(resetRes.archive.includes('.archive-'))

  const postReset = await runtime.status({
    workspace: dir,
    experiment: 'test-exp',
  })
  assert.equal(postReset.exists, false)
})

test('Harness2Runtime k=2 sequential and parallel modes execute selector with CPython MT19937 ordering', async (t) => {
  const { dir } = await tempWorkspace(t)

  const createSelectorRunner = (choiceId) => ({
    async run({ purpose, label, workspace }) {
      if (purpose === 'probe') {
        await fs.writeFile(
          path.join(workspace, 'output.txt'),
          `artifact from ${label}\n`,
        )
        return {
          ok: true,
          text: `candidate response from ${label}`,
          events: [],
          trajectory: `[PROBE] ${label}`,
        }
      }
      if (purpose === 'select') {
        return {
          ok: true,
          text: `<why>Selected ${choiceId} by oracle</why>\n\`\`\`choice\n${choiceId}\n\`\`\``,
          events: [],
          trajectory: `[SELECT] ${choiceId}`,
        }
      }
      if (purpose === 'reflect') {
        return {
          ok: true,
          text: '<experience>{"cue":"When k=2","lesson":"Choose best composed harness","evidence":"Selector verified"}</experience><edits>none</edits>',
          events: [],
          trajectory: '[REFLECT]',
        }
      }
      return {
        ok: true,
        text: `stage ${purpose} ${label}`,
        events: [],
        trajectory: `[STAGE] ${label}`,
      }
    },
  })

  // 1. k=2 sequential: task 't1' with ['c1', 'c2'] -> MT19937 order is ['c1', 'c2'] -> A='c1', B='c2'
  const seqRuntime = new Harness2Runtime(
    {},
    { workspace: dir, concurrency: 2 },
    { runner: createSelectorRunner('B') },
  )
  const seqResult = await seqRuntime.refine({
    manifest: {
      experiment: 'exp-seq-k2',
      id: 't1',
      domain: 'math',
      instruction: 'Solve task t1',
      inputs: ['data.txt'],
      outputs: [{ path: 'output.txt', format: 'text' }],
    },
    workspace: dir,
    k: 2,
    mode: 'sequential',
  })

  assert.equal(seqResult.ok, true)
  assert.equal(seqResult.selectionOk, true)
  assert.equal(seqResult.selectionFallback, false)
  assert.deepEqual(seqResult.idMap, { A: 'c1', B: 'c2' })
  assert.equal(seqResult.winner, 'c2')
  assert.equal(seqResult.libraryAdded, true)

  const candA = await fs.readFile(
    path.join(seqResult.runDir, 'contexts/selector/context/candidates/A.md'),
    'utf8',
  )
  const candB = await fs.readFile(
    path.join(seqResult.runDir, 'contexts/selector/context/candidates/B.md'),
    'utf8',
  )
  assert.equal(candA, '# output.txt\n\nartifact from c1\n')
  assert.equal(candB, '# output.txt\n\nartifact from c2\n')

  // 2. k=2 parallel: task 't1' with ['agg1', 'agg2']
  const parRuntime = new Harness2Runtime(
    {},
    { workspace: dir, concurrency: 2 },
    { runner: createSelectorRunner('A') },
  )
  const parResult = await parRuntime.refine({
    manifest: {
      experiment: 'exp-par-k2',
      id: 't1',
      domain: 'math',
      instruction: 'Solve parallel task t1',
      inputs: ['data.txt'],
      outputs: [{ path: 'output.txt', format: 'text' }],
    },
    workspace: dir,
    k: 2,
    mode: 'parallel',
  })

  assert.equal(parResult.ok, true)
  assert.equal(parResult.selectionOk, true)
  assert.equal(parResult.winner, parResult.idMap.A)
  assert.equal(parResult.libraryAdded, true)
})

test('Harness2Runtime k=2 handles invalid selector response and broken assignIdsScript with clean fallback', async (t) => {
  const { dir } = await tempWorkspace(t)

  // Write a broken external assignIdsScript that outputs invalid labels
  const badScript = path.join(dir, 'broken-assign.py')
  await fs.writeFile(
    badScript,
    'import sys, json\nsys.stdin.read()\nprint(json.dumps(["nonexistent_1", "nonexistent_2"]))\n',
  )

  // Case A: Broken assignIdsScript falls back to native assignIds without aborting refine
  const validSelectorRunner = {
    async run({ purpose, label, workspace }) {
      if (purpose === 'probe') {
        await fs.writeFile(path.join(workspace, 'output.txt'), `out ${label}\n`)
      }
      if (purpose === 'select') {
        return {
          ok: true,
          text: '<why>Picked A</why>\n```choice\nA\n```',
          events: [],
          trajectory: '[SELECT]',
        }
      }
      if (purpose === 'reflect') {
        return {
          ok: true,
          text: '<experience>{"cue":"cue","lesson":"lesson","evidence":"ev"}</experience>',
          events: [],
          trajectory: '[REFLECT]',
        }
      }
      return { ok: true, text: `ok ${label}`, events: [], trajectory: '' }
    },
  }

  const fallbackRuntime = new Harness2Runtime(
    {},
    { workspace: dir, assignIdsScript: badScript },
    { runner: validSelectorRunner },
  )

  const fallbackRes = await fallbackRuntime.refine({
    manifest: {
      experiment: 'exp-script-fallback',
      id: 't1',
      domain: 'math',
      instruction: 'Task with broken assignIdsScript',
      inputs: ['data.txt'],
      outputs: [{ path: 'output.txt', format: 'text' }],
    },
    workspace: dir,
    k: 2,
    mode: 'sequential',
  })

  assert.equal(fallbackRes.ok, true)
  assert.equal(fallbackRes.selectionOk, true)
  assert.equal(fallbackRes.idOrderingFallback, true)
  assert.match(fallbackRes.idOrderingError, /not an exact permutation/)
  assert.deepEqual(fallbackRes.idMap, { A: 'c1', B: 'c2' })

  // Case B: Invalid selector choice produces selectionOk=false, selectionFallback=true, and skips library update
  const badSelectorRunner = {
    async run({ purpose, label, workspace }) {
      if (purpose === 'probe') {
        await fs.writeFile(path.join(workspace, 'output.txt'), `out ${label}\n`)
      }
      if (purpose === 'select') {
        return {
          ok: true,
          text: '```choice\nINVALID_ID\n```',
          events: [],
          trajectory: '[BAD_SELECT]',
        }
      }
      return { ok: true, text: `ok ${label}`, events: [], trajectory: '' }
    },
  }

  const badSelRuntime = new Harness2Runtime(
    {},
    { workspace: dir },
    { runner: badSelectorRunner },
  )

  const badSelResult = await badSelRuntime.refine({
    manifest: {
      experiment: 'exp-bad-selector',
      id: 't1',
      domain: 'math',
      instruction: 'Task with invalid selector choice',
      inputs: ['data.txt'],
      outputs: [{ path: 'output.txt', format: 'text' }],
    },
    workspace: dir,
    k: 2,
    mode: 'sequential',
  })

  assert.equal(badSelResult.ok, false)
  assert.equal(badSelResult.selectionOk, false)
  assert.equal(badSelResult.selectionFallback, true)
  assert.equal(badSelResult.winner, 'c1')
  assert.equal(badSelResult.libraryAdded, false)
})
