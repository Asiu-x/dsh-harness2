import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { Harness2Runtime } from '../lib/harness2.js'

async function tempWorkspace() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'h2-orch-'))
  const manifestPath = path.join(dir, 'task.json')
  const manifest = {
    experiment: 'test-exp',
    id: 'task-1',
    domain: 'test-domain',
    instruction: 'Test task instruction',
    inputs: ['data.txt'],
    outputs: [{ path: 'output.txt', format: 'text' }],
  }
  await fs.writeFile(manifestPath, JSON.stringify(manifest))
  await fs.writeFile(path.join(dir, 'data.txt'), 'hello data\n')
  return { dir, manifestPath }
}

test('Harness2Runtime validates input parameters', async () => {
  const { dir } = await tempWorkspace()
  const manifest = {
    experiment: 'test-exp',
    id: 'task-1',
    domain: 'test-domain',
    instruction: 'Test task instruction',
    inputs: ['data.txt'],
    outputs: [{ path: 'output.txt', format: 'text' }],
  }
  const runtime = new Harness2Runtime({}, { workspace: dir })

  // Invalid k
  await assert.rejects(
    () => runtime.refine({ manifest, k: 0 }),
    /Invalid k/,
  )
  await assert.rejects(
    () => runtime.refine({ manifest, k: 10 }),
    /Invalid k/,
  )

  // Invalid mode
  await assert.rejects(
    () => runtime.refine({ manifest, k: 1, mode: 'invalid' }),
    /Invalid mode/,
  )

  await fs.rm(dir, { recursive: true, force: true })
})

test('Harness2Runtime status and reset cycle', async () => {
  const { dir, manifestPath } = await tempWorkspace()
  const runtime = new Harness2Runtime({}, { workspace: dir })

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

  await fs.rm(dir, { recursive: true, force: true })
})

test('Harness2Runtime refine runs with mock runner and records result', async () => {
  const { dir } = await tempWorkspace()
  const realDir = await fs.realpath(dir)
  const manifest = {
    experiment: 'test-exp',
    id: 'task-1',
    domain: 'test-domain',
    instruction: 'Test task instruction',
    inputs: ['data.txt'],
    outputs: [{ path: 'output.txt', format: 'text' }],
  }

  // Mock runner simulating agent execution
  const mockRunner = {
    async run({ purpose, label, workspace }) {
      if (purpose === 'probe') {
        // Produce requested output file
        await fs.writeFile(
          path.join(workspace, 'output.txt'),
          `output for ${label}\n`,
        )
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
    { workspace: realDir, concurrency: 1 },
    { runner: mockRunner },
  )

  const result = await runtime.refine({
    manifest,
    workspace: realDir,
    k: 1,
    mode: 'sequential',
    seed: 42,
  })

  assert.equal(result.ok, true)
  assert.equal(result.k, 1)
  assert.equal(result.mode, 'sequential')
  assert.equal(result.winner, 'c1')
  assert.ok(result.runDir.startsWith(realDir))

  // Status now returns the experiment record
  const status = await runtime.status({
    workspace: realDir,
    experiment: 'test-exp',
  })
  assert.equal(status.version, 2)
  assert.equal(status.settings.portVersion, '0.2.4')

  // Reset archives the experiment
  const resetRes = await runtime.reset({
    workspace: realDir,
    experiment: 'test-exp',
    confirm: true,
  })
  assert.ok(resetRes.archive.includes('.archive-'))

  const postReset = await runtime.status({
    workspace: realDir,
    experiment: 'test-exp',
  })
  assert.equal(postReset.exists, false)

  await fs.rm(dir, { recursive: true, force: true })
})
