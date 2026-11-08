// Google Harness² method port, reference 6868817. Apache-2.0; native DSH substrate.
import { promises as fs } from 'node:fs'
import path from 'node:path'
import {
  AgentRunner,
  approvalPolicyFor,
  mapLimit,
  parseTag,
  parseExperience,
  materialiseResources,
} from './agents.js'
import { readTree, writeTree, seedTree, diffTrees } from './surface.js'
import { stagePrompt } from './prompts.js'
import {
  autoTrigger,
  validateExecutableTree,
  assertEvidence,
  assertEvidenceDirectory,
} from './validation.js'
import {
  loadTask,
  writeFiles,
  deliverable,
  digest,
  identifier,
} from './task.js'
import { ExperimentStore, hasExperience } from './store.js'
import { assignIds, assignIdsAsync } from './ordering.js'

export const REFERENCE = '6868817518876de8fd170c6a8354daca273b6191'
export class Harness2Runtime {
  constructor(ctx, config = {}, options = {}) {
    this.ctx = ctx
    this.config = {
      maxK: 5,
      concurrency: 2,
      timeoutMinutes: 60,
      maxSteps: 200,
      maxAlwaysOnChars: 24000,
      maxWorkspaceMB: 50,
      sandboxMode: 'workspace-write',
      ...config,
    }
    this.workspace = path.resolve(config.workspace || process.cwd())
    this.runner =
      options.runner ||
      new AgentRunner({ ctx, config: this.config, log: options.log })
    this.ready = Promise.resolve()
  }
  routes() {
    const current = this.ctx.agentDefaultModel?.currentSelection?.() || {
      provider: 'unconfigured',
      model: 'unconfigured',
    }
    return {
      executor: this.config.executor || current,
      editor: this.config.editor || current,
      selector: this.config.selector || this.config.editor || current,
    }
  }
  async refine({
    manifest,
    workspace = this.workspace,
    k = 1,
    mode = 'sequential',
    parentAgent,
    signal,
    seed = 0,
  }) {
    if (!Number.isInteger(k) || k < 1 || k > this.config.maxK)
      throw new Error('Invalid k')
    if (!['parallel', 'sequential'].includes(mode))
      throw new Error('Invalid mode')
    if (!Number.isSafeInteger(seed)) throw new Error('Invalid seed')
    signal?.throwIfAborted()
    workspace = await fs.realpath(workspace)
    const { task, files, inputFingerprint } = await loadTask(
      manifest,
      workspace,
      this.config,
    )
    let h0 = await seedTree()
    if (this.config.baseHarnessDir) {
      const loaded = await readTree(
        path.resolve(workspace, this.config.baseHarnessDir),
      )
      if (loaded.rejected.length) throw new Error('Off-surface H0 files')
      h0 = { ...h0, ...loaded.tree }
    }
    const h0Validation = await validateExecutableTree(h0, this.config)
    if (!h0Validation.ok) throw new Error(h0Validation.errors.join('; '))
    const routes = this.routes()
    const effectiveMode =
      parentAgent?.ctx
        ?.get?.('sandboxPolicy')
        ?.resolve({ session: parentAgent.session })?.mode === 'read-only'
        ? 'read-only'
        : this.config.sandboxMode
    const settings = {
      reference: REFERENCE,
      portVersion: '0.2.4',
      maxAlwaysOnChars: this.config.maxAlwaysOnChars,
      python: this.config.python || 'python3',
      parentTools:
        parentAgent && this.ctx.tools
          ? this.ctx.tools
              .schemas()
              .map((t) => t.name)
              .filter(
                (n) =>
                  n !== 'run_code' && parentAgent.ctx.tools.get(n, parentAgent),
              )
              .sort()
          : null,
      k,
      mode,
      seed,
      routes,
      sandboxMode: effectiveMode,
      approvalPolicy: approvalPolicyFor(parentAgent, this.config),
      maxSteps: this.config.maxSteps,
      timeoutMinutes: this.config.timeoutMinutes,
      allowedTools: this.config.allowedTools || null,
    }
    const store = new ExperimentStore(workspace, task.experiment, settings)
    const release = await store.lock()
    try {
      await store.initialize(h0)
      const runDir = store.runDir(task)
      const resultFile = path.join(runDir, 'result.json')
      try {
        const old = JSON.parse(await fs.readFile(resultFile, 'utf8'))
        if (old.inputFingerprint !== inputFingerprint)
          throw new Error('Task inputs changed; use a new task id')
        if (!old.ok)
          throw new Error(
            'Prior run incomplete/failed; use a new task id after inspecting evidence',
          )
        // Artifacts are part of the cached outcome, not merely a status flag.
        for (const record of old.runs) {
          const artifact = await deliverable(record.workspace, task)
          if (digest(artifact) !== record.artifactFingerprint)
            throw new Error('Cached artifacts changed; use a new task id')
        }
        if (
          digest(
            (await readTree(path.join(runDir, 'harnesses', old.winner))).tree,
          ) !== old.harnessFingerprint
        )
          throw new Error('Cached harness changed')
        if (hasExperience(old.experience)) {
          await store.add(
            old.domain,
            old.task,
            (await readTree(path.join(runDir, 'harnesses', old.winner))).tree,
            old.experience,
            { winner: old.winner },
          )
          old.libraryAdded = true
          await store.atomic(resultFile, old)
        }
        return { ...old, resumed: true }
      } catch (e) {
        if (e.code !== 'ENOENT') throw e
      }
      await fs.mkdir(path.dirname(runDir), { recursive: true })
      try {
        await fs.mkdir(runDir)
      } catch (e) {
        if (e.code === 'EEXIST')
          throw new Error(
            'Interrupted run exists; inspect it and use a new task id',
          )
        throw e
      }
      await writeFiles(path.join(runDir, 'source'), files)
      const runs = [],
        stages = [],
        history = [],
        decisions = {}
      const call = async (
        purpose,
        label,
        root,
        prompt,
        harness = null,
        onAttempt = () => {},
      ) => {
        signal?.throwIfAborted()
        const resourcesDir = harness
          ? await materialiseResources(root, label, harness)
          : ''
        let result
        for (
          let transport = 1;
          transport <= (purpose === 'probe' ? 1 : 2);
          transport++
        ) {
          signal?.throwIfAborted()
          onAttempt()
          try {
            const executionRoot =
              purpose === 'probe'
                ? root
                : path.join(
                    runDir,
                    'transport',
                    `${label}.transport${transport}`,
                  )
            if (purpose !== 'probe') {
              await fs.mkdir(path.dirname(executionRoot), { recursive: true })
              await fs.cp(root, executionRoot, {
                recursive: true,
                force: false,
                errorOnExist: true,
                dereference: false,
              })
            }
            result = await this.runner.run({
              purpose,
              label,
              prompt,
              harness,
              workspace: executionRoot,
              resourcesDir,
              parentAgent,
              signal,
              route:
                routes[
                  purpose === 'probe'
                    ? 'executor'
                    : purpose === 'select' || purpose === 'reflect'
                      ? 'selector'
                      : 'editor'
                ],
              timeoutMs: this.config.timeoutMinutes * 60000,
            })
          } catch (error) {
            signal?.throwIfAborted()
            result = {
              ok: false,
              text: '',
              events: [],
              trajectory: '',
              error: error.message,
            }
          }
          result.transportAttempts = transport
          if (result.ok && ['INV', 'DOM', 'compose'].includes(purpose)) {
            const harvested = await readTree(
              path.join(
                runDir,
                'transport',
                `${label}.transport${transport}`,
                'context/harness',
              ),
            )
            if (!Object.keys(harvested.tree).length)
              result.harvestMissing = true
            else {
              await writeTree(
                path.join(root, 'context/harness'),
                harvested.tree,
              )
              result.rejectedCandidateFiles = harvested.rejected
            }
          }
          signal?.throwIfAborted()
          await store.atomic(
            path.join(runDir, 'agents', label + `.transport${transport}.json`),
            result,
          )
          if (result.ok) break
        }
        return result
      }
      const probe = async (label, tree) => {
        const root = path.join(runDir, 'workspaces', label)
        await fs.mkdir(root, { recursive: true })
        await writeFiles(root, files)
        await writeTree(path.join(runDir, 'harnesses', label), tree)
        let result
        try {
          result = await call('probe', label, root, task.instruction, tree)
        } catch (e) {
          signal?.throwIfAborted()
          result = {
            ok: false,
            text: '',
            trajectory: '',
            events: [],
            error: e.message,
          }
        }
        let artifact
        try {
          artifact = await deliverable(root, task)
        } catch (e) {
          artifact = { delivered: false, text: '', files: {}, error: e.message }
        }
        const record = {
          ...result,
          label,
          workspace: root,
          tree,
          ...artifact,
          artifactFingerprint: digest(artifact),
        }
        runs.push(record)
        return record
      }
      const context = async (
        label,
        tree,
        evidence,
        pool = [],
        decisionView = {},
      ) => {
        const root = path.join(runDir, 'contexts', label)
        const dir = path.join(root, 'context')
        await fs.mkdir(dir, { recursive: true })
        await writeFiles(dir, { 'task.md': task.instruction })
        await writeFiles(path.join(dir, 'source'), files)
        await writeTree(path.join(dir, 'harness'), tree)
        await store.copyLibrary(task.domain, path.join(dir, 'library'))
        for (const r of evidence) {
          assertEvidence({ 'trajectory.md': r.trajectory || '', ...r.files })
          await writeFiles(dir, {
            [`rollouts/${r.label}.md`]: r.trajectory || r.error || '',
            [`deliverables/${r.label}.md`]: r.text || '',
          })
        }
        for (const entry of pool) {
          await writeTree(
            path.join(dir, 'pool', entry.label, 'harness'),
            entry.tree,
          )
          await writeFiles(path.join(dir, 'pool', entry.label), {
            'rollout.md': entry.run?.trajectory || '',
            'deliverable.md': entry.run?.text || '',
          })
        }
        for (const [name, notes] of Object.entries(decisionView))
          await writeFiles(path.join(dir, 'decisions'), {
            [name + '.md']: notes,
          })
        await assertEvidenceDirectory(root)
        return root
      }
      const stage = async (
        purpose,
        label,
        tree,
        evidence,
        pool = [],
        dim = '',
        round = 1,
        index = 1,
        decisionView = {},
      ) => {
        let root
        try {
          root = await context(label, tree, evidence, pool, decisionView)
        } catch (error) {
          signal?.throwIfAborted()
          const entry = {
            label,
            dim,
            tree: structuredClone(tree),
            notes: '',
            error: 'could not build evidence: ' + error.message,
            executionFailed: false,
            attempts: 0,
            fellBack: true,
          }
          stages.push(entry)
          decisions[label] = entry.error
          return entry
        }
        let error = '',
          candidate = tree,
          notes = '',
          executionFailed = false,
          attempts = 0
        const mission = stagePrompt(
          purpose === 'compose' ? 'compose' : 'propose',
          { task: task.instruction, k, mode, round, index, dim },
        )
        for (let attempt = 1; attempt <= 2; attempt++) {
          const prompt =
            mission +
            '\n\n# YOUR EVIDENCE\nRead context/task.md, context/source/, context/rollouts/, context/deliverables/, context/harness/, context/pool/, context/library/ and context/decisions/ when present.' +
            (error
              ? `\n\n# YOUR PREVIOUS ATTEMPT WAS REJECTED\n${error}\nFix it in context/harness/ and reply again.`
              : '')
          await writeFiles(root, { 'MISSION.md': prompt })
          let result
          try {
            result = await call(
              purpose === 'compose' ? 'compose' : dim,
              label + `.a${attempt}`,
              root,
              prompt,
              null,
              () => {
                attempts++
              },
            )
          } catch (e) {
            signal?.throwIfAborted()
            executionFailed = true
            error = e.message
            break
          }
          if (!result.ok) {
            executionFailed = true
            error = result.error || 'Stage execution failed'
            break
          }
          if (result.harvestMissing) {
            error = 'The harness directory did not return a nonempty tree'
            continue
          }
          const read = await readTree(path.join(root, 'context/harness'))
          candidate = autoTrigger(read.tree)
          const validated = await validateExecutableTree(candidate, this.config)
          error = [
            ...[...read.rejected, ...(result.rejectedCandidateFiles || [])].map(
              (n) => 'off-surface ' + n,
            ),
            ...validated.errors,
          ].join('; ')
          if (!Object.keys(candidate).length) error = 'Empty harness tree'
          await writeTree(path.join(root, 'context/harness'), candidate)
          if (!error) {
            notes = parseTag(result.text, 'notes') || result.text
            break
          }
        }
        const entry = {
          label,
          dim,
          tree: error ? structuredClone(tree) : candidate,
          notes,
          error,
          executionFailed,
          attempts,
          fellBack: Boolean(error),
        }
        stages.push(entry)
        decisions[label] = notes || error
        return entry
      }
      const bases = await mapLimit(
        Array.from({ length: k }, (_, i) => i + 1),
        this.config.concurrency,
        (i) => probe(`base${i}`, h0),
      )
      if (!bases.some((b) => b.ok)) {
        const result = {
          version: 2,
          reference: REFERENCE,
          experiment: task.experiment,
          task: task.id,
          domain: task.domain,
          k,
          mode,
          seed,
          inputFingerprint,
          h0Fingerprint: digest(h0),
          ok: false,
          status: 'base-failed',
          selectionOk: false,
          selectionFallback: false,
          error: 'no base rollout produced anything',
          winner: null,
          experience: {},
          libraryAdded: false,
          runDir,
          settings,
          stages: [],
          runs: runs.map(({ tree, files, events, trajectory, ...r }) => r),
        }
        await store.atomic(resultFile, result)
        return result
      }
      let finals = []
      if (mode === 'sequential') {
        let current = structuredClone(h0)
        for (let round = 1; round <= k; round++) {
          const evidence = bases
          const proposalDecisions = { ...decisions }
          const priorPool = history.flatMap((e) => [...e.proposals, e.composed])
          const proposals = await mapLimit(
            ['INV', 'DOM'],
            this.config.concurrency,
            async (dim) => {
              return stage(
                'propose',
                `${dim.toLowerCase()}${round}`,
                current,
                evidence,
                priorPool,
                dim,
                round,
                round,
                proposalDecisions,
              )
            },
          )
          await mapLimit(proposals, this.config.concurrency, async (e) => {
            e.run = await probe(e.label, e.tree)
          })
          const composed = await stage(
            'compose',
            `c${round}`,
            current,
            evidence,
            history
              .flatMap((e) => [...e.proposals, e.composed])
              .concat(proposals),
            '',
            round,
            1,
            { ...decisions },
          )
          composed.run = await probe(composed.label, composed.tree)
          history.push({ proposals, composed })
          current = composed.tree
          finals.push(composed)
        }
      } else {
        const specs = Array.from({ length: k }, (_, i) => i + 1).flatMap(
          (index) => ['INV', 'DOM'].map((dim) => ({ index, dim })),
        )
        const pool = await mapLimit(
          specs,
          this.config.concurrency,
          async ({ index, dim }) => {
            return stage(
              'propose',
              `${dim.toLowerCase()}${index}`,
              h0,
              bases,
              [],
              dim,
              1,
              index,
              {},
            )
          },
        )
        await mapLimit(pool, this.config.concurrency, async (e) => {
          e.run = await probe(e.label, e.tree)
        })
        const aggregateDecisions = { ...decisions }
        finals = await mapLimit(
          Array.from({ length: k }, (_, i) => i + 1),
          this.config.concurrency,
          async (index) => {
            const entry = await stage(
              'compose',
              `agg${index}`,
              h0,
              bases,
              pool,
              '',
              1,
              index,
              aggregateDecisions,
            )
            return entry
          },
        )
        await mapLimit(finals, this.config.concurrency, async (e) => {
          e.run = await probe(e.label, e.tree)
        })
      }
      // Only delivered finals enter the selector. Baselines never enter its pool.
      const pool = finals.filter((e) => e.run.ok && e.run.delivered)
      let selection = {
        ok: false,
        fallback: false,
        winner: null,
        error: 'no candidate produced an artifact',
        trivial: k === 1,
      }
      if (pool.length && k === 1)
        selection = {
          ok: true,
          fallback: false,
          winner: pool[0],
          trivial: true,
        }
      else if (pool.length) {
        const root = path.join(runDir, 'contexts', 'selector')
        await writeFiles(path.join(root, 'context'), {
          'task.md': task.instruction,
        })
        await writeFiles(path.join(root, 'context/source'), files)
        // Stable deterministic identity; actual oracle compares outcomes independent of opaque ID permutation.
        const labels = pool.map((e) => e.label)
        const ids = this.config.assignIdsScript
          ? await assignIdsAsync({
              labels,
              task: task.id,
              k,
              mode: mode === 'parallel' ? 'agg' : 'seq',
              scriptPath: this.config.assignIdsScript,
              python: this.config.python,
            })
          : assignIds({
              labels,
              task: task.id,
              k,
              mode: mode === 'parallel' ? 'agg' : 'seq',
            })
        const anon = (i) => {
          let n = i + 1,
            s = ''
          while (n) {
            n--
            s = String.fromCharCode(65 + (n % 26)) + s
            n = Math.floor(n / 26)
          }
          return s
        }
        const mapping = Object.fromEntries(
          ids.map((label, i) => [anon(i), pool.find((e) => e.label === label)]),
        )
        for (const [id, e] of Object.entries(mapping))
          await writeFiles(path.join(root, 'context/candidates'), {
            [id + '.md']: e.run.text,
          })
        const prompt = stagePrompt('select', {
          task: task.instruction,
          index: pool.length,
        })
        await writeFiles(root, { 'MISSION.md': prompt })
        try {
          const response = await call('select', 'selector', root, prompt)
          const choice = /```choice\s*\n?\s*([A-Za-z0-9_-]+)\s*\n?```/.exec(
            response.text,
          )?.[1]
          if (!response.ok || !mapping[choice])
            throw new Error('Invalid selector response')
          selection = {
            ok: true,
            fallback: false,
            winner: mapping[choice],
            why: parseTag(response.text, 'why'),
            idMap: Object.fromEntries(
              Object.entries(mapping).map(([id, e]) => [id, e.label]),
            ),
          }
        } catch (e) {
          signal?.throwIfAborted()
          selection = {
            ok: false,
            fallback: true,
            winner: [...pool].sort((a, b) => a.label.localeCompare(b.label))[0],
            error: e.message,
          }
        }
      }
      let experience = {},
        libraryAdded = false
      let reflectionError = ''
      const winner = selection.winner
      if (selection.ok && winner) {
        try {
          const root = await context(
            'reflection',
            winner.tree,
            runs,
            stages.filter((e) => e.run),
            { ...decisions },
          )
          await writeTree(path.join(root, 'context/base_harness'), h0)
          await writeFiles(path.join(root, 'context'), {
            'adoption.json': JSON.stringify({
              winner: winner.label,
              why: selection.why || '',
              idMap: selection.idMap || {},
            }),
          })
          const prompt = stagePrompt('reflect', { task: task.instruction })
          await writeFiles(root, { 'MISSION.md': prompt })
          try {
            const response = await call('reflect', 'reflection', root, prompt)
            if (!response.ok)
              throw new Error(response.error || 'reflection transport failed')
            {
              experience = parseExperience(response.text)
              experience.edits = parseTag(response.text, 'edits')
              assertEvidence({ 'EXPERIENCE.md': JSON.stringify(experience) })
            }
          } catch (e) {
            signal?.throwIfAborted()
            reflectionError = 'reflection failed: ' + (e.message || String(e))
            experience = {}
          }
        } catch (error) {
          signal?.throwIfAborted()
          reflectionError = error.message
          experience = {}
        }
      }
      const result = {
        version: 2,
        reference: REFERENCE,
        experiment: task.experiment,
        task: task.id,
        domain: task.domain,
        k,
        mode,
        seed,
        inputFingerprint,
        h0Fingerprint: digest(h0),
        ok:
          selection.ok &&
          !stages.some((s) => s.executionFailed) &&
          !reflectionError,
        selectionOk: selection.ok,
        selectionFallback: selection.fallback,
        error: selection.error || reflectionError || '',
        winner: winner?.label || null,
        harnessFingerprint: winner ? digest(winner.tree) : null,
        experience,
        libraryAdded,
        runDir,
        settings,
        stages: stages.map(({ tree, run, ...entry }) => entry),
        runs: runs.map(({ tree, files, events, trajectory, ...r }) => r),
      }
      await store.atomic(resultFile, result)
      if (selection.ok && hasExperience(experience)) {
        result.libraryAdded = await store.add(
          task.domain,
          task.id,
          winner.tree,
          experience,
          { winner: winner.label, why: selection.why || '' },
        )
        await store.atomic(resultFile, result)
      }
      return result
    } finally {
      await release()
    }
  }
  async status({ workspace = this.workspace, experiment }) {
    const root = path.join(
      workspace,
      '.dsh-harness2-v2',
      identifier(experiment),
    )
    try {
      return JSON.parse(
        await fs.readFile(path.join(root, 'experiment.json'), 'utf8'),
      )
    } catch (e) {
      if (e.code === 'ENOENT') return { version: 2, exists: false }
      throw e
    }
  }
  async reset({ workspace = this.workspace, experiment, confirm }) {
    if (confirm !== true) throw new Error('confirm: true is required')
    const root = path.join(
      workspace,
      '.dsh-harness2-v2',
      identifier(experiment),
    )
    const archive = root + '.archive-' + Date.now()
    const lock = await fs.open(path.join(root, 'run.lock'), 'wx')
    let moved = false
    try {
      await fs.rename(root, archive)
      moved = true
      return { archive }
    } finally {
      await lock.close()
      await fs.rm(path.join(moved ? archive : root, 'run.lock'))
    }
  }
}
