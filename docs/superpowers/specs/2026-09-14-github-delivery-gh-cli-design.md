# GitHub Issue、验收追踪与 PR 交付设计

> Issue: #51 `feat: 为 Comet 工作流接入 GitHub issue、验收追踪与 PR 交付`
>
> 目标分支：`enterprise/main`
>
> 本文档是 Issue #51 的实现设计，中文版本为当前权威版本。设计稳定后再按仓库约定同步英文文档与 Skill。

## 1. 背景

Comet 当前已经具备需求分析、本地开发、验证、代码审查、归档以及部分远程交付能力，但 GitHub Issue、验收标准、代码审查和 Pull Request 之间仍缺少统一、可追溯的交付契约。

Issue #51 希望形成如下闭环：

```text
需求确定
  ↓
创建 / 绑定 GitHub Issue
  ↓
本地开发
  ↓
逐条验收
  ↓
Code Review
  ↓
Archive / Finalize
  ↓
Push
  ↓
Pull Request
  ↓
Merge
  ↓
完整解决时关闭 Issue
```

本设计不合并 Classic 与 Native 的状态机，而是在两套工作流之上增加一个独立的 GitHub Delivery 领域能力。

## 2. 设计目标

本次设计需要同时满足以下目标：

1. Classic Open 与 Native Shape 在需求明确后能够创建或绑定 GitHub Issue。
2. GitHub Issue 中的验收标准使用稳定的业务编号，例如 `AC-01`、`AC-02`。
3. Verify 能够逐条记录验收结果与证据，并区分 `passed`、`failed` 和 `not-run`。
4. 正式 PR 创建前必须完成有效的 Code Review。
5. 即使 Classic 配置为 `review_mode: off`，只要选择正式 PR 交付，也必须补齐一次交付 Review。
6. Archive 后产生的最终差异必须进入审查覆盖范围。
7. PR 正文自动生成验收对照、Review 结果、本地验证和 CI 状态。
8. GitHub 远程状态与 Classic / Native workflow 生命周期状态解耦。
9. GitHub 写操作具有明确授权边界。
10. GitHub 远程操作具备幂等、查询确认和故障恢复能力。
11. 所有 `gh` 写操作显式指定 repository、base、head。
12. 兼容当前 Native Pull Request finish 能力，并逐步抽取为公共领域模块。
13. 新增领域模块必须更新仓库架构约束。
14. 单元测试、契约测试与真实隔离 GitHub 仓库验证共同覆盖交付能力。

## 3. 非目标

本次不包含：

- 自动合并 Pull Request；
- 修改默认分支或分支保护；
- 强制推送；
- 自动发布版本；
- 合并 Classic 与 Native 状态机；
- 修改 Superpowers / OpenSpec 上游原始 Skill；
- 每次提交都向 Issue 发布进度评论；
- 引入新的项目管理平台；
- 修改 website 子模块。

## 4. 核心设计原则

### 4.1 Workflow 生命周期与 GitHub Delivery 状态分离

以下状态不能视为同一个“完成”状态：

```text
workflow archived
push completed
PR created
PR merged
Issue closed
```

因此不得复用 Classic 的 `branch_status` 或 Native 的 phase/workspace 状态表示远程 GitHub 生命周期。

GitHub Delivery 应拥有独立持久化记录，并通过关联键连接 workflow/change。

### 4.2 Classic 与 Native 只提供事实，不拥有 GitHub 交付语义

整体结构：

```text
Classic Open / Verify / Archive ─┐
                                 ├──> github-delivery ───> gh / GitHub
Native Shape / Verify / Archive ─┘
```

Classic 与 Native 的职责是：

- 提供需求和验收源；
- 提供当前 change/workflow 信息；
- 提供 Verify 结果；
- 提供当前分支和最终提交；
- 触发交付动作。

`github-delivery` 负责：

- Issue 创建/绑定/同步；
- 稳定 AC Manifest；
- Review Receipt；
- Delivery Preflight；
- push / PR；
- 幂等恢复；
- PR / Issue 远程状态观察。

## 5. 新增 `github-delivery` Domain

建议新增：

```text
domains/github-delivery/
  types.ts
  store.ts
  acceptance-manifest.ts
  authorization.ts
  review-receipt.ts
  delivery-preflight.ts
  github-cli.ts
  issue-delivery.ts
  pull-request-delivery.ts
  pull-request-renderer.ts
  reconciliation.ts
  index.ts
```

职责划分如下。

### 5.1 `types.ts`

定义公共数据模型：

- `GithubDeliveryRecord`
- `AcceptanceItem`
- `AcceptanceVerification`
- `ReviewReceipt`
- `AuthorizationGrant`
- `RemoteOperation`
- Issue / PR 状态模型

### 5.2 `store.ts`

负责 GitHub Delivery 独立状态的读取和写入。

不得把该状态嵌入 Classic 或 Native 主状态机。

### 5.2.1 存储、提交与恢复边界

