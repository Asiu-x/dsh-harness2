// Isolated probe workspaces and deliverable diffing.

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'

export const DEFAULT_SKIP_DIRS = Object.freeze([
  '.git',
  'node_modules',
  '.venv',
  'venv',
  'dist',
  'build',
  'target',
  '.next',
  '.nuxt',
  '.cache',
  '.turbo',
  '.obsidian',
  '.qoder',
  '.claude',
  '.codex',
  '.dsh-harness2',
  '.harness2-probe',
])

const SKIP_FILES = new Set(['.DS_Store', 'Thumbs.db'])

function shouldSkipDir(name) {
  return DEFAULT_SKIP_DIRS.includes(name)
}

async function walk(root, options, visit) {
  const maxBytes = options.maxBytes ?? 50 * 1024 * 1024
  const maxFiles = options.maxFiles ?? 20_000
  let bytes = 0
  let files = 0
  const stack = ['']
  while (stack.length) {
    const relDir = stack.pop()
    const absDir = relDir ? path.join(root, relDir) : root
    let entries
    try {
      entries = await fs.readdir(absDir, { withFileTypes: true })
    } catch (error) {
      if (error?.code === 'ENOENT' && relDir === '') throw new Error(`workspace does not exist: ${root}`)
      if (error?.code === 'ENOENT') continue
      throw error
    }
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name
      const abs = path.join(root, rel)
      if (entry.isDirectory()) {
        if (shouldSkipDir(entry.name)) continue
        stack.push(rel)
        continue
      }
      if (!entry.isFile()) continue
      if (SKIP_FILES.has(entry.name)) continue
      if (entry.name.endsWith('.tmp') || entry.name.includes('.tmp-')) continue
      const stat = await fs.stat(abs)
      bytes += stat.size
      files += 1
      if (bytes > maxBytes) {
        throw new Error(
          `workspace copy exceeds ${Math.round(maxBytes / 1024 / 1024)} MB (scanned ${Math.round(bytes / 1024 / 1024)} MB). ` +
            'Pass a smaller `workspace`, raise `maxWorkspaceMB`, or use `isolation: "shared"` after reviewing the side effects.',
        )
      }
      if (files > maxFiles) {
        throw new Error(`workspace has more than ${maxFiles} files; pass a smaller workspace or raise maxFiles`)
      }
      await visit({ rel, abs, size: stat.size })
    }
  }
}

/** Copy a workspace, excluding repositories' bulky or local-only directories. */
export async function copyWorkspace(source, dest, options = {}) {
  const src = path.resolve(source)
  const dst = path.resolve(dest)
  if (src === dst) throw new Error('workspace source and destination are the same directory')
  await fs.rm(dst, { recursive: true, force: true })
  await fs.mkdir(dst, { recursive: true })
  await walk(src, options, async ({ rel, abs }) => {
    const target = path.join(dst, rel)
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.copyFile(abs, target)
  })
}

