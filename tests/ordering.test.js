import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import {
  sha1Seed,
  sha1Seed48,
  mulberry32,
  cpythonRandom,
  deterministicShuffle,
  isValidPermutation,
  assignIds,
  assignIdsAsync,
} from '../lib/ordering.js'

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
)
const LEGACY_SCRIPT = path.join(REPO_ROOT, 'scripts', 'legacy-assign-ids.py')

test('sha1Seed and sha1Seed48 return deterministic unsigned seeds', () => {
  const seed1 = sha1Seed('task-1|2|sequential')
  const seed2 = sha1Seed('task-1|2|sequential')
  const seed3 = sha1Seed('task-2|2|sequential')

  assert.equal(typeof seed1, 'number')
  assert.ok(seed1 >= 0 && seed1 <= 0xffffffff)
  assert.equal(seed1, seed2)
  assert.notEqual(seed1, seed3)

  const s48a = sha1Seed48('t1|2|seq')
  const s48b = sha1Seed48('t1|2|seq')
  assert.equal(typeof s48a, 'bigint')
  assert.equal(s48a, s48b)
  assert.ok(s48a > 0n && s48a <= 0xffffffffffffn)
})

test('mulberry32 generates floats in [0, 1) and truncates state to 32 bits', () => {
  const rng = mulberry32(12345)
  for (let i = 0; i < 100; i++) {
    const val = rng()
    assert.ok(val >= 0 && val < 1)
  }
  // Verify state wrapping around 0xffffffff boundary without precision drift
  const wrapRng = mulberry32(0xffffffff)
  const v1 = wrapRng()
  const v2 = wrapRng()
  assert.ok(Number.isFinite(v1) && v1 >= 0 && v1 < 1)
  assert.ok(Number.isFinite(v2) && v2 >= 0 && v2 < 1)
})

test('deterministicShuffle and isValidPermutation validate candidate bijections', () => {
  const items = ['alpha', 'beta', 'gamma', 'delta', 'epsilon']
  const rng = mulberry32(42)
  const shuffled = deterministicShuffle(items, rng)

  assert.equal(shuffled.length, items.length)
  assert.equal(isValidPermutation(items, shuffled), true)
  assert.equal(items[0], 'alpha')

  assert.equal(isValidPermutation(items, ['alpha', 'beta']), false)
  assert.equal(
    isValidPermutation(items, ['alpha', 'alpha', 'gamma', 'delta', 'epsilon']),
    false,
  )
  assert.equal(isValidPermutation(items, null), false)
})

test('assignIds matches CPython MT19937 golden vectors and legacy-assign-ids.py 100%', async () => {
  const goldenCases = [
    {
      labels: ['c1', 'c2'],
      task: 't1',
      k: 2,
      mode: 'seq',
      expected: ['c1', 'c2'],
    },
    {
      labels: ['agg1', 'agg2', 'agg3', 'agg4', 'agg5'],
      task: 'demo',
      k: 5,
      mode: 'agg',
      expected: ['agg5', 'agg1', 'agg3', 'agg2', 'agg4'],
    },
    {
      labels: ['c1', 'c2', 'c3'],
      task: 'task-alpha',
      k: 3,
      mode: 'seq',
      expected: ['c3', 'c2', 'c1'],
    },
    {
      labels: ['agg1', 'agg2', 'agg3', 'agg4'],
      task: 'task-beta',
      k: 4,
      mode: 'agg',
      expected: ['agg1', 'agg2', 'agg4', 'agg3'],
    },
  ]

  for (const tc of goldenCases) {
    const jsResult = assignIds(tc)
    assert.deepEqual(jsResult, tc.expected, `Golden vector mismatch for ${tc.task}`)

    const pyResult = await assignIdsAsync({
      ...tc,
      scriptPath: LEGACY_SCRIPT,
    })
    assert.deepEqual(
      jsResult,
      pyResult,
      `CPython parity mismatch for ${tc.task}`,
    )
  }
})

test('assignIdsAsync falls back to native shuffle when scriptPath is absent', async () => {
  const labels = ['x1', 'x2', 'x3']
  const syncRes = assignIds({ labels, task: 'task-1', k: 3, mode: 'seq' })
  const asyncRes = await assignIdsAsync({
    labels,
    task: 'task-1',
    k: 3,
    mode: 'seq',
  })

  assert.deepEqual(asyncRes, syncRes)
})

test('assignIdsAsync rejects invalid script outputs and non-zero exit codes', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'h2-ord-test-'))
  t.after(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  const badLabelsScript = path.join(dir, 'bad-labels.py')
  await fs.writeFile(
    badLabelsScript,
    'import sys, json\nsys.stdin.read()\nprint(json.dumps(["wrong1", "wrong2"]))\n',
  )

  await assert.rejects(
    () =>
      assignIdsAsync({
        labels: ['c1', 'c2'],
        task: 't1',
        k: 2,
        mode: 'seq',
        scriptPath: badLabelsScript,
      }),
    /not an exact permutation/,
  )

  const badJsonScript = path.join(dir, 'bad-json.py')
  await fs.writeFile(badJsonScript, 'import sys\nsys.stdin.read()\nprint("NOT_JSON")\n')

  await assert.rejects(
    () =>
      assignIdsAsync({
        labels: ['c1', 'c2'],
        task: 't1',
        k: 2,
        mode: 'seq',
        scriptPath: badJsonScript,
      }),
    /invalid JSON/,
  )

  const crashScript = path.join(dir, 'crash.py')
  await fs.writeFile(crashScript, 'import sys\nsys.exit(2)\n')

  await assert.rejects(
    () =>
      assignIdsAsync({
        labels: ['c1', 'c2'],
        task: 't1',
        k: 2,
        mode: 'seq',
        scriptPath: crashScript,
      }),
    /exited with code 2/,
  )

  // Verify edge case seed 0 in cpythonRandom
  const zeroRng = cpythonRandom(0n)
  assert.equal(zeroRng.randbelow(1), 0)
})
