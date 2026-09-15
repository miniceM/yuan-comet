# GitHub 交付实现与验收记录

对应 [Issue #51](https://github.com/miniceM/yuan-comet/issues/51)。设计依据为 `docs/superpowers/specs/2026-09-14-github-delivery-gh-cli-design.md`。

## 实现范围

新增 `domains/github-delivery/` 与 `comet delivery` 命令，集中管理 issue 绑定、稳定验收编号、验证证据、审查记录、授权及远端操作恢复。Classic 使用 Skill 协议和归档后的交付提示接入；Native 已绑定的 PR 收尾通过共享模块检查。未绑定交付的流程保留原有行为。

交付记录位于 Git common directory 的 `comet/github-delivery/`，由同一 clone 的 linked worktree 共享；不写入 workflow 的阶段状态，也不因归档删除。记录通过独立字段区分 PR 创建、合并、未合并关闭及 issue 关闭。

中文协议已确认并同步英文，发布清单包含两套参考文档。当前版本为 0.4.1，`origin/master` 为 0.4.0，本次追加到已有 0.4.1 Changelog，不再次升级版本。

## 验收证据范围

下表的“本地覆盖”指源码、临时 Git 仓库测试及契约测试证据，不等同于真实 GitHub 写入验收，也不等同于真实模型完整执行 Skill。

| 标准      | 本地覆盖     | 主要证据                                                                                                                              |
| --------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| AC-01～03 | 已实现并覆盖 | Classic/Native 绑定、已有 issue 正文确认、稳定 AC 编号、范围修订与源文件漂移测试；双语言阶段协议                                      |
| AC-04～06 | 已实现并覆盖 | 逐项结果、失败/未执行阻塞、独立执行标识检查、过期 HEAD、完整/增量审查链、归档差异验证继承，以及 PR 创建后追加提交再合并的漂移阻塞测试 |
| AC-07～09 | 已实现并覆盖 | PR 正文、full/partial 关系、显式仓库与分支、远端 SHA、所有 PR 状态的仓库/分支/SHA 漂移检查、issue 关闭独立观测测试                    |
| AC-10～12 | 已实现并覆盖 | 分动作授权、每次远端写入前的仓库绑定复核、预写操作日志、丢失响应恢复、确定性失败重试、防重复创建和 gh 错误分类测试                    |
| AC-13     | 已实现并覆盖 | 独立领域模块、Classic/Native 最小接线、架构检查、双语言参考文档与发布清单                                                             |
| AC-14     | 已完成       | 本地检查与隔离仓库真实 `gh` 验收均完成；真实对象见下                                                                                  |

## 验证结果

- `pnpm exec vitest run`：394 个测试文件通过、1 个跳过；4811 项通过、35 项跳过，耗时 360.65 秒。跳过项未算作通过。
- `pnpm exec vitest run test/domains/github-delivery`：41 项通过，包含确定性失败重试、错误仓库写入阻塞、fork 同名分支识别，以及 PR 创建后追加提交再合并的回归覆盖。
- 相关集成/Skill/结构契约测试：9 个文件、213 项通过。
- `pnpm build`、`pnpm exec tsc --noEmit`、`pnpm lint`：通过。Lint 包含架构与 Enterprise Guard 检查。
- 受影响源码、新参考文档、发布清单与 Changelog 的 Prettier 检查、`git diff --check`：通过。既有 8 个 Skill 文件的整文件排版在基线中已不符合 Prettier，本次保留原有密集排版；Open/Design 双语言文件检查通过。
- `node bin/comet.js delivery --help`：通过，编译后 CLI 可列出交付命令。
- `npm pack --ignore-scripts --dry-run --json`：通过，清单包含新 CLI/domain 及双语言参考文档；这只是打包清单检查，不是安装后的端到端测试。
- `pnpm check:generated`：通过；最终 Runtime/Skill/domain 复验 5 个文件、65 项通过。
- 真实隔离仓库 `miniceM/devops-demo`：创建一次性分支 `codex/comet-delivery-e2e-20260915`（SHA `db99ab449e0b21eaaa90fa95ca4fdb41818460c8`），创建 [Issue #7](https://github.com/miniceM/devops-demo/issues/7) 并确认正文包含背景、变更、影响、非目标和 AC-01；首次 issue 响应未观测到时记录为 uncertain，随后 `observe` 找回并绑定同一 issue，再次执行 issue 没有创建重复对象。
- 真实 PR 验收：[PR #8](https://github.com/miniceM/devops-demo/pull/8) 以 `main` 为 base、测试分支为 head，远端 SHA 与 review/verify 一致；正文包含变更、影响、兼容性、逐项 AC 结果、review 证据和 `CI: Pending`。`observe` 后再次执行 pr 复用 #8，未创建重复 PR。PR 和 Issue 均保持 OPEN，未执行合并或自动关闭。

本轮审查修正后的首次全量检查有 393 个文件通过，bundle 兼容性基准在并发运行时出现一次 Skill 文件读取比率波动；该测试隔离复验通过，随后第二次全量检查全部通过。更早的实现检查曾发现发布清单、Native 内容预算/隔离约束与架构测试 fixture 等集成问题，均已在最终检查前修正。

## 审查与边界

本次进行了单独的源码审查步骤，核对持久化、授权、远端恢复、验收证据与 Native 适配的边界。审查意见要求修改后，进一步固定了创建 PR 时已经验证和审查的交付 SHA；远端实际 SHA 单独记录，任何 PR 状态下的仓库、分支或 SHA 漂移都会阻止交付完成。绑定及每次 issue/PR 写入前都会重新核对 Git remote 与 GitHub repository；确定未产生远端副作用的 `gh` 失败进入可重试的 `failed` 状态，只有结果无法判定的失败进入 `uncertain`；同名 fork PR 不再阻塞同仓库 PR。未执行另一独立 Agent 的代码 review，不能把本次自查冒充独立 reviewer 的审查凭据。

当前 provider 支持 github.com 同仓库分支，支持 HTTPS/SSH remote；不支持跨 fork PR 或 GitHub Enterprise hostname。绑定的 base 分支需要已存在于本地。验证与审查命令保存执行方提供的证据，不自行运行测试或判断审查是否真实发生。

操作结果不确定时保留日志并阻止盲目重复创建；查询无结果不会自动解除阻塞。整个 clone 丢失后，本地证据与授权不能自动继承。既有 Native 自定义 provider 在绑定新交付协议后必须使用扩展输入中的正文，最终由 gh 查询验证。

## 尚未执行

- 真实模型完整阶段执行及平台 Hook 端到端验收：本轮未运行；本地契约和 Runtime 检查不代表这两层已通过。
- 本次功能 PR、合并与发布：尚未执行；真实 E2E 的测试 PR/Issue 也保持打开，避免把创建状态误报为合并或关闭。
