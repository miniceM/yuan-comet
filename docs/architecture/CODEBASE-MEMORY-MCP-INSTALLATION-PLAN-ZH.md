# codebase-memory-mcp 统一安装集成实现方案

关联需求：[Issue #32](https://github.com/miniceM/yuan-comet/issues/32)。

状态：实现设计，尚未实现。日期：2026-09-08。

## 1. 目标与决策

在现有 `comet init` 依赖选择中新增 codebase-memory-mcp（下称 CBM），复用平台选择、作用域、安装结果、退出码及 `doctor`。保留 CodeGraph 实现和参数语义；两者允许共存，但 CBM 首次安装必须明确选择。

本期采用独立 domain 和最小接线，不建设通用插件框架，不迁移 CodeGraph，不修改工作流状态机、Rule、Hook Router 或内置 Skill。安装成功仅表示程序、配置及索引达到对应检查条件，不承诺 Agent 必然使用图工具。

## 2. 已确认的现状

- `app/commands/init.ts` 的 `selectNpmDeps` 对缺失依赖默认勾选，`--yes`/`--json` 也会选择缺失依赖。CBM 不能直接继承这条规则。
- 现有 CodeGraph 在依赖选择、安装结果、失败判定及 JSON 输出中都有接线；新增集成必须覆盖完整结果链路。
- `domains/integrations/codegraph.ts` 以 `.codegraph` 和 CodeGraph CLI 状态判断索引，不能复用为 CBM 状态解析器。
- `platform/install/platforms.ts` 已提供平台 ID 和配置目录能力，但 Skill/Hook 支持不代表 MCP 支持；MCP 目标需独立能力表。
- 官方文档提供 `npm install -g codebase-memory-mcp`、手动 stdio MCP 配置及 `cli index_repository`。第三方 `install` 还可能配置指令和生命周期 Hook，因此本方案不调用该命令。

## 3. CLI 与交互契约

新增 `--codebase-memory <action>`，允许 `install|init|skip`：

| 输入                    | 行为                                                              |
| ----------------------- | ----------------------------------------------------------------- |
| 交互勾选 CBM            | 等价于 install，完成程序、所选平台 MCP 配置及项目索引             |
| install + project       | 确保程序、注册所选平台、初始化或复用当前项目索引                  |
| install + global        | 确保程序、注册所选平台的全局 MCP；不索引调用目录                  |
| init + project          | 确保程序并处理项目索引；不修改 Agent 配置                         |
| init + global           | 参数错误，任何安装写入前拒绝                                      |
| skip                    | 不安装、不注册、不索引；返回 skipped                              |
| 未传参数 + --yes/--json | 不首次启用 CBM；保持原有组件的行为                                |
| 未传参数 + 交互         | 显示 CBM 的程序、配置状态，首次默认不选；已有配置保留，不自动删除 |

示例（新增参数为待实现接口）：

```bash
comet init . --platform claude --scope project --codebase-memory install --yes
comet init . --scope project --codebase-memory init --json
```

实施时用平台注册表确认示例平台 ID。已有 MCP 配置只作为展示和复用依据，不等于允许后台修改。重复执行显式 install 可以补齐缺失步骤。旧 `--codegraph` 参数与默认行为保持原样；希望只使用 CBM 的调用者可显式传 `--codegraph skip`。

## 4. 模块边界

```text
app init / doctor / update
             ↓ 公开导出
 domains/code-intelligence/
   index.ts                 公开入口
   types.ts                 安装计划、结果与诊断契约
   plan.ts                  动作选择、前置条件、步骤依赖
   codebase-memory.ts       CBM 命令与版本协议适配
   project-identity.ts      项目路径与索引匹配规则
   diagnostics.ts           状态归一化、修复计划
             ↓
 platform/install/mcp-targets.ts      平台 MCP 格式、路径、作用域能力
 platform/install/mcp-config.ts       配置读取、局部修改、并发保护
 platform/process/ 中的进程执行能力
 platform/fs/ 中的文件写入能力
```

文件拆分可按实现规模合并，但依赖方向固定。平台路径、JSON/JSONC/TOML/YAML 差异留在 platform；domain 不直接散落平台差异。新文件通过公开导出被 app 单向组合，不反向调用 app，也不把新规则写入 CodeGraph 模块。

同步 domainModules、架构 linter、AGENTS 结构说明及 `test/domains/code-intelligence/`。新 platform 文件使用现有模块根，不新增顶层源码目录。

## 5. 安装执行模型

先生成安装计划再执行：解析参数 → 检测程序及配置 → 校验平台/作用域 → 安装程序 → 逐平台合并 MCP → 处理项目索引 → 复查 → 统一汇总。

- 预检完成前不安装程序。全部所选 MCP 目标都不支持时返回明确失败，不先下载再报错；部分支持时继续支持的平台并汇总其他失败。
- 程序安装只执行一次，不随平台数重复执行；使用数组参数执行进程，路径不拼接为 shell 字符串。
- 首选复用兼容的已有程序；缺失时沿用项目 npm 可执行程序发现能力安装固定、经测试的 CBM 版本。安装后重新解析绝对启动路径并探测版本与必要 CLI 能力。
- 不默认升级用户已有程序。版本或协议不兼容时返回诊断与明确操作建议。
- 配置、索引各自返回结果。配置失败不抹掉已成功平台；索引失败保留程序和有效 MCP 配置，允许重试。
- CLI 超时只停止当前子进程，不清理用户共享 CBM daemon 或其他工作树任务；后续查询实际索引状态，不把超时等同于后端必然停止。
- 不开启团队共享索引导出，不创建 graph.db.zst，不修改用户全局 auto-index/cache 配置。

### 发行版验证任务

编码第一步固定一个已发布版本，读取该 tag 的 npm 包和 CLI 帮助，确认：包安装脚本只分发运行资产；stdio 启动方式；版本查询方式；CLI 参数和 JSON 返回；index_status 新鲜度信息；实际支持 OS/CPU。检查已有版本时以必要能力和测试过的版本范围判断。

文档 main 与 Context7 索引可能领先或落后发行版，不能把其中版本号直接当作兼容基线。若 npm 安装存在额外配置副作用，则改用经校验的发行资产安装方式，并补齐下载校验和平台测试后才开放自动安装。

## 6. MCP 配置与所有权

建立以平台 ID 为键的显式目标表，包含支持作用域、配置路径解析器、格式、服务条目位置、stdio 配置构造器及官方依据。不得根据 skillsDir 推断 MCP 文件位置。

首轮核验当前 CodeGraph 已识别的 Claude Code、Cursor、Codex、OpenCode、Hermes、Gemini CLI、Antigravity、Kiro 与 Comet 平台注册表的交集；逐个确认准确的配置路径和格式后启用。其他平台返回 unsupported，不静默回退到全局。能力表和对应 fixtures 是发布前必交付内容，不能只完成当前开发机的平台。

服务使用稳定名称 `codebase-memory-mcp`，启动配置优先使用已解析的程序路径；各客户端的配置形状由平台适配器生成，不将通用 JSON 形状强加给所有客户端。

合并规则：

1. 没有条目：添加该条目，保留其他内容。
2. 存在语义等价且有效条目：复用，包括合理的用户 env/args；不重写整个文件。
3. 存在不同名称的等价 CBM 服务：识别并复用，避免重复注册；多个候选不确定时报告冲突。
4. 同名冲突、禁用状态或不明启动配置：报告冲突，`--yes` 不覆盖；本期即使传 `--overwrite` 也不擅自覆盖未确认属于 Comet 管理的 MCP 配置，因为现有选项指向 manifest-managed 文件。
5. 畸形配置：停止该目标写入，返回文件位置和解析错误，不创建空配置覆盖原文件。

写入需局部修改并保留注释及非目标内容。实现前盘点现有保格式编辑工具；现有普通 TOML/YAML parse/stringify 不自动满足此要求。需要新增依赖时按对应官方文档选定方案，不能用脆弱正则处理任意嵌套配置。

以真实配置路径加锁；锁内重读、检查目标片段、写同目录临时文件、原子替换并校验。检测到外部编辑时重新规划或返回冲突，不覆盖编辑。验证 Windows 替换行为和失败清理；备份包含原权限，不在 JSON 输出配置原文或环境变量值。

## 7. 索引身份和生命周期

使用 realpath 规范化工作树根目录，再从 CBM 项目列表按 repo_path 等实际路径字段匹配。不要按仓库 basename 匹配，不把 Git common-dir 当工作树身份，不自行猜测工具默认项目名。

已存在唯一匹配则复用 CBM 返回的 project 标识；无匹配则显式提交 repo-path 索引，随后重新列表确认对应关系。若选定版本不暴露可验证的路径字段，需要通过其支持的接口补证；无法验证时不得标记 ready。

新增/修改文件、重命名、删除及切换分支后的状态需要真实集成测试。两棵 worktree、两个同名仓库必须对应不同身份。单次 CLI 与常驻 MCP 的 watcher 生命周期不同，不能用“曾索引成功”推断长期新鲜。

使用默认用户缓存位置，不为每个 worktree 设置不同 CBM_CACHE_DIR，以免与共享 daemon 的缓存根约束冲突。可共享 daemon，但逻辑索引归属必须分离。

## 8. 结果、doctor 与 update

新增顶层 `codebaseMemory` 对象，保留原 `codegraph` 字段。平台结果增加可选的同名组件结果，并接入失败、安装、跳过统计和现有退出码映射，避免 JSON 显示失败但进程退出成功。

诊断最小契约：

```ts
interface CodebaseMemoryDiagnostic {
  requested: 'install' | 'init' | 'skip' | 'auto';
  cliStatus: 'installed' | 'missing' | 'incompatible' | 'unknown';
  indexStatus: 'not_applicable' | 'missing' | 'indexing' | 'ready' | 'stale' | 'failed' | 'unknown';
  freshness: 'current' | 'stale' | 'unknown' | 'not_applicable';
  agents: Array<{
    platform: string;
    scope: 'project' | 'global';
    status: 'registered' | 'missing' | 'conflict' | 'invalid' | 'unsupported';
  }>;
  repairable: boolean;
  remediation: string | null;
}
```

另外携带各步骤结果及失败原因；skip 在汇总层返回 skipped，不伪装成已完成诊断。ready 仅描述索引可用，新鲜度独立报告；未暴露新鲜度时 freshness 必须为 unknown。

`doctor` 只读，不触发隐式索引。CBM 从未启用且无有效配置时返回 not configured 信息，不把所有旧用户都判为故障。按目标平台和作用域检查实际配置；配置注册成功与真实握手成功明确区分。

`doctor --repair --yes` 仅修复已确认归属项目的缺失、陈旧或失败索引，不安装程序、不修改 Agent 配置、不删除共享缓存。配置问题引导重新执行显式 install。遇到 unknown 时先补充诊断，不盲目重建。

`update` 仅扩展已选集成的状态展示，不首次安装 CBM、不自动升级其程序、不修改 MCP 配置。初期不增加持久化后端选择字段，避免把本机集成状态写入 workflow schema；以显式参数和现有配置为依据。

## 9. 实施步骤与完成条件

| 步骤                  | 交付                                                           | 完成条件                                    |
| --------------------- | -------------------------------------------------------------- | ------------------------------------------- |
| 1. 固定外部契约       | 版本能力表、安装副作用检查、CLI JSON fixtures、平台 MCP 能力表 | 所有计划支持组合有证据；未知项明确关闭      |
| 2. 平台适配           | 配置目标解析、保格式合并、并发写入保护                         | 多格式、作用域、冲突、注释保留测试通过      |
| 3. CBM domain         | 安装计划、执行器、身份解析、诊断和修复                         | 单元及模拟 CLI 契约测试通过                 |
| 4. init 接线          | 交互选项、参数、平台结果、JSON、退出码、i18n                   | 三种 workflow、两种作用域和旧参数回归通过   |
| 5. doctor/update 接线 | 只读诊断、授权修复、已有集成状态                               | 未安装旧用户不受影响，部分失败可重试        |
| 6. 实机与发布验证     | 各支持平台冒烟、并发工作树测试、文档                           | 全量检查与 build 完成；最终报告列出验证边界 |

功能代码从 enterprise/main 创建 codex/\* 分支；本方案文档不触发企业版本升级。功能完成后按 master/上一发布 tag 基线决定版本和英文 Changelog，仅记录用户可见的可选安装能力。

## 10. 测试矩阵

- domain：未选择不执行、程序缺失/不兼容、JSON 畸形、超时、步骤失败与重试、路径身份冲突。
- platform：JSON/JSONC/TOML/YAML、项目/全局路径、环境路径覆盖、相同条目复用、同名冲突、禁用项、并发修改、原子写失败。
- init：Native/Classic/Both；交互首次不勾选；--yes/--json 不首次启用；显式 install/init/skip；global+init 提前失败；旧 CodeGraph 不变；部分平台失败和退出码。
- doctor：无集成不报故障、程序与注册状态区分、新鲜度 unknown、repair 未授权不写入、授权仅修复正确项目。
- 实机：macOS/Linux/Windows 的已支持 OS/CPU 组合；中文及空格路径；两份同名仓库；两个 worktree 并发；分支切换；删除/重命名文件；MCP 客户端重启。

每步先跑相关测试，最后因涉及安装与跨模块执行 pnpm lint、pnpm build 和一次全量测试。只有触达 runtime 源码时才重建对应 runtime 资产。用户文档中文后英文同步，README 仅加必要选项说明和文档引用。

## 11. 参考与证据范围

- [需求 Issue #32](https://github.com/miniceM/yuan-comet/issues/32)
- [CBM 官方 npm 分发说明](https://github.com/DeusData/codebase-memory-mcp/blob/main/pkg/npm/README.md)
- [CBM 官方手动配置、CLI 和索引说明](https://github.com/DeusData/codebase-memory-mcp/blob/main/README.md)
- 本仓库 `app/commands/init.ts`、`domains/integrations/codegraph.ts`、`platform/install/platforms.ts`。

已验证当前会话可搜索并追踪此工作树代码；尚未执行安装实验、多平台 MCP 配置写入或工作树并发索引实验。外部版本和平台能力核验属于步骤 1 的明确交付，不将文档示例视作已通过的实现验证。
