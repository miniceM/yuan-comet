# Enterprise Guard 基线实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 为后续 Enterprise Guard 实现提供经测试的策略契约、规则边界、威胁模型和平台能力事实基线。

**架构：** 基线只新增独立的 `docs/architecture/enterprise-guard/` 文档与 JSON Schema；不接线现有 Hook Router，不生成 Hook bundle，也不改安装器。仓库级测试把 Schema 版本、规则编号、例外字段、平台覆盖和强制阻断声明锁定为可回归的契约。

**技术栈：** Markdown、JSON Schema Draft 2020-12、Vitest、Node.js 文件读取。

---

## 文件结构

- `docs/architecture/enterprise-guard/README.md`：基线入口，说明范围、消费顺序与父/子 Issue 关联。
- `docs/architecture/enterprise-guard/contracts/enterprise-hook-input.v1.schema.json`：平台 Hook 输入的可扩展标准化结构。
- `docs/architecture/enterprise-guard/contracts/enterprise-rule-result.v1.schema.json`：规则求值结果的稳定输出结构。
- `docs/architecture/enterprise-guard/contracts/enterprise-exception.v1.schema.json`：受保护例外记录的最小字段与审批/CI 证据。
- `docs/architecture/enterprise-guard/policy.md`：HARD/SOFT、未知/解析失败矩阵、规则目录和例外机制。
- `docs/architecture/enterprise-guard/threat-model.md`：三层覆盖、信任边界与不作出的安全承诺。
- `docs/architecture/enterprise-guard/platform-capability-matrix.md`：14 个支持 Hook 平台的证据、能力等级、降级路径和可重复 Spike 步骤。
- `test/repository/enterprise-guard-baseline.test.ts`：验证上述设计基线完整且不会把未验证平台写成强制阻断。

### 任务 1：先建立失败的基线契约测试

**文件：**

- 创建：`test/repository/enterprise-guard-baseline.test.ts`

- [x] **步骤 1：编写失败的测试**

```ts
import { promises as fs } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const root = path.resolve('docs/architecture/enterprise-guard');
const artifacts = [
  'README.md',
  'contracts/enterprise-hook-input.v1.schema.json',
  'contracts/enterprise-rule-result.v1.schema.json',
  'contracts/enterprise-exception.v1.schema.json',
  'policy.md',
  'threat-model.md',
  'platform-capability-matrix.md',
];

it('ships a complete enterprise guard design baseline', async () => {
  const missing = (
    await Promise.all(
      artifacts.map(async (artifact) =>
        (await fs
          .access(path.join(root, artifact))
          .then(() => true)
          .catch(() => false))
          ? null
          : artifact,
      ),
    )
  ).filter((artifact): artifact is string => artifact !== null);

  expect(missing).toEqual([]);
});
```

- [x] **步骤 2：运行测试验证失败**

运行：`npx vitest run test/repository/enterprise-guard-baseline.test.ts`

预期：FAIL，断言报告尚未创建的 Enterprise Guard 文档与 Schema 路径。

### 任务 2：写入版本化契约和策略边界

**文件：**

- 创建：`docs/architecture/enterprise-guard/contracts/enterprise-hook-input.v1.schema.json`
- 创建：`docs/architecture/enterprise-guard/contracts/enterprise-rule-result.v1.schema.json`
- 创建：`docs/architecture/enterprise-guard/contracts/enterprise-exception.v1.schema.json`
- 创建：`docs/architecture/enterprise-guard/README.md`
- 创建：`docs/architecture/enterprise-guard/policy.md`
- 创建：`docs/architecture/enterprise-guard/threat-model.md`

- [x] **步骤 1：定义输入、结果和例外 JSON Schema**

