# Enterprise Guard 平台覆盖设计

> 日期：2026-08-31  
> 关联：[Issue #5](https://github.com/miniceM/comet/issues/5)  
> 状态：已确认，待实施计划

## 目标

将已完成端到端原型验证的 Claude Code 提升为 Enterprise Guard 的唯一“强制阻断（项目级）”平台，并让所有其他已支持 Comet 平台明确呈现“规则注入 + CI 兜底”的降级状态。用户可通过 `doctor` 与覆盖能力报告检查实际的安装范围、拦截工具、阻断保证和降级路径。

本变更不把未完成 Spike 的平台宣称为受保护，也不扩展 HARD 规则目录或改变 Enterprise Guard 的规则判定语义。

## 现状与约束

- `domains/enterprise-guard/` 已实现 Claude Code 的 `Write`、`Edit`、`Bash` 输入适配、决策输出和受管 Hook 生命周期。
- `domains/skill/` 已提供跨平台的受管 Hook 安装、巡检和卸载能力；Enterprise Guard 只能通过其公开接口接线，不能复制或改变上游平台配置合并语义。
- 原能力矩阵将全部平台标为未完成 Spike。本设计只推广 Claude Code，并将矩阵、Doctor 和用户报告同步为同一事实来源。
- 企业 Guard 防范 Agent 误操作与普通 PR 违规；项目级 Hook 不能抵御可修改本地配置、脚本或 CI 的恶意主体，CI 仍是必要兜底。

## 架构

### 覆盖状态模型

在独立的 Enterprise Guard domain 中定义稳定的覆盖描述，而非在 `app/` 或 `domains/skill/` 中散落平台特例。每个平台的描述包含：

- 平台标识与展示名称；
- 覆盖等级：`enforced-project` 或 `rules-and-ci`；
- 受管安装范围；
- 被 Enterprise Guard 拦截的工具；
- 阻断保证；
- 用户可执行的降级路径或修复命令。

Claude Code 的描述为 `enforced-project`：Comet 在项目或既有支持的全局范围安装唯一的、自身拥有的 Guard Hook；平台的 PreToolUse 协议将 HARD deny 映射为工具调用阻断。该表述限定为“项目级”，不宣称企业受管全局不可绕过。

其余 Comet 平台一律为 `rules-and-ci`：不新增 Enterprise Guard Hook，也不暗示规则文本等同于强制阻断。报告说明其当前路径是规则注入与远端 CI，并指向需要完成的 Spike 条件。

### 生命周期接线

`init`、`update`、`doctor --repair` 和 `uninstall` 继续调用既有 Enterprise Guard lifecycle 接口。

- 对 Claude Code，保持当前安装、巡检、修复和移除行为；只管理 `comet-enterprise-hook.mjs` 对应的条目。
- 对降级平台，安装和修复不写入 Enterprise Guard Hook，卸载也不触碰用户条目；返回与覆盖状态一致的跳过原因。
- 受管条目按脚本路径识别，因此更新和修复应保留用户 Hook 与 Comet Router Hook，并保持重复执行幂等。

### Doctor 与覆盖报告

Doctor 在现有平台检查结果旁报告 Enterprise Guard 覆盖状态：

- Claude Code：Guard 条目存在且完整时显示通过；缺失、重复或陈旧时显示警告及 `doctor --repair` 修复路径。
- 降级平台：显示非错误的降级状态，明确“规则注入 + CI 兜底”，并给出覆盖报告位置；不使用“已保护”“强制阻断”或等价措辞。

覆盖能力报告放在 Enterprise Guard 架构文档目录，面向用户列出全部平台与六类事实：平台、安装范围、拦截工具、覆盖等级、阻断保证、降级路径。它会更新现有能力矩阵，使 Claude Code 的可验证状态与运行时报告一致。

## 错误与安全处理

- 未支持的平台不是安装失败，不应触发破坏性修复或使正常 Doctor 检查失败；必须透明呈现其降级状态。
- Claude 的 Hook 健康问题保留现有可修复警告，不将 Hook 安装状态误报为企业全局不可绕过的控制。
- 文档和命令输出只描述规则 ID、工具类别和覆盖状态，不写入或回显敏感 Hook 输入。
- 本设计不修改策略引擎、例外、findings 或 CI 消费；这些属于 Issue #4 已完成的后续安全闭环，不在本 Issue 再次实现。

## 测试与验证

实现遵循红-绿-重构：先为以下行为编写并运行失败测试，再写最少生产代码。

1. Claude Code 覆盖描述标为项目级强制阻断，并列出 `Write`、`Edit`、`Bash`。
2. 每个非 Claude 平台均标为规则注入 + CI 兜底，且不具备 Enterprise Guard Hook 安装状态。
3. Claude 的 install、update、doctor repair、uninstall 在用户 Hook 与 Router Hook 并存时只管理自身条目，并保持幂等。
4. Doctor 为 Claude 返回可修复的健康结果，为所有降级平台返回透明、非虚假的覆盖状态。
5. 覆盖报告与能力矩阵包含相同的平台覆盖结论，且不把未验证平台声明为强制阻断。

完成后运行 Enterprise Guard、相关 app lifecycle、repository asset/layout 文档测试；因改动跨 domain、app、生成运行时与发布资产，最终运行完整测试集，并重建 Enterprise Guard runtime。

## 非目标

- 不新增 Codex、Copilot、Gemini 或其他平台的 Enterprise Guard adapter。
- 不把文档证据或现有 Hook 配置投影升级为 Spike 通过。
- 不在上游 Router、平台安装器或策略引擎内嵌企业专属判断。
- 不新增 HARD 规则、例外机制、findings 消费协议或 CI 规则。

## 验收映射

| Issue #5 验收项                         | 本设计的交付                                                                           |
| --------------------------------------- | -------------------------------------------------------------------------------------- |
| 强制阻断平台具备 fixture 与生命周期测试 | Claude Code 真实 PreToolUse fixture、并存 Hook、install/update/doctor/uninstall 测试。 |
| 不支持平台的降级状态可见                | Doctor 覆盖状态和用户可读报告对每个平台标注规则注入 + CI 兜底。                        |
| 输出符合平台协议且与策略矩阵一致        | Claude 继续使用现有 Claude 输出适配器；覆盖状态以能力矩阵的 Claude 项目级边界为准。    |
