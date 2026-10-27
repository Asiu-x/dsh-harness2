# dsh-harness2

**把 Google Research 的 [Harness²](https://github.com/google-research/harness2)（递归式 Agent Harnessing）做成 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 插件。**

它让 Agent 用真实执行证据改进自己的 harness：先在当前 harness 下跑一个代表性任务，再分别提出 INV（工作方式）和 DOM（领域知识）修改，在同一个任务上探测这些修改，合成改进后的 harness，匿名选择输出，并把采纳的 harness 与经验写进按领域划分的库。

这是对论文方法的 DSH 原生实现，不是论文基准（JobBench / LAB / WorkBuddy-Bench）的复现。论文：[arXiv:2610.14224](https://arxiv.org/abs/2610.14224)。

> 状态：`0.1.0` 早期版本，已在 DSH `0.1.5-rc.1` + Node.js 20+ 上验证。详见 [方法说明](docs/method.md)。

## 安装

```bash
dsh plugin --profile web add github:Asiu-x/dsh-harness2
```

安装后重启 DSH（或重新执行 `dsh web`）。插件带有 DSH bundle patch，会自动加入 profile 插件树。

本地开发：

```bash
git clone https://github.com/Asiu-x/dsh-harness2.git
dsh plugin --profile web add /absolute/path/to/dsh-harness2
```

检查是否加载：

```bash
dsh --profile web --dump-config | grep -A2 harness2
```

## 快速开始

插件注册三个工具：

| 工具 | 作用 |
|---|---|
| `harness2_refine` | 对一个代表性任务跑一轮 Harness² 改进。 |
| `harness2_status` | 查看已采纳的 harness、组件、领域库和最近一次运行。 |
| `harness2_reset` | 归档当前 harness 并恢复种子版本（需 `confirm: true`）。 |

直接对 Agent 说：

```text
用 harness2_refine 改进这个代表性任务：
“读取 data/orders.csv，计算 amount 列总和，把结果写成 result.md，内容只有一行 'Total: <数字>'。”
domain: data-analysis
k: 1
```

`k=1` 的顺序模式大约会启动 9 个子 Agent：1 次基线探测、2 次提议、2 次候选探测、1 次合成、1 次最终探测、1 次选择、1 次反思。会消耗真实模型调用，建议先用小工作区。

人类命令：

```text
/harness2            查看状态
/harness2 library    列出当前领域库
/harness2 reset      归档并恢复种子 harness
```

采纳后，该工作区里的普通 DSH Agent 会在系统提示中收到 harness 的 always-on 文本和最近的经验；新会话启动时即可看到，执行改进的当前会话会在下一步收到一条采纳上下文消息。

## 工作方式

```text
任务 ──► 基线执行 ──► PROPOSE（INV + DOM）──► PROBE ──► COMPOSE ──► 最终探测
                                                          │
                                                          ├─► 匿名 SELECT
                                                          └─► REFLECT ──► 领域库
```

- **Propose**：两个提议者分别修改 harness。INV 改“怎么工作”，DOM 改“这个领域知道什么”。
- **Probe**：每个候选在独立的工作区副本里跑同一个任务，证据是轨迹、产物，以及是否真的交付。
- **Compose**：合成一个 harness；可以合并、整体采纳某个候选，或者保留基线。每条被采纳的修改都要有具体轨迹证据。
- **Select**：匿名比较产物，不比较 harness。基线也进入比较池；没有实际改动或劣于基线的候选不会被采纳。
- **Reflect**：记录每条修改的实际作用，最多提炼一条可迁移经验，写入 `.dsh-harness2/library/<domain>/`。

完整方法、八类组件、DSH 映射与差异见 [docs/method.md](docs/method.md)。

### Harness 文件

`.dsh-harness2/harness/`：

| 文件 | 作用 | 成本 |
|---|---|---|
| `system.md` | 角色与流程 | 常驻上下文 |
| `guardrails.md` | 常驻规则 | 常驻上下文 |
| `memory.md` | 已验证的工作区事实 | 常驻上下文 |
| `tool-guidance.md` | 工具使用指导 | 常驻上下文 |
| `skills/<name>/SKILL.md` | 按需加载的工作流 | 调用时才读 |
| `sub_agents/<name>/AGENT.md` | 委派角色 | 独立上下文 |
| `scripts/<name>.py` | 确定性脚本 | 按需运行 |
| `plugins/<name>.md` | 工具循环中的中间件规则（指导） | 作为规则阅读 |

四个常驻文件默认上限 12,000 字符。技能名必须出现在 `system.md` 或 `guardrails.md` 的触发句中；被引用的脚本必须存在。候选中间件插件只作为指导阅读，本版本不执行。

## 配置

在 profile 的 `cordis.patch.yml` 中覆盖：

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

主要配置项：`dataDir`、`maxAlwaysOnChars`、`maxK`、`concurrency`、`timeoutMinutes`、`maxWorkspaceMB`、`workspaceIsolation`（`copy` / `shared`）、`selection`、`reflection`、`libraryLessons`、`libraryEntries`、`model` / `provider` / `reasoningEffort`。完整默认值见 [README.md](README.md#configuration)。

## 数据目录

```text
.dsh-harness2/
├── harness/        # 当前采纳的 harness
├── state.json      # 采纳状态、领域、run
├── library/        # 按领域的 harness + EXPERIENCE.md
└── runs/<run>/     # progress.log、rollouts、deliverables、proposals、compositions、contexts、workspaces
```

`runs/` 和 `workspaces/` 已被数据目录的 `.gitignore` 忽略；`harness/` 与 `library/` 可以纳入版本管理。

## 验证与限制

已通过单元测试（harness 树与校验、store/library、工作区复制与 diff、轨迹渲染）和端到端冒烟测试：基线成功时不假装采纳；隐藏规则任务中 DOM 提议把已验证事实写入 `memory.md`，合成保留、选择采纳、反思入库；新会话的系统提示确实包含采纳的 harness 与经验。

未验证：论文基准分数；候选中间件插件的执行；大规模仓库下的复制开销。每个探测都会真实执行任务，子 Agent 使用你当前 DSH profile 的工具与权限；在敏感数据上使用前请先检查权限/沙箱设置。

## 许可与致谢

Apache-2.0，见 [LICENSE](LICENSE) 与 [NOTICE](NOTICE)。方法与部分提示词改编自 [google-research/harness2](https://github.com/google-research/harness2)（Copyright 2026 Google LLC，Apache-2.0）。Harness² 是研究发布，不是 Google 官方支持产品；本项目为独立集成，与 Google、DeepSeek 无隶属或背书关系。
