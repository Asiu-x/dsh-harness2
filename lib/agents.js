// Drive DSH child agents as Harness² proposers, composers, probes, and judges.

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { randomUUID, createHash } from 'node:crypto'
import { createUserMessage } from './message.js'
import {
  composeAlwaysOn,
  skillEntries,
  subagentEntries,
  writeTree,
} from './surface.js'
import {
  finalAssistantText,
  lastTurnReason,
  renderTrajectory,
} from './trajectory.js'

export function mapLimit(items, limit, fn) {
  const list = [...items]
  const width = Math.max(1, Math.min(Number(limit) || 1, list.length || 1))
  const results = new Array(list.length)
  let cursor = 0
  let failure
  const worker = async () => {
    while (true) {
      if (failure) return
      const index = cursor++
      if (index >= list.length) return
      try {
        results[index] = await fn(list[index], index)
      } catch (error) {
        failure ||= error
        return
      }
    }
  }
  return Promise.all(Array.from({ length: width }, () => worker())).then(() => {
    if (failure) throw failure
    return results
  })
}

export function parseTag(text, tag) {
  const re = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'i')
  return re.exec(String(text ?? ''))?.[1]?.trim() ?? ''
}

export function parseExperience(text) {
  const raw = parseTag(text, 'experience')
  if (!raw) return {}
  try {
    const value = JSON.parse(raw)
    return value && typeof value === 'object' ? value : {}
  } catch {
    const out = {}
    for (const line of raw.split('\n')) {
      const m = /^\s*[-*]?\s*([A-Za-z]+)\s*:\s*(.+)$/.exec(line)
      if (m) out[m[1].toLowerCase()] = m[2].trim()
    }
    return out
  }
}

/**
 * Install one harness on an agent scope: always-on text as a prompt section and
 * skills into the scoped skill registry. Subagent/script/plugin components are
 * advertised by composeAlwaysOn and read from the resources directory.
 */
export async function installHarness(
  agentCtx,
  tree,
  { resourcesDir = '', maxAlwaysOnChars = 24_000, log = () => {} } = {},
) {
  const text = composeAlwaysOn(tree, {
    resourcesDir,
    maxChars: maxAlwaysOnChars,
  })
  if (text.trim()) {
    agentCtx.systemPrompt.section({
      name: 'harness2:candidate',
      order: 10_050,
      text,
    })
  }
  await fs.writeFile(
    path.join(resourcesDir, 'package.json'),
    '{"type":"module"}',
  )
  for (const rel of Object.keys(tree)
    .filter((n) => /^plugins\/.*\.js$/.test(n))
    .sort()) {
    const module = await import(
      pathToFileURL(path.join(resourcesDir, rel)).href +
        '?sha256=' +
        createHash('sha256').update(tree[rel]).digest('hex')
    )
    if (typeof module.apply !== 'function')
      throw new Error('Hook must export apply: ' + rel)
    const dispose = await module.apply(agentCtx)
    if (typeof dispose === 'function')
      agentCtx.effect(() => dispose, 'harness2 middleware')
  }
  const skills = safeGet(agentCtx, 'skills')
  if (skills) {
    for (const skill of skillEntries(tree)) {
      try {
        skills.register({
          name: skill.name,
          description: skill.data.description || 'on-demand workflow',
          whenToUse: skill.data.whenToUse,
          content: skill.body,
          source: 'runtime',
          resourceBase: {
            kind: 'directory',
            path: path.dirname(path.join(resourcesDir, skill.rel)),
          },
          invocation: { modelInvocable: true, userInvocable: false },
        })
      } catch (error) {
        throw new Error(
          `could not register skill ${skill.name}: ${error?.message || error}`,
        )
      }
    }
  }
}

function safeGet(ctx, name) {
  try {
    return typeof ctx.get === 'function' ? ctx.get(name) : ctx[name]
  } catch {
    return undefined
  }
}

export function approvalPolicyFor(parent, config = {}) {
  if (
    config.approvalPolicy &&
    !['ask', 'never'].includes(config.approvalPolicy)
  )
    throw new Error('Invalid approval policy')
  const service = parent?.ctx?.get?.('approval')
  const inherited =
    service?.overrideOf(parent.session) ?? service?.config?.policy
  return inherited === 'never' || config.approvalPolicy === 'never'
    ? 'never'
    : 'ask'
}

