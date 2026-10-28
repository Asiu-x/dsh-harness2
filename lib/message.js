// Minimal user-message constructor, kept local so the plugin does not install
// a second DSH LLM package into the host profile.

import { randomUUID } from 'node:crypto'

export function createUserMessage({ content, source }) {
  return structuredClone({
    id: randomUUID(),
    role: 'user',
    content,
    source,
  })
}
