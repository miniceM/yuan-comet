# GitHub 交付

用户要求通过 GitHub issue/PR 交付时使用。已有明确授权继续沿用；缺少某项写入授权时先准备正文和证据，再取得该项授权。未启用的本地流程不要求 gh。

## 接入节点

- Classic Open / Native Shape：需求明确并形成正式需求/spec 后绑定交付；已有 issue 先核对整个 issue 的验收范围，否则经授权创建 issue。
- Classic Design / Native 需求修订：同步 scope；保持已有 AC key，新增项省略 key 自动分配。不得删除旧项，移除目标须标记 retired 并提供新的范围确认依据。
- Verify：逐 AC 收集实际验证结果，提交本轮代码后记录 verify；超时、环境缺失和未执行均填 not-run，不能填 passed。
- Review：使用独立复核执行，记录其身份和证据。Classic/hotfix 即使 review_mode 为 off，只要选择正式 PR，就必须补齐 review；不调用未经用户允许的外部 Skill。
- Archive：沿用原有归档和精确提交步骤。归档后的 HEAD 必须有有效验收和 review；完成后用 delivery push/pr，替代直接 git push/gh pr create。Native 的已绑定 pull-request 收尾由相同模块强制检查。
- 后续恢复：用 delivery list/status 找到记录，observe 核对远端。归档、推送、PR 创建、合并与 issue 关闭分别报告，不能把其中一个当作全部完成。

## 绑定和授权

所有命令输出 JSON。`--path` 必须是绑定的工作区；`--input` 是 JSON 文件，不拼接 shell 正文。记录保存在 Git common directory，归档和删除 linked worktree 不会删除它；整个 clone 丢失后本地授权和证据不能自动继承。

```bash
comet delivery bind --path <project-root> --input <binding.json> --json
comet delivery list --path <project-root> --json
comet delivery status --path <project-root> --id <delivery-id> --json
```

binding.json 示例（替换为真实仓库、当前分支和需求文件；目标分支必须存在于本地）：

```json
{
  "repository": "owner/repo",
  "workflow": "classic",
  "change": "my-change",
  "base": "enterprise/main",
  "head": "codex/my-change",
  "remote": "origin",
  "summary": {
    "title": "变更标题",
    "background": "当前问题",
    "changes": "最终变更内容",
    "impact": "影响范围",
    "nonGoals": "明确不包含的内容",
    "compatibility": "兼容性、迁移与回滚说明；不适用则说明"
  },
  "scope": {
    "confirmation": "本次需求确认的会话或文档引用",
    "items": [
      {
        "internalRef": "原始场景 ID",
        "source": "docs/requirements.md",
        "text": "源文件中真实存在的验收文字"
      }
    ]
  }
}
```

Native 使用 workflow=native，internalRef 沿用真实 acceptance ID；公开 AC key 独立保留。首次默认承诺所有 active AC。部分交付显式指定 committedKeys，仍保留 issue 的全部 AC；只有本次范围覆盖全部 active AC 才能使用 full。

记录某项已有授权：

```bash
comet delivery grant --path <project-root> --id <delivery-id> --input <grant.json> --json
```

grant.json：`{"action":"issue:create","source":"用户明确授权的会话引用"}`。合法 action 为 issue:create、issue:update、push、pull-request:create；issue:update 必须先绑定 issue，并只适用于该 issue。不要把推测或 Agent 自己的决定当作授权。

```bash
comet delivery issue --path <project-root> --id <delivery-id> --json
```

绑定已有 issue 时，先用 `delivery inspect-issue --id <delivery-id> --input <number.json>` 读取正文和 bodyHash（number.json 为 `{"number":51}`），核对后传入 `{"number":51,"expectedBodyHash":"...","scopeConfirmation":"核对整个 issue 范围的确认依据"}`。不自动覆盖手工内容。scope 修订用 `delivery scope --input <scope.json>`；scope.json 结构同 binding.scope，原 AC 带回 key，confirmation 必须反映新的明确确认。

