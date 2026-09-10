# 上游同步与企业主线分离设计

> 日期：2026-09-01  
> 状态：已确认，待迁移计划审阅

## 目标

让 fork 能持续、无冲突地镜像 `rpamis/comet:master`，同时保留并持续交付
企业定制；上游同步冲突必须在独立、可审阅的集成变更中处理，不能由
GitHub 的 **Sync fork** 对企业产品主线隐式处理。

## 背景与问题

GitHub 提示 fork 的 `master` “ahead 18 / behind 8”，说明同一分支同时含有
企业提交和未合入的上游提交。此时“同步 fork”只能尝试把上游变更合入一个
已分叉的产品分支；共享装配文件发生重叠时，GitHub 无法替代人工解决冲突。

仓库现状进一步表明这不是单个文件的问题：企业代码大多位于
`domains/enterprise-guard/`，但仍需通过 CLI、Hook Router、安装注册和生成资产
接入。隔离 domain 可以缩小冲突面，但无法消除这些受上游维护的接线点的冲突。

本地仅配置了 fork 的 `origin`，未配置明确的 `upstream` remote，因此也缺少可重
复用、可审计的同步起点。

## 决策

采用“双主线 + 上游集成 PR”模型。

```text
rpamis/comet:master
        │
        ▼
miniceM/comet:master                 纯上游镜像，精确对应上游
        │
        ▼
miniceM/comet:enterprise/main        企业产品主线，默认分支与发布来源
        │
        ▼
codex/*、feature/*                   从企业主线创建的短期工作分支
```

### 分支职责

| 分支                   | 允许内容                          | 禁止内容                    | 保护规则                                   |
| ---------------------- | --------------------------------- | --------------------------- | ------------------------------------------ |
| `master`               | 来自 `upstream/master` 的快进同步 | 企业功能、版本发布、常规 PR | 禁止普通推送与 PR；仅同步负责人可更新      |
| `enterprise/main`      | 企业定制、上游集成合并、发布 tag  | 未经验证的直接上游同步      | 需要 CI 与审阅；设为 GitHub 默认分支       |
| `sync/upstream-*`      | 一次上游版本的集成与冲突解决      | 新功能开发                  | 只向 `enterprise/main` 提交 PR，合并后删除 |
| `codex/*`、`feature/*` | 单一企业功能或修复                | 直接修改镜像分支            | 从 `enterprise/main` 创建并向其提 PR       |

`master` 不再是产品开发线；`enterprise/main` 是用户可安装版本、变更日志和 release
tag 的唯一来源。

## 一次性迁移

迁移必须由有仓库管理员权限的负责人执行，并在 GitHub 设置中先将默认分支切换到
`enterprise/main`。迁移前不允许使用“Discard commits”。

1. 读取 `origin/master`、`upstream/master` 的完整 SHA，记录 ahead/behind 与受影响
   文件；若工作树不干净则停止。
2. 添加只读语义的 `upstream` remote，获取上游 refs 和 tags。
3. 从当前 `origin/master` 创建并推送 `enterprise/main`，再创建并推送带日期和旧 SHA
   的备份 tag 及备份分支。两份备份都确认在远端可见后才继续。
4. 将 GitHub 默认分支改为 `enterprise/main`，并为它启用 PR、审阅和 CI 保护；为
   `master` 启用仅同步负责人可更新的保护。
5. 由负责人使用带期望旧 SHA 的 `--force-with-lease` 将 `master` 定位到
   `upstream/master`。这是唯一一次历史重写；它安全的前提是步骤 3 的远端备份已
   验证且默认分支已切换。
6. 验证 fork 的 `master` 与 `upstream/master` 指向同一提交、所有原企业提交仍可从
   `enterprise/main` 和备份分支到达、CI 继续以 `enterprise/main` 为目标。

如果步骤 5 后发现错误，先停止发布；用已经验证的备份 ref 通过同样带 lease 的操作
恢复 `master`，并把默认分支切回备份分支。不得以未验证的 SHA 强推恢复。

## 常规上游同步协议

### 阶段 A：镜像上游

同步负责人在干净工作树中执行以下只影响镜像分支的操作：

```bash
git fetch upstream --prune --tags
git switch master
git merge --ff-only upstream/master
git push origin master
```

`--ff-only` 失败即表示镜像分支已被错误写入，应停止并调查，不能改用普通 merge。

### 阶段 B：将上游集成到企业产品线

从当前 `enterprise/main` 创建集成分支，显式合并已经同步的 `master`：

```bash
git switch enterprise/main
git pull --ff-only origin enterprise/main
git switch -c sync/upstream-YYYYMMDD
git merge --no-ff master -m "chore(sync): integrate upstream master"
```

冲突只在该分支处理。处理顺序为：先解决 domain 源码与少数接线点，再运行对应 build
重新生成 `assets/` runtime；不得在生成的 `.mjs` bundle 中手工拼接冲突结果。随后按
改动风险运行相关测试；由于同步可能跨 Runtime、安装与路由，合入前运行完整测试。

推送该分支并向 `enterprise/main` 创建 PR。该 PR 应包含上游范围、冲突说明、生成物
已重建的证据和验证结果。CI 通过、审阅完成后合入；不自动合入。

## 企业定制边界

- 领域规则、平台差异和策略实现继续放在独立的 `domains/enterprise-guard/`；只通过
  公开导出被消费。
- 上游模块只保留极少的单向装配点：命令注册、Hook Router 入口、安装入口和资产清单。
  新的企业需求不得绕过这些接口向多个 `app/`、`platform/` 或上游 domain 散落逻辑。
- 接线点的变更与企业 domain 变更进入同一 PR；生成资产由构建产生并提交，不作为
  手工维护的逻辑来源。
- 每次上游集成 PR 都记录发生冲突的接线点。连续两次以上冲突的接线点应被列为下一轮
  边界收敛候选，但不借同步 PR 做无关重构。

## 非目标

- 不要求或假设上游接受企业定制。只有可独立、通用且无企业语义的修复，才另行向上游
  发起 PR。
- 不自动合并上游，也不允许机器人在冲突时选择内容。
- 不以 rebase 改写 `enterprise/main` 的共享历史；短期功能分支可在提交 PR 前自行 rebase。
- 不在本设计中改变现有运行时行为、版本号或发布内容。

## 验收标准

1. `origin/master` 与 `upstream/master` 的 SHA 相同，且 `master` 相对上游没有独有提交。
2. 迁移前的全部企业提交可从 `enterprise/main` 或远端备份 ref 到达。
3. GitHub 默认分支是 `enterprise/main`；普通功能 PR 不能目标指向 `master`。
4. 每次上游同步都有一个指向 `enterprise/main` 的 `sync/upstream-*` PR，包含测试和
   生成资产验证证据。
5. 新增企业能力仍集中在企业 domain 与约定装配点，未扩大对上游内部实现的直接依赖。
