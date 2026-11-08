import { promises as fs } from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { assertEvidence } from './validation.js'
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    )
  return value
}
export const digest = (value) =>
  createHash('sha256')
    .update(
      typeof value === 'string' ? value : JSON.stringify(canonical(value)),
    )
    .digest('hex')

export function identifier(value) {
  if (
    typeof value !== 'string' ||
    !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(value)
  )
    throw new Error('Invalid identifier')
  return value
}
export function relative(value) {
  if (
    typeof value !== 'string' ||
    !value ||
    path.isAbsolute(value) ||
    value.includes('\\') ||
    value.split('/').some((x) => !x || x === '.' || x === '..')
  )
    throw new Error('Invalid relative path')
  return value
}
export function sensitive(value) {
  return value
    .split('/')
    .some(
      (n) =>
        /^\.env(?:\.|$)|^\.(?:git|aws|ssh|codex|claude|dsh|npmrc|netrc)$|(?:rubrics?|reference_answer|score|judge|verdict|deterministic_eval)/i.test(
          n,
        ) || /\.(?:pem|key|p12|pfx)$/i.test(n),
    )
}
export async function safeFile(root, rel) {
  relative(rel)
  let cursor = root
  for (const part of rel.split('/')) {
    cursor = path.join(cursor, part)
    const stat = await fs.lstat(cursor)
    if (stat.isSymbolicLink())
      throw new Error(`Symbolic link not allowed: ${rel}`)
  }
  const stat = await fs.stat(cursor)
  if (!stat.isFile()) throw new Error(`Expected regular file: ${rel}`)
  return cursor
}
export async function loadTask(
  manifest,
  workspace,
  { maxWorkspaceMB = 50 } = {},
) {
  if (!manifest || typeof manifest !== 'object')
    throw new Error('manifest is required')
  const task = structuredClone(manifest)
  for (const key of ['experiment', 'id', 'domain']) identifier(task[key])
  if (typeof task.instruction !== 'string' || !task.instruction.trim())
    throw new Error('instruction is required')
  if (
    !Array.isArray(task.inputs) ||
    !Array.isArray(task.outputs) ||
    !task.outputs.length
  )
    throw new Error('inputs and outputs are required')
  const files = Object.create(null)
  let bytes = 0
  for (const rel of task.inputs) {
    relative(rel)
    if (sensitive(rel)) throw new Error(`sensitive/forbidden input: ${rel}`)
    const file = await safeFile(workspace, rel)
    const body = await fs.readFile(file)
    bytes += body.length
    if (bytes > maxWorkspaceMB * 1024 * 1024)
      throw new Error('Task inputs exceed workspace budget')
    // Explicit adapter v1 supports UTF-8 text. Fail rather than silently truncate/binary-loss.
    const text = new TextDecoder('utf-8', {
      fatal: true,
      ignoreBOM: true,
    }).decode(body)
    assertEvidence({ [rel]: text })
    files[rel] = text
  }
  for (const out of task.outputs) {
    relative(out.path)
    if (sensitive(out.path)) throw new Error(`forbidden output: ${out.path}`)
    if (out.format !== 'text')
      throw new Error('This task adapter requires format: text')
  }
  assertEvidence({ 'task.md': task.instruction })
  return { task, files, inputFingerprint: digest({ task, files }) }
}
export async function writeFiles(root, tree) {
  for (const [rel, body] of Object.entries(tree)) {
    relative(rel)
    const file = path.join(root, rel)
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, body)
  }
}
export async function deliverable(workspace, task) {
  const files = Object.create(null)
  for (const spec of task.outputs) {
    let file
    try {
      file = await safeFile(workspace, spec.path)
    } catch (e) {
      if (e.code === 'ENOENT') return { delivered: false, text: '', files: {} }
      throw e
    }
    const text = new TextDecoder('utf-8', {
      fatal: true,
      ignoreBOM: true,
    }).decode(await fs.readFile(file))
    if (!text.trim()) return { delivered: false, text: '', files: {} }
    files[spec.path] = text
  }
  assertEvidence(files)
  return {
    delivered: true,
    files,
    text: Object.entries(files)
      .map(([name, text]) => `# ${name}\n\n${text}`)
      .join('\n\n'),
  }
}
