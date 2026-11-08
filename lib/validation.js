import { parse } from 'acorn'
import { execFileSync } from 'node:child_process'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { validateTree, skillEntries } from './surface.js'
import { VERDICT_MARKERS } from './prompts.js'
export function assertEvidence(tree) {
  for (const [name, body] of Object.entries(tree))
    for (const marker of VERDICT_MARKERS) {
      if (name.includes(marker) || String(body).includes(marker))
        throw new Error(`grader verdict marker in ${name}: ${marker}`)
    }
}
export function autoTrigger(tree) {
  const on = ['system.md', 'guardrails.md', 'memory.md', 'tool-guidance.md']
    .map((n) => tree[n] || '')
    .join('\n')
  for (const s of skillEntries(tree))
    if (!new RegExp(`(^|[^a-z0-9_-])${s.name}([^a-z0-9_-]|$)`, 'i').test(on))
      tree['guardrails.md'] =
        (tree['guardrails.md'] || '') +
        `\n- When ${s.data.description || s.name}, load the \`${s.name}\` skill.\n`
  return tree
}
export async function validateExecutableTree(
  tree,
  { python = 'python3', ...options } = {},
) {
  const result = validateTree(tree, options)
  try {
    assertEvidence(tree)
  } catch (e) {
    result.errors.push(e.message)
  }
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'h2-validate-'))
  try {
    for (const [name, body] of Object.entries(tree)) {
      try {
        if (name.endsWith('.py'))
          execFileSync(
            python,
            [
              '-I',
              '-c',
              'import sys; compile(sys.stdin.read(), sys.argv[1], "exec")',
              name,
            ],
            {
              input: body,
              timeout: 10000,
              encoding: 'utf8',
              stdio: ['pipe', 'pipe', 'pipe'],
            },
          )
        if (/^plugins\/.*\.js$/.test(name)) {
          const file = path.join(temp, path.basename(name) + '.mjs')
          await fs.writeFile(file, body)
          execFileSync(process.execPath, ['--check', file], {
            timeout: 10000,
            encoding: 'utf8',
            stdio: ['pipe', 'pipe', 'pipe'],
          })
          if (!hasApplyFunction(body))
            throw new Error(
              'middleware must export a statically declared apply function',
            )
        }
      } catch (e) {
        result.errors.push(`${name} does not compile: ${e.stderr || e.message}`)
      }
    }
  } finally {
    await fs.rm(temp, { recursive: true, force: true })
  }
  result.ok = !result.errors.length
  return result
}

// Contexts and library are authoring evidence, never an execution surface.
export async function assertEvidenceDirectory(root) {
  let entries
  try {
    entries = await fs.readdir(root, { withFileTypes: true })
  } catch (e) {
    if (e.code === 'ENOENT') return
    throw e
  }
  for (const entry of entries) {
    const file = path.join(root, entry.name)
    if (entry.isSymbolicLink())
      throw new Error('Symbolic link in evidence: ' + file)
    if (entry.isDirectory()) await assertEvidenceDirectory(file)
    else if (entry.isFile())
      assertEvidence({ [entry.name]: await fs.readFile(file, 'utf8') })
    else throw new Error('Non-regular evidence: ' + file)
  }
}

export function hasApplyFunction(source) {
  const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module' })
  const bindings = new Map()
  let exported
  const declaration = (node) => {
    if (node?.type === 'FunctionDeclaration') bindings.set(node.id.name, node)
    if (node?.type === 'VariableDeclaration')
      for (const d of node.declarations)
        if (d.id.type === 'Identifier') bindings.set(d.id.name, d.init)
  }
  for (const statement of ast.body) {
    declaration(statement)
    if (statement.type === 'ExportNamedDeclaration') {
      declaration(statement.declaration)
      if (
        statement.declaration?.type === 'FunctionDeclaration' &&
        statement.declaration.id.name === 'apply'
      )
        exported = 'apply'
      if (
        statement.declaration?.type === 'VariableDeclaration' &&
        statement.declaration.declarations.some((d) => d.id.name === 'apply')
      )
        exported = 'apply'
      for (const spec of statement.specifiers)
        if (
          (spec.exported.name || spec.exported.value) === 'apply' &&
          !statement.source
        )
          exported = spec.local.name
    }
  }
  const visited = new Set()
  while (exported && !visited.has(exported)) {
    visited.add(exported)
    const node = bindings.get(exported)
    if (
      [
        'FunctionDeclaration',
        'FunctionExpression',
        'ArrowFunctionExpression',
      ].includes(node?.type)
    )
      break
    exported = node?.type === 'Identifier' ? node.name : null
  }
  if (
    !exported ||
    ![
      'FunctionDeclaration',
      'FunctionExpression',
      'ArrowFunctionExpression',
    ].includes(bindings.get(exported)?.type)
  )
    return false
  // Require the exported binding and its aliases to remain statically immutable.
  // Walk assignment targets, including destructuring, without evaluating code.
  let reassigned = false
  const target = (node) => {
    if (!node) return
    if (node.type === 'Identifier' && visited.has(node.name)) reassigned = true
    else if (node.type === 'ArrayPattern') node.elements.forEach(target)
    else if (node.type === 'ObjectPattern')
      node.properties.forEach((p) =>
        target(p.type === 'RestElement' ? p.argument : p.value),
      )
    else if (node.type === 'AssignmentPattern') target(node.left)
    else if (node.type === 'RestElement') target(node.argument)
    else if (node.type === 'VariableDeclaration')
      node.declarations.forEach((d) => target(d.id))
  }
  const walk = (node) => {
    if (!node || typeof node !== 'object') return
    if (node.type === 'AssignmentExpression') target(node.left)
    if (node.type === 'UpdateExpression') target(node.argument)
    if (node.type === 'ForOfStatement' || node.type === 'ForInStatement')
      target(node.left)
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(walk)
      else if (value && typeof value === 'object') walk(value)
    }
  }
  walk(ast)
  return !reassigned
}
