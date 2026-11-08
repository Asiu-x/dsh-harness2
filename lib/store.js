// Version 2 is isolated from the upstream v1 singleton state. No automatic import.
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { writeFiles, digest, identifier } from './task.js'
import { assertEvidence, assertEvidenceDirectory } from './validation.js'
import { readTree, writeTree } from './surface.js'
export const hasExperience = (e) =>
  Boolean(
    e &&
      ['cue', 'lesson', 'evidence'].every(
        (k) => typeof e[k] === 'string' && e[k].trim(),
      ),
  )
export class ExperimentStore {
  constructor(workspace, experiment, settings) {
    this.root = path.join(workspace, '.dsh-harness2-v2', identifier(experiment))
    this.settings = settings
    this.libraryRoot = path.join(
      this.root,
      `library-${digest(settings).slice(0, 20)}`,
    )
  }
  async initialize(h0) {
    await fs.mkdir(this.root, { recursive: true })
    const record = {
      version: 2,
      settings: this.settings,
      h0,
      h0Fingerprint: digest(h0),
    }
    const file = path.join(this.root, 'experiment.json')
    try {
      const old = JSON.parse(await fs.readFile(file, 'utf8'))
      if (digest(old) !== digest(record))
        throw new Error(
          'Experiment configuration or H0 changed; use a new experiment id',
        )
    } catch (e) {
      if (e.code !== 'ENOENT') throw e
      await this.atomic(file, record)
    }
  }
  async lock() {
    await fs.mkdir(this.root, { recursive: true })
    const file = path.join(this.root, 'run.lock')
    let handle
    try {
      handle = await fs.open(file, 'wx')
    } catch (e) {
      if (e.code !== 'EEXIST') throw e
      let stale = false
      try {
        const existing = JSON.parse(await fs.readFile(file, 'utf8'))
        const pid = existing?.pid
        if (Number.isInteger(pid) && pid > 0 && pid !== process.pid) {
          try {
            process.kill(pid, 0)
          } catch (killErr) {
            if (killErr.code === 'ESRCH') stale = true
          }
        }
      } catch {
        // Unreadable or non-JSON lock file from an active writer is treated as locked.
      }
      if (!stale) throw e
      await fs.rm(file, { force: true })
      handle = await fs.open(file, 'wx')
    }
    await handle.writeFile(
      JSON.stringify({ pid: process.pid, started: new Date().toISOString() }),
    )
    return async () => {
      await handle.close()
      await fs.rm(file, { force: true })
    }
  }
  runDir(task) {
    return path.join(this.root, 'runs', identifier(task.id))
  }
  libraryDir(domain) {
    return path.join(this.libraryRoot, identifier(domain))
  }
  async library(domain) {
    const dir = this.libraryDir(domain)
    try {
      const entries = JSON.parse(
        await fs.readFile(path.join(dir, 'index.json'), 'utf8'),
      )
      return entries
    } catch (e) {
      if (e.code === 'ENOENT') {
        // A missing authoritative index after a receipt is corruption, not an empty library.
        const tasks = await fs
          .readdir(path.join(this.root, 'runs'))
          .catch((error) => {
            if (error.code === 'ENOENT') return []
            throw error
          })
        for (const task of tasks) {
          const record = await fs
            .readFile(path.join(this.root, 'runs', task, 'result.json'), 'utf8')
            .then(JSON.parse)
            .catch((error) => {
              if (error.code === 'ENOENT') return null
              throw error
            })
          if (
            record?.domain === domain &&
            record.libraryAdded &&
            digest(record.settings) === digest(this.settings)
          )
            throw new Error(
              'Authoritative library index missing; restore the experiment evidence before continuing',
            )
        }
        return []
      }
      throw e
    }
  }
  async repairLibrary(domain, entries = undefined) {
    entries ||= await this.library(domain)
    const dir = this.libraryDir(domain)
    for (const entry of entries) {
      if (!/^[0-9]{6,}-[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(entry.name))
        throw new Error('Invalid library entry name')
      identifier(entry.task)
      if (
        !hasExperience(entry.experience) ||
        !entry.harness ||
        digest(entry.harness) !== entry.fingerprint
      )
        throw new Error('Invalid authoritative library commit')
      assertEvidence(entry.harness)
      assertEvidence({ 'EXPERIENCE.md': JSON.stringify(entry.experience) })
      const root = path.join(dir, 'harnesses', entry.name)
      const existing = await readTree(path.join(root, 'harness'))
      if (
        existing.rejected.length ||
        digest(existing.tree) !== entry.fingerprint
      )
        await writeTree(path.join(root, 'harness'), entry.harness)
      const experience = JSON.stringify(entry.experience, null, 2) + '\n'
      const old = await fs
        .readFile(path.join(root, 'EXPERIENCE.md'), 'utf8')
        .catch((e) => {
          if (e.code === 'ENOENT') return ''
          throw e
        })
      if (old !== experience)
        await writeFiles(root, { 'EXPERIENCE.md': experience })
    }
    if (entries.length) {
      const text =
        entries
          .map(
            (e) =>
              `- harnesses/${e.name}/: ${e.task}: ${e.experience.cue}\n  ${e.experience.lesson}`,
          )
          .join('\n') + '\n'
      const file = path.join(dir, 'INDEX.md')
      const old = await fs.readFile(file, 'utf8').catch((e) => {
        if (e.code === 'ENOENT') return ''
        throw e
      })
      if (old !== text) {
        const temp = file + '.tmp-' + randomUUID()
        await fs.writeFile(temp, text)
        await fs.rename(temp, file)
      }
    }
    return entries
  }
  async add(domain, task, harness, experience, selection) {
    if (!hasExperience(experience)) return false
    assertEvidence(harness)
    assertEvidence({
      'EXPERIENCE.md': JSON.stringify(experience),
      'selection.json': JSON.stringify(selection),
    })
    const entries = await this.library(domain)
    const existing = entries.find((e) => e.task === task)
    if (existing) {
      if (
        existing.fingerprint !== digest(harness) ||
        digest(existing.experience) !== digest(experience)
      )
        throw new Error(
          'Library commit disagrees with the authoritative task result',
        )
    } else {
      const name = `${String(entries.length + 1).padStart(6, '0')}-${identifier(task)}`
      entries.push({
        task,
        name,
        experience,
        selection,
        harness,
        fingerprint: digest(harness),
      })
      // This single atomic record contains everything needed to reconstruct derived files.
      await this.atomic(
        path.join(this.libraryDir(domain), 'index.json'),
        entries,
      )
    }
    await this.repairLibrary(domain, entries)
    return true
  }
  async copyLibrary(domain, dest) {
    const entries = await this.repairLibrary(domain)
    if (!entries.length) return
    await assertEvidenceDirectory(this.libraryDir(domain))
    await fs.mkdir(path.join(dest, 'harnesses'), { recursive: true })
    await fs.copyFile(
      path.join(this.libraryDir(domain), 'INDEX.md'),
      path.join(dest, 'INDEX.md'),
    )
    for (const e of entries) {
      await fs.cp(
        path.join(this.libraryDir(domain), 'harnesses', e.name),
        path.join(dest, 'harnesses', e.name),
        { recursive: true, dereference: false },
      )
    }
  }
  async atomic(file, value) {
    await fs.mkdir(path.dirname(file), { recursive: true })
    const temp = file + `.tmp-${randomUUID()}`
    await fs.writeFile(temp, JSON.stringify(value, null, 2) + '\n')
    await fs.rename(temp, file)
  }
}
