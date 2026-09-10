# Enterprise Guard 设计基线

> 版本：v1.1 · 最后更新：2026-09-01 · 负责人：Comet maintainers · 评审：Proposed（Issue #2）

本目录是 Enterprise Guard 的可引用设计基线，对应 [Issue #2](https://github.com/miniceM/comet/issues/2)，并作为 [Issue #1](https://github.com/miniceM/comet/issues/1) 与后续实现 Issue 的前置依赖。当前覆盖结论见 [平台覆盖能力报告](platform-coverage.md)，对应 [Issue #5](https://github.com/miniceM/comet/issues/5)：Claude Code 由单一 `comet-enterprise-gateway.mjs` 本地入口承载 Guard 与 Hook Router，但同级 Hook 的并行执行使当前覆盖只能标记为 `best-effort`；覆盖等级与各平台宿主能力登记以覆盖报告为准。

## 目标与边界

目标是在实现任何企业级 HARD/SOFT Guard 前，先统一输入、结果、例外、失败分级和平台能力的事实来源。后续实现必须以本目录的 Schema 和政策为准；若平台实测结果与本文不一致，先更新矩阵和版本化契约，再改变运行时行为。

本基线不实现 Hook bundle、安装器、Router 接线或 L4/L7 消费逻辑。它也不改变现有 `CometHookRequest` 和 `CometHookDecision` 的行为：这两者仍是当前工作流阶段 Router 的兼容接口，而不是 Enterprise Guard 输入/输出。

## 阅读和消费顺序

1. [输入契约](contracts/enterprise-hook-input.v1.schema.json)：将平台原始事件标准化为 `EnterpriseHookInput@v1`，保留解析失败、未知字段和截断事实。
2. [规则结果契约](contracts/enterprise-rule-result.v1.schema.json)：每个规则独立产生一个稳定的 HARD/SOFT 决策结果。
3. [例外契约](contracts/enterprise-exception.v1.schema.json)：只允许受保护、可审计、会过期的外部例外记录。
4. [策略与规则目录](policy.md)：定义规则边界、失败分级和例外判定。
5. [威胁模型](threat-model.md)：明确三层覆盖能防什么、不能防什么。
6. [平台能力矩阵](platform-capability-matrix.md)：决定某个实现能否把平台 Hook 用作阻断点，还是必须只依赖 CI。
7. [覆盖能力报告](platform-coverage.md)：汇总当前每个平台的安装范围、拦截工具、阻断保证与降级路径。
8. [findings 消费协议](review-consumption.md)：L4 `/sdd-review` 的 reader 消费规则与 L7 基线完整性检查。

## 兼容性规则

- Schema 的 `schemaVersion` 是协议版本，不是 Comet 包版本。破坏性字段变更必须新增 `v2` 文件，而不是改写 `v1`。
- 标准化层必须把字段不可用、解析失败或载荷被截断表示为事实；不得推断为“无命令”“无写入”或安全的空字符串。
- 一个规则结果只描述一个规则，不得用“总放行”覆盖尚未求值或 `abstain` 的规则。
- 例外只对精确规则和精确范围生效；没有例外记录时，文本中的“已批准”“ignore guard”或同义表达没有任何效力。
- 平台文档中的“候选”不是强制阻断承诺。只有矩阵记录了可重复 Spike 证据、且超时/故障语义可接受时，后续 Issue 才能升级覆盖等级。

## 本次不作出的安全承诺

Enterprise Guard 防范 Agent 误操作和普通 PR 违规。它不宣称抵御能够改写本地 Hook、Hook 配置、已安装脚本或本地 CI 配置的恶意主体；这类场景必须依赖企业受管全局策略和远端 CI 保护。详见[威胁模型](threat-model.md)。
