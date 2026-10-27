# Harness² method and its DSH mapping

This plugin is a DSH-native implementation of **Harness²: Recursive Agent Harnessing for an Open World** by Google Research and Northwestern University.

- Reference release: [google-research/harness2](https://github.com/google-research/harness2) (Apache-2.0)
- Paper: [arXiv:2610.14224](https://arxiv.org/abs/2610.14224)
- Project page: [harness2.github.io](https://harness2.github.io)

The reference release is a Python benchmark framework with OpenCode/Codex executors and JobBench/LAB/WorkBuddy-Bench adapters. This plugin does not re-run those benchmarks. It ports the **method** onto DSH's native agent, tool, session, and prompt surfaces so that a DSH workspace can refine its own harness on a representative task.

## 1. Definitions

A **harness** is the system around a model that turns it into an agent: prompts, tools, memory, skills, orchestration, guardrails, scripts, and middleware.

**Harnessing** is the process of optimizing that system without changing model weights.

Harness² is **recursive** because it couples two adaptation loops:

1. **Task-level recursion** improves the harness for the task in front of the agent.
2. **Harnessing-level recursion** stores the adopted harness and evidence-supported lessons so future tasks start from a better improvement mechanism.

The paper's central claim is that an agent can improve its own harness from **behavioral contrasts** — differences between executions on the same task — without a rubric, answer key, or ground truth.

## 2. Propose–Probe–Compose

One step has three parts:

### Propose

Given the task, the base rollouts, their trajectories and deliverables, the current harness, and the domain library, two proposers edit the harness independently:

- **INV (invariant):** how the agent works — procedure, orchestration, tool use, verification, stopping, output discipline.
- **DOM (domain):** what a practitioner of the domain knows — domain facts, conventions, checks, and verified joins between the workspace's files.

A proposal is the edited harness tree itself, not a patch description. Each edit must trace to a moment in a trajectory. If the evidence does not support a change, `KEEP_BASE` is a valid proposal.

### Probe

Each candidate harness is rolled out on the **same task**. Because there is no rubric, the evidence is what the executions did:

- the trajectory (actions, observations, errors, turn outcome),
- the artifact the run produced,
- whether the run delivered at all.

In this plugin each probe runs in an isolated copy of the workspace. The candidate harness is installed as a scoped prompt section, its skills are registered in the child's skill registry, and its scripts/subagent/plugin notes are materialized under a resources directory referenced from the harness text.

### Compose

A composer reads the base rollouts, every candidate harness, and every candidate rollout, then produces one harness. It may:

- merge edits across candidates,
- adopt one candidate wholesale,
- keep the base.

It must not merge an edit merely because it is present; the edit needs a specific supporting moment. An edit associated with a non-delivering rollout is treated as unsafe unless the evidence is overwhelming.

## 3. Parallel and sequential recursion

Both modes start with `k` reference executions of the base harness.

| Mode | Shape |
|---|---|
| `sequential` (`k=K`) | `K` successive Propose–Probe–Compose steps. Each checkpoint carries the refined harness and accumulated evidence into the next round. |
| `parallel` (`k=K`) | `K` INV and `K` DOM candidates are proposed and probed from shared base evidence, then `K` independent composers produce `K` finals. |

`k=1` is one Propose–Probe–Compose step in either mode. The plugin defaults to `k=1` because each extra unit multiplies model calls.

## 4. Selection and reflection

After the finals are probed, an anonymous **selector** compares rendered deliverables, not harnesses. Candidate ids are shuffled and the harnesses are hidden. The selector checks delivery, conformance to the requested shape, fidelity to the source material, internal consistency, and finish.

This plugin adds a conservative option: the base output is included in the comparison pool. If the selector picks base, or if the selected candidate's harness is byte-identical to the base, the current harness is kept. The reference release selects among finals; the conservative variant avoids adopting a no-op or a regression.

**Reflection** then reads the whole round — base harness, every candidate harness, every rollout, the adopted harness, and the selection rationale — and writes:

- what each edit did, with a verdict (`helped`, `hurt`, `no observed effect`, `confounded`),
- at most one transferable lesson: a **cue** describing the shape of situation, a **lesson** naming the component and the operation, the **evidence**, and a **confidence**.

The adopted harness and lesson are stored in a per-domain library. Later proposals read this library as evidence, and the adopted harness's always-on text plus recent lessons are injected into ordinary DSH agents in that workspace.

## 5. The eight components on the DSH surface

Harness² exposes eight editable components. This plugin keeps them explicit as files under `.dsh-harness2/harness/`:

| Harness² component | DSH file | Runtime treatment |
|---|---|---|
| System prompt | `system.md` | always-on prompt section |
| Guardrails | `guardrails.md` | always-on prompt section |
| Memory | `memory.md` | always-on prompt section |
| Tool guidance | `tool-guidance.md` | always-on prompt section |
| Skills | `skills/<name>/SKILL.md` | registered in the child's scoped skill registry; loaded on demand |
| Subagents | `sub_agents/<name>/AGENT.md` | advertised in the harness text; read by the agent and used through DSH delegation |
| Scripts | `scripts/<name>.py` | materialized under the harness resources directory; run through the shell |
| Plugins (middleware) | `plugins/<name>.md` | read as a rule; this build does not execute candidate plugins |

The four always-on files are capped (default 12,000 characters). A skill's literal name must appear in `system.md` or `guardrails.md`, otherwise validation rejects the proposal. Referenced scripts must exist in the same tree. Template braces are rejected because DSH interpolates prompt variables strictly.

The plugin deliberately does **not** execute a candidate's plugin code. A plugin acts inside the tool loop and can be dangerous; reading it as guidance is the safe default. This is a documented difference from a full substrate that can install middleware.

## 6. What is implemented, and what is not

Implemented:

- DSH-native child agents for probes, proposers, composers, selector, and reflection;
- sequential and parallel recursion with `k` budgets;
- harness tree read/write/validation, always-on composition, scoped skill registration;
- isolated workspace copies, trajectory rendering, deliverable diffing;
- anonymous selection, conservative base comparison, no-op detection;
- per-domain library, lessons injected into later agents;
- tools `harness2_refine`, `harness2_status`, `harness2_reset` and a `/harness2` command.

Not implemented:

- the reference benchmark adapters (JobBench, LAB, WorkBuddy-Bench);
- re-running the paper's experiments or reproducing its reported scores;
- executing candidate middleware plugins;
- a hard OS sandbox around probes. `copy` isolation gives each probe its own workspace copy, but the child still runs with the DSH profile's tools and permissions. Review your DSH permission/sandbox settings before using this on sensitive material.

## 7. Cost and operational notes

- A `k=1` sequential run starts `1` base probe, `2` proposals, `2` candidate probes, `1` composition, `1` final probe, `1` selector, and `1` reflection: roughly **9 child-agent runs**.
- `k=2` / `k=3` multiply proposal, probe, and composition calls. The plugin caps `k` at 3.
- Each probe runs the real task in a copied workspace. On a large repository, workspace copies dominate time and disk; `maxWorkspaceMB` bounds them.
- The plugin uses the session's current default model unless `model`/`provider` is configured. It inherits the profile's permission and sandbox settings.
- Runs, contexts, rollouts, and workspaces stay under `.dsh-harness2/runs/` and are ignored by the data directory's `.gitignore`. The adopted harness and library remain visible for inspection and can be committed.

## 8. Verification performed for this release

The repository includes unit tests for the harness surface, validation rules, store/library behavior, workspace copying/diffing, and trajectory rendering. Before the first public release, the plugin was exercised end to end in a disposable DSH headless profile:

1. base probe, INV/DOM proposals, probes, composition, selector, reflection, adoption;
2. a round where the composer kept the base because no edit was supported;
3. a round where a DOM proposal added a verified workspace fact to `memory.md`, the composer kept it, the selector chose the final, and the harness was adopted;
4. a fresh session whose system prompt contained the adopted always-on harness and the library lesson.

See `README.md` for the current status and commands.

## 9. Sources and license

The method, component taxonomy, and several prompt rules are adapted from the Harness² reference release and paper, both under Apache-2.0. See `NOTICE` and `LICENSE`. The DeepSeek Harness integration, DSH surface mapping, isolation, selection, and library code are original to this repository.
