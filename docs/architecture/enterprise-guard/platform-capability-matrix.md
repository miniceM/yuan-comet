# Enterprise Guard 平台能力矩阵与 Spike 协议

> 版本：v1.2 · 最后更新：2026-09-01 · 负责人：Comet maintainers · 评审：Proposed（Issue #2）

## 结论先行

当前仓库已为 14 个平台声明 Hook 配置投影，但“可以写入 Hook 配置”不等于“企业级 HARD 阻断已验证”。Claude Code 已完成 Gateway 生命周期 Spike，由单一 `comet-enterprise-gateway.mjs` 本地入口承载；但同级 Hook 并行执行且不能互相观察输出，因此 [覆盖能力报告](platform-coverage.md) 将其标记为 `best-effort`。OpenCode 已安装受管 `.js` 插件桥，并在 OpenCode 1.18.26 实测确认自动发现与 Bash 拒绝；但插件顺序和全部工具覆盖仍未验证，因此保持 `best-effort`。其他平台不会因内部能力档案或抽象升级而自动宣称强制阻断。

未验证的平台禁止标记为“强制阻断”。即使官方文档支持 `PreToolUse`，只要并列 Hook、超时、受管安装或 Comet 生命周期没有完成可重复 Spike，后续实现也只能使用项目级候选或 CI 兜底。

### 证据等级

| 等级       | 含义                                                                               | 可用覆盖                                  |
| ---------- | ---------------------------------------------------------------------------------- | ----------------------------------------- |
| 文档证据   | 官方文档已说明至少一个关键输入、阻断或生命周期语义；尚未在目标平台版本执行 Probe。 | 仅可作为 Spike 前提，不能宣称端到端强制。 |
| 仓库投影   | Comet 当前安装器、更新、Doctor 和卸载逻辑会操作该平台格式，但缺少足够官方语义。    | 项目级行为护栏或 CI 兜底。                |
| 未验证     | 缺少可引用的输入/阻断/超时语义，或当前投影与官方格式尚未对齐。                     | 只允许 CI 兜底。                          |
| Spike 通过 | 后续 Issue 在确定平台版本上完成本文全部 Probe，并保存脱敏证据。                    | 可由评审决定提升到项目级或企业受管全局。  |

### 当前 Comet 生命周期事实

当前 Claude Code 会在项目范围内安装单一受管 `comet-enterprise-gateway.mjs`：Enterprise Guard 先于项目发现与 Hook Router 在同一入口内求值，HARD 拒绝时直接短路。`doctor` 只检查 Claude 的这一个受管 Gateway（健康口令 “exactly one managed Enterprise Gateway present”），并把过期 runtime、缺失、重复与遗留双 Hook 归类诊断，由 `comet doctor --repair` 幂等迁移为 Gateway 单条目；卸载只移除自身管理的条目。其余 Hook 平台仍合并受管 Router Hook，`doctor` 对它们检查 Router runtime、重复与遗留 Hook。该流程的验收口令是：`install / update / doctor / uninstall` 都必须在目标平台版本上执行并记录结果。

Claude Gateway 可以写入项目或用户本地配置，但用户本地配置仍不是企业受管全局部署，也不能作为管理员级覆盖的证据。企业受管全局必须使用平台原生的系统、MDM、云策略或等效受保护配置。

## 已核对的平台事实

