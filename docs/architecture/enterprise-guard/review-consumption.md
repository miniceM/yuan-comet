# Enterprise Guard findings 消费协议

> 版本：v1.0 · 最后更新：2026-08-31 · 负责人：Comet maintainers

`enterprise-guard` 在项目目录的 `.comet/enterprise-guard/findings.jsonl` 追加审计记录。该文件是追加日志，不是直接由 L4 阅读的 API；L4 和 `/sdd-review` 必须调用领域 reader `readEnterpriseFindings(projectRoot)`，由 reader 验证 [finding 契约](contracts/enterprise-finding.v1.schema.json) 并计算状态。

## L4 / `/sdd-review` 消费规则

1. 调用 `readEnterpriseFindings(projectRoot)`，不得自行宽松解析 JSONL，也不得把原始行回显到终端、评论或报告。
2. `status: "blocked"` 时必须使评审失败：这表示存在 HARD `deny` 或 findings 损坏、缺失必要字段、不可读取。输出只可列出规则 ID 和不可逆 `fingerprint`。
3. `status: "warn"` 时必须保留人工复核项：可展示规则 ID、路径和 `exceptionId`，但不能将其解释为已通过的安全检查。
4. `status: "clear"` 仅表示 findings 中没有阻断或告警；它不替代测试、代码审查或其他 CI 检查。

示例：

```ts
const report = await readEnterpriseFindings(projectRoot);
if (report.status === 'blocked') {
  throw new Error(
    `Enterprise Guard review blocked: ${report.findings.map((finding) => finding.ruleId).join(', ')}`,
  );
}
```

## L7 baseline integrity 与 CI 自动消费

CI 必须运行 `pnpm run lint:enterprise-guard`。该检查同时执行以下两项任务：

1. **基线与契约完整性**：以 [baseline](contracts/enterprise-guard-baseline.v1.json) 为事实来源，验证规则目录、JSON Schema、独立策略/reader 源码与已发布 Hook bundle 对同一组版本和规则 ID 达成一致；同时断言 Git 原生边界 (`domains/enterprise-guard/git-boundary.ts`) 与 CI 消费端 (`scripts/lint/check-enterprise-findings.mjs`) 均完整实现。
2. **自动化 Findings 审查**：自动调用 `node scripts/lint/check-enterprise-findings.mjs`。若工作区内存在未解决 HARD findings 或审计链损坏，CI 立即以非零状态码阻断，确保未经授权的违规变更无法合入主线。
