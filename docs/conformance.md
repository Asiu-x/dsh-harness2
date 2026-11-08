# Conformance and integration evidence

Reference Google commit: 6868817518876de8fd170c6a8354daca273b6191. Community base: bd9dfd077a0e6607197000c3f8706d1efe1cf257. Local version 0.2.3. DSH 0.2.1-rc.5 / Node 25.6.1 / Python 3.9.6 (runtime), 3.12 (oracle).

| Contract | Proof | Result |
|---|---|---|
| k=1, k=2, sequential and parallel, two-task library | tests/conformance.test.js executes Google's real DemoAdapter/DemoProposer/run_domain in a temporary reference directory, then the JS port with the same initial Python calculation, ledger inputs and programmed edits. Checks outputs, winner labels, execution/editor counts, H0 and prior-library visibility. | Passed |
| Reference prompt branches | tests/prompts.test.js compares live original generator after documented DSH vocabulary mapping against JS renderer for k=1/2/3/5, all rounds, INV/DOM, composition, selection, reflection. | Passed |
| Selector invalid, throws, unsuccessful transport | tests/orchestration.test.js: fallback remains selectionOk=false, no reflection/library. | Passed |
| No-op/NO_ENTRY | Same suite: no-op still reflects, empty experience never persists. | Passed |
| Validation/retry | Bad Python/ESM, missing helper, preserved invalid edits corrected on second proposal/composition attempt; execution failure separate from structural rejection. | Passed |
| State/inputs/isolation | Explicit input paths, fake .env/evaluator refusal, symlink refusal, marker guard, immutable H0, config mismatch, artifact tampering, cached reuse, two workspaces, exclusive lock. | Passed |
| Cancellation/parallel drain | Abort before work and no admission after worker error; all already admitted workers settle before failure returns. | Passed |
| DSH real substrate | tests/dsh-fixture loaded by the actual profile/loader; local programmed LlmAdapter, no network inference. Calls public refine through ctx.tools.execute; two workspaces have independent state/library. | Passed |
| Eight components | Stock text surface, named skill tool invocation, Bash Python script, harness2_delegate in a separate agent context, scoped ESM callbacks in pre/post tool, pre-step and turn-stopping. Post-tool modifies actual tool output, stop hook injects corrective continuation. | Passed |
| DSH lifecycle/policies | Hook effects absent in subsequent neutral agent; child read-only preserved; caller cancellation and wall timeout drain actual agents. | Passed |
| Packaging | npm archive includes production modules, generated assets and docs; only Acorn as a runtime dependency, no bundled DSH services or private credentials; fixture remains separate test-only package. | Validated during isolated installation |

Executed logs in parent workspace: harness2-v2-before.log (upstream red), harness2-v2-tests.log (42/42), harness2-dsh-integration.log, harness2-pack.log. Reference tests are deterministic demonstrations, not a proof of all possible model behavior or reproduction of professional benchmark scores. Text fixtures do not certify binary document renderers, which this adapter deliberately rejects.

## Follow-up after independent review

Version 0.2.0 was rejected by independent review; version **0.2.3** adds phase-isolation regressions, all-baseline-failure early exit, authoritative library repair, missing-authority failure, canonical cache fingerprints, reset/reused-ID module+helper reloading, context-failure recording, static apply export analysis, and real PTC/scoped-parent setup. `tests/review-regressions.test.js` failed before these corrections and passes after them. Acorn 8.15.0 is the only production JS dependency and does not duplicate host DSH services.

Version **0.2.2** additionally records failed reflection transports/parsing, rejects reassigned apply aliases, isolates every authoring transport attempt while retaining only invalid-tree edits for correction, and preserves UTF-8 BOM. Regression tests cover all four mechanisms. Static export analysis is conservative and is not a security certification of hook bodies.

Version **0.2.3** rejects var/destructuring loop writes to apply aliases and records actual transport counts across structural retries. Localized and English documentation versions agree.
