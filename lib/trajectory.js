// Render a DSH session as a bounded, readable trajectory.

export function blockText(content) {
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
    else if (block.type === 'image') parts.push('[image]')
    else if (block.type === 'file') parts.push(`[file${block.name ? `: ${block.name}` : ''}]`)
  }
  return parts.join('')
}

function truncate(value, max) {
  const text = String(value ?? '')
  if (text.length <= max) return text
  return text.slice(0, max) + `\n… [truncated ${text.length - max} chars]`
}

function reasonText(reason) {
  if (reason == null) return ''
  if (typeof reason === 'string') return reason
  try {
    if (reason.kind === 'error' && reason.error) {
      return `error: ${reason.error.code || 'unknown'}: ${reason.error.message || ''}`
    }
    return JSON.stringify(reason)
  } catch {
    return String(reason)
  }
}

/**
 * Render the events of one owned interval.
 * @param {object} session - DSH Session.
 * @param {number} fromSeq - first event sequence to include.
 * @param {{maxChars?: number, observationChars?: number, assistantChars?: number}} options
 */
export function renderTrajectory(session, fromSeq = 0, options = {}) {
  const maxChars = options.maxChars ?? 120_000
  const observationChars = options.observationChars ?? 4_000
  const assistantChars = options.assistantChars ?? 8_000
  const chunks = []
  const end = session.seq
  for (let seq = fromSeq; seq < end; seq++) {
    const event = session.eventAt(seq)
    if (!event) continue
    switch (event.type) {
      case 'user/message': {
        const text = blockText(event.data?.content).trim()
        if (text) chunks.push(`[USER]\n${truncate(text, assistantChars)}`)
        break
      }
      case 'assistant/message': {
        const text = blockText(event.data?.message?.content).trim()
        if (text) chunks.push(`[ASSISTANT]\n${truncate(text, assistantChars)}`)
        break
      }
      case 'tool/call': {
        const name = event.data?.name || 'tool'
        const args = event.data?.arguments || ''
        chunks.push(`[ACTION] ${name}\n${truncate(args, observationChars)}`)
        break
      }
      case 'tool/result': {
        const text = blockText(event.data?.message?.content).trim()
        const failed = Boolean(event.data?.error) || event.data?.message?.content?.[0]?.isError
        if (text) chunks.push(`[${failed ? 'ERROR' : 'OBSERVATION'}]\n${truncate(text, observationChars)}`)
        break
      }
      case 'assistant/attempt': {
        chunks.push('[MODEL ATTEMPT] no committed model-visible message')
        break
      }
      case 'turn/end': {
        const reason = reasonText(event.data?.reason)
        if (reason) chunks.push(`[TURN END] ${reason}`)
        break
      }
      default:
        break
    }
  }
  const joined = chunks.join('\n\n')
  if (joined.length <= maxChars) return joined
  const head = Math.floor(maxChars * 0.7)
  const tail = Math.floor(maxChars * 0.25)
  return (
    joined.slice(0, head) +
    `\n\n… [trajectory truncated; ${joined.length - head - tail} chars omitted] …\n\n` +
    joined.slice(-tail)
  )
}

export function finalAssistantText(session, fromSeq = 0) {
  let text = ''
  for (let seq = fromSeq; seq < session.seq; seq++) {
    const event = session.eventAt(seq)
    if (event?.type !== 'assistant/message') continue
    const value = blockText(event.data?.message?.content).trim()
    if (value) text = value
  }
  return text
}

export function lastTurnReason(session, fromSeq = 0) {
  let reason = null
  for (let seq = fromSeq; seq < session.seq; seq++) {
    const event = session.eventAt(seq)
    if (event?.type === 'turn/end') reason = event.data?.reason ?? null
  }
  return reason
}

export function countEvents(session, fromSeq = 0) {
  return Math.max(0, Number(session.seq) - fromSeq)
}
