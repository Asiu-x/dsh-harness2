# Conformance and integration evidence

Reference Google commit: `6868817518876de8fd170c6a8354daca273b6191`. Community base: `bd9dfd077a0e6607197000c3f8706d1efe1cf257`. Local version **0.2.5**. DSH 0.2.1-rc.5 / Node 25.6.1 / Python 3.9.6.

| Contract | Proof in `tests/` | Result |
|---|---|---|
| Exact upstream `selection.assign_ids` ordering parity | `tests/ordering.test.js` validates 48-bit SHA-1 seed (`sha1Seed48`) + CPython `MT19937` (`init_by_array`, `genrandUint32`, `randbelow`) in pure JS against `scripts/legacy-assign-ids.py` and fixed golden vectors across sequential (`seq`) and parallel (`agg`) modes. | Passed |
| Asynchronous external script ordering & resilience | `tests/ordering.test.js` & `tests/orchestration.test.js` verify `assignIdsAsync` via `spawn` + `stdin.end`, permutation validation (`isValidPermutation`), and automatic fallback to native ordering (`idOrderingFallback: true`) when an external script fails or returns invalid labels. | Passed |
| `k=1` and `k=2` sequential & parallel orchestration | `tests/orchestration.test.js` executes `Harness2Runtime.refine` with programmed mock runners for `k=1` (trivial selection) and `k=2` (`sequential` and `parallel` modes), verifying selector invocation, candidate anonymization (`context/candidates/A.md`, `B.md`), `idMap`, reflection, and domain library persistence. | Passed |
| Selector failure & fallback containment | `tests/orchestration.test.js` verifies that invalid selector output or selector transport failure produces `selectionOk: false`, `selectionFallback: true`, deterministic lexical fallback winner, and suppresses reflection/library updates without aborting the run or locking the task ID. | Passed |
| Static ESM `apply` analysis & Python compilation | `tests/validation.test.js` verifies Acorn AST static export validation (blocking reassignments, destructuring, update expressions, duplicate top-level declarations, and nested `var` hoisting), asynchronous Python syntax checking via `stdin`, and grader marker guards. | Passed |
| Surface validation & off-surface rejection | `tests/surface.test.js` verifies seed tree validity, 24,000-character always-on budget, template brace rejection, named skill trigger rules, and symlink/off-surface rejection. | Passed |
| Experiment store, atomic commits, repair & stale lock recovery | `tests/store.test.js` verifies `ExperimentStore` initialization, H0 drift detection, mutual exclusion locking (`run.lock`), automatic recovery from dead-process stale locks (`ESRCH`), and physical reconstruction of deleted/corrupted harness files via `repairLibrary`. | Passed |
| Bounded trajectory rendering | `tests/trajectory.test.js` verifies action/observation/stop-reason formatting and character truncation. | Passed |

## Post-audit remediation summary (v0.2.5)

Version **0.2.4** was rejected by post-coding review due to `assignIdsAsync` ignoring `input` in `promisify(execFile)`, uncontained selector ordering exceptions, PRNG divergence from upstream CPython `MT19937`, residual `execFileSync` calls in `lib/validation.js`, nested `var` hoisting bypass in `hasApplyFunction`, and missing `k=2` orchestration tests.

Version **0.2.5** resolves all identified defects:
1. Replaces Mulberry32 in `assignIds` with an exact pure-JS port of CPython's 48-bit SHA-1 seeded `MT19937` (`init_by_array` + `_randbelow`), achieving 100% bit-for-bit permutation parity with `scripts/legacy-assign-ids.py` in microseconds.
2. Rewrites `assignIdsAsync` using `spawn` with explicit `child.stdin.end(input)` and permutation validation (`isValidPermutation`).
3. Encloses selector candidate ordering and mapping inside the selector `try/catch` block in `lib/harness2.js`, automatically falling back to native ordering (`idOrderingFallback: true`) if a configured `assignIdsScript` fails.
4. Eliminates all remaining `execFileSync` calls from `lib/validation.js` (switching Python syntax compilation to asynchronous `spawn` over `stdin` and validating plugin ESM syntax directly in memory via Acorn).
5. Blocks nested `var` redeclarations/hoisting of the exported `apply` binding and its aliases in `hasApplyFunction`.
6. Adds stale lock recovery (`ESRCH` dead-PID check) in `ExperimentStore.lock()` and explicit existence validation in `Harness2Runtime.reset()`.

## Limitações conhecidas (Known limitations)

- **Static AST analysis scope:** `hasApplyFunction` enforces static binding immutability on the exported `apply` identifier chain (including nested `var` hoisting and destructuring writes), but is not an OS sandbox against dynamic runtime constructs such as `eval()` or `Function()`. ESM hooks remain trusted code within the host DSH process.
- **Legacy workspace helper:** `lib/workspace.js` (tested by `tests/workspace.test.js`) is retained in the package solely for backward compatibility with v0.1.0 consumers; the v2 runtime (`lib/harness2.js`) uses `lib/surface.js` and `lib/task.js` for tree isolation.
- **External benchmark reproduction:** Reference tests use deterministic local runners and fixtures; reproducing full LLM benchmark scores or binary document rendering (PDF/Office/images) is outside the scope of this text-surface adapter.
