// Persistent improvement harness, per-domain experience library, and run state.

import { promises as fs } from 'node:fs'
import fsSync from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import {
  copyTree,
  composeAlwaysOn,
  inventory,
  readTree,
  readTreeSync,
  seedTree,
  validateTree,
  writeTree,
  DEFAULT_MAX_ALWAYS_ON_CHARS,
} from './surface.js'

export const DATA_DIR_NAME = '.dsh-harness2'
const STATE_VERSION = 1

export function safeSlug(value, fallback = 'item') {
  const text = String(value ?? '').normalize('NFKC')
  const slug = text
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .toLowerCase()
  if (slug) return slug
  return `${fallback}-${createHash('sha1').update(text).digest('hex').slice(0, 8)}`
}

export function domainSlug(domain) {
  const text = String(domain ?? '').trim() || 'general'
  const cleaned = text.replace(/[\\/]+/g, '__').replace(/[\u0000-\u001f]/g, '').trim()
  return cleaned || 'general'
}

export class Store {
  constructor(rootDir, { maxAlwaysOnChars = DEFAULT_MAX_ALWAYS_ON_CHARS } = {}) {
    this.root = path.resolve(rootDir)
    this.maxAlwaysOnChars = maxAlwaysOnChars
  }

  get harnessDir() {
    return path.join(this.root, 'harness')
  }

  get libraryRoot() {
    return path.join(this.root, 'library')
  }

  get runsDir() {
    return path.join(this.root, 'runs')
  }

  get statePath() {
    return path.join(this.root, 'state.json')
  }

  async ensure() {
    await fs.mkdir(this.root, { recursive: true })
    await fs.mkdir(this.runsDir, { recursive: true })
    await fs.mkdir(this.libraryRoot, { recursive: true })
    const ignore = path.join(this.root, '.gitignore')
    try {
      await fs.access(ignore)
    } catch {
      await fs.writeFile(
        ignore,
        '# dsh-harness2: run artifacts are local; the adopted harness and library can be committed\nruns/\nworkspaces/\ncontexts/\n*.tmp\n',
        'utf8',
      )
    }
    try {
      await fs.access(this.harnessDir)
    } catch {
      await this.writeHarness(await seedTree(), { validate: false })
    }
  }

  async readState() {
    try {
      return JSON.parse(await fs.readFile(this.statePath, 'utf8'))
    } catch {
      return { version: STATE_VERSION, adopted: false }
    }
  }

  readStateSync() {
    try {
      return JSON.parse(fsSync.readFileSync(this.statePath, 'utf8'))
    } catch {
      return { version: STATE_VERSION, adopted: false }
    }
  }

  readHarnessSync() {
    const { tree, rejected } = readTreeSync(this.harnessDir)
    if (rejected.length) {
      throw new Error(`the adopted harness contains off-surface files: ${rejected.join(', ')}`)
    }
    return tree
  }