- 需求/spec 和不含运行结果的 Acceptance Manifest 快照可以随 change 提交、归档。
- 可变交付记录、授权、不可变历史验证快照、Review Receipt、验证覆盖证明及 Remote Operation Journal 存放在 `<git-common-dir>/comet/github-delivery/<delivery-id>/`，不进入 Git 跟踪。通过 Git common directory 定位，使同一仓库的 linked worktree 共享记录，不依赖当前 change 所在目录。
- `delivery-id` 在首次准备操作前生成并持久化；归档移动和 worktree 清理不删除记录。支持按 delivery-id 或 repository/workflow/change 查询并恢复；恢复入口不要求 active change 仍存在。
- 每条记录采用版本校验、同目录临时文件原子替换和按 delivery-id 的排他锁；同一仓库创建 binding 时也需串行检查，避免并发生成重复关联。先落盘 prepared 操作及其目标、正文 hash，再执行远端写入。
- 最终 HEAD、review 和远端状态的更新不得触发新的源码提交，避免“记录 HEAD → 新提交 → HEAD 失效”的循环。
- 此本地记录随整个 clone 删除而丢失，不承诺跨 clone 自动继承。异机恢复通过远端稳定标识找回 issue/PR；无法恢复的授权和本地验证/review 证据必须重新取得，不从远端正文推断为通过。
- GitHub 关闭/合并状态通过显式恢复或观察操作刷新，记录观察时间；本地快照不是远端当前状态的保证。

### 5.3 `acceptance-manifest.ts`

负责：

- 生成稳定 `AC-xx`；
- 保留 acceptance revision；
- 建立 public AC ID 与内部 acceptance locator 的映射；
- 处理新增、修改和 retired acceptance。

### 5.4 `authorization.ts`

记录本次任务允许的远程动作，例如：

- create issue
- update issue
- push branch
- create PR

权限必须是按任务、按动作记录的，不能将“允许创建 PR”解释为：

- 允许 merge；
- 允许任意 Issue 评论；
- 允许修改其他 Issue；
- 允许修改仓库设置。

### 5.5 `review-receipt.ts`

持久化 Review 结论，并绑定：

- reviewed HEAD；
- Acceptance Manifest；
- Verification 结果。

### 5.6 `delivery-preflight.ts`

在 push / PR 前执行统一检查：

- 本次已确认 AC 是否全部通过，验证上下文和代码覆盖是否有效；
- Review 是否存在；
- Review 是否仍然覆盖当前 HEAD；
- repository/base/head 是否正确；
- 当前任务是否具有对应授权；
- Issue 是否绑定；
- 是否允许使用 `Closes #N`。

### 5.7 `github-cli.ts`

只负责受控执行 `gh`。

要求：

- 参数数组启动；
- 不经过 shell 拼接；
- repository 显式指定；
- base/head 显式指定；
- Markdown 正文使用文件传递；
- 所有写操作支持 timeout 后 reconcile。

### 5.8 `issue-delivery.ts`

负责：

- 创建 Issue；
- 绑定已有 Issue；
- 同步 Comet 管理区域；
- 远端查询和幂等恢复。

### 5.9 `pull-request-delivery.ts`

负责：

- 观察现有 PR；
- 创建 PR；
- 验证 base/head/HEAD SHA；
- timeout / response lost 后的恢复；
- 观察 merged / closed-unmerged 状态。

### 5.10 `pull-request-renderer.ts`

生成 PR body，不允许直接使用 `gh pr create --fill` 作为默认正式交付。

### 5.11 `reconciliation.ts`

统一处理：

```text
prepared
  ↓
remote mutation
  ↓
observed / uncertain
```

当命令超时或响应不确定时，必须先查询远端，再判断是否可以重试。

## 6. GitHub Delivery 独立状态模型

建议逻辑模型：

```ts
interface GithubDeliveryRecord {
  schema: 'comet.github-delivery.v1';

  binding: {
    id: string;
    repository: string;
    workflow: 'classic' | 'native';
    change: string;
    targetBranch: string;
    headBranch: string;
  };

  issue: {
    number: number | null;
    url: string | null;
    status: 'unbound' | 'open' | 'closed';
    resolution: 'full' | 'partial' | null;
  };

  acceptance: {
    revision: number;
    manifestHash: string; // 包含 issue 总范围和本次已确认范围
    items: AcceptanceItem[]; // issue 的全部已知 AC
    issueScopeRevision: string;
    committedKeys: string[]; // 本次 change 承诺完成的 active AC
    scopeConfirmationRef: string;
  };

  verification: {
    headSha: string | null;
    manifestHash: string | null;
    verificationHash: string | null;
    items: AcceptanceVerification[];
    coverage: VerificationCoverage[]; // 验证后纯归档差异的适用性证明
  };

  review: {
    status: 'missing' | 'passed' | 'blocked' | 'stale';
    receipts: ReviewReceipt[];
    finalReceiptId: string | null; // 完整审查或连续 delta 链的末端
  };

  authorization: AuthorizationGrant[];

  push: {
    status: 'not-started' | 'completed' | 'uncertain' | 'failed';
    sha: string | null;
  };

  pullRequest: {
    status: 'not-created' | 'open' | 'merged' | 'closed-unmerged';
    number: number | null;
    url: string | null;
    headSha: string | null;
  };

  issueClosure: {
    status: 'pending' | 'closed' | 'not-applicable';
  };
}
```

