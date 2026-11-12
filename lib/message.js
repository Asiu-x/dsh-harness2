// Minimal user-message constructor, kept local so the plugin does not install
// a second DSH LLM package into the host profile.

import { randomUUID } from 'node:crypto'

// DSH format v4 requires a producer-owned kind; the bare 'plugin' kind
// is reserved for historical v3 messages and is rejected at runtime.
export function createUserMessage({ content, source = { kind: 'plugin:dsh-harness2' } }) {
  return structuredClone({
    id: randomUUID(),
    role: 'user',
    content,
    source,
  })
}
