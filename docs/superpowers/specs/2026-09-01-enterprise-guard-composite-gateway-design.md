# Enterprise Guard 统一组合网关与多宿主本地硬阻断设计

> 日期：2026-09-01
>
> 关联：[Issue #1](https://github.com/miniceM/comet/issues/1)
>
> 状态：设计已确认，待实施计划
>
> 取代范围：取代《Enterprise Guard 平台覆盖设计》中“Claude Code 是唯一强制阻断平台”及“双 Hook 并行安装”的目标方案；原文保留为阶段性设计记录。

## 结论

Enterprise Guard 的最终形态不是在每个平台复制策略代码，也不是继续并排安装 Enterprise Hook 与 Comet Hook Router。最小上游差异下的目标架构是：

1. 企业策略、例外、审计和宿主适配全部收敛在独立的 `domains/enterprise-guard/` 中。
2. 支持命令 Hook 的平台只安装一个 `comet-enterprise-gateway.mjs`。网关只读取一次原始输入，先执行 Enterprise Guard，再调用原有 Comet Hook Router，最后统一输出平台决策。
3. OpenCode 一类只提供插件事件的平台安装一个薄插件桥。桥接层把 `tool.execute.before` 事件交给受管 Guard Runner，并在拒绝时抛出异常阻止工具执行，不复制任何企业规则。
4. 平台差异按“宿主类型 + 输入协议族 + 决策协议族 + 安装策略”建模；只有协议确实不同才新增 codec，不为每个平台复制完整 adapter。
5. Git `pre-push` 等原生边界作为纵深补充，不能替代工具执行前的拦截。
6. Doctor 只按可验证事实声明覆盖等级；不能证明安装完整性、工具覆盖或最终授权顺序时，不宣称硬阻断。

该方案把不可避免的平台接线限制在 Enterprise Guard 模块和生成资产内，保持 `domains/comet-entry/`、现有平台定义与 Hook Router 行为不变，降低后续同步上游的冲突成本。

## 背景与当前基线

Issue #1 要补齐企业 SDD 洋葱模型的 L5：在工具真正执行前阻断硬编码密钥、直接修改环境文件、危险递归删除、强制推送等 HARD 违规，并对 SOFT 发现保留审计记录。

当前仓库已经具备：

- 独立的 `domains/enterprise-guard/`，包含 Claude 输入解析、策略判定、例外、findings、覆盖描述与生命周期；
- 原样保留的 `domains/comet-entry/` Hook Router，负责 Classic/Native workflow 阶段约束；
- Claude Code 的 Enterprise Hook 原型与项目级生命周期；
- 不支持强制阻断的平台采用规则注入与 CI 兜底。

当前实现仍有三个结构性缺口：

- Enterprise Hook 与 Router 作为两条平台 Hook 并行存在，执行顺序、输入复用和决策合并依赖平台行为；
- 策略引擎仍以 Claude 输入模型为中心，继续铺平台会让适配代码与平台数量线性增长；
- OpenCode 当前在 Comet 中只有 skills、rules、commands 以及外部 Superpowers 插件检测，没有 Comet 自己的执行前 Hook。检测到第三方插件不等于 Enterprise Guard 已接入。

因此，本设计描述的是目标架构，不表示所有覆盖等级已经实现。

## 设计目标

- 在宿主提供可靠执行前边界时，实现本地、同步、默认安全的 HARD 阻断。
- Enterprise Guard 在非 Comet 项目或当前 change 不可识别时仍然生效。
- 不修改上游 Hook Router、workflow 状态机或平台定义中的既有业务逻辑。
- 策略核心与平台协议彻底分离，新增同协议平台以配置为主。
- 受管运行时不依赖当前项目的可变文件，避免 Agent 通过普通写操作改写 Guard 后放行自己。
- 安装、更新、巡检、修复和卸载幂等，并保留用户已有 Hook 和插件。
- 覆盖报告准确表达实际保证，不把规则提示、项目可变配置或事后 CI 描述为硬阻断。

## 非目标与信任边界

- 不防御拥有当前用户账户、管理员权限或直接修改宿主安装目录能力的恶意操作者。
- 不承诺拦截宿主没有暴露的工具、插件内部自行执行的副作用或 Guard 安装前已经发生的操作。
- 不把 SOFT 规则全部塞进实时 Hook；需要全仓分析的规则继续由 lint、review 或 CI 承担。
- 不合并 Enterprise Guard 与 Classic/Native workflow 状态机，也不把企业策略写入 `domains/comet-entry/`。
- 不依靠提示词、规则注入或模型自觉实现 HARD 语义。

本设计保护的主要对象是 Agent 误操作、普通自动化违规和未经批准的危险工具调用。更强的终端、账户和操作系统控制属于企业设备管理边界。

## 总体架构

```text
                          ┌──────────────────────────────┐
命令 Hook 宿主 ──────────▶│ 单一 Composite Gateway       │
                          │ Guard → Findings → Router    │
                          └──────────────┬───────────────┘
                                         │
插件 Hook 宿主 ─▶ 薄插件桥 ─▶ 受管 Runner ├─▶ 统一规范事件
                                         │
原生边界 ───────▶ pre-push 等补充入口 ───┘
                                         │
                                         ▼
                          ┌──────────────────────────────┐
                          │ 平台无关策略核心              │
                          │ HARD / SOFT / exceptions     │
                          └──────────────┬───────────────┘
                                         │
                                         ▼
                          allow / deny / abstain + audit
```

建议的目标模块布局如下：

```text
domains/enterprise-guard/
  policy-engine.ts               # 平台无关规则判定
  exceptions.ts                  # 受控例外语义
  findings.ts                    # 脱敏、并发安全的审计记录
  normalized-event.ts            # 统一事件与决策契约
  platform-profiles.ts           # 平台能力与协议组合
  input-codecs/                  # 原始宿主输入 → 统一事件
  decision-codecs/               # 统一决策 → 宿主协议
  enterprise-gateway.ts          # Guard 与 Router 的组合编排
  enterprise-gateway-entry.ts    # 命令 Hook bundle 入口
  guard-runner-entry.ts          # 插件/原生宿主调用的无状态 Runner
  plugin-hosts/opencode.ts       # OpenCode 薄桥生成与生命周期
  lifecycle.ts                   # install/inspect/repair/update/uninstall

assets/skills/comet/scripts/
  comet-enterprise-gateway.mjs   # 命令 Hook 平台唯一入口
  comet-enterprise-runner.mjs    # 插件与原生边界的受管执行入口
```

这里的文件名是目标责任划分。实施时可以在不改变边界的前提下复用现有 `enterprise-hook-entry.ts`、`hook-lifecycle.ts` 等文件，避免无收益的重命名。

## 统一事件与策略核心

所有宿主先转换为版本化的规范事件，再进入策略核心：

```ts
interface EnterpriseGuardEvent {
  schemaVersion: 1;
  host: string;
  event: 'before-tool' | 'pre-push';
  cwd: string;
  projectRoot?: string;
  tool: {
    name: string;
    family: 'command' | 'write' | 'edit' | 'patch' | 'unknown';
    mutating: boolean;
  };
  payload: {
    command?: string;
    path?: string;
    content?: string;
    patch?: string;
  };
  rawDigest: string;
  truncated: boolean;
}
```

策略核心只接收该结构，不感知 Claude、OpenCode 或某个配置文件格式。它返回稳定的内部结果：

- `deny`：命中 HARD、输入不可安全判定或关键依赖失败；
- `allow`：已完成适用规则检查且允许执行；
- `abstain`：事件明确属于无副作用、非受保护工具，交给后续 Router 或宿主处理；
- `findings`：需要持久化的 SOFT 发现；
- `ruleIds`、安全摘要与诊断信息：供审计和 Doctor 使用，不包含完整密钥或敏感输入。

内置 HARD 规则编译进受管 Runner。项目内 baseline 只能增加或收紧规则，不能覆盖或关闭内置规则。例外必须限定规则、路径/命令范围、原因和过期时间；受保护 Agent 的普通写工具不得直接激活例外。若项目保存例外申请，真正生效的授权应由本地受管状态确认并绑定摘要，避免一次自写配置即可绕过 Guard。

## 平台能力组合，而非逐平台复制

每个平台只声明一个 profile：

```ts
interface EnterpriseGuardPlatformProfile {
  host: 'command-hook' | 'plugin-hook' | 'native-boundary' | 'none';
  inputCodec: string;
  decisionCodec: string;
  installStrategy: string;
  enforcement: 'managed' | 'project' | 'managed-plugin' | 'best-effort' | 'none';
  coveredTools: string[];
  orderingGuarantee: 'final' | 'verified' | 'unknown';
}
```

多个平台若共享输入和输出协议，复用同一个 codec。例如同为 JSON stdin、命令退出码阻断的平台只需要不同 profile；只有字段形状或 deny 协议真的不同才新增 codec。平台特有逻辑只能位于 codec、安装策略或 plugin host，不进入策略核心。

新增平台前必须完成真实宿主 Spike：

1. 事件是否在副作用前触发；
2. 是否覆盖命令、写、编辑、补丁和自定义工具；
3. 输入是否包含完整命令、目标路径和待写内容；
4. deny 的 JSON、异常或退出码是否确实阻止执行；
5. 多 Hook/插件的顺序与短路语义；
6. 全局、项目和插件目录的覆盖优先级；
7. 超时、崩溃、无输出和畸形输出时宿主如何处理；
8. 安装、更新、Doctor 修复与卸载能否只管理 Comet 条目；
9. 能否证明 Guard 是最后一个可改变工具参数的授权者。

任何一项无法验证，都必须反映在覆盖等级中，不能靠推测升级为强制阻断。

## 命令 Hook 平台：单一组合网关

支持命令式执行前 Hook 的平台只安装一个入口：

```text
host stdin
  → 一次性读取并限制大小
  → input codec 规范化
  → Enterprise Guard
      HARD deny / 关键失败：立即渲染拒绝，不进入 Router
      SOFT：先可靠落盘，再继续
      allow/abstain：继续
  → 原有 Comet Hook Router
  → decision codec 只渲染一次最终结果
```

这比并排安装两个 Hook 更可靠：

- 原始输入只读取一次，不依赖宿主是否为每条 Hook 重放 stdin；
- Guard 固定在项目发现与 workflow 路由之前，非 Comet 项目也不会绕过 HARD 检查；
- Guard 与 Router 的执行顺序由 Comet 自己保证；
- 平台只收到一个最终决策，不需要猜测多条 Hook 的合并规则；
- Router 通过公开函数被调用，源码和状态机保持上游原样。

组合网关属于 Enterprise Guard，不把企业逻辑反向写进 `comet-hook-router.mjs`。安装器用受管标识将旧的 Enterprise/Router 双条目迁移为一个 Gateway 条目，同时保留所有用户自定义 Hook。

## OpenCode：独立插件桥接方案

### 当前事实

截至本设计日期，[上游 Comet](https://github.com/rpamis/comet) 的 OpenCode 平台入口不声明 Comet Hook 能力，也没有安装 `comet-hook-router.mjs`。现有逻辑只安装 skills、rules、commands，并检测用户是否已经安装外部 Superpowers OpenCode 插件；该检测不能提供 Enterprise Guard 阻断。

[OpenCode 插件](https://opencode.ai/docs/plugins/)提供 `tool.execute.before` 事件。处理器能够读取工具名、会话/调用标识及可变参数，并可通过抛出异常中止后续工具执行。插件按加载顺序执行，前一个插件抛出异常会短路后续处理。这足以实现执行前拦截，但“后续插件还能否修改参数”决定它是否是最终授权者。

### 桥接结构

OpenCode 插件只承担三件事：

1. 将 `tool.execute.before` 的工具名和参数转换为规范事件；
2. 通过绝对路径调用版本锁定的 `comet-enterprise-runner.mjs`，设置严格超时并校验返回 schema；
3. 对 `deny` 抛出不含敏感内容的错误，对 `allow/abstain` 返回，对 SOFT findings 使用 Runner 的统一持久化路径。

```text
OpenCode tool.execute.before
  → managed plugin bridge
  → absolute-path Guard Runner
  → normalized decision
      deny  → throw，工具不执行
      allow → return
```

桥中不内嵌正则、HARD/SOFT 列表、例外规则或 findings 格式。这样策略升级只替换 Runner，不需要为 OpenCode 重写一份策略实现。

OpenCode profile 至少映射内置 `bash`、`write`、`edit`、补丁类工具；未知自定义工具按以下规则处理：

- 明确只读且位于 allowlist：`abstain`；
- 参数中出现命令、路径、内容或无法证明无副作用：严格模式下 `deny`；
- 宿主以后新增工具时先保持安全失败，再通过 profile 更新覆盖。

### 安装与排序

插件桥优先安装在项目外的用户受管插件目录，生成内容只包含版本、受管标识和 Runner 绝对路径。项目文件不能覆盖 Runner 或更改内置 HARD 规则。生命周期负责写入/更新 Comet 自己的插件条目，不修改第三方插件源码。

OpenCode 的全局配置、项目配置、全局插件目录和项目插件目录存在既定加载顺序。由于项目插件可能在受管全局插件之后运行并修改参数，只有同时满足以下条件才可标记 `enforced-managed-plugin`：

- 实际运行版本已通过 fixture 证明 Guard 在副作用前执行；
- 安装状态、Runner 摘要和插件桥摘要均通过 Doctor；
- Guard 之后不存在能够修改受保护工具参数的插件，或宿主提供不可变的最终授权点；
- deny、异常、Runner 缺失、超时和畸形结果都已验证为阻断。

若无法证明最终授权顺序，OpenCode 仍安装插件并提供实际拦截，但覆盖等级必须是 `best-effort`，同时启用原生 Git 边界与 CI 兜底。不能通过文件命名或假设目录排序来虚构强保证。

## 受管运行时与完整性

Gateway、Runner 和插件桥使用版本化、项目外的受管安装：

- 运行时安装到 Comet 数据目录下的版本目录，由 `platform/` 的路径能力解析实际操作系统位置；
- manifest 保存版本、schema、文件摘要和兼容范围；
- 更新先写入新版本目录，校验成功后原子切换当前指针；
- Hook 和插件桥使用绝对路径，不依赖项目 `node_modules`、`PATH` 或当前仓库脚本；
- Doctor 同时检查条目唯一性、目标存在、摘要、权限、协议版本和宿主能力；
- Repair 只恢复 Comet 受管文件与条目；Uninstall 只移除带受管标识且摘要/路径匹配的对象；
- 项目生成资产仍由源码构建，不在 bundle 中直接维护业务逻辑。

受管运行时降低普通 Agent 通过项目写操作篡改 Guard 的风险，但不宣称抵御拥有本地账户控制权的恶意用户。

## 失败语义

本地硬阻断必须对“无法安全判断”和“与事件无关的内部故障”做不同处理：

| 场景                                                | 严格模式行为               | 原因                                  |
| --------------------------------------------------- | -------------------------- | ------------------------------------- |
| HARD 命中                                           | 拒绝                       | 核心安全语义                          |
| 受保护写/命令输入缺字段、解析失败或发生安全相关截断 | 拒绝                       | 无法证明安全                          |
| 未知且可能修改状态的工具                            | 拒绝                       | 新工具默认安全失败                    |
| Runner 缺失、超时、摘要不匹配或返回 schema 错误     | 拒绝受保护/未知修改工具    | 防止安装损坏变成静默绕过              |
| SOFT findings 无法可靠持久化                        | 拒绝当前修改工具并提示修复 | 保证审计链不静默丢失                  |
| 明确只读且不属于 Guard 范围                         | `abstain`                  | 避免无关故障扩大为全局拒绝服务        |
| Router 失败                                         | 保持 Router 既有安全语义   | Enterprise Guard 不改写 workflow 契约 |
| 平台协议未完成 Spike                                | 不安装伪 Hook，降级并报告  | 不把推测当保证                        |

拒绝信息只包含规则 ID、工具类别、脱敏路径或修复提示。密钥原文、完整待写内容和完整命令不写入 stdout、stderr 或 findings。

## 原生边界与 CI 纵深

对于插件顺序不可证明、宿主工具覆盖不完整或用户主动绕过 Agent 的场景，增加独立原生边界：

- Git `pre-push` 阻断强推受保护分支、未满足的必要检查和已知 HARD findings；
- 必要时由 pre-commit/CI 重新扫描密钥与受保护文件；
- CI 作为最终共享仓库边界，不依赖某个开发者是否安装本地工具。

原生边界只能覆盖对应操作。例如 `pre-push` 无法阻止 `rm -rf` 或编辑 `.env`，因此不得被计入工具级完整覆盖。

## 覆盖等级与用户报告

覆盖等级由可验证能力计算，不由平台名称硬编码：

| 等级                      | 含义                                                         |
| ------------------------- | ------------------------------------------------------------ |
| `enforced-managed`        | 命令 Hook 位于受管范围，完整性、工具覆盖、决策和顺序均已验证 |
| `enforced-project`        | 项目级命令 Hook 可同步阻断，但项目配置可被本地操作者移除     |
| `enforced-managed-plugin` | 受管插件在最终授权位置执行，Runner 和排序均可验证            |
| `best-effort`             | 已有执行前拦截，但排序、工具覆盖或宿主失败语义存在未消除缺口 |
| `rules-and-ci`            | 没有可靠执行前边界，仅规则注入、原生补充和 CI                |

Doctor 和覆盖报告必须展示：宿主类型、安装范围、受保护工具、输入/决策协议、Runner 摘要、排序保证、原生补充、覆盖等级和降级原因。任何一项退化时立即降低等级并给出 `doctor --repair` 或明确的人工修复路径。

## 生命周期

统一生命周期由 Enterprise Guard domain 自管：

1. `install`：探测平台 profile，安装受管运行时，再安装单一 Gateway 或插件桥；不支持的平台只记录降级状态。
2. `inspect`：检查宿主版本、受管条目、摘要、协议、工具覆盖和排序保证。
3. `update`：原子安装新 Runner/Gateway，迁移旧双 Hook，保留用户条目，成功后清理旧受管版本。
4. `repair`：只修复 Comet 标识的缺失、重复、陈旧或损坏对象，不重写完整用户配置。
5. `uninstall`：只移除 Comet 受管 Hook、插件桥、manifest 和无引用版本；保留用户 Hook、第三方插件、findings 和项目业务文件。

所有操作必须幂等。中断时要么继续使用上一完整版本，要么明确降级，不能留下指向半写入文件的 Hook。

## 最小上游差异约束

实施应遵守以下改动预算：

- 企业逻辑只新增或修改 `domains/enterprise-guard/`、对应测试、构建入口和发布资产；
- `domains/comet-entry/` 的 Router 与 adapter 保持原样，只通过公开导出被组合；
- `domains/skill/`、`platform/` 和 `app/` 仅在缺少公开接线能力时增加最小通用接口或一次注册，不加入企业规则和平台判断；
- OpenCode 插件实现归 Enterprise Guard plugin host，不修改上游 OpenCode 平台入口来伪装命令 Hook；
- 新增源码、测试和生成物时同步 `config/repository-layout.json`、架构 linter、`assets/manifest.json` 与对应 runtime asset 测试；
- 任何必须修改上游模块的变更都要能独立解释为稳定接线点，而不是策略实现。

评审时应单独查看相对 upstream 的 diff。若企业策略散落到多个上游文件，视为架构回归。

## 实施顺序

### 阶段 1：稳定内部契约

- 定义规范事件、内部决策、profile 和 codec 接口；
- 把 Claude 解析从策略核心拆到输入 codec；
- 为截断、未知工具、例外和 findings 失败建立契约测试；
- 保持现有行为可回归，不立即铺开其他平台。

### 阶段 2：Claude 单一组合网关

- 新增 Gateway 和自包含 bundle；
- 用一条受管 Hook 替换 Enterprise/Router 双条目；
- 验证 Guard 先于项目发现、Router 行为不变、用户 Hook 保留；
- 完成 install/update/doctor/repair/uninstall 迁移测试。

### 阶段 3：OpenCode 插件宿主

- 以当前受支持 OpenCode 版本完成真实 `tool.execute.before` fixture；
- 实现薄插件桥、受管 Runner、超时/异常/schema 安全失败；
- 验证工具映射、第三方插件并存和实际加载顺序；
- 只有满足最终授权条件才标记 `enforced-managed-plugin`，否则发布为 `best-effort`。

### 阶段 4：协议族扩展

- 对其余平台逐个完成九项 Spike；
- 优先复用现有 codec/profile；
- 只对确有差异的协议新增实现；
- 未通过的平台维持 `rules-and-ci`。

### 阶段 5：纵深与发布验证

- 接入 Git 原生补充边界和 CI findings 消费；
- 完成受管运行时原子升级、回滚和摘要巡检；
- 更新能力矩阵与用户文档；
- 运行跨模块、Runtime、安装/路由和发布资产的完整验证。

## 验收标准

1. 已声明强制阻断的平台中，HARD 事件无法到达真实工具执行；解析失败、Runner 损坏与未知修改工具同样不能静默放行。
2. 命令 Hook 平台只安装一个 Enterprise Gateway；Guard 固定先于 Router，Router 的 Classic/Native 路由结果与现有实现一致。
3. 非 Comet 项目、没有 current change 或项目发现失败时，Enterprise Guard 仍检查 HARD 规则。
4. OpenCode 插件桥不包含策略规则；更新 Runner 即可统一升级策略。
5. OpenCode 只有在真实排序、完整性和 deny 语义全部通过时才显示 `enforced-managed-plugin`，否则明确显示 `best-effort`。
6. 同协议平台新增接入不复制策略引擎，只新增 profile；协议不同才新增 codec。
7. 项目文件不能关闭内置 HARD 规则，也不能通过 Agent 普通写操作自行激活例外。
8. install、update、repair 和 uninstall 重复执行结果稳定，且不删除或改写用户 Hook 与第三方插件。
9. Doctor 的覆盖等级、实际安装状态、能力矩阵和文档结论一致。
10. 相对上游的已有模块变更保持为最小接线点；Enterprise Guard 可以作为独立 domain 审查和维护。

## 关键决策摘要

| 问题                               | 最终决策                                              |
| ---------------------------------- | ----------------------------------------------------- |
| 是否逐平台修改策略代码             | 否，平台仅组合 host/profile/codec/install strategy    |
| Enterprise Hook 与 Router 是否并行 | 否，命令 Hook 平台改为单一组合网关                    |
| 是否修改上游 Router                | 否，公开调用并保持原样                                |
| OpenCode 如何接入                  | 独立薄插件监听 `tool.execute.before`，委托受管 Runner |
| OpenCode 是否天然等于硬阻断        | 否，必须验证最终授权顺序；无法证明时为 `best-effort`  |
| 规则放在哪里                       | 平台无关策略核心；内置 HARD 编译进受管 Runner         |
| 项目 baseline 能否放宽 HARD        | 不能，只能增加或收紧                                  |
| Runner 故障是否放行                | 对受保护或未知修改工具拒绝；明确只读工具可 `abstain`  |
| Git Hook/CI 的定位                 | 纵深补充，不替代执行前拦截                            |
| 如何控制 upstream 冲突             | 独立 domain + 生成资产 + 最小单向注册                 |