| 平台             | 原始输入与事件                                                                                                                       | 并列 Hook / 阻断 / 超时语义                                                                                                                                      | Comet 当前投影                                                                                                         | 证据等级与覆盖结论                                                                                                                                |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `claude`         | `PreToolUse` 在工具调用前提供 `cwd`、`tool_name`、`tool_input`、`tool_use_id`。                                                      | 官方文档支持 deny/ask/defer；所有匹配 Hook 并行执行、互相不可见且顺序不确定。Gateway 只保证自身内部 Guard 先于 Router，不能验证同级 Hook 的最终 `updatedInput`。 | `.claude/settings.local.json` 的 `PreToolUse`，指向单一 `comet-enterprise-gateway.mjs`，覆盖 `Write`、`Edit`、`Bash`。 | [Claude Code Hooks](https://code.claude.com/docs/en/hooks) 为文档证据；尽力阻断（`best-effort`）+ CI 兜底。                                       |
| `opencode`       | OpenCode 1.18.26 自动发现项目 `.opencode/plugins/comet-enterprise-guard.js`；`tool.execute.before` 可提供 Bash 工具名与参数。实测 Write 未触发该事件。 | Bash 触发时插件桥抛出异常并阻止执行；插件桥设置 10 秒 Runner 超时并失败关闭。同级插件顺序和宿主超时语义未验证。                                                       | 自动发现受管插件桥与 `comet-enterprise-runner.mjs`；不写入 `opencode.json`。                                   | OpenCode 1.18.26 Bash 拒绝探针通过；尽力阻断（`best-effort`）+ CI 兜底。Bash 之外的工具覆盖待补充 Probe。                                        |
| `codex`          | `PreToolUse` 通过 stdin JSON 提供 `session_id`、`transcript_path`、`cwd`、`hook_event_name`、`model`、`permission_mode` 与工具参数。 | 多个匹配命令 Hook 并发启动，不能假设顺序或互相阻止启动；多数 Hook 默认 600 秒。文档支持受管 `requirements.toml`、`managed_dir` 和仅受管模式。                    | `<repo>/.codex/hooks.json`；安装器当前使用 Claude 形状，但必须由 Spike 比对官方 Codex 形状。                           | [Codex Hooks](https://learn.chatgpt.com/docs/hooks) 为文档证据；企业受管全局候选与项目级候选，尚未端到端验证，CI 必须保留。                       |
| `windsurf`       | `pre_write_code` 在代码写入前触发；输入 JSON 细节待 Probe。                                                                          | 文档显示退出码 2 可以阻断写入；并列 Hook 和超时语义未在本基线确认。                                                                                              | `.windsurf/hooks.json` 的 `pre_write_code`。                                                                           | [Cascade Hooks](https://docs.windsurf.com/de/windsurf/cascade/hooks) 为有限文档证据；项目级候选 + CI 兜底。                                       |
| `github-copilot` | `preToolUse` 输入含 `toolName` 与字符串形式的 `toolArgs`，后者必须再次 JSON 解析。                                                   | 同类型 Hook 按顺序执行，任一 deny 阻断；非超时错误对 `preToolUse` 失败关闭，但 timeout 始终失败开放。管理员 policy Hook 可在系统策略目录安装。                   | `.github/hooks/comet-guard.json` 的 `preToolUse`。                                                                     | [GitHub Copilot Hooks](https://docs.github.com/en/copilot/reference/hooks-reference) 为文档证据；受管全局候选仍必须用 CI 覆盖 timeout fail-open。 |
| `gemini`         | `BeforeTool` 提供 `tool_name`、`tool_input` 与可选 `mcp_context`。                                                                   | Hook 组可显式 `sequential`；否则并发。`decision: deny` 或退出码 2 可阻断当前调用/回合；具体 timeout 行为需 Probe。                                               | `.gemini/settings.json` 的 `BeforeTool`。                                                                              | [Gemini CLI Hooks](https://geminicli.com/docs/hooks/reference/) 为文档证据；项目级候选 + CI 兜底。                                                |
| `grok`           | 没有可靠的官方 Hook 输入契约。                                                                                                       | 不假设 Claude 形状、顺序、阻断或超时与 Grok 兼容。                                                                                                               | `.grok/hooks/comet.json`，当前复用 Claude 形状。                                                                       | 未验证；只允许 CI 兜底。                                                                                                                          |
| `amazon-q`       | `preToolUse` 通过 stdin 提供 `hook_event_name`、`cwd`、`tool_name`、`tool_input`。                                                   | 退出码 2 可阻断；其他非零仅警告并放行；默认 timeout 30 秒。并列 Hook 语义待 Probe。                                                                              | `.amazonq/settings.local.json` 的 `PreToolUse`。                                                                       | [Amazon Q CLI Hooks](https://github.com/aws/amazon-q-developer-cli/blob/main/docs/hooks.md) 为文档证据；项目级候选 + CI 兜底。                    |
| `qwen`           | `PreToolUse` 提供 `cwd`、`tool_name`、`tool_input`、`tool_use_id` 等标准化事件字段。                                                 | 默认并发；`sequential: true` 才串行。退出码 2 阻断，其他非零放行；默认 timeout 60 秒；项目 Hook 可被禁用。                                                       | `.qwen/settings.json` 的 `PreToolUse`。                                                                                | [Qwen Code Hooks](https://qwenlm.github.io/qwen-code-docs/en/users/features/hooks/) 为文档证据；项目级候选 + CI 兜底。                            |
| `kiro`           | `preToolUse` 提供 `hook_event_name`、`cwd`、`session_id`、`tool_name`、`tool_input`。                                                | 退出码 2 阻断，默认 timeout 30 秒；并列 Hook 语义待 Probe。                                                                                                      | `.kiro/hooks/*.kiro.hook`；官方当前示例使用 `.kiro/hooks/*.json`，格式差异必须先消除。                                 | [Kiro CLI Hooks](https://kiro.dev/docs/cli/hooks/) 为文档证据，但当前投影未验证；CI 兜底。                                                        |
| `codebuddy`      | 没有可靠的官方 Hook 输入契约。                                                                                                       | 不假设 Qwen 形状、并列、阻断或超时语义。                                                                                                                         | `.codebuddy/settings.json` 的 `PreToolUse`。                                                                           | 未验证；只允许 CI 兜底。                                                                                                                          |
| `workbuddy`      | 没有可靠的官方 Hook 输入契约。                                                                                                       | 不假设与 CodeBuddy 的投影等同于平台保证。                                                                                                                        | `.workbuddy/settings.json` 的 `PreToolUse`。                                                                           | 未验证；只允许 CI 兜底。                                                                                                                          |
| `qoder`          | 没有可靠的官方 Hook 输入契约。                                                                                                       | 不假设 Qwen 形状、并列、阻断或超时语义。                                                                                                                         | `.qoder/settings.json` 的 `PreToolUse`。                                                                               | 未验证；只允许 CI 兜底。                                                                                                                          |
| `trae`           | 官方配置参考披露 `PreToolUse` 事件；完整输入和故障语义仍需 Probe。                                                                   | Comet 为每个命令设置 30 秒 timeout；平台真实并列和 timeout 语义未确认。                                                                                          | `.trae/hooks.json` 的 `PreToolUse`。                                                                                   | [Trae Hook 配置参考](https://docs.trae.cn/ide_hook-configuration-reference) 为有限文档证据；项目级候选 + CI 兜底。                                |
| `trae-cn`        | 与 `trae` 共享事件投影，但使用独立目录配置。                                                                                         | 不得因共享格式就推断中国版与国际版的运行语义相同。                                                                                                               | 项目 `.trae/hooks.json`，全局 `.trae-cn/hooks.json`；后者仍不是受管全局。                                              | 未验证；只允许 CI 兜底。                                                                                                                          |

## 最小可重复 Spike

每个平台必须在干净工作区、固定平台版本和最小受管脚本下执行以下六项。原始输入中可能含密钥，证据只能保存字段名、类型、长度、路径类别和 SHA-256 摘要。

| Probe       | 操作                                                               | 记录                                                               | 成功标准                                                                        |
| ----------- | ------------------------------------------------------------------ | ------------------------------------------------------------------ | ------------------------------------------------------------------------------- |
| `input`     | 触发一次文件写入和一次 shell 命令。                                | 原始事件字段清单、标准化后的 `EnterpriseHookInput@v1` 与截断状态。 | 事件、工具、工作目录、路径、命令/写入片段的缺失情况可判定；未知字段不破坏解析。 |
| `deny`      | 对一个无害的固定测试路径返回 HARD deny。                           | 平台输出、退出码、是否真的阻止工具执行。                           | 工具未执行，Agent 获得可操作原因。                                              |
| `multiple`  | 配置两个匹配 Hook：一个记录、一个拒绝。                            | 启动顺序、完成顺序、两个 Hook 是否都开始、最终决策。               | 记录真实并列语义；不得再假设“并列 Hook 必定有序”。                              |
| `malformed` | 让 Hook 返回畸形 JSON 与非零退出。                                 | 平台对 stdout/stderr、退出码和工具调用的处理。                     | 明确失败关闭、失败开放或警告；无法判定则保持未验证。                            |
| `timeout`   | 让 Hook 超过显式小 timeout。                                       | 平台 timeout、是否放行、重试/日志行为。                            | 超时语义可复现；任何 fail-open 平台必须保留 CI 兜底。                           |
| `lifecycle` | 依次执行 `install / update / doctor / uninstall`，再重复一次安装。 | 配置路径、重复条目数、Doctor 结果、卸载后用户 Hook 是否保留。      | 恰有一个 Comet 管理的 Hook，无遗留重复，且不会覆盖用户 Hook。                   |

## 提升覆盖等级的门槛

1. 将平台版本、操作系统、配置位置、Probe 脚本 SHA-256 和六项观察结果提交为脱敏证据。
2. 对 `deny`、`multiple`、`timeout` 和 `lifecycle` 都有可重复的通过结果；任何一次失败开放都必须说明为什么 CI 足以兜底。
3. 企业受管全局还必须证明普通用户不能关闭、替换或修改 Hook 配置与脚本，并验证更新/卸载由管理员工具完成。
4. 评审通过后才可把矩阵行标为 `Spike 通过`，并允许后续 Issue 在该平台挂接 HARD 规则。
