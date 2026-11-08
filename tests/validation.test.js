import test from 'node:test'
import assert from 'node:assert/strict'
import {
  hasApplyFunction,
  validateExecutableTree,
  assertEvidence,
  autoTrigger,
} from '../lib/validation.js'
import { seedTree } from '../lib/surface.js'

test('hasApplyFunction accepts valid static function exports', () => {
  assert.equal(hasApplyFunction('export function apply(ctx) {}'), true)
  assert.equal(
    hasApplyFunction('const apply = (ctx) => {}; export { apply };'),
    true,
  )
  assert.equal(
    hasApplyFunction('function handler(ctx) {} export { handler as apply };'),
    true,
  )
  assert.equal(
    hasApplyFunction(
      'const fn = function(ctx) {}; const apply = fn; export { apply };',
    ),
    true,
  )
})

test('hasApplyFunction rejects missing or non-function apply exports', () => {
  assert.equal(hasApplyFunction('export const notApply = () => {};'), false)
  assert.equal(hasApplyFunction('export const apply = 42;'), false)
  assert.equal(hasApplyFunction('export const apply = "string";'), false)
})

test('hasApplyFunction rejects reassignments, mutations, and nested var hoisting of apply binding', () => {
  // Reassignment to variable
  const code1 = `
    let apply = () => {};
    apply = () => {};
    export { apply };
  `
  assert.equal(hasApplyFunction(code1), false)

  // Reassignment via update expression
  const code2 = `
    let apply = 1;
    apply++;
    export { apply };
  `
  assert.equal(hasApplyFunction(code2), false)

  // Reassignment via destructuring
  const code3 = `
    let apply = () => {};
    [apply] = [() => {}];
    export { apply };
  `
  assert.equal(hasApplyFunction(code3), false)

  // Nested block var hoisting overwrite (Audit finding A3)
  const code4 = `
    export var apply = () => {};
    { var apply = 5; }
  `
  assert.equal(hasApplyFunction(code4), false)

  // Conditional block var hoisting overwrite
  const code5 = `
    export var apply = () => {};
    if (true) var apply = 5;
  `
  assert.equal(hasApplyFunction(code5), false)

  // Duplicate top-level var declaration
  const code6 = `
    var apply = 5;
    export var apply = () => {};
  `
  assert.equal(hasApplyFunction(code6), false)

  // Alias redeclaration in nested block
  const code7 = `
    var fn = () => {};
    export const apply = fn;
    { var fn = 42; }
  `
  assert.equal(hasApplyFunction(code7), false)
})

test('validateExecutableTree checks Python syntax asynchronously and plugin AST in-memory', async () => {
  const tree = await seedTree()

  // Valid Python script
  tree['scripts/valid.py'] = 'def run():\n    return 42\n'
  let result = await validateExecutableTree(tree)
  assert.equal(result.ok, true, result.errors.join('; '))

  // Invalid Python syntax
  tree['scripts/invalid.py'] = 'def broken(:\n    pass\n'
  result = await validateExecutableTree(tree)
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((e) => e.includes('scripts/invalid.py')))

  delete tree['scripts/invalid.py']

  // Valid plugin middleware
  tree['plugins/my-plugin.js'] = 'export function apply(ctx) {}\n'
  result = await validateExecutableTree(tree)
  assert.equal(result.ok, true, result.errors.join('; '))

  // Plugin missing apply function
  tree['plugins/bad-plugin.js'] = 'export const x = 1;\n'
  result = await validateExecutableTree(tree)
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((e) => e.includes('plugins/bad-plugin.js')))

  // Plugin with nested var hoisting bypass
  tree['plugins/bad-plugin.js'] =
    'export var apply = () => {}; { var apply = 5; }\n'
  result = await validateExecutableTree(tree)
  assert.equal(result.ok, false)
})

test('assertEvidence detects grader verdict markers and throws', () => {
  assert.doesNotThrow(() => assertEvidence({ 'notes.md': 'regular notes' }))
  assert.throws(
    () => assertEvidence({ 'notes.md': 'found deterministic_eval_summary here' }),
    /grader verdict marker/,
  )
})

test('autoTrigger adds always-on triggers to guardrails for named skills', () => {
  const tree = {
    'system.md': '',
    'guardrails.md': '',
    'memory.md': '',
    'tool-guidance.md': '',
    'skills/summarizer/SKILL.md':
      '---\nname: summarizer\ndescription: Summarize long threads.\n---\nPrompt here.',
  }
  const updated = autoTrigger(tree)
  assert.match(updated['guardrails.md'], /summarizer/)
  assert.match(updated['guardrails.md'], /Summarize long threads/)
})
