// Harness² for DeepSeek Harness — editable harness surface.
//
// The surface keeps the eight logical components of Harness² explicit:
//   system prompt, guardrails, memory, tool guidance (always-on text),
//   skills (on demand), subagents, scripts, plugins (middleware guidance).
//
// Apache-2.0. The Harness² method and its component taxonomy come from
// google-research/harness2 (arXiv:2610.14224); see NOTICE.

import { promises as fs } from 'node:fs'
import fsSync from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const ALWAYS_ON = Object.freeze([
  'system.md',
  'guardrails.md',
  'memory.md',
  'tool-guidance.md',
])

export const ALWAYS_ON_LABEL = Object.freeze({
  'system.md': 'System prompt',
  'guardrails.md': 'Guardrails',
  'memory.md': 'Durable memory',
  'tool-guidance.md': 'Tool guidance',
})

export const SURFACE_NAME = 'dsh'
export const DEFAULT_MAX_ALWAYS_ON_CHARS = 12_000
export const MAX_FILE_CHARS = 200_000
export const MAX_TOTAL_CHARS = 1_000_000
export const MAX_FILES = 200

const NAME = '[a-z0-9][a-z0-9-]*'
const RE = Object.freeze({
  skill: new RegExp(`^skills/(${NAME})/SKILL\\.md$`),
  skillScript: new RegExp(`^skills/(${NAME})/scripts/[A-Za-z0-9_.-]+$`),
  subagent: new RegExp(`^sub_agents/(${NAME})/AGENT\\.md$`),
  script: /^scripts\/[a-z0-9_][a-z0-9_]*\.py$/,
  plugin: new RegExp(`^plugins/(${NAME})\\.md$`),
})

export const SEED_DIR = fileURLToPath(new URL('../seed/', import.meta.url))

/** Normalise a harness-relative path and reject escapes. */
export function normalizeRel(rel) {
  const raw = String(rel ?? '').trim().replaceAll('\\', '/')
  if (!raw || raw.startsWith('/') || raw.split('/').includes('..')) {
    throw new Error(`path escapes the harness: ${JSON.stringify(rel)}`)
  }
  return raw.replace(/^\.\//, '').replace(/\/+/g, '/').replace(/\/+$/, '')
}

/** Whether a path is on the editable surface. Never throws. */
export function isAllowed(rel) {
  try {
    const r = normalizeRel(rel)
    return (
      ALWAYS_ON.includes(r) ||
      RE.skill.test(r) ||
      RE.skillScript.test(r) ||
      RE.subagent.test(r) ||
      RE.script.test(r) ||
      RE.plugin.test(r)
    )
  } catch {
    return false
  }
}

export function skillNameOf(rel) {
  return RE.skill.exec(rel)?.[1] ?? ''
}

export function subagentNameOf(rel) {
  return RE.subagent.exec(rel)?.[1] ?? ''
}

export function pluginNameOf(rel) {
  return RE.plugin.exec(rel)?.[1] ?? ''
}

function isIgnored(rel) {
  const base = path.posix.basename(rel)
  return base === '.DS_Store' || base === 'Thumbs.db' || base === '.gitkeep'
}

/**
 * Read every editable file under a harness directory.
 * @returns {{tree: Record<string,string>, rejected: string[]}}
 */
export async function readTree(root) {
  const tree = {}
  const rejected = []
  let entries
  try {
    entries = await fs.readdir(root, { withFileTypes: true })
  } catch (error) {
    if (error?.code === 'ENOENT') return { tree, rejected }
    throw error
  }
  const walk = async (dir, prefix) => {
    for (const entry of entriesOf(await fs.readdir(dir, { withFileTypes: true }))) {
      const rel = normalizeRel(prefix ? `${prefix}/${entry.name}` : entry.name)
      if (entry.isSymbolicLink()) {
        rejected.push(rel)
        continue
      }
      if (entry.isDirectory()) {
        await walk(path.join(dir, entry.name), rel)
        continue
      }
      if (!entry.isFile()) {
        rejected.push(rel)
        continue
      }
      if (isAllowed(rel)) {
        tree[rel] = await fs.readFile(path.join(dir, entry.name), 'utf8')
      } else if (!isIgnored(rel)) {
        rejected.push(rel)
      }
    }
  }
  await walk(root, '')
  return { tree, rejected }
}

function entriesOf(entries) {
  return [...entries].sort((a, b) => a.name.localeCompare(b.name))
}

/** Write exactly one tree, deleting anything already at `root`. */
export async function writeTree(root, tree) {
  await fs.rm(root, { recursive: true, force: true })
  for (const [rawRel, body] of Object.entries(tree)) {
    const rel = normalizeRel(rawRel)
    if (!isAllowed(rel)) throw new Error(`off-surface file: ${rel}`)
    const dest = path.join(root, rel)
    await fs.mkdir(path.dirname(dest), { recursive: true })
    await fs.writeFile(dest, String(body ?? ''), 'utf8')
  }
}

/** Copy a tree to a new directory without reading it through the surface filter. */
export async function copyTree(source, dest) {
  await fs.rm(dest, { recursive: true, force: true })
  await fs.mkdir(dest, { recursive: true })
  let entries
  try {
    entries = await fs.readdir(source, { withFileTypes: true })
  } catch (error) {
    if (error?.code === 'ENOENT') return
    throw error
  }
  for (const entry of entriesOf(entries)) {
    if (entry.isSymbolicLink()) continue
    const from = path.join(source, entry.name)
    const to = path.join(dest, entry.name)
    if (entry.isDirectory()) await copyTree(from, to)
    else if (entry.isFile()) await fs.copyFile(from, to)
  }
}

/** Parse the small YAML frontmatter subset skill and subagent files use. */
export function parseFrontmatter(text) {
  const src = String(text ?? '')
  if (!src.startsWith('---')) return { data: {}, body: src }
  const end = src.indexOf('\n---', 3)
  if (end < 0) return { data: {}, body: src }
  const head = src.slice(3, end).split('\n')
  const data = {}
  for (const line of head) {
    const m = /^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line.trim())
    if (!m) continue
    let value = m[2].trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    data[m[1]] = value
  }
  let body = src.slice(end + 4)
  if (body.startsWith('\r\n')) body = body.slice(2)
  else if (body.startsWith('\n')) body = body.slice(1)
  return { data, body }
}

