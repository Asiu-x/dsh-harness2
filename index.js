// dsh-harness2 — Harness² recursive agent harnessing for DeepSeek Harness.
//
// Registers three model tools and a /harness2 command:
//   harness2_refine  run Propose–Probe–Compose, select, reflect, adopt
//   harness2_status  inspect the adopted harness and domain library
//   harness2_reset   archive and restore the seed harness
//
// Apache-2.0. The method comes from google-research/harness2
// ("Harness²: Recursive Agent Harnessing for an Open World", arXiv:2610.14224).

import path from 'node:path'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { Harness2Runtime } from './lib/harness2.js'
import { Store } from './lib/store.js'
import { DEFAULT_MAX_ALWAYS_ON_CHARS } from './lib/surface.js'

export const name = 'dsh-harness2'

export const inject = ['agents', 'agentDefaultModel', 'systemPrompt', 'tools']

export const Config = z.object({
  workspace: z.string().default(''),
  dataDir: z.string().default('.dsh-harness2'),
  maxAlwaysOnChars: z.number().default(DEFAULT_MAX_ALWAYS_ON_CHARS),
  maxK: z.number().default(3),
  mode: z.string().default('sequential'),
  concurrency: z.number().default(2),
  timeoutMinutes: z.number().default(20),
  toolTimeoutMinutes: z.number().default(120),
  maxWorkspaceMB: z.number().default(50),
  workspaceIsolation: z.string().default('copy'),
  selection: z.boolean().default(true),
  reflection: z.boolean().default(true),
  libraryLessons: z.number().default(3),
  libraryEntries: z.number().default(8),
  model: z.string().default(''),
  provider: z.string().default(''),
  reasoningEffort: z.string().default(''),
})

function log(message) {
  try {
    console.log(`[dsh-harness2] ${message}`)
  } catch {}
}

function summaryText(value) {
  const lines = [
    value.adopted
      ? `Adopted \`${value.winner}\` as the current Harness² harness.`
      : 'Kept the current harness; no candidate beat the base in selection.',
    '',
    `- run: \`${value.runId}\``,
    `- mode: ${value.mode}, k: ${value.k}, domain: ${value.domain}`,
    `- harness: ${value.harness}`,
    `- winner: ${value.winner || 'none'}${value.winnerIsBase ? ' (base)' : ''}`,
    `- proof: \`${value.progressLog}\``,
  ]
  if (value.why) lines.push('', `Why: ${value.why}`)
  if (value.experience?.cue) lines.push('', `Lesson cue: ${value.experience.cue}`)
  if (value.experience?.lesson) lines.push(`Lesson: ${value.experience.lesson}`)
  lines.push('', `Inspect the run at \`${value.runDir}\`.`)
  return lines.join('\n')
}

function asString(value) {
  return String(value ?? '').trim()
}

