// Google Harness² selection.assign_ids native ordering and deterministic shuffle.
// Replaces blocking execFileSync Python process call with pure, non-blocking JS.
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/**
 * Derives a 32-bit unsigned integer seed from a string using SHA-1.
 * @param {string} str
 * @returns {number}
 */
export function sha1Seed(str) {
  const hex = createHash('sha1').update(String(str)).digest('hex')
  return parseInt(hex.slice(0, 8), 16) >>> 0
}

/**
 * High-dispersion 32-bit pseudo-random number generator (Mulberry32).
 * @param {number} seed
 * @returns {() => number} Returns float in [0, 1)
 */
export function mulberry32(seed) {
  let a = seed >>> 0
  return function () {
    let t = (a += 0x6d2b79f5)
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Deterministically shuffles an array using Fisher-Yates and provided PRNG.
 * Does not mutate the original array.
 * @template T
 * @param {T[]} items
 * @param {() => number} rng
 * @returns {T[]}
 */
export function deterministicShuffle(items, rng) {
  const arr = [...items]
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    const temp = arr[i]
    arr[i] = arr[j]
    arr[j] = temp
  }
  return arr
}

/**
 * Native, non-blocking candidate permutation for selector isolation.
 * Sorts labels alphabetically, seeds from task identity, and shuffles deterministically.
 * @param {{ labels: string[], task: string, k: number, mode: string }} params
 * @returns {string[]}
 */
export function assignIds({ labels, task, k, mode }) {
  const sorted = [...labels].sort()
  const seedStr = `${task}|${k}|${mode}`
  const seed = sha1Seed(seedStr)
  const rng = mulberry32(seed)
  return deterministicShuffle(sorted, rng)
}

/**
 * Asynchronous fallback for executing a custom external permutation script if specified.
 * @param {{ labels: string[], task: string, k: number, mode: string, scriptPath?: string, python?: string }} params
 * @returns {Promise<string[]>}
 */
export async function assignIdsAsync({
  labels,
  task,
  k,
  mode,
  scriptPath,
  python = 'python3',
}) {
  if (!scriptPath) {
    return assignIds({ labels, task, k, mode })
  }
  const input = JSON.stringify({
    labels: [...labels].sort(),
    task,
    k,
    mode,
  })
  const { stdout } = await execFileAsync(python, ['-I', scriptPath], {
    input,
    encoding: 'utf8',
    timeout: 10000,
  })
  return JSON.parse(stdout)
}