export function skillEntries(tree) {
  const out = []
  for (const [rel, body] of Object.entries(tree)) {
    const name = skillNameOf(rel)
    if (!name) continue
    const fm = parseFrontmatter(body)
    out.push({ rel, name, body: fm.body, data: fm.data, text: body })
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

export function subagentEntries(tree) {
  const out = []
  for (const [rel, body] of Object.entries(tree)) {
    const name = subagentNameOf(rel)
    if (!name) continue
    out.push({ rel, name, data: parseFrontmatter(body).data, text: body })
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

export function scriptEntries(tree) {
  return Object.keys(tree)
    .filter((rel) => RE.script.test(rel))
    .sort()
}

export function pluginEntries(tree) {
  const out = []
  for (const [rel, body] of Object.entries(tree)) {
    const name = pluginNameOf(rel)
    if (!name) continue
    out.push({ rel, name, data: parseFrontmatter(body).data, text: body })
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

export function alwaysOnText(tree) {
  return ALWAYS_ON.map((rel) => String(tree[rel] ?? '').trim())
    .filter(Boolean)
    .join('\n\n')
}

export function alwaysOnChars(tree) {
  return ALWAYS_ON.reduce((n, rel) => n + String(tree[rel] ?? '').length, 0)
}

export function inventory(tree) {
  const skills = skillEntries(tree)
  const subagents = subagentEntries(tree)
  const scripts = scriptEntries(tree)
  const plugins = pluginEntries(tree)
  const bits = [
    `${alwaysOnChars(tree).toLocaleString('en-US')} always-on chars`,
    `${skills.length} skill${skills.length === 1 ? '' : 's'}`,
    `${subagents.length} subagent${subagents.length === 1 ? '' : 's'}`,
    `${scripts.length} script${scripts.length === 1 ? '' : 's'}`,
    `${plugins.length} plugin note${plugins.length === 1 ? '' : 's'}`,
  ]
  return bits.join(' · ')
}

/**
 * Compose the model-facing always-on block. Always-on prose is capped and the
 * catalogs only advertise on-demand components by name, trigger, and path.
 */
export function composeAlwaysOn(tree, { resourcesDir = '', maxChars = DEFAULT_MAX_ALWAYS_ON_CHARS } = {}) {
  const parts = []
  for (const rel of ALWAYS_ON) {
    const body = String(tree[rel] ?? '').trim()
    if (!body) continue
    parts.push(`## ${ALWAYS_ON_LABEL[rel]}\n\n${body}`)
  }

  const skills = skillEntries(tree)
  if (skills.length) {
    const rows = skills.map((skill) => {
      const desc = skill.data.description || 'on-demand workflow'
      return `- \`${skill.name}\` — ${desc}${skill.rel ? ` (body: \`${skill.rel}\`)` : ''}`
    })
    parts.push(
      '## Skills (loaded on demand)\n\n' +
        'Invoke a skill by its literal name when its trigger applies. The body is not kept in always-on context.\n\n' +
        rows.join('\n'),
    )
  }

  const subagents = subagentEntries(tree)
  if (subagents.length) {
    const rows = subagents.map((agent) => {
      const desc = agent.data.description || 'delegated role'
      return `- \`${agent.name}\` — ${desc} (role: \`${agent.rel}\`)`
    })
    parts.push(
      '## Subagents (delegated work)\n\n' +
        'Delegate a bounded sub-task when its input is large and its answer is small.\n\n' +
        rows.join('\n'),
    )
  }

  const scripts = scriptEntries(tree)
  if (scripts.length) {
    parts.push(
      '## Scripts (deterministic helpers)\n\n' +
        'Run these with the shell when the situation calls for them; read the file before relying on it.\n\n' +
        scripts.map((rel) => `- \`${rel}\``).join('\n'),
    )
  }

  const plugins = pluginEntries(tree)
  if (plugins.length) {
    const rows = plugins.map((plugin) => {
      const desc = plugin.data.description || 'middleware guidance'
      return `- \`${plugin.name}\` — ${desc} (read \`${plugin.rel}\`)`
    })
    parts.push(
      '## Plugin guidance (middleware notes)\n\n' +
        'These notes describe behavior that belongs inside the tool loop. They are guidance in this build; read them and follow the rule.\n\n' +
        rows.join('\n'),
    )
  }

  if (resourcesDir) {
    parts.push(
      `## Harness resources\n\nThis harness is stored at \`${resourcesDir}\`. Read a skill body or script there when needed.`,
    )
  }

  const text = parts.join('\n\n')
  if (text.length <= maxChars) return text
  return text.slice(0, maxChars) + '\n\n[harness2: always-on block truncated]'
}

/**
 * Validate a harness tree against the DSH surface rules.
 * @returns {{ok: boolean, errors: string[], warnings: string[]}}
 */
export function validateTree(tree, { maxAlwaysOnChars = DEFAULT_MAX_ALWAYS_ON_CHARS } = {}) {
  const errors = []
  const warnings = []
  const rels = Object.keys(tree)

  if (rels.length > MAX_FILES) errors.push(`harness has ${rels.length} files; limit is ${MAX_FILES}`)
  let total = 0
  for (const [rel, body] of Object.entries(tree)) {
    let normalized
    try {
      normalized = normalizeRel(rel)
    } catch (error) {
      errors.push(error.message)
      continue
    }
    if (!isAllowed(normalized)) errors.push(`off-surface file: \`${normalized}\``)
    const len = String(body ?? '').length
    total += len
    if (len > MAX_FILE_CHARS) {
      errors.push(`\`${normalized}\` is ${len} chars; per-file limit is ${MAX_FILE_CHARS}`)
    }
  }
  if (total > MAX_TOTAL_CHARS) errors.push(`harness is ${total} chars; total limit is ${MAX_TOTAL_CHARS}`)

  if (!String(tree['system.md'] ?? '').trim()) {
    errors.push('`system.md` must exist and must not be empty')
  }
  const on = alwaysOnChars(tree)
  if (on > maxAlwaysOnChars) {
    errors.push(
      `always-on text is ${on} chars; limit is ${maxAlwaysOnChars}. Prefer a skill, script, subagent, or plugin note over more always-on prose.`,
    )
  }
  for (const rel of ALWAYS_ON) {
    const body = String(tree[rel] ?? '')
    if (/{{|{%/.test(body)) {
      errors.push(`\`${rel}\` contains a template brace (\`{{\` or \`{%\`); DSH interpolation is strict`)
    }
  }

  const baseText = ALWAYS_ON.map((rel) => String(tree[rel] ?? '')).join('\n')
  const seenSkills = new Set()
  for (const skill of skillEntries(tree)) {
    if (seenSkills.has(skill.name)) errors.push(`duplicate skill name: \`${skill.name}\``)
    seenSkills.add(skill.name)
    if (!skill.data.name) {
      errors.push(`\`${skill.rel}\` needs YAML frontmatter \`name: ${skill.name}\``)
    } else if (skill.data.name !== skill.name) {
      errors.push(`skill frontmatter name \`${skill.data.name}\` must match directory \`${skill.name}\``)
    }
    if (!skill.data.description) {
      errors.push(`\`${skill.rel}\` needs YAML frontmatter \`description:\``)
    }
    if (skill.body.trim().length < 20) {
      warnings.push(`\`${skill.rel}\` has a very short body`)
    }
    const trigger = new RegExp(`(^|[^a-z0-9_-])${escapeRegex(skill.name)}([^a-z0-9_-]|$)`, 'i')
    if (!trigger.test(baseText)) {
      errors.push(
        `skill \`${skill.name}\` is never named in always-on text; add a trigger line such as "When <situation>, load the \`${skill.name}\` skill."`,
      )
    }
  }

  for (const agent of subagentEntries(tree)) {
    if (!agent.data.description) {
      errors.push(`\`${agent.rel}\` needs YAML frontmatter \`description:\``)
    }
  }

  const scriptRefs = new Set()
  const refRe = /(?:^|[^A-Za-z0-9_./-])((?:skills\/[a-z0-9][a-z0-9_-]*\/)?scripts\/[A-Za-z0-9_.-]+\.py)/g
  for (const text of [baseText, ...skillEntries(tree).map((s) => s.body)]) {
    for (const match of text.matchAll(refRe)) scriptRefs.add(match[1])
  }
  for (const ref of scriptRefs) {
    if (!tree[ref]) errors.push(`referenced script \`${ref}\` is not in the harness`)
  }

  for (const plugin of pluginEntries(tree)) {
    if (!plugin.data.description) {
      warnings.push(`\`${plugin.rel}\` has no frontmatter description; its first line is used in the catalog`)
    }
  }

  return { ok: errors.length === 0, errors, warnings }
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** A stable, human-readable diff of two harness trees. */
export function diffTrees(left, right) {
  const added = []
  const removed = []
  const modified = []
  for (const rel of Object.keys(right)) {
    if (!(rel in left)) added.push(rel)
    else if (left[rel] !== right[rel]) modified.push(rel)
  }
  for (const rel of Object.keys(left)) {
    if (!(rel in right)) removed.push(rel)
  }
  return {
    added: added.sort(),
    removed: removed.sort(),
    modified: modified.sort(),
    empty: added.length + removed.length + modified.length === 0,
  }
}

export function diffSummary(diff) {
  if (diff.empty) return 'no changes'
  const parts = []
  if (diff.added.length) parts.push(`added ${diff.added.join(', ')}`)
  if (diff.modified.length) parts.push(`modified ${diff.modified.join(', ')}`)
  if (diff.removed.length) parts.push(`removed ${diff.removed.join(', ')}`)
  return parts.join('; ')
}

/** Seed the first harness (four always-on files). */
export async function seedTree() {
  const { tree, rejected } = await readTree(SEED_DIR)
  if (rejected.length) throw new Error(`seed contains off-surface files: ${rejected.join(', ')}`)
  return tree
}

/** Synchronous tree reader for plugin startup, before the first prompt assembly. */
export function readTreeSync(root) {
  const tree = {}
  const rejected = []
  let entries
  try {
    entries = fsSync.readdirSync(root, { withFileTypes: true })
  } catch (error) {
    if (error?.code === 'ENOENT') return { tree, rejected }
    throw error
  }
  const walk = (dir, prefix) => {
    for (const entry of entriesOf(fsSync.readdirSync(dir, { withFileTypes: true }))) {
      const rel = normalizeRel(prefix ? `${prefix}/${entry.name}` : entry.name)
      if (entry.isSymbolicLink()) {
        rejected.push(rel)
        continue
      }
      if (entry.isDirectory()) {
        walk(path.join(dir, entry.name), rel)
        continue
      }
      if (!entry.isFile()) {
        rejected.push(rel)
        continue
      }
      if (isAllowed(rel)) {
        tree[rel] = fsSync.readFileSync(path.join(dir, entry.name), 'utf8')
      } else if (!isIgnored(rel)) {
        rejected.push(rel)
      }
    }
  }
  walk(root, '')
  return { tree, rejected }
}

export function seedTreeSync() {
  const { tree, rejected } = readTreeSync(SEED_DIR)
  if (rejected.length) throw new Error(`seed contains off-surface files: ${rejected.join(', ')}`)
  return tree
}