这份状态不表示 workflow phase，只表示 GitHub Delivery 的事实。

## 7. 稳定 Acceptance Manifest

Native 当前 acceptance ID 是内容 hash 类型的内部标识。该方式适合机器定位，但不适合作为 GitHub 上公开且长期稳定的 AC 编号。

因此增加独立 public ID：

```ts
interface AcceptanceItem {
  key: string; // AC-01
  internalRef: string; // Native acceptance hash / Classic locator

  source: {
    artifact: string;
    locator: string;
  };

  fingerprint: string;
  text: string;

  lifecycle: 'active' | 'retired';
  revision: number;
}
```

### 7.1 AC 编号规则

#### 文案调整但目标不变

保留原编号：

```text
AC-03 revision 1
→ wording refined
AC-03 revision 2
```

更新 fingerprint，不创建新编号。

#### 新增独立验收目标

新增：

```text
AC-05
AC-06
...
```

#### 删除验收项

不允许直接消失。

改为：

```text
AC-04
lifecycle: retired
reason: ...
```

保留历史与变更依据。

#### 实质性范围扩张

如果超出当前 Issue 的任务边界，应创建新 Issue，而不是无限扩张现有 Issue。

## 8. Issue 管理区块

Comet 不应覆盖用户在 Issue 中手工维护的全部内容。

推荐只维护标记区块：

```md
## Acceptance Criteria

<!-- comet:acceptance:start delivery=abc123 revision=3 -->

- [ ] AC-01 ...
- [ ] AC-02 ...
- [ ] AC-03 ...
<!-- comet:acceptance:end -->

<!-- comet:metadata
delivery-id: abc123
workflow: native
change: my-change
acceptance-hash: sha256:...
-->
```

Issue 其余区域可以由用户继续编辑。

同步时只更新 Comet managed block。

隐藏 metadata 同时承担两个作用：

1. 识别该 Issue 是否已经由本次 change 绑定；
2. Issue 创建响应丢失时用于远端查询和幂等恢复。

## 9. Issue 创建和绑定流程

需求明确后：

```text
requirements confirmed
  ↓
build Acceptance Manifest
  ↓
已有 issue?
  ├─ yes → validate scope → bind
  └─ no
       ↓
     authorization?
       ├─ no → record pending
       └─ yes → create issue
```

已有 Issue 时必须核对：

- repository；
- Issue state；
- 当前 scope；
- change 是否已经绑定；
- acceptance managed block 是否与 Manifest 一致。

不能因为 Agent 没有看到本地 binding 就直接重复创建 Issue。

## 10. Verify：逐 AC 记录状态与证据

统一模型：

```ts
interface AcceptanceVerification {
  key: string;
  acceptanceRevision: number;
  status: 'passed' | 'failed' | 'not-run';
  evidenceRefs: string[];
  reason?: string;
}
```

### 10.1 `failed`

表示验收实际执行并得到失败结果。

### 10.2 `not-run`

表示未完成有效执行，例如：

- 环境缺失；
- 外部依赖不可用；
- 命令超时；
- 工具不存在；
- 当前平台不能执行；
- 用户未授权所需外部动作。

`not-run` 不能自动转为 passed。

### 10.3 PR Gate

正式 PR 的默认要求：

```text
所有 committedKeys 对应的 active AC == passed
且 verification 对当前 Manifest 和最终代码仍有效
```

Issue #51 本次正式范围不得通过“从 PR 中暂时省略失败 AC”的方式绕过。

如果属于明确的部分交付，应：

- Issue 保持 open；
- PR 使用 `Related to #N`；
- 不使用 `Closes #N`；
- 交付记录 resolution = partial。

### 10.4 Issue 总范围与本次交付范围

`acceptance.items` 保存绑定 issue 的全部已知验收项，`committedKeys` 保存需求确认时承诺由本次 change 完成的子集，并保存确认依据与 issue 范围版本。二者共同参与 manifestHash。已有 issue 的范围不能由当前 change 的子集覆盖。

- 正式 PR 要求 committedKeys 非空、全部指向有效 active AC，且每项都有唯一的当前版本通过结果。
- 本次范围之外的 issue AC 在 PR 中标为“不属于本次交付”，不能标记 PASS；issue 保持未完成状态。
- 只有 committedKeys 覆盖 issue 全部 active AC 且均有效通过，才能选择 full 和 `Closes`；本期对多个部分 PR 的累计完成不自动推断 full。
- 创建 PR 前重新核对 issue 范围；远端范围有变化或无法确认时阻止 full 判定，先完成冲突核对和范围确认。
- 缩减 committedKeys、retire AC 或改变验收语义必须保留变更依据和明确确认，禁止为绕过失败而自动缩小范围。

### 10.5 验证有效性与代码覆盖

