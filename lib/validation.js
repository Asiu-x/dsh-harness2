import { parse } from 'acorn'
import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
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

function compilePythonSource(python, name, body, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      python,
      [
        '-I',
        '-c',
        'import sys; compile(sys.stdin.read(), sys.argv[1], "exec")',
        name,
      ],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    )
    let stderr = ''
    let settled = false

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill('SIGTERM')
      reject(new Error(`Python syntax check timed out after ${timeoutMs}ms`))
    }, timeoutMs)

    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => {
      if (stderr.length < 65536) stderr += chunk
    })

    child.on('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(err)
    })

    child.on('close', (code, signal) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (code !== 0) {
        const err = new Error(
          stderr.trim() || `python exited with ${code ?? signal}`,
        )
        err.stderr = stderr
        reject(err)
        return
      }
      resolve()
    })

    child.stdin.on('error', () => {})
    child.stdin.end(String(body))
  })
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
  for (const [name, body] of Object.entries(tree)) {
    try {
      if (name.endsWith('.py')) {
        await compilePythonSource(python, name, body)
      }
      if (/^plugins\/.*\.js$/.test(name)) {
        if (!hasApplyFunction(body))
          throw new Error(
            'middleware must export a statically declared apply function',
          )
      }
    } catch (e) {
      result.errors.push(`${name} does not compile: ${e.stderr || e.message}`)
    }
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
  const legitimateDecls = new Set()
  const declaredTopNames = new Set()
  let duplicateTopDecl = false
  let exported

  const recordName = (name) => {
    if (declaredTopNames.has(name)) duplicateTopDecl = true
    declaredTopNames.add(name)
  }

  const declaration = (node) => {
    if (node?.type === 'FunctionDeclaration' && node.id?.type === 'Identifier') {
      recordName(node.id.name)
      bindings.set(node.id.name, node)
      legitimateDecls.add(node)
    }
    if (node?.type === 'VariableDeclaration') {
      for (const d of node.declarations) {
        if (d.id.type === 'Identifier') {
          recordName(d.id.name)
          bindings.set(d.id.name, d.init)
          legitimateDecls.add(d)
        }
      }
    }
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
    duplicateTopDecl ||
    !exported ||
    ![
      'FunctionDeclaration',
      'FunctionExpression',
      'ArrowFunctionExpression',
    ].includes(bindings.get(exported)?.type)
  )
    return false

  // Require the exported binding and its aliases to remain statically immutable,
  // including blocking nested `var` hoisting or shadowing redeclarations.
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
    if (node.type === 'VariableDeclarator' && !legitimateDecls.has(node))
      target(node.id)
    if (
      (node.type === 'FunctionDeclaration' ||
        node.type === 'ClassDeclaration') &&
      !legitimateDecls.has(node)
    )
      target(node.id)
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(walk)
      else if (value && typeof value === 'object') walk(value)
    }
  }
  walk(ast)
  return !reassigned
}