  readLessonsSync(domain, limit = 3) {
    const root = path.join(this.libraryDir(domain), 'harnesses')
    let entries
    try {
      entries = fsSync.readdirSync(root, { withFileTypes: true })
    } catch {
      return []
    }
    const rows = []
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory()) continue
      try {
        const e = JSON.parse(
          fsSync.readFileSync(path.join(root, entry.name, 'experience.json'), 'utf8'),
        )
        const bits = []
        if (e.cue) bits.push(`When: ${e.cue}`)
        if (e.lesson) bits.push(`Do: ${e.lesson}`)
        if (e.confidence) bits.push(`Confidence: ${e.confidence}`)
        if (bits.length) rows.push(bits.join(' '))
      } catch {}
    }
    return rows.slice(-Math.max(1, limit))
  }

  async writeState(patch) {
    const current = await this.readState()
    const next = { ...current, ...patch, version: STATE_VERSION, updatedAt: new Date().toISOString() }
    await this.atomicFile(this.statePath, JSON.stringify(next, null, 2) + '\n')
    return next
  }

  async isAdopted() {
    return (await this.readState()).adopted === true
  }

  async readHarness() {
    const { tree, rejected } = await readTree(this.harnessDir)
    if (rejected.length) {
      throw new Error(`the adopted harness contains off-surface files: ${rejected.join(', ')}`)
    }
    return tree
  }

  async readHarnessSafe() {
    try {
      return await this.readHarness()
    } catch {
      return await seedTree()
    }
  }

  async validate(tree) {
    return validateTree(tree, { maxAlwaysOnChars: this.maxAlwaysOnChars })
  }

  async writeHarness(tree, { validate = true } = {}) {
    if (validate) {
      const result = validateTree(tree, { maxAlwaysOnChars: this.maxAlwaysOnChars })
      if (!result.ok) throw new Error(`invalid harness: ${result.errors.join('; ')}`)
    }
    const temp = path.join(this.root, `harness.tmp-${randomUUID()}`)
    const backup = path.join(this.root, `harness.bak-${randomUUID()}`)
    await writeTree(temp, tree)
    let hadOld = false
    try {
      await fs.rename(this.harnessDir, backup)
      hadOld = true
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    try {
      await fs.rename(temp, this.harnessDir)
    } catch (error) {
      if (hadOld) await fs.rename(backup, this.harnessDir).catch(() => {})
      throw error
    }
    if (hadOld) await fs.rm(backup, { recursive: true, force: true })
    return this.readHarness()
  }

  async resetHarness({ archive = true } = {}) {
    const current = await this.readHarnessSafe()
    if (archive) {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      const dest = path.join(this.libraryRoot, '_reset', stamp, 'harness')
      await fs.mkdir(path.dirname(dest), { recursive: true })
      await copyTree(this.harnessDir, dest)
    }
    const tree = await seedTree()
    await this.writeHarness(tree, { validate: false })
    await this.writeState({
      adopted: false,
      adoptedAt: null,
      domain: null,
      runId: null,
      reason: 'reset',
    })
    return current
  }

  libraryDir(domain) {
    return path.join(this.libraryRoot, domainSlug(domain))
  }

  async listLibrary(domain) {
    const dir = this.libraryDir(domain)
    const entries = []
    try {
      for (const entry of await fs.readdir(path.join(dir, 'harnesses'), { withFileTypes: true })) {
        if (!entry.isDirectory()) continue
        const entryDir = path.join(dir, 'harnesses', entry.name)
        let experience = {}
        try {
          experience = JSON.parse(await fs.readFile(path.join(entryDir, 'experience.json'), 'utf8'))
        } catch {}
        let inventoryText = ''
        try {
          inventoryText = inventory((await readTree(path.join(entryDir, 'harness'))).tree)
        } catch {}
        entries.push({ id: entry.name, experience, inventory: inventoryText })
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    return entries.sort((a, b) => a.id.localeCompare(b.id))
  }

  async readLessons(domain, limit = 3) {
    const entries = await this.listLibrary(domain)
    return entries
      .slice(-Math.max(1, limit))
      .map((entry) => {
        const e = entry.experience || {}
        const bits = []
        if (e.cue) bits.push(`When: ${e.cue}`)
        if (e.lesson) bits.push(`Do: ${e.lesson}`)
        if (e.confidence) bits.push(`Confidence: ${e.confidence}`)
        return bits.join(' ')
      })
      .filter(Boolean)
  }

  async copyLibrary(domain, destDir, { limit = 12 } = {}) {
    const source = this.libraryDir(domain)
    try {
      await fs.access(source)
    } catch {
      return false
    }
    const entries = await this.listLibrary(domain)
    const keep = new Set(entries.slice(-limit).map((entry) => entry.id))
    await fs.mkdir(destDir, { recursive: true })
    try {
      await fs.copyFile(path.join(source, 'INDEX.md'), path.join(destDir, 'INDEX.md'))
    } catch {}
    for (const id of keep) {
      const from = path.join(source, 'harnesses', id)
      const to = path.join(destDir, 'harnesses', id)
      await copyTree(from, to)
    }
    return true
  }

  async archive({ domain, task, harness, why = '', edits = '', experience = {}, runId = '' }) {
    const dirName = `${new Date().toISOString().slice(0, 10)}-${safeSlug(task, 'task')}`
    const base = path.join(this.libraryDir(domain), 'harnesses', dirName)
    let dest = base
    for (let i = 2; i < 100; i++) {
      try {
        await fs.access(dest)
        dest = `${base}-${i}`
      } catch {
        break
      }
    }
    await fs.mkdir(dest, { recursive: true })
    if (harness) await writeTree(path.join(dest, 'harness'), harness)
    else await copyTree(this.harnessDir, path.join(dest, 'harness'))
    const record = {
      task: String(task ?? '').slice(0, 2000),
      adoptedAt: new Date().toISOString(),
      runId,
      why: String(why ?? '').slice(0, 4000),
      edits: String(edits ?? '').slice(0, 4000),
      cue: String(experience.cue ?? '').slice(0, 500),
      lesson: String(experience.lesson ?? '').slice(0, 1000),
      evidence: String(experience.evidence ?? '').slice(0, 1000),
      confidence: String(experience.confidence ?? '').slice(0, 40),
      inventory: inventory(harness || (await this.readHarness())),
    }
    await fs.writeFile(path.join(dest, 'experience.json'), JSON.stringify(record, null, 2) + '\n', 'utf8')
    const md = [
      `# ${record.task || dirName}`,
      '',
      `- adopted: ${record.adoptedAt}${runId ? ` (run \`${runId}\`)` : ''}`,
      `- components: ${record.inventory}`,
      '',
    ]
    if (record.why) md.push('## Why this harness', '', record.why, '')
    if (record.edits) md.push('## What each edit did', '', record.edits, '')
    if (record.cue || record.lesson) {
      md.push('## Transferable lesson', '')
      if (record.cue) md.push(`- **cue**: ${record.cue}`)
      if (record.lesson) md.push(`- **lesson**: ${record.lesson}`)
      if (record.evidence) md.push(`- **evidence**: ${record.evidence}`)
      if (record.confidence) md.push(`- **confidence**: ${record.confidence}`)
      md.push('')
    }
    await fs.writeFile(path.join(dest, 'EXPERIENCE.md'), md.join('\n'), 'utf8')
    await this.rebuildIndex(domain)
    return dest
  }

  async rebuildIndex(domain) {
    const dir = this.libraryDir(domain)
    const entries = await this.listLibrary(domain)
    const lines = [
      `# Experience library — ${domain}`,
      '',
      'Each entry is a harness adopted on an earlier task in this domain, stored with its full component tree and the lesson drawn from its evidence. Browse this index, then open the entries that look relevant.',
      '',
    ]
    if (!entries.length) lines.push('_(empty — this is the first adopted harness in this domain)_')
    for (const entry of entries) {
      const e = entry.experience || {}
      lines.push(`## \`harnesses/${entry.id}/\``)
      lines.push(`- harness: \`harnesses/${entry.id}/harness/\` — ${entry.inventory || 'inventory unavailable'}`)
      lines.push(`- why: \`harnesses/${entry.id}/EXPERIENCE.md\``)
      if (e.cue) lines.push(`- cue: ${e.cue}`)
      if (e.lesson) lines.push(`- lesson: ${e.lesson}`)
      lines.push('')
    }
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, 'INDEX.md'), lines.join('\n'), 'utf8')
  }

  async atomicFile(file, body) {
    const temp = path.join(path.dirname(file), `.${path.basename(file)}.tmp-${randomUUID()}`)
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(temp, body, 'utf8')
    await fs.rename(temp, file)
  }

  adoptedSummary(tree) {
    return {
      inventory: inventory(tree),
      alwaysOnChars: composeAlwaysOn(tree, { maxChars: this.maxAlwaysOnChars }).length,
    }
  }
}