export function apply(ctx, rawConfig) {
  const config = rawConfig ?? {}
  const runtime = new Harness2Runtime(ctx, config, { log })
  runtime.ready.catch((error) => log(`init failed: ${error?.message || error}`))

  // The adopted harness is a dynamic prompt section: after adoption the next
  // model step sees it, including lessons from the domain library.
  ctx.effect(
    () =>
      ctx.systemPrompt.section({
        name: 'harness2:adopted',
        order: 10_050,
        text: () => runtime.adoptedText,
      }),
    'dsh-harness2: adopted harness section',
  )

  ctx.tools.register(
    defineTool({
      name: 'harness2_refine',
      description:
        'Refine the current workspace harness with Harness² (Google Research): run baseline probes, propose invariant and domain edits, probe them on the same task, compose an improved harness, select an output anonymously, and reflect the lesson into a per-domain library. This spawns several real child agents and can be expensive; k=1 is the default.',
      parameters: {
        task: {
          type: 'string',
          required: true,
          description:
            'The representative task to refine on. It is run several times in isolated copies of the workspace.',
        },
        domain: {
          type: 'string',
          description: 'Library domain, e.g. "legal", "procurement", "data-analysis". Defaults to general.',
        },
        k: {
          type: 'number',
          description: 'Task-level recursion budget, 1–3. 1 is one Propose–Probe–Compose step.',
        },
        mode: {
          type: 'string',
          enum: ['sequential', 'parallel'],
          description:
            'sequential refines deeper; parallel explores wider with 2k candidates and k compositions.',
        },
        isolation: {
          type: 'string',
          enum: ['copy', 'shared'],
          description:
            'copy runs each probe in a fresh copy of the workspace (default and safest). shared runs in place and can interfere.',
        },
        workspace: {
          type: 'string',
          description:
            'Workspace to refine. Defaults to the session workspace. A different directory switches this plugin instance to that workspace for later status/reset calls.',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            runId: { type: 'string', required: true },
            adopted: { type: 'boolean', required: true },
            winner: { type: 'string' },
            winnerIsBase: { type: 'boolean' },
            mode: { type: 'string' },
            k: { type: 'integer' },
            domain: { type: 'string' },
            harness: { type: 'string' },
            why: { type: 'string' },
            runDir: { type: 'string' },
            progressLog: { type: 'string' },
            summary: { type: 'string', required: true },
          },
        },
        render: (_args, value) => [{ type: 'text', text: value.summary }],
        presentationMeta: (_args, value) => ({
          runId: value.runId,
          adopted: value.adopted,
          winner: value.winner,
          runDir: value.runDir,
        }),
      },
      timeoutMs: Math.max(1, Number(config.toolTimeoutMinutes) || 120) * 60_000,
      isConcurrencySafe: () => false,
      async execute(args, exec) {
        await runtime.ready
        const task = asString(args.task)
        if (!task) throw new Error('`task` is required')
        const requestedWorkspace = asString(args.workspace)
        if (requestedWorkspace) {
          const target = path.resolve(requestedWorkspace)
          if (target !== runtime.workspace) {
            log(`switching plugin workspace to ${target}`)
            runtime.workspace = target
            runtime.store = new Store(path.resolve(target, runtime.config.dataDir), {
              maxAlwaysOnChars: runtime.config.maxAlwaysOnChars,
            })
            await runtime.store.ensure()
            await runtime.refreshAdopted()
          }
        }
        const summary = await runtime.refine({
          task,
          domain: asString(args.domain) || 'general',
          k: args.k,
          mode: asString(args.mode) || runtime.config.mode,
          isolation: asString(args.isolation),
          parentAgent: exec.agent,
          signal: exec.signal,
        })
        const text = summaryText(summary)
        if (summary.adopted && runtime.adoptedText) {
          try {
            exec.deferContext(
              createUserMessage({
                content: [
                  {
                    type: 'text',
                    text:
                      `# Harness² adoption\n\nThe workspace harness was refined and adopted (\`${summary.winner}\`). ` +
                      'The following standing harness context applies to subsequent work in this session; ' +
                      'do not repeat this message, just apply it.\n\n' +
                      runtime.adoptedText,
                  },
                ],
                source: { kind: 'plugin', plugin: 'dsh-harness2' },
              }),
            )
          } catch (error) {
            log(`could not defer adopted harness context: ${error?.message || error}`)
          }
        }
        return {
          runId: summary.runId,
          adopted: summary.adopted,
          winner: summary.winner || '',
          winnerIsBase: summary.winnerIsBase,
          mode: summary.mode,
          k: summary.k,
          domain: summary.domain,
          harness: summary.harness,
          why: summary.why || '',
          runDir: summary.runDir,
          progressLog: summary.progressLog,
          summary: text,
        }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'harness2_status',
      description:
        'Show the adopted Harness² harness, its components, the per-domain experience library, and the latest run.',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            adopted: { type: 'boolean' },
            text: { type: 'string', required: true },
          },
        },
        render: (_args, value) => [{ type: 'text', text: value.text }],
      },
      async execute() {
        await runtime.ready
        const status = await runtime.status()
        const lines = [
          status.adopted
            ? `Adopted harness: yes (${status.adoptedAt || 'unknown time'}, domain: ${status.domain})`
            : 'Adopted harness: no — the seed harness is present but not active.',
          `Harness: \`${status.harness.dir}\` · ${status.harness.inventory}`,
          `Data: \`${status.dataDir}\``,
        ]
        if (status.latestRun) lines.push(`Latest run: ${status.latestRun}`)
        lines.push('', `Library (${status.domain}): ${status.library.length} entr${status.library.length === 1 ? 'y' : 'ies'}`)
        for (const entry of status.library.slice(-8)) {
          lines.push(`- \`${entry.id}\` — ${entry.cue || entry.lesson || entry.inventory}`)
        }
        return { adopted: status.adopted, text: lines.join('\n') }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'harness2_reset',
      description:
        'Archive the adopted Harness² harness into the library and restore the seed harness. Requires confirm=true.',
      parameters: {
        confirm: {
          type: 'boolean',
          required: true,
          description: 'Must be true; the current harness is archived before it is replaced.',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            text: { type: 'string', required: true },
          },
        },
        render: (_args, value) => [{ type: 'text', text: value.text }],
      },
      async execute(args) {
        if (args.confirm !== true) throw new Error('Set `confirm: true` to archive and reset the harness')
        await runtime.ready
        const result = await runtime.reset()
        return {
          text: `Reset to the seed harness. Archived previous harness (${result.archivedInventory}).`,
        }
      },
    }),
  )

  ctx.inject(['commands'], (commandCtx) => {
    commandCtx.commands.register({
      name: 'harness2',
      description: 'inspect or reset the Harness² improvement harness',
      input: { hint: '[status|library|reset]' },
      handler: async (invocation) => {
        await runtime.ready
        const input = asString(invocation?.input ?? invocation?.args ?? '')
        if (input === 'reset') {
          const result = await runtime.reset()
          return {
            kind: 'success',
            text: `Harness² reset. Archived the previous harness (${result.archivedInventory}) and restored the seed.`,
          }
        }
        const status = await runtime.status()
        const lines = [
          status.adopted
            ? `Harness²: adopted (${status.adoptedAt || 'unknown'}, domain ${status.domain})`
            : 'Harness²: seed only (no adopted harness)',
          `Harness: ${status.harness.inventory}`,
          `Library: ${status.library.length} entr${status.library.length === 1 ? 'y' : 'ies'} in ${status.domain}`,
        ]
        if (input === 'library') {
          for (const entry of status.library) {
            lines.push(`- ${entry.id} — ${entry.cue || entry.lesson || entry.inventory}`)
          }
        }
        return { kind: 'success', text: lines.join('\n') }
      },
    })
  })
}
