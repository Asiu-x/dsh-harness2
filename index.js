// DSH-native port of Google Harness². Apache-2.0; see NOTICE and docs/method.md.
import path from 'node:path'
import { promises as fs } from 'node:fs'
import { Harness2Runtime } from './lib/harness2.js'
export const name = 'dsh-harness2'
export const inject = ['agents', 'agentDefaultModel', 'systemPrompt', 'tools']
export function apply(ctx, config = {}) {
  const runtime = new Harness2Runtime(ctx, config)
  const workspace = async (agent) => {
    const cwd = agent?.session?.header?.cwd
    if (!cwd) throw new Error('Harness² requires an explicit session workspace')
    return fs.realpath(cwd)
  }
  const tool = (name, description, parameters, execute) =>
    ctx.tools.register({
      name,
      description,
      parameters,
      timeoutMs: 24 * 60 * 60 * 1000,
      isConcurrencySafe: () => false,
      execute,
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => [
          { type: 'text', text: JSON.stringify(value) },
        ],
      },
    })
  tool(
    'harness2_refine',
    'Run the reference Harness² method on an explicit task manifest. Executes the task repeatedly, learning a per-experiment library; does not change ordinary sessions.',
    {
      type: 'object',
      properties: {
        taskFile: { type: 'string' },
        k: { type: 'integer', minimum: 1 },
        mode: { type: 'string', enum: ['parallel', 'sequential'] },
        seed: { type: 'integer' },
      },
      required: ['taskFile'],
      additionalProperties: false,
    },
    async (args, exec) => {
      const cwd = await workspace(exec.agent)
      const file = path.resolve(cwd, args.taskFile)
      const real = await fs.realpath(file)
      if (!real.startsWith(cwd + path.sep))
        throw new Error('Task manifest must be inside the session workspace')
      const manifest = JSON.parse(await fs.readFile(real, 'utf8'))
      return runtime.refine({
        manifest,
        workspace: cwd,
        k: args.k,
        mode: args.mode,
        seed: args.seed,
        parentAgent: exec.agent,
        signal: exec.signal,
      })
    },
  )
  const params = {
    type: 'object',
    properties: { experiment: { type: 'string' } },
    required: ['experiment'],
    additionalProperties: false,
  }
  tool(
    'harness2_status',
    'Read an identified Harness² experiment without inference.',
    params,
    async (args, exec) =>
      runtime.status({ ...args, workspace: await workspace(exec.agent) }),
  )
  tool(
    'harness2_reset',
    'Archive an identified experiment, retaining all original evidence.',
    {
      ...params,
      properties: { ...params.properties, confirm: { type: 'boolean' } },
      required: ['experiment', 'confirm'],
    },
    async (args, exec) =>
      runtime.reset({ ...args, workspace: await workspace(exec.agent) }),
  )
}
