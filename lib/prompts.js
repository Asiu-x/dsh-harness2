// Derived from Google Harness² 6868817, Apache-2.0. Generated asset is checked by oracle tests.
import { readFileSync } from 'node:fs'
const assets = JSON.parse(
  readFileSync(new URL('./reference-prompts.json', import.meta.url), 'utf8'),
)
export const VERDICT_MARKERS = assets.markers
export function stagePrompt(
  kind,
  { task, k = 1, index = 1, round = 1, mode = 'sequential', dim } = {},
) {
  const size = k === 1 ? 'one' : 'many'
  const phase =
    k === 1
      ? 'first-final'
      : round === 1
        ? 'first'
        : round === k
          ? 'final'
          : 'middle'
  const effectiveMode = k === 1 ? 'parallel' : mode
  const key =
    kind === 'propose'
      ? `propose:${dim}:${size}:${effectiveMode === 'parallel' ? 'parallel' : round === 1 ? 'first' : 'later'}`
      : kind === 'compose'
        ? effectiveMode === 'parallel'
          ? `aggregate:${size}`
          : `compose:${size}:${phase}`
        : kind
  if (!assets[key]) throw new Error(`Unknown prompt ${key}`)
  const values = {
    WORK: task.trim(),
    K: k,
    T: round,
    INDEX: index,
    N: 2 * k,
    PREVCOUNT: Math.max(k - 1, 2),
    COUNT: index,
  }
  return assets[key].replace(/@@([A-Z]+)@@/g, (_, name) => String(values[name]))
}
