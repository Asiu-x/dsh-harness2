// Harness² recursion: Propose–Probe–Compose, selection, and the persistent library.

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { Store, safeSlug, domainSlug } from './store.js'
import { AgentRunner, mapLimit, parseExperience, parseTag, materialiseResources } from './agents.js'
import {
  composeAlwaysOn,
  diffSummary,
  diffTrees,
  inventory,
  readTree,
  seedTree,
  validateTree,
  writeTree,
  DEFAULT_MAX_ALWAYS_ON_CHARS,
} from './surface.js'
import {
  collectChanges,
  copySourceExcerpts,
  copyWorkspace,
  renderDeliverable,
  snapshotFiles,
  writeManifest,
} from './workspace.js'
import { composePrompt, proposePrompt, reflectPrompt, selectPrompt } from './prompts.js'

const PLUGIN = 'dsh-harness2'
const DEFAULT_CONFIG = Object.freeze({
  workspace: '',
  dataDir: '.dsh-harness2',
  maxAlwaysOnChars: DEFAULT_MAX_ALWAYS_ON_CHARS,
  maxK: 3,
  mode: 'sequential',
  concurrency: 2,
  timeoutMinutes: 20,
  toolTimeoutMinutes: 120,
  maxWorkspaceMB: 50,
  workspaceIsolation: 'copy',
  selection: true,
  reflection: true,
  libraryLessons: 3,
  libraryEntries: 8,
  model: '',
  provider: '',
  reasoningEffort: '',
})

function configOf(input = {}) {
  return { ...DEFAULT_CONFIG, ...input }
}

function clamp(value, min, max, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, Math.trunc(n)))
}

