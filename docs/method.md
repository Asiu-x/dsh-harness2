# Method contract and native DSH mapping

Reference: Google Harness² `6868817518876de8fd170c6a8354daca273b6191`; base: Asiu `bd9dfd0`. Apache-2.0. JS orchestration remains native; Python is only a stdlib syntax/anonymous-order utility and test oracle.

## Reference correspondence

- `recursion.run_parallel/run_sequential` → `Harness2Runtime.refine`: k baselines, independent INV/DOM proposals, phase barriers, 2k candidate probes, k compositions and k final probes. Sequential checkpoints carry whole prior candidate/decision/trajectory evidence. k=1 uses the aggregate prompt in either mode.
- `selection_pool/trivial_selection/run_selection` → finals-only selection, no selector at k=1, stable upstream Python seeded permutation, full deliverable files, invalid selection flagged separately from fallback. The chosen output is an existing output, not synthesized by selection.
- `schedule._run_one_mode` and `library.has_experience/add` → reflection only for selectionOk; no diff requirement; only supported experience is persisted. H0 is unchanged across tasks. Libraries are separated by experiment configuration and domain, and read only entries committed by preceding calls.
- `context` → explicit manifest source, complete trajectories/events on disk, complete deliverable text, full candidate trees and decisions. Rubrics and verdicts are not exposed. A task adapter owns rendering and delivery, not the improver.
- `prompts` → generated text assets from the pinned functions, checked live across branches. Native surface vocabulary replaces OpenCode paths/API; no reasoning criteria are rewritten.
- `tree.validate/autotrigger` and `_run_stage` → structural validation, helper checks, Python compilation, auto-trigger repair, two tree attempts preserving earlier edits, separate transport attempts and execution-failure records.

## Native substrate differences

H0 consists of the stock DSH runtime and blank editable components unless `baseHarnessDir` explicitly supplies the experiment baseline. DSH skill identifiers use kebab-case. DSH prompt interpolation braces are rejected rather than sent to the strict runtime. Native middleware is ESM JavaScript exporting apply(agentCtx), not TypeScript OpenCode modules or Markdown advice. Roles run through a scoped harness2_delegate tool in fresh contexts (depth bounded to 3 including the executor). A module or skill mount failure fails the agent; it is not silently ignored.

For probes, tool roots are the fresh workspace copies. Authoring stages receive evidence-only workspaces with native tools and no active candidate harness. They cannot call harness2_refine/reset recursively. Requests use frozen executor/editor/selector routes. Parent sandbox read-only and tool restrictions are preserved; the experiment never selects danger-full-access. Hooks remain trusted host-process code and are not sandboxed by the tool policy.

## Status, persistence, compatibility

`ok` is whole-run success; `selectionOk` specifically governs reflection/learning. `selectionFallback` records contingency and never implies a validated improvement. Stage transport errors can make the overall run partial even if another final yields a usable selection, matching the reference distinction between mode errors and selection validity. Missing/empty deliverables are not valid candidates. The adapter currently accepts UTF-8 text only.

Each experiment stores H0 plus settings identity and a per-task input fingerprint. Successful cache reuse checks artifacts and selected harness. Locks serialize the complete operation; failures release the live lock after owned calls settle, while interrupted evidence is retained and not silently replayed. Library commits refer to a durable task result and are idempotent; resume completes an interrupted library commit. Reset archives, never deletes, a stopped experiment. No v1 migration or ordinary-session prompt injection occurs.

Reference-derived commands, models, benchmark datasets and unrestricted executor settings are not installed. Running a paid experiment requires explicit provider configuration and invocation; installation/synthetic tests do not call those providers.
