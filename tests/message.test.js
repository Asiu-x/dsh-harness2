import test from 'node:test'
import assert from 'node:assert/strict'
import { createUserMessage } from '../lib/message.js'
import { AgentRunner } from '../lib/agents.js'
import { Harness2Runtime } from '../lib/harness2.js'
import { apply } from '../index.js'

const expectedSource = { kind: 'plugin:dsh-harness2' }

test('plugin messages default to a producer-owned source and clone content', () => {
  const content = [{ type: 'text', text: 'Run the task' }]
  const first = createUserMessage({ content })
  const second = createUserMessage({ content })
  assert.deepEqual(first.source, expectedSource)
  assert.deepEqual(second.source, expectedSource)
  assert.equal(first.role, 'user')
  assert.notEqual(first.id, second.id)
  assert.deepEqual(first.content, content)
  content[0].text = 'changed by caller'
  first.source.kind = 'changed by consumer'
  assert.equal(first.content[0].text, 'Run the task')
  assert.deepEqual(second.source, expectedSource)
})

test('explicit message sources remain independently cloned', () => {
  const source = { kind: 'user', metadata: { origin: 'test' } }
  const message = createUserMessage({ content: [], source })
  assert.deepEqual(message.source, source)
  source.metadata.origin = 'changed'
  assert.equal(message.source.metadata.origin, 'test')
})

test('AgentRunner followups use the v4-compatible plugin source', async () => {
  const messages = []
  let disposed = false
  const agent = {
    session: { seq: 0, eventAt: () => undefined },
    followup(message) {
      // Assert at the host-admission boundary, before a model turn starts.
      assert.deepEqual(message.source, expectedSource)
      messages.push(message)
    },
    whenIdle: async () => {},
  }
  const ctx = {
    agentDefaultModel: { currentSelection: () => ({ provider: 'test', model: 'test' }) },
    agents: {
      async create(options) {
        options.setup({ systemPrompt: { section() {} } })
        return { agent, dispose: async () => { disposed = true } }
      },
    },
  }
  const runner = new AgentRunner({ ctx, config: {} })
  const result = await runner.run({
    label: 'base1', purpose: 'probe', prompt: 'Run the task', workspace: '.',
  })
  assert.equal(result.ok, true)
  assert.equal(messages.length, 1)
  assert.deepEqual(messages[0].content, [{ type: 'text', text: 'Run the task' }])
  assert.equal(disposed, true)
})

test('adoption context messages use the same v4-compatible plugin source', async (t) => {
  // Stub inference and initialization only; execute the real registered tool
  // and deferContext path without touching a profile or making model calls.
  t.mock.method(Harness2Runtime.prototype, 'loadAdoptedSync', () => {})
  t.mock.method(Harness2Runtime.prototype, 'init', async function () {
    this.adoptedText = 'Verified harness context'
  })
  t.mock.method(Harness2Runtime.prototype, 'refine', async () => ({
    adopted: true, winner: 'c1', runId: 'test-run', domain: 'test',
    mode: 'sequential', k: 1, harness: 'harness', runDir: 'run', progressLog: 'progress.log',
  }))
  const tools = new Map()
  apply({
    effect() {},
    tools: { register: (tool) => tools.set(tool.name, tool) },
    inject() {},
  }, {})
  const messages = []
  const result = await tools.get('harness2_refine').execute(
    { task: 'Run the task' },
    { agent: {}, deferContext: (message) => messages.push(message) },
  )
  assert.equal(result.adopted, true)
  assert.equal(messages.length, 1)
  assert.deepEqual(messages[0].source, expectedSource)
  assert.match(messages[0].content[0].text, /Verified harness context/)
})
