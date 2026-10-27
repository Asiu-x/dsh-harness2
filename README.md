# dsh-harness2

**Harness² (recursive agent harnessing) for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).**

This is a DSH plugin that lets an agent improve its own harness from execution evidence: it runs a representative task under the current harness, proposes invariant and domain edits, probes them on the same task, composes an improved harness, selects an output anonymously, and stores the adopted harness plus the lesson in a per-domain library.

It ports the **method** of Google Research's [Harness²](https://github.com/google-research/harness2) ([paper](https://arxiv.org/abs/2610.14224), Apache-2.0) onto DSH's native agent and prompt surfaces. It does not re-run the paper's benchmarks.

> Status: `0.1.0`, early release. Tested with DSH `0.1.5-rc.1` and Node.js 20+. See [Verification](#verification) and [Limitations](#limitations).

## Install

From GitHub (public plugin package):

```bash
dsh plugin --profile web add github:Asiu-x/dsh-harness2
```

Restart DSH (or start `dsh web`) afterwards. The package declares a DSH bundle patch, so it is added to the profile's plugin tree automatically.

Local development:

```bash
git clone https://github.com/Asiu-x/dsh-harness2.git
dsh plugin --profile web add /absolute/path/to/dsh-harness2
```

Check that the plugin is in the composed tree:

```bash
dsh --profile web --dump-config | grep -A2 harness2
```

## Quick start

The plugin registers three model tools:

| Tool | Purpose |
|---|---|
| `harness2_refine` | Run one Harness² improvement loop on a representative task. |
| `harness2_status` | Show the adopted harness, its components, the library, and the latest run. |
| `harness2_reset` | Archive the current harness and restore the seed. Requires `confirm: true`. |

Ask the agent to use `harness2_refine` on a task:

```text
Use harness2_refine on this representative task:
"Read data/orders.csv, compute the total of the amount column, and write result.md containing exactly 'Total: <number>' on one line."
domain: data-analysis
k: 1
```

A `k=1` sequential run is roughly nine child-agent runs: one base probe, two proposals, two candidate probes, one composition, one final probe, one selector, and one reflection. Start with `k=1` and a small workspace. Model calls are billed by your DSH provider.

The human-facing command:

```text
/harness2            status
/harness2 library    list the current domain's library
/harness2 reset      archive and restore the seed harness
```

Once a harness is adopted, ordinary DSH agents in that workspace receive its always-on text and recent lessons as a prompt section. A fresh session sees it at startup; the session that ran the refinement receives an adoption context message on its next step.

## What it does

```text
task ──► base rollouts ──► PROPOSE (INV + DOM) ──► PROBE ──► COMPOSE ──► final probe
                                                                 │
                                                                 ├─► anonymous SELECT
                                                                 └─► REFLECT ──► library
                                                                             │
                                                                             └─► next task
```

- **Propose** — two proposers edit the harness: `INV` changes how the agent works; `DOM` adds what a practitioner of the domain knows. Proposals are the edited files, not patch descriptions.
- **Probe** — each candidate runs the same task in an isolated copy of the workspace. The evidence is the trajectory, the artifact, and whether the run delivered.
- **Compose** — one composer merges, adopts, or keeps the base, with a specific supporting moment for each decision.
- **Select** — an anonymous selector compares rendered deliverables, not harnesses. Base is included as a conservative check; a no-op winner is not adopted.
- **Reflect** — writes what each edit did and at most one transferable lesson into `.dsh-harness2/library/<domain>/`.

Read [docs/method.md](docs/method.md) for the full method, the eight components, the DSH mapping, and the differences from the reference release.

### The editable harness

The harness lives at `.dsh-harness2/harness/`:

| File | Role | Cost |
|---|---|---|
| `system.md` | role and procedure | always on |
| `guardrails.md` | standing rules | always on |
| `memory.md` | verified workspace facts | always on |
| `tool-guidance.md` | how to use tools | always on |
| `skills/<name>/SKILL.md` | on-demand workflow | loaded only when invoked |
| `sub_agents/<name>/AGENT.md` | delegated role | separate context |
| `scripts/<name>.py` | deterministic helper | run on demand |
| `plugins/<name>.md` | middleware rule (guidance) | read as a rule |

Always-on text is capped (default 12,000 characters). A skill must be named as a trigger in `system.md` or `guardrails.md`; referenced scripts must exist. Candidate middleware plugins are not executed by this build.

## Configuration

Override the plugin entry in your profile's `cordis.patch.yml` (or via `--patch`):

```yaml
- id: harness2
  config:
    maxK: 3
    concurrency: 2
    timeoutMinutes: 20
    maxWorkspaceMB: 50
    workspaceIsolation: copy
    selection: true
    reflection: true
```

| Key | Default | Meaning |
|---|---|---|
| `dataDir` | `.dsh-harness2` | Harness, library, and run data. |
| `maxAlwaysOnChars` | `12000` | Cap for the four always-on files. |
| `maxK` | `3` | Maximum recursion budget accepted by the tool. |
| `mode` | `sequential` | Default recursion mode. |
| `concurrency` | `2` | Parallel child agents per phase. |
| `timeoutMinutes` | `20` | Per-child-agent timeout. |
| `toolTimeoutMinutes` | `120` | Cooperative timeout for the whole refine tool. |
| `maxWorkspaceMB` | `50` | Copy cap; larger workspaces need a smaller path or `isolation: shared`. |
| `workspaceIsolation` | `copy` | `copy` = one workspace copy per probe; `shared` = run in place (can interfere). |
| `selection` | `true` | Anonymous selection; if false, adopt the best successful final. |
| `reflection` | `true` | Write the experience record after adoption. |
| `libraryLessons` | `3` | Recent lessons injected into ordinary agents. |
| `libraryEntries` | `8` | Library entries copied into a proposer context. |
| `model` / `provider` / `reasoningEffort` | session default | Override the child-agent route. |

## Data layout

```text
.dsh-harness2/
├── harness/                     # the live adopted harness (or seed)
├── state.json                   # adopted, domain, run, inventory
├── library/<domain>/
│   ├── INDEX.md
│   └── harnesses/<date>-<task>/
│       ├── harness/             # full adopted tree
│       ├── EXPERIENCE.md
│       └── experience.json
└── runs/<run>/
    ├── progress.log
    ├── run.json
    ├── rollouts/                # probe trajectories
    ├── deliverables/            # final answers + changed files
    ├── proposals/               # candidate harness + notes + meta
    ├── compositions/            # composed harness + notes + meta
    ├── contexts/                # evidence trees given to internal agents
    └── workspaces/              # isolated probe copies
```

`runs/` and `workspaces/` are ignored by the data directory's `.gitignore`; `harness/` and `library/` can be committed if you want to version the improvement.

## Verification

`npm test` covers the harness surface and validation rules, the store/library, workspace copy/diffing, and trajectory rendering.

End-to-end, in a disposable DSH headless profile, this release was exercised on:
- a task where the base already succeeded (composer kept the base; selector compared; no fake adoption);
- a task with a hidden workspace rule where a DOM proposal added the verified rule to `memory.md`, the composer kept it, the selector chose the final, and the harness was adopted;
- a fresh session whose system prompt contained the adopted always-on harness and the library lesson.

The plugin has **not** been validated against the paper's benchmark numbers, and it is not a benchmark harness.

## Limitations

- Each probe runs the real task in a copy of the workspace. Side effects are contained by `copy`, but the child uses your DSH profile's tools and permissions; review your permission preset before using this on sensitive data.
- Candidate middleware plugins are guidance, not executed. Skills, scripts, subagents, and prompt text are the supported levers.
- `shared` isolation runs probes in place and can produce collisions; it exists for workspaces too large to copy, not as the default.
- Selection compares deliverables using the model, not a ground-truth grader. It is evidence, not a score.
- Runs are expensive. `k=1` is the default; `k>1` multiplies model calls.
- The tool can switch the plugin instance to another workspace via its `workspace` argument, but only one workspace is active per plugin instance.

## License and acknowledgements

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).

The method, component taxonomy, and several prompt rules are adapted from [google-research/harness2](https://github.com/google-research/harness2), Copyright 2026 Google LLC, Apache-2.0. Harness² is a research release and is not an officially supported Google product. This integration is independent and is not affiliated with or endorsed by Google or DeepSeek.

Reference:

```bibtex
@article{xu2026harness2,
  title   = {Harness$^2$: Recursive Agent Harnessing for an Open World},
  author  = {Xu, Ruiyao and Chen, Yanfei and CuiZhu, Zhongying and Dalvi Mishra, Bhavana and Ming, Yifei and Yu, Han and Han, Rujun and Lee, Chen-Yu and Pfister, Tomas},
  journal = {arXiv preprint arXiv:2610.14224},
  year    = {2026},
  url     = {https://arxiv.org/abs/2610.14224}
}
```
