import test from 'node:test'
import assert from 'node:assert/strict'
import { AgentRunner, composeParentPreset, installHarness, parentPresetId } from '../lib/agents.js'

function fakeSession() {
  return {
    seq: 0,
    header: { delegationDepth: 0 },
    eventAt() {
      return undefined
    },
  }
}

function fakeAgent() {
  return {
    session: fakeSession(),
    followup() {},
    whenIdle: async () => {},
    cancel() {},
  }
}

function makeRunner({ presets, parentAgent, events = [] }) {
  const calls = events
  let creation
  const childCtx = {
    get(name) {
      if (name === 'agentPresets') return presets
      return undefined
    },
    systemPrompt: {
      section(section) {
        calls.push(`section:${section.name}`)
      },
    },
  }
  const agent = fakeAgent()
  const ctx = {
    get(name) {
      if (name === 'agentDefaultModel') {
        return { currentSelection: () => ({ provider: 'mock', model: 'model' }) }
      }
      return undefined
    },
    agents: {
      async create(options) {
        creation = options
        await options.setup(childCtx, agent)
        return {
          agent,
          dispose: async () => {
            calls.push('dispose')
          },
        }
      },
    },
  }
  const runner = new AgentRunner({
    ctx,
    config: { maxAlwaysOnChars: 12_000 },
    log: () => {},
  })
  return { runner, calls, childCtx, getCreation: () => creation }
}

test('child creation joins the parent preset before installing the harness', async () => {
  const events = []
  const parentCtx = {
    get(name) {
      return name === 'agentPresets' ? presets : undefined
    },
  }
  const presets = {
    composedPreset: () => 'standard',
    composeFrom: async (childCtx, parent) => {
      await new Promise((resolve) => setTimeout(resolve, 5))
      events.push(['compose', childCtx, parent])
    },
  }
  const parentAgent = { ctx: parentCtx, session: { header: { delegationDepth: 0 } } }
  const { runner, childCtx, getCreation } = makeRunner({ presets, parentAgent, events })

  const result = await runner.run({
    label: 'probe',
    purpose: 'probe',
    prompt: 'do the work',
    harness: { 'system.md': '# System\nBe precise.' },
    workspace: '/tmp',
    parentAgent,
    timeoutMs: 1_000,
  })

  assert.equal(result.ok, true)
  assert.equal(getCreation().meta.agentPreset, 'standard')
  assert.deepEqual(events[0], ['compose', childCtx, parentCtx])
  assert.deepEqual(
    events.slice(1).map((event) => (Array.isArray(event) ? event[0] : event)),
    ['section:harness2:adopted', 'section:harness2:candidate', 'dispose'],
  )
  const creation = getCreation()
  assert.equal(creation.meta.origin, 'subagent')
  assert.equal(creation.meta.delegationDepth, 1)
})

test('a host without agentPresets remains supported', async () => {
  const parentAgent = {
    ctx: { get: () => undefined },
    session: { header: { delegationDepth: 0 } },
  }
  const { runner, getCreation } = makeRunner({ presets: undefined, parentAgent })
  const result = await runner.run({
    label: 'probe',
    purpose: 'probe',
    prompt: 'do the work',
    harness: null,
    workspace: '/tmp',
    parentAgent,
    timeoutMs: 1_000,
  })
  assert.equal(result.ok, true)
  assert.equal(getCreation().meta.agentPreset, undefined)
})

test('preset helpers are no-ops without a parent or composition service', async () => {
  assert.equal(parentPresetId(undefined), undefined)
  assert.equal(parentPresetId({ ctx: { get: () => undefined } }), undefined)
  await composeParentPreset({ get: () => undefined }, { ctx: {} })
})

test('runtime skills include the source and harness resource base required by DSH', () => {
  const registrations = []
  const ctx = {
    systemPrompt: { section: () => {} },
    get(name) {
      if (name === 'skills') {
        return { register: (skill) => registrations.push(skill) }
      }
      return undefined
    },
  }
  installHarness(
    ctx,
    {
      'system.md': 'When totaling a CSV column, load the `tabular-sum` skill.',
      'skills/tabular-sum/SKILL.md': [
        '---',
        'name: tabular-sum',
        'description: Sum a numeric column in a CSV.',
        '---',
        '',
        'Use the bundled helper.',
      ].join('\n'),
    },
    { resourcesDir: '/tmp/harness' },
  )
  assert.equal(registrations.length, 1)
  assert.equal(registrations[0].source, 'runtime')
  assert.equal(registrations[0].resourceBase.kind, 'directory')
  assert.equal(registrations[0].resourceBase.path, '/tmp/harness')
  assert.match(registrations[0].content, /Use the bundled helper/)
})