function safeName(value) {
  return String(value ?? 'item').replace(/[^A-Za-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '') || 'item'
}

function digestRun(run, maxChars = 24_000) {
  const files = (run.changes?.files ?? [])
    .map((file) => {
      const body = String(file.text ?? '').slice(0, 3_000)
      return `### ${file.change === 'new' ? 'New' : 'Modified'} \`${file.path}\`\n\n${body}`
    })
    .join('\n\n')
  const text = [
    `Final answer:\n${String(run.text ?? '').trim() || '(none)'}`,
    files ? `Files:\n\n${files}` : '',
    run.changes?.deleted?.length ? `Deleted: ${run.changes.deleted.join(', ')}` : '',
  ]
    .filter(Boolean)
    .join('\n\n')
  return text.length > maxChars ? text.slice(0, maxChars) + '\n… [digest truncated]' : text
}

function choiceFrom(text) {
  const match = /```choice\s*\n?\s*([A-Za-z0-9_-]+)\s*\n?```/i.exec(String(text ?? ''))
  return match?.[1] ?? ''
}

function hashPick(value) {
  return createHash('sha1').update(String(value)).digest('hex')
}

export class Harness2Runtime {
  constructor(ctx, inputConfig, { log = () => {} } = {}) {
    this.ctx = ctx
    this.config = configOf(inputConfig)
    this.workspace = path.resolve(this.config.workspace || process.cwd())
    this.store = new Store(path.resolve(this.workspace, this.config.dataDir), {
      maxAlwaysOnChars: this.config.maxAlwaysOnChars,
    })
    this.runner = new AgentRunner({ ctx, config: this.config, log })
    this.log = log
    this.adoptedText = ''
    this.adoptedMeta = null
    this.loadAdoptedSync()
    this.ready = this.init()
  }

  /** Load the adopted harness before the first prompt assembly, synchronously. */
  loadAdoptedSync() {
    try {
      const state = this.store.readStateSync()
      if (!state.adopted) return
      const tree = this.store.readHarnessSync()
      const lessons = this.store.readLessonsSync(
        state.domain || 'general',
        this.config.libraryLessons,
      )
      const text = composeAlwaysOn(tree, {
        resourcesDir: this.store.harnessDir,
        maxChars: this.config.maxAlwaysOnChars,
      })
      const lessonBlock = lessons.length
        ? `## Lessons from this domain's library\n\n${lessons.map((lesson) => `- ${lesson}`).join('\n')}`
        : ''
      this.adoptedText = [text, lessonBlock].filter(Boolean).join('\n\n')
      this.adoptedMeta = {
        adoptedAt: state.adoptedAt || '',
        domain: state.domain || 'general',
        runId: state.runId || '',
        inventory: inventory(tree),
      }
    } catch (error) {
      this.adoptedText = ''
      this.adoptedMeta = null
      this.log(`could not load adopted harness at startup: ${error?.message || error}`)
    }
  }

  async init() {
    await this.store.ensure()
    await this.refreshAdopted()
  }

  async refreshAdopted() {
    const state = await this.store.readState()
    if (!state.adopted) {
      this.adoptedText = ''
      this.adoptedMeta = null
      return
    }
    try {
      const tree = await this.store.readHarness()
      const lessons = await this.store.readLessons(state.domain || 'general', this.config.libraryLessons)
      const text = composeAlwaysOn(tree, {
        resourcesDir: this.store.harnessDir,
        maxChars: this.config.maxAlwaysOnChars,
      })
      const lessonBlock = lessons.length
        ? `## Lessons from this domain's library\n\n${lessons.map((lesson) => `- ${lesson}`).join('\n')}`
        : ''
      this.adoptedText = [text, lessonBlock].filter(Boolean).join('\n\n')
      this.adoptedMeta = {
        adoptedAt: state.adoptedAt || '',
        domain: state.domain || 'general',
        runId: state.runId || '',
        inventory: inventory(tree),
      }
    } catch (error) {
      this.adoptedText = ''
      this.adoptedMeta = null
      this.log(`could not load adopted harness: ${error?.message || error}`)
    }
  }

  async status() {
    await this.ready
    const state = await this.store.readState()
    const tree = await this.store.readHarnessSafe()
    const library = await this.store.listLibrary(state.domain || 'general')
    return {
      adopted: state.adopted === true,
      adoptedAt: state.adoptedAt || null,
      domain: state.domain || 'general',
      runId: state.runId || null,
      dataDir: path.relative(this.workspace, this.store.root),
      harness: {
        dir: path.relative(this.workspace, this.store.harnessDir),
        inventory: inventory(tree),
        alwaysOnChars: composeAlwaysOn(tree, { maxChars: this.config.maxAlwaysOnChars }).length,
      },
      library: library.map((entry) => ({
        id: entry.id,
        cue: entry.experience?.cue || '',
        lesson: entry.experience?.lesson || '',
        inventory: entry.inventory,
      })),
      latestRun: state.latestRun || null,
    }
  }

  async reset() {
    await this.ready
    const previous = await this.store.resetHarness({ archive: true })
    await this.refreshAdopted()
    return {
      reset: true,
      archivedInventory: inventory(previous),
      harness: inventory(await this.store.readHarness()),
    }
  }

  async refine({
    task,
    domain = 'general',
    k = 1,
    mode = 'sequential',
    workspace = '',
    isolation = '',
    parentAgent,
    signal,
    onProgress,
  }) {
    await this.ready
    const text = String(task ?? '').trim()
    if (!text) throw new Error('`task` is required: describe the work the harness should be refined on')
    const budget = clamp(k, 1, this.config.maxK, 1)
    const recursion = mode === 'parallel' ? 'parallel' : 'sequential'
    const targetWorkspace = path.resolve(workspace || this.workspace)
    const isolationMode = isolation === 'shared' ? 'shared' : this.config.workspaceIsolation === 'shared' ? 'shared' : 'copy'
    const concurrency = isolationMode === 'shared' ? 1 : Math.max(1, Number(this.config.concurrency) || 2)
    if (isolationMode === 'shared') {
      this.emit(onProgress, 'WARNING: shared isolation is enabled; probes run in the same workspace and can interfere with each other.')
    }

    await this.store.ensure()
    const baseTree = await this.store.readHarness()
    const validation = validateTree(baseTree, { maxAlwaysOnChars: this.config.maxAlwaysOnChars })
    if (!validation.ok) {
      throw new Error(`the adopted harness is invalid: ${validation.errors.join('; ')}`)
    }

    const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${safeSlug(text, 'task').slice(0, 28)}`
    const runDir = path.join(this.store.runsDir, runId)
    await fs.mkdir(runDir, { recursive: true })
    const log = async (message) => {
      const line = `[${new Date().toISOString()}] ${message}\n`
      await fs.appendFile(path.join(runDir, 'progress.log'), line, 'utf8').catch(() => {})
      this.emit(onProgress, message)
    }

    await log(
      `run ${runId}: mode=${recursion} k=${budget} domain=${domainSlug(domain)} isolation=${isolationMode} workspace=${targetWorkspace}`,
    )
    await log(`base harness: ${inventory(baseTree)}`)

    const pristine = path.join(runDir, 'workspaces', 'pristine')
    let pristineMap
    if (isolationMode === 'shared') {
      pristineMap = await snapshotFiles(targetWorkspace, this.walkOptions())
      await log('snapshot: shared workspace')
    } else {
      await copyWorkspace(targetWorkspace, pristine, this.walkOptions())
      pristineMap = await snapshotFiles(pristine, this.walkOptions())
      await log(`snapshot: copied workspace to ${path.relative(runDir, pristine)}`)
    }
    const sourceRoot = isolationMode === 'shared' ? targetWorkspace : pristine
    await writeManifest(sourceRoot, path.join(runDir, 'source-index.md'), this.walkOptions())
    await writeTree(path.join(runDir, 'harness', 'base'), baseTree)

    const probe = async (label, tree) => {
      return this.probe({
        runId,
        runDir,
        label,
        tree,
        task: text,
        workspace: targetWorkspace,
        pristine,
        pristineMap,
        isolation: isolationMode,
        parentAgent,
        signal,
        log,
      })
    }

    const baseRuns = await mapLimit(
      Array.from({ length: budget }, (_, index) => index + 1),
      concurrency,
      async (index) => probe(`base${index}`, baseTree),
    )
    const usableBase = baseRuns.filter((run) => run.ok)
    if (!usableBase.length) {
      await log('all base rollouts failed; stopping')
      throw new Error(`all ${budget} base rollout(s) failed; see ${path.relative(targetWorkspace, runDir)}/progress.log`)
    }
    baseRuns.splice(0, baseRuns.length, ...usableBase)

    const history = []
    let finals = []
    let evidenceCandidates = []
    let compositionRecords = []
    let currentTree = baseTree
    let composerNotes = ''

    if (recursion === 'sequential') {
      for (let round = 1; round <= budget; round++) {
        const historyRuns = history.flatMap((entry) => [entry.inv.run, entry.dom.run, entry.composed.run])
        const evidenceRuns = [...baseRuns, ...historyRuns]
        const proposals = await mapLimit(
          [
            { dim: 'INV', label: `inv-r${round}` },
            { dim: 'DOM', label: `dom-r${round}` },
          ],
          concurrency,
          async (spec) => {
            const proposal = await this.propose({
              runId,
              runDir,
              label: spec.label,
              dim: spec.dim,
              task: text,
              domain,
              k: budget,
              index: round,
              round,
              checkpoint: round > 1,
              currentTree,
              runs: evidenceRuns,
              sourceIndex: path.join(runDir, 'source-index.md'),
              sourceRoot,
              parentAgent,
              signal,
              log,
            })
            const run = await probe(spec.label, proposal.tree)
            return { ...proposal, run }
          },
        )
        const pool = proposals.map((entry) => ({ label: entry.label, tree: entry.tree, run: entry.run }))
        const composed = await this.compose({
          runId,
          runDir,
          label: `c${round}`,
          task: text,
          domain,
          k: budget,
          mode: 'sequential',
          round,
          final: round === budget,
          currentTree,
          runs: [...evidenceRuns, ...proposals.map((entry) => entry.run)],
          pool,
          decisions: Object.fromEntries(proposals.map((entry) => [entry.label, entry.notes || entry.error || ''])),
          sourceIndex: path.join(runDir, 'source-index.md'),
          sourceRoot,
          parentAgent,
          signal,
          log,
        })
        const composedRun = await probe(`c${round}`, composed.tree)
        composerNotes = composed.notes || ''
        compositionRecords.push(composed)
        history.push({ round, inv: proposals[0], dom: proposals[1], composed, run: composedRun })
        currentTree = composed.tree
        await log(`round ${round}/${budget}: checkpoint ${inventory(currentTree)}`)
      }
      const last = history[history.length - 1]
      evidenceCandidates = history.flatMap((entry) => [entry.inv, entry.dom])
      finals = [{ label: `c${budget}`, tree: last.composed.tree, run: last.run, notes: last.composed.notes }]
    } else {
      const specs = []
      for (let index = 1; index <= budget; index++) {
        specs.push({ dim: 'INV', label: `inv${index}`, index })
        specs.push({ dim: 'DOM', label: `dom${index}`, index })
      }
      const proposals = await mapLimit(specs, concurrency, async (spec) => {
        const proposal = await this.propose({
          runId,
          runDir,
          label: spec.label,
          dim: spec.dim,
          task: text,
          domain,
          k: budget,
          index: spec.index,
          round: null,
          checkpoint: false,
          currentTree: baseTree,
          runs: baseRuns,
          sourceIndex: path.join(runDir, 'source-index.md'),
          sourceRoot,
          parentAgent,
          signal,
          log,
        })
        const run = await probe(spec.label, proposal.tree)
        return { ...proposal, run }
      })
      const pool = proposals.map((entry) => ({ label: entry.label, tree: entry.tree, run: entry.run }))
      const aggs = await mapLimit(
        Array.from({ length: budget }, (_, index) => index + 1),
        concurrency,
        async (index) => {
          return this.compose({
            runId,
            runDir,
            label: `agg${index}`,
            task: text,
            domain,
            k: budget,
            mode: 'parallel',
            index,
            round: null,
            final: true,
            currentTree: baseTree,
            runs: [...baseRuns, ...proposals.map((entry) => entry.run)],
            pool,
            decisions: Object.fromEntries(proposals.map((entry) => [entry.label, entry.notes || entry.error || ''])),
            sourceIndex: path.join(runDir, 'source-index.md'),
            sourceRoot,
            parentAgent,
            signal,
            log,
          })
        },
      )
      const aggRuns = await mapLimit(aggs, concurrency, async (agg) => {
        const run = await probe(agg.label, agg.tree)
        return { ...agg, run }
      })
      evidenceCandidates = proposals
      compositionRecords = aggs
      finals = aggRuns.map((entry) => ({
        label: entry.label,
        tree: entry.tree,
        run: entry.run,
        notes: entry.notes,
      }))
      composerNotes = finals.map((entry) => `${entry.label}: ${entry.notes || ''}`).join('\n')
    }

    const selection = await this.select({
      runId,
      runDir,
      task: text,
      domain,
      base: baseRuns[0],
      baseTree,
      finals,
      sourceRoot,
      parentAgent,
      signal,
      log,
    })
    const winner = selection.winner
    const winnerDiff = winner ? diffTrees(baseTree, winner.tree) : null
    const noHarnessChange = Boolean(winner && winnerDiff?.empty)
    const adopted = Boolean(winner && !winner.isBase && !noHarnessChange)
    const why = [
      selection.why || '',
      noHarnessChange ? 'The selected candidate changed no harness component, so the current harness was kept.' : '',
    ]
      .filter(Boolean)
      .join(' ')
    let experience = {}
    let reflectionNotes = ''
    if (adopted && this.config.reflection) {
      const reflection = await this.reflect({
        runId,
        runDir,
        task: text,
        domain,
        mode: recursion,
        k: budget,
        baseTree,
        winner,
        finals,
        candidates: evidenceCandidates,
        baseRuns,
        why,
        composerNotes,
        parentAgent,
        signal,
        log,
      })
      experience = reflection.experience || {}
      reflectionNotes = reflection.notes || ''
    } else if (adopted) {
      experience = { edits: composerNotes }
    }

    let archiveDir = ''
    if (adopted) {
      await this.store.writeHarness(winner.tree)
      await this.store.writeState({
        adopted: true,
        adoptedAt: new Date().toISOString(),
        domain: domainSlug(domain),
        runId,
        mode: recursion,
        k: budget,
        winner: winner.label,
        inventory: inventory(winner.tree),
        latestRun: runId,
      })
      archiveDir = await this.store.archive({
        domain,
        task: text,
        harness: winner.tree,
        why,
        edits: experience.edits || composerNotes,
        experience,
        runId,
      })
      await this.refreshAdopted()
    } else {
      await this.store.writeState({ latestRun: runId, lastDomain: domainSlug(domain) })
    }

    const summary = {
      runId,
      runDir,
      mode: recursion,
      k: budget,
      domain: domainSlug(domain),
      adopted,
      winner: winner?.label || null,
      winnerIsBase: Boolean(winner?.isBase),
      why,
      noHarnessChange,
      selectionFallback: selection.fallback || false,
      harness: inventory(adopted ? winner.tree : baseTree),
      base: baseRuns.map((run) => summariseRun(run)),
      finals: finals.map((entry) => ({ label: entry.label, ...summariseRun(entry.run) })),
      candidates: selection.candidates || [],
      candidatesDetailed: evidenceCandidates.map((entry) => ({
        label: entry.label,
        dim: entry.dim || '',
        fellBack: Boolean(entry.fellBack),
        diff: entry.diff ? diffSummary(entry.diff) : '',
        notes: String(entry.notes || '').slice(0, 2000),
        probe: entry.run ? summariseRun(entry.run) : null,
      })),
      compositions: compositionRecords.map((entry) => ({
        label: entry.label,
        fellBack: Boolean(entry.fellBack),
        diff: entry.diff ? diffSummary(entry.diff) : '',
        notes: String(entry.notes || '').slice(0, 2000),
      })),
      experience,
      reflectionNotes,
      archiveDir: archiveDir ? path.relative(this.workspace, archiveDir) : '',
      progressLog: path.relative(this.workspace, path.join(runDir, 'progress.log')),
    }
    await fs.writeFile(path.join(runDir, 'run.json'), JSON.stringify(summary, null, 2) + '\n', 'utf8')
    await log(
      `done: ${adopted ? `adopted ${winner.label}` : 'kept the current harness'} · winner=${winner?.label || 'none'}`,
    )
    return summary
  }

  async probe({
    runId,
    runDir,
    label,
    tree,
    task,
    workspace,
    pristine,
    pristineMap,
    isolation,
    parentAgent,
    signal,
    log,
  }) {
    const shared = isolation === 'shared'
    const probeWorkspace = shared ? workspace : path.join(runDir, 'workspaces', safeName(label))
    if (!shared) await copyWorkspace(pristine, probeWorkspace, this.walkOptions())
    const resourcesDir = await materialiseResources(probeWorkspace, safeName(label), tree)
    await log(`[${label}] probe start · ${inventory(tree)}`)
    let run
    try {
      run = await this.runner.run({
        label,
        purpose: 'probe',
        prompt: task,
        harness: tree,
        workspace: probeWorkspace,
        parentAgent,
        signal,
        timeoutMs: this.config.timeoutMinutes * 60_000,
        resourcesDir,
      })
    } catch (error) {
      run = {
        label,
        ok: false,
        timedOut: false,
        text: '',
        trajectory: '',
        stopReasonText: `error: ${error?.message || error}`,
        elapsedMs: 0,
        workspace: probeWorkspace,
        model: '',
        error: String(error?.message || error),
      }
    }
    let changes = { files: [], deleted: [], truncated: false }
    if (!shared) {
      changes = await collectChanges(pristineMap, probeWorkspace, {
        ...this.walkOptions(),
        maxTextFile: 200_000,
        maxTotalText: 400_000,
      })
    }
    const record = { ...run, harness: tree, changes }
    await this.writeEvidence(runDir, record)
    await log(
      `[${label}] probe ${run.ok ? 'ok' : 'not ok'} · ${changes.files.length} changed file(s)${run.timedOut ? ' · timeout' : ''}`,
    )
    return record
  }

  async propose({
    runId,
    runDir,
    label,
    dim,
    task,
    domain,
    k,
    index,
    round,
    checkpoint,
    currentTree,
    runs,
    sourceIndex,
    sourceRoot,
    parentAgent,
    signal,
    log,
  }) {
    let rejection = ''
    for (let attempt = 1; attempt <= 2; attempt++) {
      const attemptLabel = `${label}.a${attempt}`
      const root = path.join(runDir, 'contexts', `${safeName(label)}-a${attempt}`)
      const prompt = proposePrompt({
        task,
        domain,
        dim,
        k,
        index,
        round,
        checkpoint,
        rejection,
      })
      await this.buildContext({
        root,
        prompt,
        task,
        harness: currentTree,
        runs,
        domain,
        sourceIndex,
        sourceRoot,
      })
      await log(`[${label}] propose ${dim} attempt ${attempt}`)
      let run
      try {
        run = await this.runner.run({
          label: attemptLabel,
          purpose: `propose ${dim}`,
          prompt,
          harness: null,
          workspace: root,
          parentAgent,
          signal,
          timeoutMs: this.config.timeoutMinutes * 60_000,
        })
      } catch (error) {
        rejection = `proposer agent failed: ${error?.message || error}`
        await log(`[${label}] proposal agent failed: ${rejection}`)
        continue
      }
      const { tree, rejected } = await readTree(path.join(root, 'context', 'harness'))
      const validation = validateTree(tree, { maxAlwaysOnChars: this.config.maxAlwaysOnChars })
      const errors = [
        ...rejected.map((rel) => `off-surface file: ${rel}`),
        ...validation.errors,
      ]
      if (!errors.length) {
        const diff = diffTrees(currentTree, tree)
        const notes = parseTag(run.text, 'notes') || run.text || ''
        await this.writeAgentEvidence(runDir, 'proposals', label, {
          tree,
          run,
          notes,
          diff,
          dim,
        })
        return {
          label,
          dim,
          tree,
          notes,
          run,
          attempt,
          diff,
          fellBack: diff.empty,
        }
      }
      rejection = errors.join('; ')
      await log(`[${label}] proposal rejected: ${rejection}`)
    }
    const notes = `invalid proposal, kept the current harness: ${rejection}`
    await this.writeAgentEvidence(runDir, 'proposals', label, {
      notes,
      dim,
      error: rejection,
    })
    return {
      label,
      dim,
      tree: currentTree,
      notes,
      run: null,
      attempt: 2,
      diff: diffTrees(currentTree, currentTree),
      fellBack: true,
      error: rejection,
    }
  }

  async compose({
    runId,
    runDir,
    label,
    task,
    domain,
    k,
    mode,
    index = 1,
    round,
    final,
    currentTree,
    runs,
    pool,
    decisions,
    sourceIndex,
    sourceRoot,
    parentAgent,
    signal,
    log,
  }) {
    const prompt = composePrompt({
      task,
      domain,
      k,
      mode,
      round,
      final,
      poolNote:
        mode === 'parallel'
          ? `There are ${pool.length} candidates in \`context/pool/\`; each has its own harness, rollout, and deliverable.`
          : 'Earlier checkpoints and their rollouts are included as evidence.',
    })
    const { root } = await this.prepareComposeContext({
      runDir,
      label,
      prompt,
      task,
      currentTree,
      runs,
      pool,
      domain,
      decisions,
      sourceIndex,
      sourceRoot,
    })
    await log(`[${label}] compose ${mode}${round ? ` round ${round}` : ''}`)
    let run
    try {
      run = await this.runner.run({
        label,
        purpose: 'compose',
        prompt,
        harness: null,
        workspace: root,
        parentAgent,
        signal,
        timeoutMs: this.config.timeoutMinutes * 60_000,
      })
    } catch (error) {
      await log(`[${label}] compose agent failed: ${error?.message || error}`)
      const notes = `composer agent failed: ${error?.message || error}`
      await this.writeAgentEvidence(runDir, 'compositions', label, {
        notes,
        error: String(error?.message || error),
      })
      return {
        label,
        tree: currentTree,
        notes,
        run: null,
        fellBack: true,
        error: String(error?.message || error),
      }
    }
    const { tree, rejected } = await readTree(path.join(root, 'context', 'harness'))
    const validation = validateTree(tree, { maxAlwaysOnChars: this.config.maxAlwaysOnChars })
    const errors = [...rejected.map((rel) => `off-surface file: ${rel}`), ...validation.errors]
    if (errors.length) {
      await log(`[${label}] composition rejected: ${errors.join('; ')}`)
      const notes = `invalid composition, kept the fallback: ${errors.join('; ')}`
      await this.writeAgentEvidence(runDir, 'compositions', label, {
        run,
        notes,
        error: errors.join('; '),
      })
      return {
        label,
        tree: currentTree,
        notes,
        run,
        fellBack: true,
        error: errors.join('; '),
      }
    }
    const diff = diffTrees(currentTree, tree)
    const notes = parseTag(run.text, 'notes') || run.text || ''
    await log(`[${label}] composed: ${diffSummary(diff)}`)
    await this.writeAgentEvidence(runDir, 'compositions', label, {
      tree,
      run,
      notes,
      diff,
    })
    return {
      label,
      tree,
      notes,
      run,
      diff,
      fellBack: diff.empty,
    }
  }

  async select({ runId, runDir, task, domain, base, baseTree, finals, sourceRoot, parentAgent, signal, log }) {
    const candidates = [
      {
        label: 'base',
        isBase: true,
        tree: baseTree,
        run: base,
        text: digestRun(base),
      },
      ...finals.map((entry) => ({
        label: entry.label,
        isBase: false,
        tree: entry.tree,
        run: entry.run,
        text: digestRun(entry.run),
      })),
    ].filter((entry) => entry.run?.ok || entry.isBase)
    if (!candidates.length) {
      return { winner: null, why: 'no candidate produced a usable result', fallback: true, candidates: [] }
    }
    if (!this.config.selection || candidates.length === 1) {
      const winner =
        candidates.find((entry) => !entry.isBase && entry.run?.ok) ||
        candidates.find((entry) => entry.isBase) ||
        candidates[0]
      return {
        winner,
        why: candidates.length === 1 ? 'only one usable candidate' : 'selection disabled',
        fallback: false,
        candidates: candidates.map((entry) => entry.label),
      }
    }
    const ordered = [...candidates].sort((left, right) =>
      hashPick(`${runId}:${left.label}`).localeCompare(hashPick(`${runId}:${right.label}`)),
    )
    const withIds = ordered.map((entry, index) => ({ ...entry, id: anonId(index) }))
    const prompt = selectPrompt({
      task,
      domain,
      candidates: withIds.map((entry) => ({ id: entry.id, text: entry.text })),
      poolKind: withIds.some((entry) => entry.isBase) ? 'mixed' : 'finals',
    })
    const root = path.join(runDir, 'contexts', 'selector')
    await fs.rm(root, { recursive: true, force: true })
    await fs.mkdir(path.join(root, 'context', 'candidates'), { recursive: true })
    await fs.writeFile(path.join(root, 'MISSION.md'), prompt, 'utf8')
    await fs.writeFile(path.join(root, 'context', 'task.md'), task, 'utf8')
    for (const entry of withIds) {
      await fs.writeFile(
        path.join(root, 'context', 'candidates', `${entry.id}.md`),
        `# Candidate ${entry.id}\n\n${entry.text}\n`,
        'utf8',
      )
    }
    if (sourceRoot) {
      await copySourceExcerpts(sourceRoot, path.join(root, 'context', 'source'), this.walkOptions()).catch(() => {})
    }
    await log(`[selector] comparing ${withIds.length} candidates`)
    let run
    try {
      run = await this.runner.run({
        label: 'selector',
        purpose: 'select',
        prompt,
        harness: null,
        workspace: root,
        parentAgent,
        signal,
        timeoutMs: this.config.timeoutMinutes * 60_000,
      })
    } catch (error) {
      const fallback = withIds.find((entry) => !entry.isBase) || withIds[0]
      await log(`[selector] failed (${error?.message || error}); falling back to ${fallback.label}`)
      return {
        winner: fallback,
        why: `selector agent failed: ${error?.message || error}`,
        fallback: true,
        candidates: withIds.map((entry) => `${entry.id}=${entry.label}`),
      }
    }
    const choice = choiceFrom(run.text)
    const winner = withIds.find((entry) => entry.id === choice)
    if (!winner) {
      const fallback = withIds.find((entry) => !entry.isBase) || withIds[0]
      await log(`[selector] no valid choice ("${choice}"); falling back to ${fallback.label}`)
      return {
        winner: fallback,
        why: parseTag(run.text, 'why') || run.text || 'selector returned no valid choice',
        fallback: true,
        candidates: withIds.map((entry) => `${entry.id}=${entry.label}`),
      }
    }
    await log(`[selector] chose ${winner.label}`)
    return {
      winner,
      why: parseTag(run.text, 'why') || run.text || '',
      fallback: false,
      candidates: withIds.map((entry) => `${entry.id}=${entry.label}`),
    }
  }

  async reflect({
    runId,
    runDir,
    task,
    domain,
    mode,
    k,
    baseTree,
    winner,
    finals,
    candidates = [],
    baseRuns,
    why,
    composerNotes = '',
    parentAgent,
    signal,
    log,
  }) {
    const prompt = reflectPrompt({
      task,
      domain,
      adoptedLabel: winner.label,
      mode,
      k,
      why,
    })
    const root = path.join(runDir, 'contexts', 'reflection')
    await fs.rm(root, { recursive: true, force: true })
    await fs.mkdir(path.join(root, 'context', 'candidates'), { recursive: true })
    await fs.writeFile(path.join(root, 'MISSION.md'), prompt, 'utf8')
    await fs.writeFile(path.join(root, 'context', 'task.md'), task, 'utf8')
    await writeTree(path.join(root, 'context', 'base_harness'), baseTree)
    await writeTree(path.join(root, 'context', 'adopted_harness'), winner.tree)
    for (const run of baseRuns) await this.writeEvidence(path.join(root, 'context'), run)
    const seen = new Set()
    for (const entry of [...candidates, ...finals]) {
      if (!entry || seen.has(entry.label)) continue
      seen.add(entry.label)
      const dir = path.join(root, 'context', 'candidates', safeName(entry.label))
      await writeTree(path.join(dir, 'harness'), entry.tree)
      if (entry.run) {
        await fs.writeFile(path.join(dir, 'rollout.md'), this.rolloutText(entry.run), 'utf8')
        await fs.writeFile(path.join(dir, 'deliverable.md'), renderDeliverable(entry.run), 'utf8')
      }
    }
    await fs.writeFile(
      path.join(root, 'context', 'notes.md'),
      `# Selection\n\n${why || '(no rationale)'}\n\n# Composition\n\n${composerNotes || '(none)'}\n`,
      'utf8',
    )
    await log('[reflection] writing experience record')
    let run
    try {
      run = await this.runner.run({
        label: 'reflection',
        purpose: 'reflect',
        prompt,
        harness: null,
        workspace: root,
        parentAgent,
        signal,
        timeoutMs: this.config.timeoutMinutes * 60_000,
      })
    } catch (error) {
      await log(`[reflection] failed: ${error?.message || error}`)
      return { experience: {}, notes: `reflection failed: ${error?.message || error}`, run: null }
    }
    const experience = parseExperience(run.text)
    return { experience, notes: parseTag(run.text, 'notes') || run.text || '', run }
  }

  async buildContext({ root, prompt, task, harness, runs, domain, sourceIndex, sourceRoot }) {
    await fs.rm(root, { recursive: true, force: true })
    const ctx = path.join(root, 'context')
    await fs.mkdir(path.join(ctx, 'rollouts'), { recursive: true })
    await fs.mkdir(path.join(ctx, 'deliverables'), { recursive: true })
    await fs.writeFile(path.join(root, 'MISSION.md'), prompt, 'utf8')
    await fs.writeFile(path.join(ctx, 'task.md'), task, 'utf8')
    await writeTree(path.join(ctx, 'harness'), harness)
    for (const run of runs) await this.writeEvidence(ctx, run)
    await this.store.copyLibrary(domain, path.join(ctx, 'library'), {
      limit: this.config.libraryEntries,
    })
    if (sourceIndex) {
      await fs.mkdir(path.join(ctx, 'source'), { recursive: true })
      await fs.copyFile(sourceIndex, path.join(ctx, 'source', 'INDEX.md')).catch(() => {})
    }
    if (sourceRoot) {
      await copySourceExcerpts(sourceRoot, path.join(ctx, 'source'), this.walkOptions()).catch(() => {})
    }
    return { root, ctx }
  }

  async prepareComposeContext({
    runDir,
    label,
    prompt,
    task,
    currentTree,
    runs,
    pool,
    domain,
    decisions,
    sourceIndex,
    sourceRoot,
  }) {
    const root = path.join(runDir, 'contexts', safeName(label))
    await fs.rm(root, { recursive: true, force: true })
    const ctx = path.join(root, 'context')
    await fs.mkdir(path.join(ctx, 'rollouts'), { recursive: true })
    await fs.mkdir(path.join(ctx, 'deliverables'), { recursive: true })
    await fs.mkdir(path.join(ctx, 'decisions'), { recursive: true })
    await fs.writeFile(path.join(root, 'MISSION.md'), prompt, 'utf8')
    await fs.writeFile(path.join(ctx, 'task.md'), task, 'utf8')
    await writeTree(path.join(ctx, 'harness'), currentTree)
    for (const run of runs) await this.writeEvidence(ctx, run)
    for (const entry of pool) {
      const dir = path.join(ctx, 'pool', safeName(entry.label))
      await writeTree(path.join(dir, 'harness'), entry.tree)
      await fs.writeFile(path.join(dir, 'rollout.md'), this.rolloutText(entry.run), 'utf8')
      await fs.writeFile(path.join(dir, 'deliverable.md'), renderDeliverable(entry.run), 'utf8')
    }
    for (const [key, value] of Object.entries(decisions || {})) {
      await fs.writeFile(path.join(ctx, 'decisions', `${safeName(key)}.md`), String(value || '') + '\n', 'utf8')
    }
    await this.store.copyLibrary(domain, path.join(ctx, 'library'), {
      limit: this.config.libraryEntries,
    })
    if (sourceIndex) {
      await fs.mkdir(path.join(ctx, 'source'), { recursive: true })
      await fs.copyFile(sourceIndex, path.join(ctx, 'source', 'INDEX.md')).catch(() => {})
    }
    if (sourceRoot) {
      await copySourceExcerpts(sourceRoot, path.join(ctx, 'source'), this.walkOptions()).catch(() => {})
    }
    return { root, ctx }
  }

  async writeAgentEvidence(runDir, kind, label, { tree, run, notes = '', diff = null, dim = '', error = '' }) {
    const dir = path.join(runDir, kind, safeName(label))
    await fs.mkdir(dir, { recursive: true })
    if (tree) await writeTree(path.join(dir, 'harness'), tree)
    if (run) {
      await fs.writeFile(path.join(dir, 'rollout.md'), this.rolloutText(run), 'utf8')
    }
    await fs.writeFile(path.join(dir, 'notes.md'), String(notes || '') + '\n', 'utf8')
    await fs.writeFile(
      path.join(dir, 'meta.json'),
      JSON.stringify(
        {
          label,
          dim,
          diff: diff ? { added: diff.added, removed: diff.removed, modified: diff.modified } : null,
          error,
          run: run ? summariseRun(run) : null,
        },
        null,
        2,
      ) + '\n',
      'utf8',
    )
  }

  async writeEvidence(ctx, run) {
    await fs.mkdir(path.join(ctx, 'rollouts'), { recursive: true })
    await fs.mkdir(path.join(ctx, 'deliverables'), { recursive: true })
    await fs.writeFile(path.join(ctx, 'rollouts', `${safeName(run.label)}.md`), this.rolloutText(run), 'utf8')
    await fs.writeFile(
      path.join(ctx, 'deliverables', `${safeName(run.label)}.md`),
      renderDeliverable(run),
      'utf8',
    )
  }

  rolloutText(run) {
    return [
      `# ${run.label}`,
      '',
      `- stop reason: ${run.stopReasonText || (typeof run.stopReason === 'string' ? run.stopReason : run.stopReason?.kind) || 'unknown'}`,
      `- model: ${run.model || 'unknown'}`,
      `- elapsed: ${Math.round((run.elapsedMs || 0) / 1000)}s`,
      `- changed files: ${run.changes?.files?.length ?? 0}`,
      '',
      '## Final answer',
      '',
      String(run.text ?? '').trim() || '_(no final answer)_',
      '',
      '## Trajectory',
      '',
      String(run.trajectory ?? '').trim() || '_(no trajectory)_',
      '',
    ].join('\n')
  }

  walkOptions() {
    return {
      maxBytes: this.config.maxWorkspaceMB * 1024 * 1024,
      maxFiles: 20_000,
    }
  }

  emit(onProgress, message) {
    const line = `[dsh-harness2] ${message}`
    try {
      console.log(line)
    } catch {}
    try {
      onProgress?.(message)
    } catch {}
  }
}

function anonId(index) {
  let out = ''
  let n = index + 1
  while (n > 0) {
    n -= 1
    out = String.fromCharCode(65 + (n % 26)) + out
    n = Math.floor(n / 26)
  }
  return out
}

function summariseRun(run) {
  if (!run) return { label: '', ok: false, text: '' }
  return {
    label: run.label,
    ok: Boolean(run.ok),
    timedOut: Boolean(run.timedOut),
    stopReason: run.stopReasonText || '',
    elapsedSeconds: Math.round((run.elapsedMs || 0) / 1000),
    changedFiles: run.changes?.files?.length ?? 0,
    finalAnswer: String(run.text ?? '').slice(0, 2_000),
  }
}