function hashOf(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

/** Hash the files that determine a deliverable (bounded; large files hash by size only). */
export async function snapshotFiles(root, options = {}) {
  const maxHashBytes = options.maxHashBytes ?? 5 * 1024 * 1024
  const map = new Map()
  await walk(root, options, async ({ rel, abs, size }) => {
    if (size > maxHashBytes) {
      map.set(rel, { size, hash: `size:${size}` })
      return
    }
    try {
      map.set(rel, { size, hash: hashOf(await fs.readFile(abs)) })
    } catch (error) {
      map.set(rel, { size, hash: `unreadable:${error?.code || 'error'}` })
    }
  })
  return map
}

function likelyText(buffer) {
  if (!buffer.length) return true
  if (buffer.includes(0)) return false
  const sample = buffer.subarray(0, Math.min(buffer.length, 4096))
  let suspicious = 0
  for (const byte of sample) {
    if (byte < 7 || (byte > 14 && byte < 32)) suspicious += 1
  }
  return suspicious / sample.length < 0.02
}

/**
 * Compare a probe workspace to the pristine snapshot.
 * @returns {{files: Array<{path: string, change: string, text: string}>, deleted: string[], truncated: boolean}}
 */
export async function collectChanges(before, afterRoot, options = {}) {
  const maxTextFile = options.maxTextFile ?? 200_000
  const maxTotalText = options.maxTotalText ?? 400_000
  const files = []
  const seen = new Set()
  let total = 0
  let truncated = false
  await walk(afterRoot, options, async ({ rel, abs, size }) => {
    seen.add(rel)
    const old = before.get(rel)
    if (old && old.size === size && old.hash.startsWith('size:')) return
    if (old && old.size === size) {
      const buffer = size <= maxTextFile ? await fs.readFile(abs) : null
      if (buffer && old.hash === hashOf(buffer)) return
    }
    const change = old ? 'modified' : 'new'
    let text = ''
    if (size <= maxTextFile) {
      const buffer = await fs.readFile(abs)
      if (likelyText(buffer)) text = buffer.toString('utf8')
    }
    if (!text && size > maxTextFile) text = `[${size} bytes; too large to embed]`
    if (total + text.length > maxTotalText) {
      truncated = true
      files.push({ path: rel, change, text: `[${size} bytes; omitted by total text cap]` })
      return
    }
    total += text.length
    files.push({ path: rel, change, text })
  })
  const deleted = [...before.keys()].filter((rel) => !seen.has(rel)).sort()
  files.sort((a, b) => a.path.localeCompare(b.path))
  return { files, deleted, truncated }
}

export async function writeManifest(root, destFile, options = {}) {
  const rows = []
  await walk(root, options, async ({ rel, size }) => {
    rows.push({ path: rel, size })
  })
  rows.sort((a, b) => a.path.localeCompare(b.path))
  const lines = [
    '# Workspace source index',
    '',
    `Files: ${rows.length}. Readable source excerpts are copied next to this index by the context builder.`,
    '',
    ...rows.slice(0, 2000).map((row) => `- \`${row.path}\` (${row.size} bytes)`),
  ]
  if (rows.length > 2000) lines.push(`- … ${rows.length - 2000} more files`)
  await fs.mkdir(path.dirname(destFile), { recursive: true })
  await fs.writeFile(destFile, lines.join('\n') + '\n', 'utf8')
}

/** Render a deliverable document from a probe result. */
export function renderDeliverable(run) {
  const lines = [`# Deliverable — ${run.label}`, '']
  const stop =
    run.stopReasonText ||
    (typeof run.stopReason === 'string' ? run.stopReason : run.stopReason?.kind) ||
    'unknown'
  lines.push(`- stop reason: ${stop}`)
  lines.push(`- changed files: ${run.changes?.files?.length ?? 0}`)
  if (run.changes?.deleted?.length) lines.push(`- deleted files: ${run.changes.deleted.join(', ')}`)
  lines.push('', '## Final answer', '', run.text?.trim() || '_(no final answer)_', '')
  for (const file of run.changes?.files ?? []) {
    lines.push(`## ${file.change === 'new' ? 'New file' : 'Modified file'}: \`${file.path}\``, '')
    if (file.text) lines.push('```text', file.text, '```')
    else lines.push('_(binary or empty file)_')
    lines.push('')
  }
  if (run.changes?.truncated) lines.push('_Some file contents were omitted by the total text cap._', '')
  return lines.join('\n')
}

/** Copy a bounded set of readable source files into an evidence context. */
export async function copySourceExcerpts(source, dest, options = {}) {
  const maxFileBytes = options.maxFileBytes ?? 100_000
  const maxTotalBytes = options.maxTotalBytes ?? 2_000_000
  const maxFiles = options.maxFiles ?? 200
  let total = 0
  let count = 0
  await fs.mkdir(dest, { recursive: true })
  await walk(source, options, async ({ rel, abs, size }) => {
    if (count >= maxFiles || total + size > maxTotalBytes || size > maxFileBytes) return
    let buffer
    try {
      buffer = await fs.readFile(abs)
    } catch {
      return
    }
    if (!likelyText(buffer)) return
    const target = path.join(dest, rel)
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, buffer)
    total += size
    count += 1
  })
  return { files: count, bytes: total, maxFiles, maxTotalBytes, maxFileBytes }
}