Preflight 独立验证 `verification.manifestHash == acceptance.manifestHash`，并核对每项 acceptanceRevision、结果唯一性和证据引用。验收文案/目标、生命周期或承诺范围变化时，原验证快照失效；受影响项变为 not-run。未受影响项仅在显式确认适用性后迁入新快照，不能只重新签发 Review Receipt。

验证代码版本必须等于最终 HEAD，或由以下证明连续覆盖到最终 HEAD：

```ts
interface VerificationCoverage {
  fromHeadSha: string;
  toHeadSha: string;
  manifestHash: string;
  diffHash: string;
  reason: string;
  evidenceRef: string;
}
```

覆盖证明只适用于已检查且不改变产品行为、验收语义或测试结果的归档差异。实现、Skill、配置、生成 runtime 或有语义变化的 spec 修改须重新执行受影响验证，并明确其余证据继续适用的依据。未知差异按需要重新验证处理。新快照或覆盖证明改变 verificationHash，之后再签发对应 Review Receipt；review 本身不能替代验证。

## 11. Review Receipt

不能只存储：

```text
reviewed = true
```

Review 必须绑定具体代码版本和验收上下文：

```ts
interface ReviewReceipt {
  id: string;
  kind: 'full' | 'delta';
  parentReceiptId: string | null;
  diffHash: string;
  baseSha: string;
  headSha: string;

  acceptanceHash: string;
  verificationHash: string;

  status: 'passed' | 'blocked';

  findings: ReviewFinding[];
  evidenceRef: string;
}
```

### 11.1 Freshness

Delivery Preflight 必须检查：

```text
finalReceipt.headSha == current delivery HEAD
finalReceipt.acceptanceHash == current manifest hash
finalReceipt.verificationHash == current verification hash
verification context and final code coverage are valid
review coverage chain is continuous and all receipts passed
```

任意一个不一致，Review 变为 `stale`，阻止正式 PR。

完整回执必须以已确认的审查基线为起点，`parentReceiptId = null`；delta 回执通过 parentReceiptId 引用不可变父回执，其 baseSha 必须等于父回执 headSha，且父提交必须是子提交的祖先。每段 diffHash 均从实际 Git 差异重算，不能只比较字符串或把旧回执的 HEAD 改为新 HEAD。

父回执保留原验证快照与证据，不要求其 verificationHash 等于最终快照；必须能读取对应历史快照，并证明其有效性通过第 10.5 节延续到最终版本。Manifest 变化则重新做完整审查。末端回执绑定最终验证快照，汇总整条链未解决的问题，不允许仅凭最后一段无问题就覆盖父段阻塞项。

## 12. Classic `review_mode: off`

Classic 现有语义应继续保留：

```text
local-only archive / keep
→ 可以继续尊重 review_mode: off
```

但是：

```text
正式 PR delivery
→ delivery.requiresReview = true
```

因此即使：

```yaml
review_mode: off
```

或 hotfix 默认关闭自动 review，只要选择创建正式 PR，就必须完成至少一次交付 Review。

这样可以避免修改 Classic 原有本地 workflow 策略，同时满足 Issue #51。

## 13. Archive 后最终差异审查

一个典型风险流程：

```text
implementation
  ↓
Verify
  ↓
Review
  ↓
Archive
  ↓
Archive 又生成新 commit
  ↓
push / PR
```

此时 PR HEAD 并不是原先 Review 的 HEAD。

因此引入 Review Coverage Chain。

### 13.1 实现代码 Review

对实现 HEAD 做完整 Code Review。

### 13.2 Archive Delta Review

Archive 后比较：

```text
reviewedHead..finalArchiveHead
```

如果最终差异只包含：

- archive metadata；
- spec 状态；
- verification report；
- 文档归档调整；

仅在内容检查确认没有产品行为、验收语义或验证结果变化后，允许做轻量 delta review；文件路径或扩展名不能单独决定。先记录第 10.5 节的验证覆盖证明，再追加引用原实现回执的 delta 回执，使末端 headSha 等于 finalArchiveHead。原完整回执不得被覆盖或丢弃。

可变 delivery metadata 位于 Git common directory，不应出现在归档提交中。归档前后若出现其他未知差异，必须明确分类并补充验证/审查，不能默认归入轻量路径。

如果差异包含实现代码路径，例如：

```text
app/
domains/
platform/
scripts/
```

则必须：

- 补充相关 Verify；
- 补充完整或增量 Code Review；
- 生成新的 Review Receipt。

正式 PR 的 HEAD 必须被有效 Review 覆盖。

## 14. Native 现有 Pull Request 能力的演进

当前 Native 已具备：

- `gh pr list`
- `gh pr view`
- `gh pr create`
- create failure 后 re-observe
- repository-specific PR command

这些逻辑应尽量复用，但从 Native 专属模块中抽取到 `github-delivery`。

### 14.1 默认 PR 创建命令

当前默认 `gh pr create --fill` 不满足 Issue #51 的 PR body 契约。

调整为：

```text
gh pr create
  --repo owner/repo
  --base enterprise/main
  --head <change-branch>
  --title <title>
  --body-file <prepared-file>
```

