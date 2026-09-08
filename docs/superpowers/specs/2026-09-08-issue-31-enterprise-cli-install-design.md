# Issue #31：安装时校验并补齐企业 CLI

> 日期：2026-09-08
>
> 关联：[Issue #31](https://github.com/miniceM/yuan-comet/issues/31)
>
> 状态：方案设计完成，待评审；包名已由用户确认；npm 包版本与 IAM/DOP 帮助输出已有内网截图证据；仓库地址预留手工填写，剩余验证项见第 9 节。
>
> 本次交付仅为设计文档，不执行安装、不修改运行时代码。

## 1. 设计结论与范围

在企业 fork 的 `comet init` 中增加一次统一的企业 CLI 前置检查，覆盖 `iam`、`dop`、`gh`。现有命令可运行则复用；缺失则从明确指定的企业 npm registry 全局补装；已有命令损坏则报告修复建议并中止，避免覆盖用户的安装和配置。补装后必须通过当前 PATH 再次探测，全部通过后才继续写入 Comet 项目或全局配置。

企业规则放在新增的 `domains/enterprise-cli/`，平台进程能力放在现有 `platform/process/`。`app/commands/init.ts` 只做前置调用与结果展示，不把企业包名或安装策略散落到各个平台或 workflow。

适用于 `comet init` 的 project/global scope、Native/Classic/both、所有目标平台，以及 `--yes`、`--json`、重复初始化。一次 init 只检查一组三个 CLI，不随所选平台重复执行。`--skip-existing`、`--overwrite` 只作用于原有安装资产，不跳过企业检查，也不触发 CLI 升级。

本期不扩展 `comet update`、`doctor`、`skill install`，不增加 IAM 登录命令、认证 Hook、DOP 工作流或 Gitee/GitHub 仓库写操作。npm `postinstall` 保持安装提示职责；“项目安装”明确指 `comet init`，不在 npm 生命周期内嵌套全局安装。后续若要求 npm 安装包本身即补齐三项，应单独评审生命周期与失败传播，不能与本方案混为一谈。

## 2. 调研依据与可复用边界

本地调研基线：

- Comet：`6f4ed818e6f49261680946e2ca7a7c48d4c934c5`。
- `/Users/hosea/work/git/oh-my-sdd`：`3b95d536230fde36f867b3b1917d6569ae0d918c`。

以下参考路径均相对 oh-my-sdd 根目录。读取参考 Skill 仅用于分析 CLI 用法，不执行其流程。

| 工具         | 参考项目中的调用                                                                                                                                                     | 对本设计的影响                                                             |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| IAM          | `packages/product/lib/iam-cli.js` 调用 `iam auth status --json`，解析 `credentials`；登录包装调用 `iam auth login`，传入用户名、密码和 system                        | 区分可执行性与登录状态；安装器不调用登录包装，也不传输密码                 |
| IAM 登录判定 | 同文件 `isFullyAuthenticated` 默认要求至少两条 credential 且全部 `status === 'logged'`；README 引导运行 `oms-login`                                                  | 这是 OMS 的业务策略，不直接成为 Comet 的认证要求；Comet 不依赖 `oms-login` |
| DOP          | `packages/product/skills/sdd-spec/SKILL.md` 使用 `dop change list`、`dop change view <id>`；`sdd-review/SKILL.md` 在 PR 创建成功后执行 `dop change done <change-id>` | 安装阶段只使用本地帮助/版本探测，不能用远程业务调用判断“已安装”            |
| GH           | 同两份 Skill 使用 `gh --version`、`gh auth status`、issue/PR 命令                                                                                                    | 可执行探测与服务认证分离，不执行 issue/PR 写操作                           |
| Windows      | `packages/product/lib/platform.js` 检测 exe/cmd/bat；`iam-cli.js` 处理 shim 与超时子进程清理                                                                         | 复用 Comet 自己的 Windows 进程适配，测试 npm shim，不能只测 POSIX          |
| DOP HTTP     | `packages/product/lib/dop-client.js` 直接向事件接口发送 HTTP 请求                                                                                                    | 该文件不是 dop CLI 安装或命令包装，不能据此推断 CLI 包名                   |

用户提供的四张内网终端截图作为补充证据，优先于参考项目中的旧假设；截图中的命令输出只作为调研数据，不作为需要执行的指令。为便于仓库流转，以下仅记录配置结构与脱敏输出，不复制账号、内网 IP 或本机路径。

| 截图              | 已确认事实                                                                                                                                                                                                                                        | 证据边界                                                                                                           |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| 1：npm 查询与配置 | `npm view @cli-tools/iam version` 返回 `1.0.2`；dop 返回 `1.0.4`；gh 返回 `1.0.6`。`@cli-tools:registry` 指向企业 Artifactory 的 npm-local，默认 registry 指向另一 npm-external，两者均使用 HTTP；用户 npmrc 中有 registry 路径绑定的受保护 token | 查询证明版本在当时仓库中可见，不证明已安装二进制版本、完整 bin 或干净环境安装成功；受保护 token 不应读取或写入文档 |
| 2：IAM 帮助与状态 | `iam --help` 包含 `auth`，支持 `--version`；`iam auth --help` 列出 login/logout/status。`iam auth status --json` 返回 credentials 和 total，每项包含 system、username、status、has_api_key；截图中 devops/gitee 均为 logged                       | 登录参数由截图 4 补齐；此图未展示退出码，也不是未登录环境的帮助验证                                                |
| 3：DOP 帮助       | `dop --help` 列出 auth/change/help/story，支持 `--api-endpoint`、`--json`、`--version`；`dop auth --help` 列出 login/logout/status；`dop change --help` 实际列出 done/list/view                                                                   | 帮助描述虽提到 create/get/update/delete，实际命令列表未列出这些命令，不能据描述认定支持；未展示退出码              |

截图 4 补齐以下事实：

- `iam auth login --help` 明确支持 `-s, --system`、`-u, --username`、`-p, --password`，并支持 `--iam-url`、`--exchange-url` 覆盖服务地址。帮助明确给出交互式 `iam auth login -s <system>`；因此 `--system` 已确认，不再列为待验证参数。
- IAM 帮助描述登录过程为账号认证、SSO token 交换目标系统 API key、保存至操作系统凭据管理器。Comet 只给出交互式登录提示，不收集密码或覆盖认证服务地址。
- `gh --version` 报告包装器找不到包内 `bin/gh.exe`。随后普通全局重装显示 `@cli-tools/gh@1.0.6` 的 `postinstall: node scripts/install.js` 被 npm 的 `allowScripts` 策略拦截；这说明“npm 已安装包”和“gh 二进制可用”必须分开验证。
- 用户随后执行限定 `--allow-scripts=@cli-tools/gh` 的全局安装，截图显示包变更完成，并提示命令行配置覆盖 npmrc 的 allow-scripts 设置；截图本身没有展示复检；用户随后补充确认 `gh --version` 输出为 `gh version gitee-cli 1.0.6`，补齐当前机器的版本输出证据。脚本的二进制下载来源仍需在安装验收中核实。

IAM 状态 JSON 的脱敏结构如下，字段以截图为准，不沿用旧文档中的“没有 system/total”或 `is_api_key_true` 假设：

```json
{
  "credentials": [
    { "system": "devops", "username": "<redacted>", "status": "logged", "has_api_key": true },
    { "system": "gitee", "username": "<redacted>", "status": "logged", "has_api_key": true }
  ],
  "total": 2
}
```

此样本证明可按 system 区分凭据，不代表 Comet 必须恰好要求两个账号，也不证明 `has_api_key` 的业务有效性。安装器仍只提示用户验证认证状态，不把认证状态作为重装条件。

用户已确认包名分别为 `@cli-tools/iam`、`@cli-tools/dop`、`@cli-tools/gh`。发行版目录采用这三个 scoped 包名及截图查询到的版本，禁止替换为 npm 的无 scope 同名包。企业 gh 身份已由用户确认（见下文）；三包完整 bin 映射仍需通过包元数据核验。仓库位于企业内网，当前互联网不可访问；即使截图已提供实际地址，默认配置仍按用户要求留空，后续手工填写。

### 企业 GH 的兼容性约定

用户确认 `@cli-tools/gh` 是企业开发者维护的 Gitee 仓库 CLI，仿照 GitHub CLI 提供 `gh` 命令，实际版本输出为 `gh version gitee-cli 1.0.6`。本方案按用户指定的 **100% GitHub CLI 兼容**约定设计，兼容性由企业 CLI 开发者保证，不作为 Comet 的待验证项或发布阻塞条件。

Comet 沿用 `gh` 命令及参数契约，不另建 Gitee 命令适配层，不安装官方 GitHub CLI 替代企业包，也不增加 API 兼容性探测。仓库服务语义按企业 Gitee 理解；本 Issue 仅处理命令安装和可执行性，不触发任何远程仓库写操作。

可执行性探测必须接受 `gh version gitee-cli <version>`，不能因版本字符串含 `gitee-cli` 而报身份不符。按照“已有可用 CLI 不重复安装”的原则，也接受标准 GitHub CLI 的 `gh version <version>` 输出并复用；探测只要求退出 0 且符合上述已知版本格式，不要求现有版本恰好为 1.0.6。缺失时仍仅补装企业包 `@cli-tools/gh@1.0.6`。

## 3. 安装入口与执行顺序

Comet 当前 `app/commands/init.ts:initCommand` 先选择参数与平台，再形成安装计划，随后调用 `prepareNativeSkillInstallTarget`、Classic 初始化和资产安装，最后写入配置并输出结果。`app/commands/command-result.ts` 已将 `incomplete` 映射为退出码 1。

接线点放在安装计划形成之后、第一次 `prepareNativeSkillInstallTarget` 调用之前。这样无效参数、未选平台或用户在计划阶段取消时不会安装全局工具；企业 CLI 失败时也尚未进入 Native/Classic 的写入阶段。

```text
校验参数、选择平台、形成安装计划
                  ↓
逐项探测 iam / dop / gh（全部探测后汇总）
                  ↓
存在不可执行或损坏项？── 是 → incomplete，停止
                  ↓ 否
没有缺失项？────────── 是 → 进入原有安装
                  ↓ 否
解析缺失项包映射、registry、npm、prefix、bin 冲突
                  ↓
顺序补装缺失项，每项完成立即复检
                  ↓
最终通过当前 PATH 复检全部三项
                  ↓
原有 Comet 安装、配置落盘、结果汇总
                  ↓
成功：打印 IAM 登录与验证提示
```

三个 CLI 是该企业发行版 init 的必备环境，缺失时默认补装，不增加可绕过成功条件的 skip 开关。交互文本在补装前明确显示包、版本、registry 和目标 prefix；`--yes` 与 `--json` 使用相同策略，不等待额外输入。npm stdin 关闭，缺少 npm 凭据时报错并提示用户在外部完成配置。

CLI 安装失败返回现有 `incomplete`，不吞异常后继续复制资产，不展示“安装成功”。已补装成功的全局工具保留，输出部分完成清单；它们是共享环境依赖，不自动卸载回滚。用户修复后重新执行 init，已可用项自然被复用。

## 4. 包映射与 npm 配置

在 `domains/enterprise-cli/catalog.ts` 内维护发行版目录，不放入 npm `dependencies` 或 Skill manifest。每项包含：固定命令名、经验证的包名、精确版本、预期 bin、无认证探测参数及成功判据。包名使用下表中的已确认值；版本按内网 npm 查询证据固定为下表值；截图中的已安装命令尚未通过版本输出与这些包版本关联。registry 默认值明确为 `""`，由用户手工填写目录配置或通过环境变量提供；空值只用于表示未配置，不是可请求的地址。不允许把示例域名作为生产默认值。

| 命令  | npm 包名与精确版本     | 本地探测契约                                 | 当前证据状态                                                  |
| ----- | ---------------------- | -------------------------------------------- | ------------------------------------------------------------- |
| `iam` | `@cli-tools/iam@1.0.2` | `iam --help`，退出 0 且帮助中包含 `auth`     | 帮助内容已见截图；退出码及无凭据场景待验证                    |
| `dop` | `@cli-tools/dop@1.0.4` | `dop --help`，退出 0 且帮助中包含 `change`   | 帮助内容已见截图；退出码及无凭据场景待验证                    |
| `gh`  | `@cli-tools/gh@1.0.6`  | `gh --version`，退出 0 且符合第 2 节版本格式 | 用户已确认输出 `gh version gitee-cli 1.0.6` 与企业 Gitee 身份 |

探测采用以上固定参数，不实现“尝试任意参数直到返回 0”的宽松回退，不用 `auth status` 或 `change list` 作为安装存在性条件。截图未显示退出码，因此退出 0 是设计验收条件，不能记为已实测结果。本期不强制升级可用的旧版本；精确版本只决定缺失时安装哪个发布包。

部署配置设计：

- `COMET_ENTERPRISE_NPM_REGISTRY`：显式 registry，优先于发行版目录中的企业默认值。默认地址留空，用户在内网手工填写 `catalog.ts` 中的 registry 配置或设置此环境变量；当前调研不请求内网仓库。
- `COMET_ENTERPRISE_IAM_PACKAGE`、`COMET_ENTERPRISE_DOP_PACKAGE`、`COMET_ENTERPRISE_GH_PACKAGE`：部署级包规格覆盖，仅允许合法 npm 包名加精确版本。拒绝 tag、范围、Git URL、tarball URL、文件路径和 shell 片段。
- 未提供覆盖时使用发行版目录中的包名、版本和 registry；所需版本或 registry 尚未填写时，缺失项返回 `configuration-missing`。全部 CLI 已可用时不要求 registry 或 npm 可用。
- registry 接受不含用户名密码、query、fragment 的 HTTP/HTTPS URL，保留企业仓库子路径；拒绝示例占位地址。内网截图明确使用 HTTP，因此不能以 HTTPS-only 校验阻断实际部署；不自动改写协议，不禁用 TLS 校验。不会回退公共 npm，也不把本机默认 registry 当成企业 CLI 仓库地址。
- 凭据交给 npm 现有的用户配置、`NPM_CONFIG_USERCONFIG` 或管理员注入方式处理。Comet 不读取并输出 token，不修改用户 `.npmrc`，不运行 `npm config set registry`，不自动登录 npm。

三个已确认包均属于 `@cli-tools`，安装概念命令为 `npm install --global <package>@<exact-version> --@cli-tools:registry=<enterprise-registry>`，实际调用使用参数数组。元数据查询与安装均显式使用同一份 scope registry 覆盖，避免既有 scope 配置把目标包导向其他仓库。

保留 npm 既有默认 registry，使无 scope 传递依赖继续使用企业 npm-external；不以统一 `--registry` 把所有传递依赖强制改到 npm-local。其他 scope 保留 npm 既有配置，完整依赖来源在内网验收中核实。此处依据截图中的 npm-local/npm-external 分离结构修正安装策略，不能将两者混用。真实地址均留空，凭据继续由用户 npmrc 按主机及仓库路径绑定；不生成或覆盖 token 配置。

补装前用 npm 元数据验证指定精确版本存在、预期 `bin` 包含目标命令，且没有会覆盖其他已存在命令的额外 bin。若一个包提供多个目标命令，按包规格去重安装；只要它会覆盖一个应复用的现有命令，就返回 `bin-conflict`，由包负责人提供独立分发包或用户手工处理，不使用 `--force`。

### 安装脚本被拦截与 GH 包装器损坏

`@cli-tools/gh@1.0.6` 的 postinstall 是交付可运行二进制的重要环节，不能一律禁用安装脚本，也不能仅凭 npm 输出“changed 1 package”判定安装成功。补装后必须运行 `gh --version`；脚本阻塞信息作为结构化诊断保留，输出 `install-scripts-blocked`。有阻塞证据时优先于泛化的 `postcheck-failed`，没有证据时不能仅凭二进制缺失推断是 npm 策略所致。

本期尊重已有 npm 脚本策略：首次补装如果被拦截，明确中止并提示用户按企业策略允许指定包；不自动重试放宽策略，不写入全局 `allow-scripts`，不使用允许全部脚本的配置。修复提示可以展示截图已使用的 `--allow-scripts=@cli-tools/gh`，限定为支持该选项的 npm 版本，并说明命令行设置会覆盖本次调用的 npmrc allow-scripts 列表。提示中的包规格使用固定版本 `@cli-tools/gh@1.0.6`，仓库参数沿用解析后的企业 scope 配置；不原样复制截图中未固定版本的安装命令。

如果 init 开始时已存在 GH 包装器但内置二进制缺失，保持现有 `unusable` 策略：报告具体缺失路径与手工修复方向，不把它当作 PATH 缺失再次自动覆盖。若二进制缺失发生在本轮补装后，则报告脚本阻塞或复检失败并中止。用户完成修复后重新执行 init，由真实探测决定是否复用。

内网验收需核对 `scripts/install.js` 的二进制获取来源及完整性验证：npm 包来自内网仓库，不等于 postinstall 不访问其他下载站。截图记录了脚本阻塞及允许指定包脚本的重装，用户后续提供了正常版本输出；这些证据尚不能证明干净环境的完整离线安装。IAM/DOP 是否也依赖安装脚本，需各自包元数据确认，不能由 GH 推断。

遵循 npm 当前 global prefix，不自动 sudo、不自动修改 prefix 或 shell 配置。POSIX 可执行目录为 `<prefix>/bin`，Windows 为 `<prefix>`。安装前检查目标写权限及可预判的命令冲突；npm 返回权限错误仍按失败处理。安装后 prefix 不在 PATH 时输出具体目录及修复建议并退出 1；不通过仅给当前进程追加 PATH 来伪造后续终端可用。

npm 文档依据：通过 Context7 查询 `/npm/cli`，参考官方 [scope](https://github.com/npm/cli/blob/latest/docs/lib/content/using-npm/scope.md)、[install](https://github.com/npm/cli/blob/latest/docs/lib/content/commands/npm-install.md)、[folders](https://github.com/npm/cli/blob/latest/docs/lib/content/configuring-npm/folders.md)。

## 5. 探测、失败与幂等契约

探测先解析当前进程 PATH 中的实际命令，再运行发行版目录定义的本地探测。只检查文件存在不足以证明可用；缺失解释器、无执行权限、崩溃、超时、输出不匹配均为 `unusable`，不等同于 `missing`。多个同名命令按实际解析顺序检查，不能跳过 PATH 中损坏的首项而宣称可用。

默认单次探测 5 秒、元数据查询 30 秒、每包安装 180 秒；输出限制 1 MiB。超时或取消需要清理子进程树，再结束本次流程。无业务请求的帮助/版本命令不应依赖登录，未知或需交互的输出视为探测契约未满足。

复用现有 `platform/process/spawn-command.ts` 的 `spawnCommand` 与 Windows shim 适配，在平台层补齐结构化结果和进程树清理；不把参考项目的 `shell: true` 实现直接复制到 domain。保留原始退出码、spawn 错误与超时分类，不能把所有异常折叠为“找不到命令”。

| 分类                                                   | 行为及用户修复方向                                               |
| ------------------------------------------------------ | ---------------------------------------------------------------- |
| `missing`                                              | 进入已配置的 npm 补装流程                                        |
| `unusable` / `probe-timeout`                           | 显示命令路径和原因；修复权限、运行依赖或 PATH 后重试，不覆盖安装 |
| `configuration-missing` / `configuration-invalid`      | 显示缺少哪个配置键或无效字段，不猜包名和地址                     |
| `npm-unavailable`                                      | 提示安装可运行的 npm；不尝试用其他包管理器替代                   |
| `registry-auth`                                        | 401/403，提示核对企业 npm 凭据与读包权限；IAM 登录不是 npm 登录  |
| `package-unavailable` / `bin-mismatch`                 | 404、版本或 bin 不符，提示核对发布目录                           |
| `permission-denied` / `bin-conflict`                   | 提示 prefix、冲突路径及人工修复，不 sudo 或 force                |
| `network-error` / `install-timeout` / `install-failed` | 中止，显示安全摘要及重试入口                                     |
| `postcheck-failed` / `path-not-ready`                  | npm 成功但 CLI 未通过当前 PATH 验证，安装仍未完成                |
| `installation-busy`                                    | 同一用户已有 Comet CLI 补装任务，退出并提示稍后重试              |

`install-scripts-blocked`：npm 明确报告必要安装脚本被拦截时，提示按企业策略处理指定包并重新验证，退出 1；不静默返回成功。

在用户级 Comet 数据目录使用单独的企业 CLI 安装锁，保护“锁内重新探测 → 补装 → 复检”，避免两个项目同时初始化导致重复全局安装。锁包含 PID 与创建时间，使用独占创建；仅在确认持有进程已退出时回收陈旧锁，不只凭时间强行回收活跃安装锁。锁不能阻止用户在外部同时执行 npm，遇到 npm 冲突正常报错。

既有 IAM/DOP/GH 配置不属于 Comet 管理范围，不删除、不写入、不迁移；重复执行以实际命令状态为准，不以“上次安装成功”的标记替代探测。企业包自己的安装脚本是否保持已有配置，需要真实包验收，单靠 Comet 单测不能保证。

## 6. 输出与 IAM 登录提示

文本和 JSON 共用 domain 返回值：`status`、逐项 `tools`、`failures`、`nextActions`。每项至少包含 `command`、`action`（reused/installed/failed/not-run）、`reasonCode` 和脱敏错误摘要；包名及版本只在相关补装项中提供。

在现有 init JSON 中增加 `enterpriseCli` 和 `nextActions`，保留现有字段与 `complete/incomplete` 语义。前置检查失败时返回 `status: incomplete`、空平台安装结果和失败信息。`--json` 的 stdout 只输出一个 JSON 对象，npm 输出被捕获，不能穿插进度文字或凭据。普通模式按同一结果渲染摘要。原有安装后续失败时仍返回 incomplete，并保留此前 CLI 补装结果。

仅在完整 init 成功后，最后展示：

```text
企业 CLI 已就绪：iam、dop、gh。
请完成 IAM 登录配置（已登录的用户可直接验证）：
  1. 运行 iam auth login --system <system>，按提示交互式输入账号和密码。
     例如登录 devops：iam auth login --system devops；其他系统按企业要求选择。
  2. 运行 iam auth status --json，确认所需凭据处于 logged 状态。
CLI 安装完成不代表 IAM 认证已完成。
```

该提示每次成功都显示，不能因三个 CLI 都复用而丢失；JSON 通过 `nextActions` 提供同等信息。登录语法已由截图 4 确认；可用 `iam auth login --help` 查看参数，但不要求恰好两个账号，也不自动连续登录多个系统。不引入参考项目的 `oms-login`，不展示带密码的命令，不自动判断账号是否足以运行后续业务。IAM 未登录不改变本期安装成功退出码。

## 7. 模块、接线与交付清单

| 位置                                                                          | 实施内容                                                     |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `domains/enterprise-cli/index.ts`                                             | 公开检查/补装入口与类型                                      |
| `domains/enterprise-cli/catalog.ts`                                           | 三个命令的包映射、版本、探测契约                             |
| `domains/enterprise-cli/config.ts`                                            | 企业配置解析与校验                                           |
| `domains/enterprise-cli/ensure.ts`                                            | 探测、计划、安装、复检与错误分类                             |
| `domains/enterprise-cli/types.ts`                                             | 工具结果、错误与后续动作结构                                 |
| `platform/process/`                                                           | 通用命令解析、受限执行、npm 调用和进程清理；优先组合既有能力 |
| `platform/install/`                                                           | 用户级安装锁与 npm prefix/权限适配                           |
| `app/commands/init.ts`                                                        | 前置入口调用、提前失败返回、文本与 JSON 汇总，保持最小修改   |
| `test/domains/enterprise-cli/`                                                | 配置、状态转换、幂等与失败测试                               |
| `test/platform/`、`test/app/`                                                 | Windows/POSIX 进程适配、安装锁、init 接线和输出测试          |
| `config/repository-layout.json`、`scripts/lint/architecture.mjs`、`AGENTS.md` | 同步新增 domain、架构校验和结构说明                          |

不新增 workflow runtime entry，不手写 `.mjs` 生成物，不向 `assets/manifest.json` 登记外部 CLI。本功能通过现有 CLI build 打包；实施时核对 npm 发布产物确实包含新 domain。安装指南在 `docs/` 编写，README 仅补必要的依赖说明和文档链接，遵循先中文后英文。

实施顺序：先根据已确认包名和版本完成 bin 与剩余探测契约核验，再实现平台适配与独立 domain，随后接入 init 和输出，最后执行跨平台安装验收、更新安装指南与发布说明。本次仅新增内部设计文档，不改版本号或 Changelog；实现形成用户可见能力后，再按仓库规则检查 master、当前版本和上个发布 tag，写入对应版本的英文 Changelog。

## 8. 验收与验证计划

| 场景                                                          | 必须满足的结果                                                    |
| ------------------------------------------------------------- | ----------------------------------------------------------------- |
| 三项都可用                                                    | 不执行 npm 安装、不要求 registry、不改配置，成功末尾仍有 IAM 提示 |
| 三项存在/缺失的 8 种组合                                      | 只安装缺失项；逐项复检；覆盖 iam/dop/gh 每项                      |
| 已有文件但无法执行、解释器缺失、超时、身份不符                | 标记 unusable 并退出 1，不当作缺失覆盖                            |
| 同包多 bin、目标 bin 冲突                                     | 去重或明确阻塞，不能覆盖已复用项                                  |
| 配置缺失、无效版本、非法 registry、scope registry 冲突        | 安装前拒绝或正确覆盖本次调用，用户 npm 配置保持不变               |
| npm 缺失、401/403/404、网络错误、权限不足                     | 明确错误分类及修复建议，停止项目写入                              |
| 第二项安装失败                                                | 第一项保留，后续项不执行；再次 init 复用第一项                    |
| npm 退出 0 但 bin 缺失或 PATH 未生效                          | init 退出 1，报告 postcheck/path 问题                             |
| 重复执行与两个项目并发 init                                   | 已可用项不重装，锁内再次探测避免重复安装                          |
| Windows exe/cmd/bat、带空格目录、POSIX 无执行权限             | 实际命令解析与终端可用性一致                                      |
| 安装超时或取消                                                | 清理子进程树，释放锁；不继续配置落盘                              |
| project/global、三种 workflow、多平台、yes/json/skip-existing | 都经过同一检查，只执行一次；失败不进入原有安装阶段                |
| IAM 未登录、已登录                                            | 都不触发重装；完整安装成功后文本/JSON 均有登录验证动作            |
| npm stderr 含 token 或带认证信息 URL                          | 文本和 JSON 不泄露凭据，输出体积受限                              |

补充 GH 版本探测用例：`gh version gitee-cli 1.0.6` 和标准 `gh version <version>` 均可通过；其他可用版本复用不重装；退出非 0 或无有效版本输出仍报不可用。这些是安装探测测试，不是 Gitee/GitHub API 兼容性测试。

补充安装脚本回归场景：npm 返回 0 但 postinstall 被拦截、GH 包装器存在而二进制缺失、指定包脚本获准后复检仍失败、手工修复后重复 init 正常复用。各场景均不得自动改写全局脚本策略或绕过最终 CLI 复检。

单元及集成测试使用临时 HOME、npm prefix、PATH 和假 CLI/假 npm，不操作开发者真实工具或企业账号。补充隔离 npm registry/测试包的补装测试以验证真实 npm 的配置优先级与 bin 行为；跨平台 CI 覆盖 Linux/macOS/Windows。仅 mock 测试通过不足以关闭 Issue。

发布前在企业内网干净环境记录真实包名、版本、registry、bin、探测输出和退出码，验证首次安装、二次执行无重装、既有工具配置保持、IAM 提示能够指导用户完成认证。GH 身份、100% 兼容性约定及 IAM 登录参数已确认，不重复列为待核验事项；安装验收保留真实执行与退出码检查。不得把参考项目的 mock CLI 当作真实包验收证据。

实现阶段先运行相关 `test/domains/enterprise-cli/`、平台进程和 init 测试；由于涉及安装入口及跨平台共享进程能力，交付前运行一次全量测试、`pnpm lint`、`pnpm build`，以及受影响文件的格式检查。设计阶段只需文档格式与相关仓库契约检查。

## 9. 已确认输入与剩余验证项

已确认：三个包版本分别为 `@cli-tools/iam@1.0.2`、`@cli-tools/dop@1.0.4`、`@cli-tools/gh@1.0.6`；企业 npm 使用 HTTP、scope npm-local 与默认 npm-external 分离，以及路径绑定 token；IAM/DOP 帮助命令、IAM 状态 JSON 和 `iam auth login --system` 交互式登录语法已由截图补齐；GH postinstall 被 npm 策略拦截的失败场景已有真实证据；用户确认 GH 输出 `gh version gitee-cli 1.0.6`，其企业 Gitee 身份及 100% GitHub CLI 兼容性作为设计前提。registry 默认地址继续留空供用户手工填写，不要求再次提供地址。

剩余验证项：

1. 三个精确版本的完整 bin 映射、安装脚本与操作系统/CPU/Node 支持范围；已安装命令版本与 npm 包版本的对应关系。
2. 内网干净环境的实际读包安装、传递依赖分发、代理等网络前提。截图显示当前机器查询成功，不代表所有目标机器已配置；不额外假定截图未出现的 CA 或代理要求。
3. IAM/DOP 帮助探测的退出码和无凭据运行结果；IAM 登录参数已确认，无需再提供 `--system` 的帮助证明。
4. GH postinstall 二进制下载来源、完整性校验及内网可达性；版本输出与兼容性已确认，不再要求补充证明。实际安装验收仍记录命令退出码。

截图还显示 npm 12.0.2 对当前 Node 22.13.0 的兼容性警告，以及旧 `sass_binary_site` 配置警告。记录为该测试机环境信息，不视为三个 CLI 安装失败，也不由 Comet 擅自升级 Node/npm 或删除 npmrc 配置；干净环境验收使用互相兼容的 Node/npm 组合。

以上剩余项不阻止方案评审与独立模块开发，但未完成前不能声称三个 CLI 的真实补装、无认证探测和跨平台验收已经通过。
