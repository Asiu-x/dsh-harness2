// Drive DSH child agents as Harness² proposers, composers, probes, and judges.

import { randomUUID } from 'node:crypto'
import { createUserMessage } from './message.js'
import { composeAlwaysOn, skillEntries, writeTree } from './surface.js'
import { finalAssistantText, lastTurnReason, renderTrajectory } from './trajectory.js'

const PLUGIN = 'dsh-harness2'

export function mapLimit(items, limit, fn) {
  const list = [...items]
  const width = Math.max(1, Math.min(Number(limit) || 1, list.length || 1))
  const results = new Array(list.length)
  let cursor = 0
  const worker = async () => {
    while (true) {
      const index = cursor++
      if (index >= list.length) return
      results[index] = await fn(list[index], index)
    }
  }
  return Promise.all(Array.from({ length: width }, () => worker())).then(() => results)
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
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
export function installHarness(agentCtx, tree, { resourcesDir = '', maxAlwaysOnChars = 12_000, log = () => {} } = {}) {
  const text = composeAlwaysOn(tree, { resourcesDir, maxChars: maxAlwaysOnChars })
  if (text.trim()) {
    agentCtx.systemPrompt.section({
      name: 'harness2:candidate',
      order: 10_050,
      text,
    })
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
          invocation: { modelInvocable: true, userInvocable: false },
        })
      } catch (error) {
        log(`could not register skill ${skill.name}: ${error?.message || error}`)
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

export class AgentRunner {
  constructor({ ctx, config, log }) {
    this.ctx = ctx
    this.config = config
    this.log = log ?? (() => {})
  }

  selection() {
    const service = safeGet(this.ctx, 'agentDefaultModel')
    if (!service?.currentSelection) {
      throw new Error('dsh-harness2 needs the agent-default-model service to choose a model')
    }
    const current = service.currentSelection()
    const provider = this.config.provider || current.provider
    const model = this.config.model || current.model
    const reasoningEffort = this.config.reasoningEffort || current.reasoningEffort
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
  }) {
    const started = Date.now()
    const selection = this.selection()
    this.log(`[${label}] ${purpose || 'agent'} start (${selection.provider}/${selection.model})`)
    if (signal?.aborted) throw new Error(`[${label}] cancelled before start`)
    let handle
    try {
      handle = await this.ctx.agents.create({
        sessionId: `session-h2-${randomUUID()}`,
        parentAgent,
        meta: {
          cwd: workspace,
          origin: 'subagent',
          delegationDepth: (parentAgent?.session?.header?.delegationDepth ?? 0) + 1,
        },
        agentOptions: selection,
        signal,
        setup: (agentCtx) => {
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
          installHarness(agentCtx, harness, {
            resourcesDir,
            maxAlwaysOnChars: this.config.maxAlwaysOnChars,
            log: this.log,
          })
        },
      })
      const agent = handle.agent
      const startSeq = agent.session.seq
      if (signal?.aborted) throw new Error(`[${label}] cancelled during creation`)

      agent.followup(
        createUserMessage({
          content: [{ type: 'text', text: prompt }],
          source: { kind: 'plugin', plugin: PLUGIN },
        }),
      )

      const timedOut = await this.waitIdle(agent, timeoutMs, signal)
      const text = finalAssistantText(agent.session, startSeq)
      const trajectory = renderTrajectory(agent.session, startSeq)
      const stopReason = lastTurnReason(agent.session, startSeq)
      const reasonText = describeReason(stopReason)
      const ok = !timedOut && !signal?.aborted && reasonText !== 'error'
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
    const timeout = Math.max(60_000, Number(timeoutMs) || 20 * 60_000)
    let timer
    let aborted = false
    const onAbort = () => {
      aborted = true
      try {
        agent.cancel({ kind: 'parent' })
      } catch {}
    }
    signal?.addEventListener('abort', onAbort, { once: true })
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
      await Promise.race([idle, sleep(10_000).then(() => 'grace-timeout')])
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
  const dir = `${workspace.replace(/[\\/]+$/, '')}/.harness2-probe/${label}/harness`
  await writeTree(dir, tree)
  return dir
}