必须显式提供：

- `--repo`
- `--base`
- `--head`

正文通过临时文件传递。

### 14.2 Native 保持 Archive phase

不增加新的 Native phase。

Native Archive 内部拆为：

```text
Archive
 ├─ Local Finalization
 │   └─ archive commit
 │
 └─ Delivery Continuation
     ├─ final preflight
     ├─ final review freshness
     ├─ push
     └─ PR
```

即：

- workflow phase 仍然叫 Archive；
- 本地 archive 完成与 GitHub remote completion 是两个独立事实。

## 15. Classic 接线点

### 15.1 Open

需求明确后：

1. 生成 Acceptance Manifest；
2. 创建或绑定 Issue；
3. 保存 delivery binding。

### 15.2 Design

当设计导致验收标准变化时：

1. 更新 Manifest；
2. bump revision；
3. 同步 Issue managed block；
4. material scope expansion 时要求重新确认或新建 Issue。

### 15.3 Verify

将现有验证结果投影为：

```text
AC-xx → passed / failed / not-run → evidence
```

### 15.4 Archive

用户选择正式 PR 时：

```text
delivery preflight
  ↓
required review
  ↓
archive
  ↓
final diff review
  ↓
push
  ↓
PR
```

## 16. Native 接线点

### 16.1 Shape

最终 Shape 确认附近：

- 生成稳定 Acceptance Manifest；
- 创建或绑定 Issue；
- 建立 delivery binding。

### 16.2 Verify

将 Native acceptance/verifier 结果映射到 public `AC-xx`。

Native 内部 hash ID 可以继续变化，但 GitHub public AC ID 保持稳定。

### 16.3 Archive

`finish=pull-request` 时：

```text
local archive
  ↓
delivery preflight
  ↓
review freshness
  ↓
archive delta review
  ↓
push
  ↓
PR
```

## 17. PR 正文模板

推荐：

```md
## Summary

<最终变更摘要>

## Scope / Impact

<影响范围>

## Compatibility / Migration / Rollback

<兼容性、迁移、回滚；不适用时明确说明>

## Acceptance

| AC    | Result | Evidence |
| ----- | ------ | -------- |
| AC-01 | PASS   | ...      |
| AC-02 | PASS   | ...      |
| AC-03 | PASS   | ...      |

## Review

Reviewed commits: `<base>..<head>`

Result: PASS

Remaining Critical findings: 0
Remaining Important findings: 0

## Verification

### Local

- `pnpm ...` — PASS
- `pnpm ...` — PASS

### CI

Pending — CI result is not treated as local verification.

## Issue

Closes #51
```

### 17.1 Issue 关联规则

本次范围覆盖 issue 全部 active AC，且当前版本全部有效通过：

```text
Closes #51
```

部分交付：

```text
Related to #51
```

创建 PR 不代表 Issue 已完成。

## 18. PR / Merge / Issue Closure 状态

PR 状态至少区分：

```text
not-created
open
merged
closed-unmerged
```

规则：

### PR open

Issue 保持 open。

### PR closed-unmerged

Issue 保持 open。

### PR merged + full resolution

可以确认 Issue 是否已经由 `Closes #N` 自动关闭。

如果自动关闭未发生，则记录：

```text
issueClosure.status = pending
```

之后由明确授权的动作处理。

### PR merged + partial resolution

Issue 继续保持 open。

## 19. Remote Operation Journal

所有有副作用的远程操作需要操作日志。

例如：

```ts
interface RemoteOperation {
  operationId: string;

  kind: 'issue-create' | 'issue-update' | 'push' | 'pr-create';

  repository: string;

  base?: string;
  head?: string;
  headSha?: string;

  status: 'prepared' | 'completed' | 'uncertain' | 'failed';

  remoteRef?: string;
}
```

## 20. 幂等与恢复

### 20.1 PR 创建 timeout

不能直接再次执行 `gh pr create`。

操作日志已有 PR 编号时，优先按编号查询，不受当前 PR 状态或分支重命名影响。没有编号时先按绑定分支查询所有状态并完整处理分页；该过滤查询没有候选时，还必须扩大到仓库全部 PR 按稳定操作标识核对，避免 base/head 被修改后漏检：

```text
gh pr list
  --repo owner/repo
  --state all
  --base <base>
  --head <head>
```

找到候选后：

```text
gh pr view
  --repo owner/repo
  <number>
```

校验：

- repository 和 head repository 身份；
- base/head 与 prepared 操作目标；
- PR body 中的 delivery-id 和 operation-id（创建前写入）；
- 原提交与当前 head SHA，以及 open/merged/closed 状态。

分支或 SHA 变化时先保留候选，核对稳定操作标识，不把它视为“不存在”。候选歧义保持 uncertain，不创建新 PR。找到本次 PR 后，不论 open、merged 还是 closed-unmerged，创建操作均已发生；保存编号与实际状态。closed-unmerged 不自动重建，merged 不重复交付；open PR 的当前 HEAD 与待交付 HEAD 不符时报告漂移，不能宣告当前版本已交付。

