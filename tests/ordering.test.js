import test from 'node:test'
import assert from 'node:assert/strict'
import {
  sha1Seed,
  mulberry32,
  deterministicShuffle,
  assignIds,
  assignIdsAsync,
} from '../lib/ordering.js'

test('sha1Seed returns a valid 32-bit unsigned integer', () => {
  const seed1 = sha1Seed('task-1|2|sequential')
  const seed2 = sha1Seed('task-1|2|sequential')
  const seed3 = sha1Seed('task-2|2|sequential')

  assert.equal(typeof seed1, 'number')
  assert.ok(seed1 >= 0 && seed1 <= 0xffffffff)
  assert.equal(seed1, seed2)
  assert.notEqual(seed1, seed3)
})

test('mulberry32 generates uniform pseudo-random floats in [0, 1)', () => {
  const rng = mulberry32(12345)
  for (let i = 0; i < 100; i++) {
    const val = rng()
    assert.ok(val >= 0 && val < 1)
  }
})

test('deterministicShuffle preserves all elements without loss or duplication', () => {
  const items = ['alpha', 'beta', 'gamma', 'delta', 'epsilon']
  const rng = mulberry32(42)
  const shuffled = deterministicShuffle(items, rng)

  assert.equal(shuffled.length, items.length)
  assert.deepEqual([...shuffled].sort(), [...items].sort())
  // Original array is unmodified
  assert.equal(items[0], 'alpha')
})

test('assignIds produces deterministic, identical permutations for identical inputs', () => {
  const labels = ['agg1', 'agg2', 'base1', 'base2']
  const perm1 = assignIds({ labels, task: 'task-abc', k: 2, mode: 'parallel' })
  const perm2 = assignIds({ labels, task: 'task-abc', k: 2, mode: 'parallel' })

  assert.deepEqual(perm1, perm2)
  assert.deepEqual([...perm1].sort(), [...labels].sort())
})

test('assignIds produces distinct permutations across different tasks or modes', () => {
  const labels = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']
  const permA = assignIds({ labels, task: 'task-1', k: 2, mode: 'parallel' })
  const permB = assignIds({ labels, task: 'task-2', k: 2, mode: 'parallel' })

  assert.notDeepEqual(permA, permB)
})

test('assignIdsAsync falls back to synchronous native shuffle when scriptPath is absent', async () => {
  const labels = ['x1', 'x2', 'x3']
  const syncRes = assignIds({ labels, task: 'task-1', k: 1, mode: 'seq' })
  const asyncRes = await assignIdsAsync({
    labels,
    task: 'task-1',
    k: 1,
    mode: 'seq',
  })

  assert.deepEqual(asyncRes, syncRes)
})