export class AgentRunner {
  constructor({ ctx, config, log }) {
    this.ctx = ctx
    this.config = config
    this.log = log ?? (() => {})
  }

  selection() {
    const service = safeGet(this.ctx, 'agentDefaultModel')
    if (!service?.currentSelection) {
      throw new Error(
        'dsh-harness2 needs the agent-default-model service to choose a model',
      )
    }
    const current = service.currentSelection()
    const provider = this.config.provider || current.provider
    const model = this.config.model || current.model
    const reasoningEffort =
      this.config.reasoningEffort || current.reasoningEffort
    return {
      provider,
      model,
      ...(reasoningEffort ? { reasoningEffort } : {}),
    }
  }

  async run({
    label,
    purpose,
    prompt,
    harness = null,
    workspace,
    parentAgent,
    signal,
    timeoutMs,
    resourcesDir = '',
    route,
  }) {
    const started = Date.now()
    const selection = route || this.selection()
    this.log(
      `[${label}] ${purpose || 'agent'} start (${selection.provider}/${selection.model})`,
    )
    if (signal?.aborted) throw new Error(`[${label}] cancelled before start`)
    let handle
    try {
      handle = await this.ctx.agents.create({
        sessionId: `session-h2-${randomUUID()}`,
        parentAgent,
        meta: {
          cwd: workspace,
          origin: 'subagent',
          delegationDepth:
            (parentAgent?.session?.header?.delegationDepth ?? 0) + 1,
        },
        agentOptions: selection,
        signal,
        setup: async (agentCtx, child) => {
          const parentPolicy = parentAgent?.ctx
            ?.get?.('sandboxPolicy')
            ?.resolve({ session: parentAgent.session })
          const requested = this.config.sandboxMode || 'workspace-write'
          const mode =
            parentPolicy?.mode === 'read-only' ? 'read-only' : requested
          if (!['read-only', 'workspace-write'].includes(mode))
            throw new Error('Full access is not supported')
          child.session.append('sandbox/mode', { mode, source: 'delegation' })
          const approval = approvalPolicyFor(parentAgent, this.config)
          if (!['ask', 'never'].includes(approval))
            throw new Error('Invalid approval policy')
          child.session.append('approval/policy', {
            policy: approval,
            source: 'delegation',
          })
          // schemas() exposes presentation transports, not the inherited capability inventory.
          // Public get() on the unscoped registry selects actual global definitions.
          const inherited = this.ctx.tools
            .schemas()
            .map((t) => t.name)
            .filter(
              (n) =>
                n !== 'run_code' &&
                agentCtx.tools.get(n, child) &&
                this.ctx.tools.get(n),
            )
          const parentAllows = (name) =>
            !parentAgent ||
            Boolean(parentAgent.ctx.tools.get(name, parentAgent))
          const allow = inherited.filter(
            (n) =>
              parentAllows(n) &&
              (!this.config.allowedTools ||
                this.config.allowedTools.includes(n)),
          )
          const deny = ['harness2_refine', 'harness2_reset'].filter((n) =>
            inherited.includes(n),
          )
          agentCtx.tools.restrict({ allow, deny })
          agentCtx.on('agent/pre-step', async (payload, next) => {
            if (payload.step >= (this.config.maxSteps || 200))
              return { kind: 'reject' }
            return next()
          })
          // Internal agents must not inherit the workspace's adopted harness:
          // probes apply the candidate explicitly, and proposers/judges need a
          // neutral view of the evidence.
          try {
            agentCtx.systemPrompt.section({
              name: 'harness2:adopted',
              order: 10_050,
              text: '',
            })
          } catch {}
          if (!harness) return
          if ((child.session.header.delegationDepth || 0) < 3)
            agentCtx.tools.register({
              name: 'harness2_delegate',
              description: 'Delegate one bounded task to a named harness role.',
              parameters: {
                type: 'object',
                properties: {
                  role: { type: 'string' },
                  task: { type: 'string' },
                },
                required: ['role', 'task'],
                additionalProperties: false,
              },
              execute: async (args, exec) => {
                const role = subagentEntries(harness).find(
                  (r) => r.name === args.role,
                )
                if (!role) throw new Error('Unknown role')
                const result = await this.run({
                  label: 'role-' + args.role,
                  purpose: 'delegated role',
                  prompt: role.text + '\n\n' + args.task,
                  harness,
                  workspace,
                  parentAgent: child,
                  signal: exec.signal,
                  timeoutMs,
                  resourcesDir,
                  route: selection,
                })
                if (!result.ok) throw new Error('Delegated role failed')
                return { text: result.text }
              },
              output: {
                schema: {
                  type: 'object',
                  properties: { text: { type: 'string' } },
                  required: ['text'],
                },
                render: (_a, r) => [{ type: 'text', text: r.text }],
              },
            })
          await installHarness(agentCtx, harness, {
            resourcesDir,
            maxAlwaysOnChars: this.config.maxAlwaysOnChars,
            log: this.log,
          })
        },
      })
      const agent = handle.agent
      const startSeq = agent.session.seq
      if (signal?.aborted)
        throw new Error(`[${label}] cancelled during creation`)

      agent.followup(
        createUserMessage({
          content: [{ type: 'text', text: prompt }],
          source: { kind: 'harness2' },
        }),
      )

      const timedOut = await this.waitIdle(agent, timeoutMs, signal)
      const events = agent.session.snapshotEvents
        ? agent.session.snapshotEvents(startSeq)
        : Array.from({ length: agent.session.seq - startSeq }, (_, i) =>
            agent.session.eventAt(startSeq + i),
          )
      const text = finalAssistantText(agent.session, startSeq)
      const trajectory = renderTrajectory(agent.session, startSeq, {
        maxChars: Infinity,
        observationChars: Infinity,
        assistantChars: Infinity,
      })
      const stopReason = lastTurnReason(agent.session, startSeq)
      const reasonText = describeReason(stopReason)
      const ok = !timedOut && !signal?.aborted && reasonText === 'completed'
      this.log(
        `[${label}] done in ${Math.round((Date.now() - started) / 1000)}s · ${ok ? 'ok' : 'not ok'}` +
          `${timedOut ? ' · timeout' : ''}${reasonText ? ` · ${reasonText}` : ''}`,
      )
      return {
        label,
        purpose,
        ok,
        timedOut,
        text,
        trajectory,
        events,
        stopReason,
        stopReasonText: reasonText,
        elapsedMs: Date.now() - started,
        workspace,
        model: `${selection.provider}/${selection.model}`,
      }
    } finally {
      if (handle) {
        try {
          await handle.dispose()
        } catch (error) {
          this.log(`[${label}] dispose failed: ${error?.message || error}`)
        }
      }
    }
  }

