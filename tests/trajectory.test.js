import test from 'node:test'
import assert from 'node:assert/strict'
import { finalAssistantText, lastTurnReason, renderTrajectory } from '../lib/trajectory.js'

function fakeSession(events) {
  return {
    seq: events.length,
    eventAt(index) {
      return events[index]
    },
  }
}

test('trajectory renders actions, observations, final text, and stop reason', () => {
  const session = fakeSession([
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'user/message', data: { content: [{ type: 'text', text: 'Do the work' }], source: { kind: 'user' } } },
    { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'Reading files' }] } } },
    { type: 'tool/call', data: { name: 'read', arguments: '{"file_path":"a.md"}' } },
    { type: 'tool/result', data: { message: { content: [{ type: 'text', text: 'alpha' }] } } },
    { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'Done: alpha' }] } } },
    { type: 'turn/end', data: { reason: { kind: 'completed' } } },
  ])
  const text = renderTrajectory(session, 0)
  assert.match(text, /\[USER\]/)
  assert.match(text, /\[ACTION\] read/)
  assert.match(text, /\[OBSERVATION\]/)
  assert.match(text, /\[TURN END\]/)
  assert.equal(finalAssistantText(session), 'Done: alpha')
  assert.deepEqual(lastTurnReason(session), { kind: 'completed' })
})

test('trajectory is bounded', () => {
  const events = []
  for (let i = 0; i < 100; i++) {
    events.push({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'x'.repeat(2000) }] } } })
  }
  const session = fakeSession(events)
  const text = renderTrajectory(session, 0, { maxChars: 10_000 })
  assert.ok(text.length < 11_000)
  assert.match(text, /trajectory truncated/)
})
