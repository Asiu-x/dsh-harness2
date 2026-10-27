import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import {
  composeAlwaysOn,
  diffTrees,
  parseFrontmatter,
  readTree,
  seedTree,
  validateTree,
  writeTree,
} from '../lib/surface.js'

async function tempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'h2-test-'))
}

test('seed harness is valid and non-empty', async () => {
  const tree = await seedTree()
  const result = validateTree(tree)
  assert.equal(result.ok, true, result.errors.join('; '))
  assert.ok(tree['system.md'].length > 50)
  assert.match(composeAlwaysOn(tree), /Role and procedure/)
})

test('a skill without an always-on trigger is rejected; a named skill is accepted', async () => {
  const tree = await seedTree()
  tree['skills/doc-check/SKILL.md'] = [
    '---',
    'name: doc-check',
    'description: Check a document against its requested schema.',
    '---',
    '',
    'Read the requested fields and report missing values.',
  ].join('\n')
  let result = validateTree(tree)
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((error) => error.includes('never named')))

  tree['system.md'] += '\n\nWhen a document must be checked against a schema, load the `doc-check` skill.\n'
  result = validateTree(tree)
  assert.equal(result.ok, true, result.errors.join('; '))
  const composed = composeAlwaysOn(tree)
  assert.match(composed, /doc-check/)
  assert.match(composed, /loaded on demand/)
})

test('a skill script reference must exist in the same tree', async () => {
  const tree = await seedTree()
  tree['skills/doc-check/SKILL.md'] = [
    '---',
    'name: doc-check',
    'description: Check a document.',
    '---',
    '',
    'Run `python3 scripts/check_doc.py` before answering.',
  ].join('\n')
  tree['system.md'] += '\n\nWhen checking a document, load the `doc-check` skill.\n'
  let result = validateTree(tree)
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((error) => error.includes('scripts/check_doc.py')))

  tree['scripts/check_doc.py'] = 'print("ok")\n'
  result = validateTree(tree)
  assert.equal(result.ok, true, result.errors.join('; '))
})

test('always-on template braces and the size cap are rejected', async () => {
  const tree = await seedTree()
  tree['guardrails.md'] += '\n\n{{bad}}\n'
  let result = validateTree(tree)
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((error) => error.includes('template brace')))

  const big = await seedTree()
  big['memory.md'] = 'x'.repeat(13_000)
  result = validateTree(big)
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((error) => error.includes('always-on text')))
})

test('off-surface files are collected by readTree and rejected by writeTree', async () => {
  const dir = await tempDir()
  await fs.mkdir(path.join(dir, 'notes'), { recursive: true })
  await fs.writeFile(path.join(dir, 'system.md'), '# ok\n')
  await fs.writeFile(path.join(dir, 'notes', 'private.txt'), 'nope')
  const { tree, rejected } = await readTree(dir)
  assert.deepEqual(Object.keys(tree), ['system.md'])
  assert.deepEqual(rejected, ['notes/private.txt'])

  await assert.rejects(() => writeTree(dir, { ...tree, 'notes/x.md': 'x' }), /off-surface/)
  await fs.rm(dir, { recursive: true, force: true })
})

test('frontmatter parsing and tree diffs', () => {
  const parsed = parseFrontmatter('---\nname: demo\ndescription: "A test"\n---\n\nBody\n')
  assert.equal(parsed.data.name, 'demo')
  assert.equal(parsed.data.description, 'A test')
  assert.equal(parsed.body.trim(), 'Body')
  const diff = diffTrees({ 'system.md': 'a' }, { 'system.md': 'b', 'scripts/x.py': 'print(1)' })
  assert.deepEqual(diff.modified, ['system.md'])
  assert.deepEqual(diff.added, ['scripts/x.py'])
  assert.equal(diff.empty, false)
})
