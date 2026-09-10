# Enterprise Guard 覆盖能力报告

> 版本：v1.6 · 最后更新：2026-09-03 · 对应 [Issue #17](https://github.com/miniceM/yuan-comet/issues/17)、[Issue #14](https://github.com/miniceM/yuan-comet/issues/14)、[Issue #15](https://github.com/miniceM/comet/issues/15)、[Issue #5](https://github.com/miniceM/comet/issues/5)

## 结论

当前没有平台获得端到端“强制阻断”覆盖。Claude Code 已完成输入、拒绝、Gateway 生命周期与 Doctor 修复验证，但所有匹配的同级 Hook 会并行执行，Gateway 无法检查其他 Hook 返回的最终 `updatedInput`，因此覆盖等级为“尽力阻断（本地 Gateway）”。OpenCode 已在 1.18.26 实测通过项目插件自动发现和 Bash 拒绝，但 Write 未触发插件事件，插件顺序也未验证，因此同样保持“尽力阻断（本地插件桥）”。其他平台仍显示为“规则注入 + CI 兜底”。任何平台都不会因内部能力档案或抽象升级而自动获得强制阻断宣称。

Claude Code 的本地 Guard 拦截 `Write`、`Edit`、`Bash`，由单一 `comet-enterprise-gateway.mjs` 承载：在该入口内部，Guard 先于项目发现与 Comet Hook Router 求值，HARD 拒绝时直接短路；Guard 内部异常也转换为 exit 2。该顺序只约束 Comet 自己的 Guard 与 Router，不能约束并行运行的用户或第三方 Hook，因此覆盖等级为 `best-effort`。远端 CI 继续覆盖同级 Hook 改写参数、本地配置或脚本被修改的情形。此报告不抵御能够修改本地 Hook、配置或脚本的恶意主体。

OpenCode 的本地 Guard 由自动发现的 `comet-enterprise-guard.js` 薄插件桥和受管 `comet-enterprise-runner.mjs` 承载。Bash 在 OpenCode 1.18.26 实测会触发 `tool.execute.before`，Runner 判定拒绝后插件抛出异常并阻止执行；但 Write 未触发该事件，同级插件顺序和宿主超时语义也未完成 Probe，因此覆盖等级为 `best-effort`。远端 CI 继续覆盖未触发工具、参数改写和本地文件被修改的情形。

### 原生边界与 CI 纵深补充

对于未接入或尽力阻断（best-effort）的平台，接入 Git 原生边界与 CI 消费形成纵深补充：

- **Git 原生边界 (`pre-commit` + `pre-push`)**：在代码提交时扫描暂存区敏感文件（`.env` 等）与明文密钥，在推送时阻断向受保护分支（`master`、`enterprise/main`、`release/*` 等）的强推与删除；并在两处均校验本地未解决 HARD findings。原生边界作为本地操作守门，但明确不声称防范非 Git 动作（如直接 `rm -rf`）。
- **CI 远端事实源**：CI 流水线严格调用 reader 消费 `.comet/enterprise-guard/findings.jsonl`，对未解决 HARD findings 或损坏的审计链执行强制失败阻断。

## 平台覆盖

| 平台                   | 安装范围       | 拦截工具          | 阻断保证                               | 降级路径           |
| ---------------------- | -------------- | ----------------- | -------------------------------------- | ------------------ |
| Claude Code            | 项目或用户本地 | Write、Edit、Bash | 尽力阻断（本地 Gateway）               | 规则注入 + CI 兜底 |
| OpenCode               | 项目或用户本地 | Bash              | 尽力阻断（本地插件桥；仅 Bash 已实测） | 规则注入 + CI 兜底 |
| Codex                  | 规则目录       | —                 | 不提供 Enterprise Guard Hook           | 规则注入 + CI 兜底 |
| Windsurf               | 规则目录       | —                 | 不提供 Enterprise Guard Hook           | 规则注入 + CI 兜底 |
| GitHub Copilot         | 规则目录       | —                 | 不提供 Enterprise Guard Hook           | 规则注入 + CI 兜底 |
| Gemini CLI             | 规则目录       | —                 | 不提供 Enterprise Guard Hook           | 规则注入 + CI 兜底 |
| Grok                   | 规则目录       | —                 | 不提供 Enterprise Guard Hook           | 规则注入 + CI 兜底 |
| Amazon Q Developer     | 规则目录       | —                 | 不提供 Enterprise Guard Hook           | 规则注入 + CI 兜底 |
| Qwen Code              | 规则目录       | —                 | 不提供 Enterprise Guard Hook           | 规则注入 + CI 兜底 |
| Kiro                   | 规则目录       | —                 | 不提供 Enterprise Guard Hook           | 规则注入 + CI 兜底 |
| CodeBuddy              | 规则目录       | —                 | 不提供 Enterprise Guard Hook           | 规则注入 + CI 兜底 |
| WorkBuddy              | 规则目录       | —                 | 不提供 Enterprise Guard Hook           | 规则注入 + CI 兜底 |
| Qoder                  | 规则目录       | —                 | 不提供 Enterprise Guard Hook           | 规则注入 + CI 兜底 |
| Trae                   | 规则目录       | —                 | 不提供 Enterprise Guard Hook           | 规则注入 + CI 兜底 |
| Trae CN                | 规则目录       | —                 | 不提供 Enterprise Guard Hook           | 规则注入 + CI 兜底 |
| Oh My Pi               | 规则目录       | —                 | 不提供 Enterprise Guard Hook           | 规则注入 + CI 兜底 |
| DeepSeek Harness (dsh) | 规则目录       | —                 | 不提供 Enterprise Guard Hook           | 规则注入 + CI 兜底 |

## Doctor 与生命周期

Enterprise Gateway、Runner 和插件桥升级为受管 Runtime（`~/.comet/enterprise-guard/`）：

- **版本化存储与原子切换**：安装与更新流程先在隔离的临时版本目录中完整写入并通过 sha256 校验，再原子重命名进入版本目录（`versions/<version>/`），并原子更新当前指针 `current.json`，防止网络中断或写入异常导致半写入损坏；
- **Doctor 巡检**：`comet doctor` 覆盖七维检查（条目唯一性、目标脚本存在性、sha256 摘要一致性、可执行权限、schemaVersion 协议版本、工具覆盖和排序保证）；
- **`doctor --repair` 与 `uninstall` 边界**：`--repair` 幂等修复缺失、过期、损坏或摘要不匹配的受管条目和文件；`uninstall` 仅移除带有受管标记且路径/摘要匹配的对象，完整保留用户自定义 Hook、第三方插件、项目业务文件和 `.comet/enterprise-guard/findings.jsonl` 审计记录。其余平台显示预期的规则注入 + CI 兜底状态，不会安装或移除 Enterprise Guard Hook。
- **平滑兼容**：此前安装的 Claude Enterprise Hook 与 Router 双条目会在安装或更新时迁移为单一 Gateway。

## 提升覆盖等级

任何平台必须先按[能力矩阵的六项 Spike 协议](platform-capability-matrix.md)固定平台版本并提交脱敏证据，覆盖输入、拒绝、并存 Hook、解析失败、超时和生命周期。Claude Code 还需要能够证明 Gateway 检查的是所有同级 Hook 修改后的最终参数，或使用禁止同级参数改写的受管宿主配置；未满足前仍保持 `best-effort`。