输入 Schema 的 `schemaVersion` 固定为 `comet.enterprise-hook-input.v1`，并要求 `platform`、`event`、`workingDirectory`、`tool`、`command`、`writes`、`parse`、`truncation`；所有可截断载荷必须携带 `capturedBytes`、`originalBytes` 与 `truncated`。结果 Schema 固定为 `comet.enterprise-rule-result.v1`，并提供 `hard`/`soft` 分类和 `allow`/`deny`/`warn`/`abstain` 决策。例外 Schema 强制规则 ID、原因、负责人、到期时间、受保护审批和通过的 CI 证据，且不提供文本旁路字段。

- [x] **步骤 2：写入可直接消费的政策与威胁模型**

规则目录使用 `EG-HARD-ENV-001`、`EG-HARD-SECRET-001`、`EG-HARD-RM-001`、`EG-HARD-GIT-001`、`EG-SOFT-*` 等稳定 ID，分别说明 `.env`、密钥、危险删除和 force push 的正反例。策略明确：解析失败或未知输入不能被伪装成 allow；HARD 且无法安全判断时 deny，SOFT 则 warn 并交 CI 复核。威胁模型分别描述项目级、企业受管全局和 CI 兜底，只承诺防范 Agent 误操作与普通 PR 违规，不抵御能改写本地 Hook 或安装文件的主体。

### 任务 3：记录平台 Spike 事实与降级策略

**文件：**

- 创建：`docs/architecture/enterprise-guard/platform-capability-matrix.md`

- [x] **步骤 1：列出全部 14 个当前 Hook 平台**

矩阵必须包含 `claude`、`codex`、`windsurf`、`github-copilot`、`gemini`、`grok`、`amazon-q`、`qwen`、`kiro`、`codebuddy`、`workbuddy`、`qoder`、`trae`、`trae-cn`。每行都包含输入字段、多个 Hook 的顺序/并发语义、阻断和超时语义、项目/全局安装位置、install/update/doctor/uninstall 兼容性、证据 URL 和覆盖等级。

- [x] **步骤 2：只把有证据的平台标为强制候选**

将 Claude Code、GitHub Copilot、Gemini CLI、Qwen Code、Kiro、Amazon Q、Windsurf 和 Trae 的官方 Hook 参考作为已查证事实；缺少完整运行实证、无企业受管全局能力或 timeout fail-open 的平台只能标为 `项目级候选` 或 `CI 兜底`。文档必须明确“未验证的平台禁止标记为‘强制阻断’”。

- [x] **步骤 3：定义可重复的最小 Spike**

为每个平台指定 allow、deny、并列 Hook、解析失败、超时、install/update/doctor/uninstall 的观测项、记录字段和成功标准。不得把单次手工成功或配置文件存在视为强制阻断证据。

### 任务 4：扩展测试断言并验证交付物

**文件：**

- 修改：`test/repository/enterprise-guard-baseline.test.ts`

- [x] **步骤 1：扩展测试以读取 Schema 和文档正文**

断言三个 Schema 的 `$schema`、固定 `schemaVersion`、必填字段、HARD/SOFT 分类、决策枚举以及审批/CI 例外证据；断言政策包含四项 HARD 规则、禁止内联旁路措辞和未知/解析失败矩阵。断言矩阵包含 14 个平台、CI 兜底与“未验证的平台禁止标记为‘强制阻断’”的降级规则。

- [x] **步骤 2：运行测试验证通过**

运行：`npx vitest run test/repository/enterprise-guard-baseline.test.ts`

预期：PASS，输出 `1 passed`。

- [x] **步骤 3：运行文档格式检查**

运行：`pnpm exec prettier --check docs/architecture/enterprise-guard docs/superpowers/plans/2026-08-28-enterprise-guard-baseline.md test/repository/enterprise-guard-baseline.test.ts`

预期：所有文件格式正确。

## 交付判断

- 所有验收标准均在任务 2–4 中有对应产物或测试。
- 无 `TODO`、待定策略或将未验证能力描述为强制阻断的措辞。
- 不修改 `app/`、`domains/`、`platform/`、`assets/`、安装器或生成运行时；因此不需要构建 Runtime 或提升版本号。
- 本次只建立未来能力的设计基线，没有用户可运行的行为变更，不写 `CHANGELOG.md`。