确认是本次 PR：

```text
operation = completed
```

查询失败、分页不完整、仅搜索无结果或远端尚未可见，都不构成“不存在”的证明。记录 uncertain 并继续只读核对；不能自动再次创建。只有确认先前写操作未发生且没有匹配对象时，才允许在原授权和同一 operation-id 下重试。PR 创建与查询之间没有服务端幂等键保证，无法判定的情况应明确保留待处理状态。

### 20.2 Issue 创建 timeout

Issue body 内保存：

```text
delivery-id: <stable id>
```

Issue 同时保存 operation-id。发生不确定结果时，查询全部状态、处理分页并核对正文中的稳定标识；搜索仅用于发现候选，搜索未命中不能证明未创建。存在匹配对象则绑定并保存其实际状态，多个匹配对象或无法确认结果则保留 uncertain。采用与 PR 相同的重试判定，不因单次空结果重复创建。

### 20.3 push 成功、PR 创建失败

恢复时：

```text
不重新 Archive
不重新 commit
不重复 push
只恢复 PR create
```

禁止为了恢复 PR 而改写已经成功的远程分支。

## 21. GitHub CLI 约束

所有远程写操作显式指定目标。

例如：

```text
gh issue create --repo owner/repo ...
gh issue edit --repo owner/repo ...
gh pr create --repo owner/repo --base ... --head ...
gh pr view --repo owner/repo ...
```

不得依赖：

```text
current working directory
git remote implicit selection
default branch guess
```

尤其本仓库必须使用：

```text
base = enterprise/main
```

不得向镜像：

```text
master
```

提交企业变更 PR。

## 22. GitHub 能力按需检查

`gh` 只在实际使用 GitHub 功能时要求存在。

本地：

```text
Build
Verify
Archive keep
```

不应因为：

```text
gh not installed
GitHub unreachable
```

而无条件失败。

只有进入：

```text
issue remote write
push
PR
remote observation
```

时才执行对应能力检查。

错误必须明确区分：

- `gh` 缺失；
- 未登录；
- repository 无权限；
- Issue 权限不足；
- Contents 权限不足；
- Pull Request 权限不足；
- 网络失败；
- timeout；
- remote state uncertain。

## 23. 配置模型

建议新增共享配置：

```yaml
github_delivery:
  enabled: true

  repository:
    target_branch: enterprise/main

  issue:
    enabled: true

  pull_request:
    provider: github-cli

  review:
    required_for_pull_request: true
```

### 23.1 Native 兼容

当前：

```yaml
native:
  finish:
    pull_request:
      provider: repository-command
```

第一阶段不直接移除。

内部将其适配为：

```text
legacy Native PR provider
  ↓
shared github-delivery provider interface
```

待公共能力稳定后再评估配置迁移。

## 24. Repository-specific PR Provider

企业项目可能仍然需要自己的 PR 命令。

共享 provider interface 可以保留：

```text
github-cli
repository-command
```

但无论 provider 类型如何，必须经过共享的：

```text
Delivery Preflight
Review gate
Acceptance gate
remote verification
```

自定义命令不能绕过安全与验收规则。

## 25. 授权模型

示意：

```ts
interface AuthorizationGrant {
  action: 'issue:create' | 'issue:update' | 'push' | 'pull-request:create';

  repository: string;
  issueNumber?: number;
  headBranch?: string;
  targetBranch?: string;

  grantedAt: string;
  source: string;
}
```

授权原则：

1. 已明确授权的同一动作不重复询问。
2. 授权作用域不能静默扩大。
3. 创建 PR 不表示允许 merge。
4. 创建 Issue 不表示允许修改任意 Issue。
5. push 只允许绑定的 branch/repository。
6. 不把长期 unrestricted GitHub write token 放进 prompt、spec 或日志。

## 26. Delivery Preflight

正式 PR 创建前至少检查：

```text
1. delivery binding exists
2. repository matches
3. target branch matches
4. head branch matches
5. committed AC nonempty, unique, current and all passed
5a. verification manifest/revisions match and final code coverage is valid
5b. issue total scope and confirmed delivery scope reconciled
6. no unresolved Critical findings
7. no unresolved Important findings
8. Review Receipt exists
9. final Review Receipt is fresh and coverage chain is valid
10. final archive delta covered
11. push authorization exists
12. PR create authorization exists
13. Issue relation is valid
14. full / partial resolution decided
```

任何检查失败：

```text
不得执行 gh pr create
```

## 27. Review 严重级别 Gate

正式 PR 前：

```text
Critical = 0
Important = 0
```

Suggestion 可以继续保留，但必须在 Review 摘要中可见。

如果 Review 后实现代码变化：

```text
Review Receipt stale
```

重新补充 Review。

## 28. 仓库架构约束

新增 `domains/github-delivery/` 后，必须同步：

```text
config/repository-layout.json
```

并确保：

```text
pnpm run lint:architecture
```

通过。

测试目录新增：

```text
test/domains/github-delivery/
```

Classic 与 Native 不允许通过新的共享模块反向互相依赖。

建议依赖方向：