  async waitIdle(agent, timeoutMs, signal) {
    const timeout = Math.max(1, Number(timeoutMs) || 60 * 60_000)
    let timer
    let aborted = false
    const onAbort = () => {
      aborted = true
      try {
        agent.cancel({ kind: 'parent' })
      } catch {}
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) onAbort()
    const idle = agent.whenIdle().then(() => 'idle')
    const timeoutPromise = new Promise((resolve) => {
      timer = setTimeout(() => resolve('timeout'), timeout)
    })
    const result = await Promise.race([idle, timeoutPromise])
    clearTimeout(timer)
    if (result === 'timeout' || aborted) {
      try {
        agent.cancel({ kind: 'parent' })
      } catch {}
      await idle
      signal?.removeEventListener('abort', onAbort)
      return true
    }
    signal?.removeEventListener('abort', onAbort)
    return false
  }
}

function describeReason(reason) {
  if (!reason) return ''
  if (typeof reason === 'string') return reason
  if (reason.kind === 'error') return 'error'
  if (reason.kind === 'aborted') return 'aborted'
  return String(reason.kind || '')
}

/** Materialise a harness for a probe and return its absolute resources path. */
export async function materialiseResources(workspace, label, tree) {
  const fingerprint = createHash('sha256')
    .update(
      JSON.stringify(
        Object.entries(tree).sort(([a], [b]) => a.localeCompare(b)),
      ),
    )
    .digest('hex')
  const dir = `${workspace.replace(/[\\/]+$/, '')}/.harness2-probe/${label}/harness-${fingerprint}`
  await writeTree(dir, tree)
  return dir
}
