// Google Harness² 6868817 selection.assign_ids native ordering and deterministic shuffle.
// Exact pure-JS port of CPython MT19937 (48-bit SHA-1 seed + _randbelow Fisher-Yates)
// with asynchronous stdin-piped subprocess support for custom external scripts.
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import path from 'node:path'

/**
 * Derives a 32-bit unsigned integer seed from a string using SHA-1[:8].
 * Retained for backward compatibility.
 * @param {string} str
 * @returns {number}
 */
export function sha1Seed(str) {
  const hex = createHash('sha1').update(String(str)).digest('hex')
  return parseInt(hex.slice(0, 8), 16) >>> 0
}

/**
 * Derives the exact 48-bit unsigned integer seed used by Google Harness² 6868817
 * (`int(hashlib.sha1(f"{task}|{k}|{mode}".encode()).hexdigest()[:12], 16)`).
 * @param {string} str
 * @returns {bigint}
 */
export function sha1Seed48(str) {
  const hex = createHash('sha1').update(String(str)).digest('hex')
  return BigInt('0x' + hex.slice(0, 12))
}

/**
 * 32-bit pseudo-random number generator (Mulberry32) with 32-bit state truncation.
 * @param {number} seed
 * @returns {() => number} Returns float in [0, 1)
 */
export function mulberry32(seed) {
  let a = seed >>> 0
  return function () {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), a | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Exact CPython `random.Random(seed)` Mersenne Twister (MT19937) implementation
 * matching `_randommodule.c` (`init_by_array`, `genrand_uint32`, `getrandbits`, `_randbelow`).
 * @param {bigint | number} seedInt
 */
export function cpythonRandom(seedInt) {
  let n = BigInt(seedInt)
  if (n < 0n) n = -n
  const key = []
  while (n > 0n) {
    key.push(Number(n & 0xffffffffn) >>> 0)
    n >>= 32n
  }
  if (key.length === 0) key.push(0)

  const N = 624
  const M = 397
  const mt = new Uint32Array(N)
  mt[0] = 19650218
  for (let mti = 1; mti < N; mti++) {
    mt[mti] =
      (Math.imul(1812433253, mt[mti - 1] ^ (mt[mti - 1] >>> 30)) + mti) >>> 0
  }

  let i = 1
  let j = 0
  for (let k = Math.max(N, key.length); k > 0; k--) {
    mt[i] =
      ((mt[i] ^ Math.imul(mt[i - 1] ^ (mt[i - 1] >>> 30), 1664525)) +
        key[j] +
        j) >>>
      0
    i++
    j++
    if (i >= N) {
      mt[0] = mt[N - 1]
      i = 1
    }
    if (j >= key.length) j = 0
  }
  for (let k = N - 1; k > 0; k--) {
    mt[i] =
      ((mt[i] ^ Math.imul(mt[i - 1] ^ (mt[i - 1] >>> 30), 1566083941)) - i) >>>
      0
    i++
    if (i >= N) {
      mt[0] = mt[N - 1]
      i = 1
    }
  }
  mt[0] = 0x80000000

  let index = N
  const mag01 = [0x0, 0x9908b0df]

  function genrandUint32() {
    let y
    if (index >= N) {
      for (let kk = 0; kk < N - M; kk++) {
        y = ((mt[kk] & 0x80000000) | (mt[kk + 1] & 0x7fffffff)) >>> 0
        mt[kk] = (mt[kk + M] ^ (y >>> 1) ^ mag01[y & 0x1]) >>> 0
      }
      for (let kk = N - M; kk < N - 1; kk++) {
        y = ((mt[kk] & 0x80000000) | (mt[kk + 1] & 0x7fffffff)) >>> 0
        mt[kk] = (mt[kk + (M - N)] ^ (y >>> 1) ^ mag01[y & 0x1]) >>> 0
      }
      y = ((mt[N - 1] & 0x80000000) | (mt[0] & 0x7fffffff)) >>> 0
      mt[N - 1] = (mt[M - 1] ^ (y >>> 1) ^ mag01[y & 0x1]) >>> 0
      index = 0
    }
    y = mt[index++]
    y ^= y >>> 11
    y ^= (y << 7) & 0x9d2c5680
    y ^= (y << 15) & 0xefc60000
    y ^= y >>> 18
    return y >>> 0
  }

  function getrandbits(k) {
    if (k <= 0) return 0
    if (k <= 32) return genrandUint32() >>> (32 - k)
    throw new RangeError('getrandbits > 32 not required for candidate pools')
  }

  function randbelow(n) {
    if (n <= 1) return 0
    const k = 32 - Math.clz32(n)
    let r = getrandbits(k)
    while (r >= n) {
      r = getrandbits(k)
    }
    return r
  }

  return { genrandUint32, getrandbits, randbelow }
}

/**
 * Shuffles an array in-place copy using exact CPython `random.Random(seed).shuffle` semantics.
 * @template T
 * @param {T[]} items
 * @param {bigint | number} seed
 * @returns {T[]}
 */
export function cpythonShuffle(items, seed) {
  const arr = [...items]
  const rng = cpythonRandom(seed)
  for (let i = arr.length - 1; i > 0; i--) {
    const j = rng.randbelow(i + 1)
    const temp = arr[i]
    arr[i] = arr[j]
    arr[j] = temp
  }
  return arr
}

/**
 * Deterministically shuffles an array using Fisher-Yates and provided float [0, 1) PRNG.
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
 * Validates that `candidate` is an exact 1-to-1 permutation of `labels`.
 * @param {string[]} labels
 * @param {unknown} candidate
 * @returns {candidate is string[]}
 */
export function isValidPermutation(labels, candidate) {
  if (!Array.isArray(candidate) || candidate.length !== labels.length) {
    return false
  }
  if (!candidate.every((item) => typeof item === 'string')) {
    return false
  }
  const expected = [...labels].sort()
  const actual = [...candidate].sort()
  return expected.every((val, idx) => val === actual[idx])
}

/**
 * Native, non-blocking candidate permutation matching Google Harness² 6868817 `selection.assign_ids`.
 * Sorts labels lexicographically, derives the 48-bit SHA-1 seed, and applies CPython MT19937 shuffle.
 * @param {{ labels: string[], task: string, k: number, mode: string }} params
 * @returns {string[]}
 */
export function assignIds({ labels, task, k, mode }) {
  const sorted = [...labels].sort()
  const seed = sha1Seed48(`${task}|${k}|${mode}`)
  return cpythonShuffle(sorted, seed)
}

/**
 * Asynchronous execution for a custom external permutation script (`assignIdsScript`),
 * writing JSON payload to child stdin and validating the returned permutation.
 * Falls back to synchronous native `assignIds` when `scriptPath` is omitted.
 * @param {{
 *   labels: string[],
 *   task: string,
 *   k: number,
 *   mode: string,
 *   scriptPath?: string,
 *   workspace?: string,
 *   python?: string,
 *   timeoutMs?: number
 * }} params
 * @returns {Promise<string[]>}
 */
export async function assignIdsAsync({
  labels,
  task,
  k,
  mode,
  scriptPath,
  workspace,
  python = 'python3',
  timeoutMs = 10000,
}) {
  if (!scriptPath) {
    return assignIds({ labels, task, k, mode })
  }
  const resolvedScript =
    workspace && !path.isAbsolute(scriptPath)
      ? path.resolve(workspace, scriptPath)
      : path.resolve(scriptPath)

  const input = JSON.stringify({
    labels: [...labels].sort(),
    task,
    k,
    mode,
  })

  const stdout = await new Promise((resolve, reject) => {
    const child = spawn(python, ['-I', resolvedScript], {
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let out = ''
    let err = ''
    let settled = false
    const maxBuffer = 1024 * 1024

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill('SIGTERM')
      reject(new Error(`assignIdsScript timed out after ${timeoutMs}ms`))
    }, timeoutMs)

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')

    child.stdout.on('data', (chunk) => {
      out += chunk
      if (out.length > maxBuffer && !settled) {
        settled = true
        clearTimeout(timer)
        child.kill('SIGTERM')
        reject(new Error('assignIdsScript stdout exceeded maxBuffer'))
      }
    })

    child.stderr.on('data', (chunk) => {
      if (err.length < maxBuffer) err += chunk
    })

    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(error)
    })

    child.on('close', (code, signal) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (code !== 0) {
        reject(
          new Error(
            `assignIdsScript exited with code ${code ?? signal}: ${err.trim()}`,
          ),
        )
        return
      }
      resolve(out)
    })

    child.stdin.on('error', () => {
      // Ignore EPIPE if child exits before reading stdin; 'close' handles exit code.
    })
    child.stdin.end(input)
  })

  let parsed
  try {
    parsed = JSON.parse(stdout)
  } catch (e) {
    throw new Error(`assignIdsScript returned invalid JSON: ${e.message}`)
  }

  if (!isValidPermutation(labels, parsed)) {
    throw new Error(
      'assignIdsScript output is not an exact permutation of candidate labels',
    )
  }
  return parsed
}