```text
comet-classic ─┐
               ├──> github-delivery
comet-native ──┘

github-delivery ──X──> comet-classic
github-delivery ──X──> comet-native
```

## 29. 测试策略

测试分四层。

### 29.1 `github-delivery` 单元测试

建议：

```text
test/domains/github-delivery/
  acceptance-manifest.test.ts
  authorization.test.ts
  delivery-preflight.test.ts
  issue-delivery.test.ts
  pull-request-renderer.test.ts
  pull-request-delivery.test.ts
  reconciliation.test.ts
  review-receipt.test.ts
  store.test.ts
```

覆盖：

- AC stable key；
- wording revision；
- retired AC；
- per-AC verification；
- Review freshness；
- permission scope；
- PR body；
- full/partial Issue link；
- timeout reconciliation；
- wrong base/head；
- duplicate prevention；
- AC 修改后旧 PASS 失效，重新 review 不能恢复旧验证；
- committedKeys 与 issue 总范围分离，未授权缩减范围被拒绝；
- full/delta 回执链断裂、父段阻塞、过期验证和未知归档差异被拒绝；
- common-dir 存储跨 worktree 恢复、原子写入、并发 binding 与操作串行；
- 归档清理不删除交付日志，更新回执不改变 Git HEAD；
- PR 响应丢失后已 merged/closed、候选漂移、查询失败/分页不完整均不重复创建。

### 29.2 Classic Contract Tests

覆盖：

- Open 创建/绑定 Issue；
- Design 同步 Acceptance；
- Verify 投影 AC；
- `review_mode: off` + local-only；
- `review_mode: off` + PR 必须 Review；
- Archive final diff review；
- PR gate。

### 29.3 Native Contract Tests

覆盖：

- Shape binding；
- public AC 与 Native hash acceptance 映射；
- Verify projection；
- Archive local finalization；
- PR continuation；
- legacy `native.finish.pull_request` 兼容。

当前 `native-pull-request-finish.test.ts` 等现有测试应尽量迁移或复用。

### 29.4 隔离 GitHub Runtime Test

使用明确授权的隔离测试仓库真实验证：

1. Issue create；
2. Issue reuse；
3. Issue managed block update；
4. push；
5. PR create；
6. PR observe；
7. timeout / lost response recovery；
8. wrong base rejection；
9. permission failure；
10. push completed + PR failed recovery。

真实 GitHub 验证不能被 mock 单元测试替代。

## 30. Targeted Vitest

针对小范围文件执行 Vitest 时，应避免 coverage threshold 导致：

```text
tests pass
coverage threshold fail
```

影响局部开发反馈。

局部测试应使用仓库认可的 targeted test 配置。

最终验收仍需执行适用的：

```text
unit tests
contract tests
build
architecture lint
full verification
runtime smoke
real GitHub acceptance
```

局部测试通过不能替代最终全量验证。

## 31. Issue #51 AC 映射

### AC-01

> Classic Open 和 Native Shape 能创建或绑定 Issue。

对应：

- `acceptance-manifest.ts`
- `issue-delivery.ts`
- Classic Open adapter
- Native Shape adapter

测试：

- create；
- existing issue reuse；
- duplicate prevention。

### AC-02

> Issue 包含背景、范围、非目标和稳定 AC 编号。

对应：

- Issue renderer；
- Acceptance Manifest。

测试：

- stable `AC-xx`；
- managed block formatting。

### AC-03

> 设计验收变化可追溯同步。

对应：

- acceptance revision；
- issue update；
- retired AC；
- material scope policy。

测试：

- wording change preserves AC；
- removed AC becomes retired；
- material expansion is blocked/prompted.

### AC-04

> Verify 逐项生成状态和证据。

对应：

- `AcceptanceVerification`；
- Classic/Native Verify adapter。

测试：

- passed；
- failed；
- not-run；
- timeout/environment unavailable。

### AC-05

> 验收或 Review 未完成时不能创建正式 PR。

对应：

- Delivery Preflight；
- Review Receipt。

测试：

- failed AC；
- not-run AC；
- missing review；
- Classic review off；
- Native。

### AC-06

> Review 对应具体提交，后续修改和 Archive 差异得到检查。

对应：

- Review Receipt；
- final delta review；
- freshness。

测试：

- HEAD changed → stale；
- acceptance changed → stale；
- archive metadata-only delta；
- code delta requires new review。

### AC-07

> PR 包含完整交付信息。

对应：

- `pull-request-renderer.ts`

测试：

- Summary；
- Scope；
- Compatibility / Migration / Rollback；
- AC matrix；
- Review；
- Local Verify；
- CI Pending。

### AC-08

> repository/head/base 明确，本仓库 base 为 enterprise/main。

对应：

- GitHub CLI wrapper；
- Preflight。

测试：

- explicit repo；
- explicit head；
- `enterprise/main`；
- reject `master`。

### AC-09

> 正确处理完整解决、部分交付、PR merge 与 Issue closure。

对应：

- Pull Request state；
- Issue closure state。

测试：