同步 issue 用 `delivery sync-issue --input <sync.json>`，传入当前正文的 expectedBodyHash，且需 issue:update 授权。只更新 Comet 标记区块；检测到远端变化时先重新核对，不能覆盖新编辑。创建 PR 前需确认 issue 全部验收目标已体现在本地 scope；标记区块外新增的需求由执行方核对后纳入，不能忽略。

## 验证和 review 输入

先 status 读取当前 scope.hash、各项 revision；HEAD 用真实 Git 提交。verify 不执行测试，只保存执行方已经获得的证据。

```bash
comet delivery verify --path <project-root> --id <delivery-id> --input <verification.json> --json
```

```json
{
  "head": "实际提交 SHA",
  "manifest": "当前 scope.hash",
  "items": [
    {
      "key": "AC-01",
      "revision": 1,
      "status": "passed",
      "evidence": ["真实测试报告或验收证据引用"],
      "reason": "实际执行与结果"
    }
  ]
}
```

每个 committedKeys 项必须有且只有一个结果；failed/not-run 必须说明原因。源需求文件改变后先重新核对 scope，旧验证不能由重新 review 恢复有效。

```bash
comet delivery review --path <project-root> --id <delivery-id> --input <review.json> --json
```

```json
{
  "kind": "full",
  "base": "binding.baseSha",
  "head": "实际提交 SHA",
  "manifest": "当前 scope.hash",
  "verification": "最新 verifications 项的 hash",
  "reviewer": "独立复核执行标识",
  "builder": "实施执行标识",
  "evidence": "真实 review 报告引用",
  "findings": []
}
```

findings 项包含 severity（critical/important/suggestion）、resolved（布尔）和 text。未解决的 critical/important 阻止 PR。修复后重新验证并完整审查，不能把旧问题无依据改为 resolved。

归档仅发生内容完全相同的文档重命名或空提交时，可用 `delivery carry --input <carry.json>` 保留验证结果：`{"head":"最终 SHA","parent":"前一验证 hash","evidence":"归档差异不影响验收的检查证据"}`。目前只自动允许已登记需求来源文档向归档目录的纯重命名，排除实现、Skill 和配置路径；其他差异必须重新验证。随后做 delta review，kind=delta、parent=前一 review.id、base=前一 review.head，其余字段绑定最终上下文。Manifest 变化则做 full review。

## 交付与恢复

```bash
comet delivery preflight --path <project-root> --id <delivery-id> --resolution full --json
comet delivery push --path <project-root> --id <delivery-id> --resolution full --json
comet delivery pr --path <project-root> --id <delivery-id> --resolution full --json
comet delivery observe --path <project-root> --id <delivery-id> --json
```

部分交付改为 resolution=partial，PR 使用 Related to，保留 issue；full 才使用 Closes。创建 PR 不自动合并。CI 在 PR 正文中标记 Pending，不当作本地已通过。

timeout、连接中断或响应丢失等结果不确定的创建失败先 observe，不重新归档、不重复提交或直接再运行 gh create；查询无结果不是重新创建的依据。`gh` 缺失、未登录、权限拒绝或仓库不可用等确定未写入的失败记为 failed，修复前置条件后可沿用原授权重试。已关闭/已合并 PR 也是已创建事实；所有状态都必须保持远端 HEAD 与原 verified/reviewed SHA 一致，漂移时保留原交付 SHA 并阻止完成。

当前 GitHub CLI provider 支持 github.com 的同仓库分支交付（HTTPS 或 SSH remote），不支持跨 fork head 或 GitHub Enterprise hostname。原有未绑定的 Native repository-command 路径保持兼容；绑定后保留原有 provider 输入结构，并增加 delivery 对象（schema=comet.github-delivery.provider.v1，包含 repository/base/head/headSha/title/body），必须原样使用受审查正文，最终仍由 gh 查询验证。启用前应确认企业自定义命令支持该协议。
