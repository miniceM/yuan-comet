---
name: comet-upstream-sync
description: 将上游仓库 rpamis/comet:master 代码快进同步至本地 master 镜像分支，并在独立的隔离分支中安全集成到 enterprise/main 企业主线，提供冲突解决规范、资产重建和全量回归指引。同步上游最新代码或合并上游更新时使用。
disable-model-invocation: true
---

# Comet 上游同步

> 本 Skill 为仓库维护者/开发者专用内部能力，不作为面向终端用户的公开 Skill 发布或安装。
> 在执行任何 Git 切换、合并、推送或 PR 前，先读取 `../comet-github/references/maintainer-contract.md`。
> 整个同步流程严格遵循[双主线拓扑与上游同步设计](../../../docs/superpowers/specs/2026-09-01-upstream-sync-topology-design.md)及 `AGENTS.md` 中的“上游同步与双主线”强制规范。

## 双主线拓扑架构

```text
upstream/master (rpamis/comet)
        │
        ▼ (git merge --ff-only)
origin/master (纯上游镜像，严禁直接合入企业提交或常规 PR)
        │
        ▼ (创建 sync/upstream-YYYYMMDD 隔离分支显式合入)
origin/enterprise/main (企业产品主线，默认分支与发布来源)
        │
        ▼
codex/*、feature/* (从企业主线创建的短期工作分支)
```

## 步骤 1：环境与状态前置检查

1. **检查工作区状态**：
   ```bash
   git status --short --branch
   ```
   必须在干净的工作树中执行。若有未提交的改动或冲突状态，停止操作并先妥善处理。

2. **验证 Remote 配置**：
   ```bash
   git remote -v
   ```
   - 确认 `upstream` 指向 `https://github.com/rpamis/comet.git`（或 SSH 形式 `git@github.com:rpamis/comet.git`）。若缺失，执行：
     ```bash
     git remote add upstream https://github.com/rpamis/comet.git
     ```
   - 确认 `origin` 指向企业 fork（如 `https://github.com/miniceM/yuan-comet.git`）。

3. **刷新远程引用**：
   ```bash
   git fetch upstream --prune --tags
   git fetch origin --prune
   ```

4. **校验镜像分支纯洁性**：
   ```bash
   git log upstream/master..master --oneline
   ```
   `master` 分支必须与 `upstream/master` 保持一致，不得有任何独有提交。若存在独有提交，说明镜像已被污染，**严禁使用 Discard commits 或普通 merge 修复**；必须联系仓库管理员按规范通过带预期 SHA 的 `--force-with-lease` 重置恢复。

## 步骤 2：快进同步上游镜像到 master

1. **切换并快进合并**：
   ```bash
   git switch master
   git merge --ff-only upstream/master
   ```
   `--ff-only` 失败即表示镜像分支存在异常提交，应立即停止并调查，不得改用普通 merge。

2. **推送更新至企业远端镜像**：
   在获得明确授权后，将更新推送到企业 fork 镜像：
   ```bash
   git push origin master
   ```

## 步骤 3：创建隔离分支集成到企业主线

1. **切换并刷新企业产品主线**：
   ```bash
   git switch enterprise/main
   git pull --ff-only origin enterprise/main
   ```

2. **创建独立的隔离同步分支**：
   分支命名格式为 `sync/upstream-YYYYMMDD`（如 `sync/upstream-20260904`）。**严禁直接在 `enterprise/main` 上执行 merge**：
   ```bash
   git switch -c sync/upstream-YYYYMMDD
   ```

3. **显式合并 master 镜像**：
   ```bash
   git merge --no-ff master -m "chore(sync): integrate upstream master"
   ```

## 步骤 4：冲突解决与资产重建规约

若合并产生冲突，严格遵循以下规约：

1. **源码与接线点优先**：
   - 企业定制功能收敛在独立模块（如 `domains/enterprise-guard/`），上游通用模块只保留最小侵入装配点（命令注册、Hook Router 接入、安装清单）。
   - 仅解决源码与配置文件冲突，不要把定制逻辑散落嵌入上游模块内部。

2. **严禁手工拼接构建生成物**：
   - 绝对禁止在 `assets/skills/comet/scripts/*.mjs` 等生成的 bundle 文件上手工解决冲突或拼凑代码！
   - 源码冲突解决后，必须通过构建脚本重新编译生成 runtime 资产：
     ```bash
     pnpm build:classic-runtime
     pnpm build:native-runtime
     pnpm build:entry-runtime
     pnpm build
     ```

3. **版本号与元数据核验**：
   - `package.json` 中的版本号遵循企业主线版本，不被上游版本覆盖。
   - 同步核验 `pnpm-lock.yaml`（执行 `pnpm install`）、`assets/manifest.json` 与 `CHANGELOG.md`。

4. **暂存与提交**：
   - 只暂存明确解决的路径（禁止宽泛的 `git add .`）：
     ```bash
     git add <解决冲突的文件>
     git commit -m "chore(sync): resolve upstream merge conflicts and rebuild runtime assets"
     ```

## 步骤 5：全量验证

由于上游同步涉及跨模块、跨 Runtime 和安装路由的高风险改动，合入前必须运行完整校验：

1. **架构与格式检查**：
   ```bash
   pnpm run lint:architecture
   pnpm format:check
   ```

2. **运行测试**：
   - 先运行受冲突影响的最小相关测试。
   - 最终提交前运行全量回归测试：
     ```bash
     pnpm test
     ```

## 步骤 6：安全交付与 PR 合入

1. **推送集成分支**：
   在获得用户明确授权后，推送同步分支到远端：
   ```bash
   git push origin sync/upstream-YYYYMMDD
   ```

2. **向 enterprise/main 发起 PR**：
   - **PR Base 分支必须选择 `enterprise/main`**，严禁指向 `master`。
   - PR 描述中清晰列出：
     - 上游同步的 commit 范围与 upstream SHA。
     - 解决的冲突文件列表及处理说明。
     - Runtime 资产已重新构建并验证的证据。
     - 本地全量测试与架构检查通过的输出结果。

3. **合入与分支清理**：
   - 经远端 CI 绿灯并通过维护者审阅后合入 `enterprise/main`。
   - 合并完成后，删除本地和远端的 `sync/upstream-YYYYMMDD` 分支。