- open PR；
- merged；
- closed-unmerged；
- partial；
- full + `Closes #N`。

### AC-10

> 授权不静默扩张。

对应：

- authorization domain。

测试：

- create PR != merge；
- issue create != arbitrary issue edit；
- scoped push；
- repeated same action reuses authorization。

### AC-11

> timeout 后先观察再重试。

对应：

- Operation Journal；
- reconciliation。

测试：

- PR created but response lost；
- Issue created but response lost；
- push completed + PR failed。

### AC-12

> gh / auth / permission / remote failure 有明确恢复信息。

对应：

- GitHub CLI error taxonomy。

测试：

- gh missing；
- unauthenticated；
- permission denied；
- network；
- timeout。

### AC-13

> 独立模块与仓库架构规则通过。

对应：

- `domains/github-delivery/`
- `repository-layout.json`
- architecture linter
- Skill 中文/英文同步

测试：

```text
pnpm run lint:architecture
```

### AC-14

> 完成单元、契约、全量和真实 GitHub 验证。

对应：

- test layering；
- isolated runtime repository；
- final delivery report。

## 32. 实施顺序

建议拆为八个阶段。

### Phase 1：公共领域模型

实现：

- `github-delivery` domain；
- Delivery state；
- Acceptance Manifest；
- Store；
- architecture layout。

暂不做远程写操作。

### Phase 2：Issue Binding

实现：

- create/bind；
- managed block；
- metadata；
- reconciliation。

先接一个最小 workflow adapter 验证领域接口。

### Phase 3：Verification + Review Gate

实现：

- per-AC verification；
- Review Receipt；
- Delivery Preflight；
- stale detection。

### Phase 4：抽取 Native PR 逻辑

从现有 Native PR finish 中抽取：

- observe PR；
- verify PR；
- create/reconcile。

替换默认 `--fill` 为显式 body-file。

### Phase 5：Classic 接入

接入：

```text
Open
Design
Verify
Archive
```

重点完成：

```text
review_mode: off + PR delivery
```

的强制 Review。

### Phase 6：Native 接入

接入：

```text
Shape
Verify
Archive
```

保留 Native phase，拆分 local archive finalization 与 remote delivery continuation。

### Phase 7：Skill 与文档

按仓库约定：

```text
先中文
确认
再英文
```

同步 Classic / Native / Verify / Review / Archive 的用户可见行为。

### Phase 8：完整验证

执行：

- targeted tests；
- domain tests；
- Classic contract；
- Native contract；
- build；
- architecture lint；
- full verification；
- isolated GitHub runtime test。

## 33. 兼容与迁移

### 33.1 Classic

不改变：

- Classic lifecycle schema；
- 本地-only review_mode 语义；
- 原有 Archive phase。

仅当使用 GitHub Delivery 时增加额外交付 Gate。

### 33.2 Native

不增加 phase。

当前 `native.finish.pull_request` 第一阶段继续兼容，由 adapter 转为共享 provider。

### 33.3 已有项目

`github_delivery` 缺失时：

- 现有本地工作流继续工作；
- 不应因为缺少 `gh` 而失败；
- 仅当调用新 GitHub 功能时要求配置和 GitHub 能力。

## 34. 安全边界

GitHub Delivery 必须遵守：

1. 不把 token 写入 prompt、spec、report 或状态文件。
2. 不在 shell 中拼接 Markdown。
3. 不使用隐式 repo/base/head。
4. 不自动扩大授权。
5. 不因 PR 创建成功而宣告 merge 成功。
6. 不因 workflow archive 而宣告 GitHub delivery 完成。
7. remote mutation 不确定时不盲目重试。
8. 不把 CI Pending 写成 PASS。
9. 不把 `not-run` 写成 PASS。
10. 不把 partial delivery 写成 `Closes #N`。

## 35. 关键设计决策

本设计最重要的三个决策是：

### 35.1 `AC-01` 是稳定的业务 ID

Native 的内容 hash acceptance ID 继续作为内部 locator，但不能作为 GitHub 上稳定公开的验收编号。

### 35.2 Archive、PR Created、PR Merged、Issue Closed 是四个独立事实

不得压缩成一个 workflow “done” 状态。

### 35.3 PR 的最终 HEAD 必须被 Review 覆盖

Archive 在 Review 之后产生 commit 时，必须对最终差异执行 delta review；如果改变实现代码，则需要重新验证和审查。

## 36. 完成定义

Issue #51 只有在以下条件满足时才可以认为实现完成：

- `github-delivery` 公共领域模块存在；
- Classic 与 Native 均完成最小接线；
- AC 使用稳定 public ID；
- Verify 有逐 AC evidence；
- Review Receipt 可检测 stale；
- Archive final diff 被覆盖；
- PR body 完整；
- repo/base/head 显式；
- full/partial Issue 关系正确；
- timeout/recovery 幂等；
- repository architecture lint 通过；
- 中文 Skill 更新并同步英文；
- 单元与契约测试通过；
- 完整构建/架构验证通过；
- 在隔离测试仓库执行真实 `gh` 验收，并如实记录未执行项。
