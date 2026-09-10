# Enterprise Guard 组合网关第一里程碑实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 建立平台无关的 Enterprise Guard 输入/能力契约，并把 Claude Code 从 Enterprise Hook 与 Router 双条目迁移为单一 `comet-enterprise-gateway.mjs` 本地硬阻断入口。

**架构：** Claude codec 将原始 stdin 规范化，Guard service 执行策略、例外和 findings，Composite Gateway 在同一进程内按 `Enterprise Guard → Comet Hook Router` 顺序编排并只渲染一次宿主决策。现有 `domains/comet-entry/` Router 保持不变；安装迁移、巡检和旧条目清理由 `domains/enterprise-guard/` 单向组合公开安装能力完成。

**技术栈：** TypeScript、Node.js 20 ESM、esbuild、自包含 `.mjs` runtime、Vitest、JSON manifest、Claude Code PreToolUse Hook。

---

## 计划边界

本计划是已确认设计的第一个独立发布单元，覆盖规范输入与 profile、Claude codec、Guard service、单一 Gateway、runtime 资产、双 Hook 迁移和完整生命周期验证。

OpenCode 插件桥依赖这里稳定下来的规范事件、Runner 决策和失败语义，并且必须以真实 OpenCode 版本完成加载顺序 Spike。它在本里程碑只登记 `plugin-hook` 能力边界，不安装插件、不提升覆盖等级；Gateway 合入后单独制定 OpenCode 实施计划。

完整方案按以下依赖顺序交付，避免一个计划跨越多个独立宿主：

1. 本计划：规范契约与 Claude 单一 Gateway。
2. 受管 Runner 计划：版本化项目外运行时、manifest 摘要、原子升级和本地受控例外激活。
3. OpenCode 计划：真实版本 Spike、`tool.execute.before` 薄桥、超时/异常安全失败、排序验证和覆盖定级。
4. 平台扩展计划：按九项 Spike 复用协议族，并增加 Git 原生边界与 CI 消费。

每个计划都以前一个里程碑的契约测试通过为开始条件，独立形成可运行、可回滚的交付物。

## 文件结构

### 创建

- `domains/enterprise-guard/normalized-event.ts`：版本化规范输入、内部决策和 codec 类型。
- `domains/enterprise-guard/input-codecs/claude.ts`：Claude stdin 到规范输入的唯一转换实现。
- `domains/enterprise-guard/input-codecs/index.ts`：codec 注册表与严格平台选择。
- `domains/enterprise-guard/platform-profiles.ts`：宿主、协议、安装和覆盖事实。
- `domains/enterprise-guard/guard-service.ts`：策略、例外、findings 的平台无关编排。
- `domains/enterprise-guard/enterprise-gateway.ts`：Guard 与现有 Router 的顺序组合。
- `domains/enterprise-guard/enterprise-gateway-entry.ts`：stdin/argv 进程入口。
- `test/domains/enterprise-guard/input-codecs.test.ts`
- `test/domains/enterprise-guard/guard-service.test.ts`
- `test/domains/enterprise-guard/enterprise-gateway.test.ts`

### 修改

- `domains/enterprise-guard/policy-engine.ts`
- `domains/enterprise-guard/hook-lifecycle.ts`
- `domains/enterprise-guard/platform-coverage.ts`
- `scripts/build/build-enterprise-guard-runtime.mjs`
- `config/repository-layout.json`
- `assets/manifest.json`
- `domains/skill/platform-install.ts`
- `app/commands/doctor.ts`
- `test/domains/enterprise-guard/policy-engine.test.ts`
- `test/domains/enterprise-guard/hook-lifecycle.test.ts`
- `test/domains/enterprise-guard/platform-coverage.test.ts`
- `test/app/init-e2e.test.ts`
- `test/app/update.test.ts`
- `test/app/doctor.test.ts`
- `test/app/uninstall.test.ts`
- `test/repository/enterprise-guard-runtime-assets.test.ts`
- `test/repository/repository-layout.test.ts`
- `docs/architecture/enterprise-guard/README.md`
- `docs/architecture/enterprise-guard/platform-capability-matrix.md`
- `docs/architecture/enterprise-guard/platform-coverage.md`
- `CHANGELOG.md`、`package.json`（最终按 master 版本基线决定）。

### 删除

- `domains/enterprise-guard/enterprise-hook-entry.ts`
- `test/domains/enterprise-guard/enterprise-hook-entry.test.ts`
- `assets/skills/comet/scripts/comet-enterprise-hook.mjs`

## 任务 1：抽取规范事件与 Claude 输入 codec

**文件：**

- 创建：`domains/enterprise-guard/normalized-event.ts`
- 创建：`domains/enterprise-guard/input-codecs/claude.ts`
- 创建：`domains/enterprise-guard/input-codecs/index.ts`
- 创建：`test/domains/enterprise-guard/input-codecs.test.ts`
- 修改：`domains/enterprise-guard/policy-engine.ts`
- 修改：`test/domains/enterprise-guard/policy-engine.test.ts`

- [ ] **步骤 1：编写 codec 失败测试**

```ts
import { describe, expect, it } from 'vitest';

import { parseEnterpriseGuardInput } from '../../../domains/enterprise-guard/input-codecs/index.js';

describe('Enterprise Guard input codecs', () => {
  it('normalizes Claude Bash and Write without losing policy fields', () => {
    const bash = parseEnterpriseGuardInput(
      'claude',
      JSON.stringify({
        hook_event_name: 'PreToolUse',
        cwd: '/workspace/comet',
        tool_name: 'Bash',
        tool_input: { command: 'git push --force origin main' },
      }),
    );
    expect(bash.command.value).toBe('git push --force origin main');
    expect(bash.event).toEqual({ name: 'PreToolUse', preAction: true, blockingCapable: true });

    const write = parseEnterpriseGuardInput(
      'claude',
      JSON.stringify({
        tool_name: 'Write',
        tool_input: { file_path: '.env', content: 'TOKEN=value' },
      }),
    );
    expect(write.writes[0]).toMatchObject({ operation: 'create' });
    expect(write.writes[0].path.value).toBe('.env');
    expect(write.writes[0].fragment.value).toBe('TOKEN=value');
  });

  it('marks oversized or malformed security input as unsafe', () => {
    const oversized = parseEnterpriseGuardInput(
      'claude',
      JSON.stringify({
        tool_name: 'Write',
        tool_input: { file_path: '.env', content: 'x'.repeat(300 * 1024) },
      }),
    );
    expect(oversized.parse.status).toBe('partial');
    expect(oversized.truncation.fields.some((field) => field.truncated)).toBe(true);
    expect(parseEnterpriseGuardInput('claude', '{').parse.status).toBe('failed');
  });

  it('rejects a platform without a registered codec', () => {
    expect(() => parseEnterpriseGuardInput('opencode', '{}')).toThrow(
      'Enterprise Guard input codec is unavailable for platform: opencode',
    );
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：

```bash
npx vitest run test/domains/enterprise-guard/input-codecs.test.ts
```

预期：FAIL，错误指出 `input-codecs/index.js` 不存在。

- [ ] **步骤 3：定义规范类型和 codec 接口**

将现有 `CapturedString`、`CapturedJson`、`EnterpriseHookInput`、`EnterpriseRuleResult` 和 `EnterpriseGuardDecision` 从 `policy-engine.ts` 移到 `normalized-event.ts`，保持 v1 JSON 字段不变，并新增：

```ts
export type EnterpriseGuardHost = 'command-hook' | 'plugin-hook' | 'native-boundary';

export interface EnterpriseGuardInputCodec {
  readonly id: string;
  parse(source: string): EnterpriseHookInput;
}

export interface EnterpriseGuardEvaluation {
  input: EnterpriseHookInput;
  decision: EnterpriseGuardDecision;
}
```

`policy-engine.ts` 改为导入并兼容导出这些类型：

```ts
import type {
  EnterpriseGuardDecision,
  EnterpriseHookInput,
  EnterpriseRuleResult,
} from './normalized-event.js';

export type {
  EnterpriseGuardDecision,
  EnterpriseHookInput,
  EnterpriseRuleResult,
} from './normalized-event.js';
```

- [ ] **步骤 4：移动 Claude 解析实现并建立注册表**

把 `isRecord`、`boundedString`、`boundedJson`、`truncationField`、`rawInput`、`writeOperation`、`isWriteTool` 和 `parseClaudeEnterpriseHookInput` 移到 `input-codecs/claude.ts`。保持 `MAX_ENTERPRISE_HOOK_INPUT_BYTES = 256 * 1024`、字段优先级和截断计算不变，并导出：

```ts
export const claudeEnterpriseGuardCodec: EnterpriseGuardInputCodec = {
  id: 'claude',
  parse: parseClaudeEnterpriseHookInput,
};
```

在 `input-codecs/index.ts` 写入：

```ts
import type { EnterpriseHookInput } from '../normalized-event.js';
import { claudeEnterpriseGuardCodec } from './claude.js';

const CODECS = new Map([[claudeEnterpriseGuardCodec.id, claudeEnterpriseGuardCodec]]);

export function parseEnterpriseGuardInput(platformId: string, source: string): EnterpriseHookInput {
  const codec = CODECS.get(platformId);
  if (!codec) {
    throw new Error(`Enterprise Guard input codec is unavailable for platform: ${platformId}`);
  }
  return codec.parse(source);
}
```

策略测试改从 `input-codecs/claude.js` 导入 parser；HARD/SOFT 断言不得改变。

- [ ] **步骤 5：运行最小测试并提交**

```bash
npx vitest run test/domains/enterprise-guard/input-codecs.test.ts test/domains/enterprise-guard/policy-engine.test.ts
git add domains/enterprise-guard/normalized-event.ts domains/enterprise-guard/input-codecs domains/enterprise-guard/policy-engine.ts test/domains/enterprise-guard/input-codecs.test.ts test/domains/enterprise-guard/policy-engine.test.ts
git commit -m "refactor: separate enterprise guard input codecs"
```

预期：测试 PASS，提交只包含本任务文件。

## 任务 2：建立平台 profile 与诚实覆盖模型

**文件：**

- 创建：`domains/enterprise-guard/platform-profiles.ts`
- 修改：`domains/enterprise-guard/platform-coverage.ts`
- 修改：`test/domains/enterprise-guard/platform-coverage.test.ts`

- [ ] **步骤 1：编写 profile 失败测试**

```ts
it('separates host capability from verified enforcement', () => {
  expect(enterpriseGuardPlatformProfile({ id: 'claude' })).toEqual({
    platformId: 'claude',
    host: 'command-hook',
    inputCodec: 'claude',
    decisionCodec: 'comet-command-hook',
    installStrategy: 'composite-gateway',
    enforcement: 'best-effort',
    coveredTools: ['Write', 'Edit', 'Bash'],
    orderingGuarantee: 'unknown',
  });
  expect(enterpriseGuardPlatformProfile({ id: 'opencode' })).toMatchObject({
    host: 'plugin-hook',
    installStrategy: 'not-installed',
    enforcement: 'none',
    orderingGuarantee: 'unknown',
  });
  expect(enterpriseGuardCoverage({ id: 'opencode' }).level).toBe('rules-and-ci');
});
```

- [ ] **步骤 2：运行测试验证失败**

运行 `npx vitest run test/domains/enterprise-guard/platform-coverage.test.ts`。

预期：FAIL，`enterpriseGuardPlatformProfile` 尚未定义。

- [ ] **步骤 3：实现 profile 和覆盖派生**

```ts
export type EnterpriseGuardCoverageLevel =
  | 'enforced-managed'
  | 'enforced-project'
  | 'enforced-managed-plugin'
  | 'best-effort'
  | 'rules-and-ci';

export interface EnterpriseGuardPlatformProfile {
  platformId: string;
  host: 'command-hook' | 'plugin-hook' | 'native-boundary' | 'none';
  inputCodec: string | null;
  decisionCodec: string | null;
  installStrategy: 'composite-gateway' | 'managed-plugin' | 'not-installed';
  enforcement: 'managed' | 'project' | 'managed-plugin' | 'best-effort' | 'none';
  coveredTools: readonly string[];
  orderingGuarantee: 'final' | 'verified' | 'unknown';
}
```

使用只读常量定义 Claude 和 OpenCode；其他平台返回 `host: 'none'`、`installStrategy: 'not-installed'`、`enforcement: 'none'`。`platform-coverage.ts` 从以下映射计算 level，不再判断平台名：

```ts
const LEVEL_BY_ENFORCEMENT = {
  managed: 'enforced-managed',
  project: 'enforced-project',
  'managed-plugin': 'enforced-managed-plugin',
  'best-effort': 'best-effort',
  none: 'rules-and-ci',
} as const;
```

- [ ] **步骤 4：运行测试并提交**

```bash
npx vitest run test/domains/enterprise-guard/platform-coverage.test.ts
git add domains/enterprise-guard/platform-profiles.ts domains/enterprise-guard/platform-coverage.ts test/domains/enterprise-guard/platform-coverage.test.ts
git commit -m "refactor: model enterprise guard platform capabilities"
```

预期：PASS；Claude 安装本地 Gateway，但因同级 Hook 并行执行而为 `best-effort`；OpenCode 和未接入平台为 `rules-and-ci`。

## 任务 3：建立平台无关 Guard service

**文件：**

- 创建：`domains/enterprise-guard/guard-service.ts`
- 创建：`test/domains/enterprise-guard/guard-service.test.ts`
- 修改：`domains/enterprise-guard/findings.ts`

- [ ] **步骤 1：编写 Guard service 失败测试**

```ts
import { describe, expect, it, vi } from 'vitest';

import { evaluateEnterpriseGuardSource } from '../../../domains/enterprise-guard/guard-service.js';

describe('Enterprise Guard service', () => {
  it('denies HARD input before workflow routing', async () => {
    const result = await evaluateEnterpriseGuardSource({
      platformId: 'claude',
      source: JSON.stringify({
        tool_name: 'Bash',
        tool_input: { command: 'rm -rf /' },
      }),
      projectRoot: '/workspace/comet',
    });
    expect(result.decision.allowed).toBe(false);
    expect(result.decision.ruleId).toBe('EG-HARD-RM-001');
  });

  it('fails closed when SOFT findings cannot be persisted', async () => {
    const result = await evaluateEnterpriseGuardSource(
      {
        platformId: 'claude',
        source: JSON.stringify({
          cwd: '/workspace/comet',
          tool_name: 'Bash',
          tool_input: { command: 'git push --force origin feature/demo' },
        }),
        projectRoot: '/workspace/comet',
      },
      { recordFindings: vi.fn().mockRejectedValue(new Error('read-only filesystem')) },
    );
    expect(result.decision).toMatchObject({
      allowed: false,
      reason: 'Enterprise Guard audit persistence is unavailable',
    });
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行 `npx vitest run test/domains/enterprise-guard/guard-service.test.ts`。

预期：FAIL，`guard-service.js` 不存在。

- [ ] **步骤 3：实现可注入依赖的 Guard service**

```ts
interface GuardServiceRequest {
  platformId: string;
  source: string;
  projectRoot: string | null;
}

interface GuardServiceDependencies {
  readExceptions(root: string): ReturnType<typeof readEnterpriseExceptions>;
  recordFindings: typeof recordEnterpriseFindings;
}

export async function evaluateEnterpriseGuardSource(
  request: GuardServiceRequest,
  overrides: Partial<GuardServiceDependencies> = {},
): Promise<EnterpriseGuardEvaluation> {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...overrides };
  const input = parseEnterpriseGuardInput(request.platformId, request.source);
  const auditRoot = request.projectRoot ?? input.workingDirectory.value;
  const exceptions = auditRoot ? await dependencies.readExceptions(auditRoot) : [];
  let decision = evaluateEnterpriseHookInput(input, { exceptions });

  if (auditRoot && decision.warningRuleIds.length > 0) {
    try {
      await dependencies.recordFindings(auditRoot, input, decision);
    } catch {
      decision = {
        ...decision,
        allowed: false,
        ruleId: 'EG-HARD-AUDIT-001',
        reason: 'Enterprise Guard audit persistence is unavailable',
      };
    }
  }
  return { input, decision };
}
```

保留 findings 的脱敏和锁语义；service 仅在 `warningRuleIds.length > 0` 时调用存储。

- [ ] **步骤 4：迁移审计场景并验证**

把旧 entry 测试中的“只写脱敏 findings”“消费已批准例外”和“审计不可用时拒绝”迁入 `guard-service.test.ts`，继续使用真实临时目录验证文件不包含密钥原文。

```bash
npx vitest run test/domains/enterprise-guard/guard-service.test.ts test/domains/enterprise-guard/findings.test.ts test/domains/enterprise-guard/exceptions.test.ts
```

预期：PASS。

- [ ] **步骤 5：提交**

```bash
git add domains/enterprise-guard/guard-service.ts domains/enterprise-guard/findings.ts test/domains/enterprise-guard/guard-service.test.ts
git commit -m "refactor: centralize enterprise guard evaluation"
```

## 任务 4：实现 Guard-first 单一组合网关

**文件：**

- 创建：`domains/enterprise-guard/enterprise-gateway.ts`
- 创建：`domains/enterprise-guard/enterprise-gateway-entry.ts`
- 创建：`test/domains/enterprise-guard/enterprise-gateway.test.ts`
- 删除：`domains/enterprise-guard/enterprise-hook-entry.ts`
- 删除：`test/domains/enterprise-guard/enterprise-hook-entry.test.ts`

- [ ] **步骤 1：编写顺序与短路失败测试**

```ts
it('short-circuits Router when Enterprise Guard denies', async () => {
  const inspectRouter = vi.fn();
  const output = await executeEnterpriseGateway(
    ['--platform', 'claude', '--project-root', '/workspace/comet'],
    JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'rm -rf /' } }),
    { inspectRouter },
  );
  expect(output.exitCode).toBe(2);
  expect(output.stderr).toContain('EG-HARD-RM-001');
  expect(inspectRouter).not.toHaveBeenCalled();
});

it('returns Router denial after Guard allows the same raw input', async () => {
  const output = await executeEnterpriseGateway(
    ['--platform', 'claude', '--project-root', '/workspace/comet'],
    JSON.stringify({
      cwd: '/workspace/comet',
      tool_name: 'Write',
      tool_input: { file_path: 'openspec/changes/demo/tasks.md', content: '- [x] task' },
    }),
    { inspectRouter: vi.fn().mockResolvedValue({ allowed: false, reason: 'phase denied' }) },
  );
  expect(output).toEqual({ exitCode: 2, stdout: '', stderr: 'phase denied\n' });
});
```

再加入：没有 Comet 项目时 HARD 仍拒绝；安全非 Comet 写操作允许；不支持的平台返回 exit 64。

- [ ] **步骤 2：运行测试验证失败**

运行 `npx vitest run test/domains/enterprise-guard/enterprise-gateway.test.ts`。

预期：FAIL，Gateway 模块不存在。

- [ ] **步骤 3：实现纯组合函数**

`enterprise-gateway.ts` 只组合公开能力：`evaluateEnterpriseGuardSource`、`parseCometHookRequest`、`projectRootFrom`、`inspectCometHook`、`runWithHookReadCache` 和 `renderCometHookDecision`。

```ts
export async function executeEnterpriseGateway(
  args: readonly string[],
  source: string,
  overrides: Partial<EnterpriseGatewayDependencies> = {},
): Promise<CometHookProcessOutput> {
  const parsed = parseGatewayArgs(args);
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...overrides };
  const guard = await dependencies.evaluateGuard({
    platformId: parsed.platformId,
    source,
    projectRoot: parsed.projectRoot ?? null,
  });
  if (!guard.decision.allowed) {
    return renderCometHookDecision(parsed.platformId, guard.decision);
  }

  let routerDecision: CometHookDecision;
  try {
    const request = parseCometHookRequest(source);
    const projectRoot = await projectRootFrom(parsed, request);
    routerDecision = projectRoot
      ? await runWithHookReadCache(() => dependencies.inspectRouter(projectRoot, request))
      : { allowed: true, reason: 'No Comet project discovered' };
  } catch (error) {
    routerDecision = {
      allowed: false,
      reason: `Comet Hook Router failed closed during project discovery: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
  return renderCometHookDecision(parsed.platformId, routerDecision);
}
```

`parseGatewayArgs` 只接受 `--platform` 与可选 `--project-root`，复用 Router 的平台白名单和错误语义。Guard 决策只在最终返回时渲染一次。

- [ ] **步骤 4：实现 bounded stdin 进程入口**

`enterprise-gateway-entry.ts` 从旧 entry 移入 `isDirectEntry` 与 bounded stdin 读取。它读完整 stdin 流，但最多缓存 `MAX_ENTERPRISE_HOOK_INPUT_BYTES + 1`：

```ts
const output = await executeEnterpriseGateway(process.argv.slice(2), await readStdin());
if (output.stdout) process.stdout.write(output.stdout);
if (output.stderr) process.stderr.write(output.stderr);
process.exitCode = output.exitCode;
```

删除旧 entry 和旧测试；旧测试场景必须已经分别落在 Guard service 与 Gateway 测试中。

- [ ] **步骤 5：运行最小测试并提交**

```bash
npx vitest run test/domains/enterprise-guard/enterprise-gateway.test.ts test/domains/enterprise-guard/guard-service.test.ts test/domains/comet-entry/hook-router.test.ts test/domains/comet-entry/hook-adapter.test.ts
git add domains/enterprise-guard/enterprise-gateway.ts domains/enterprise-guard/enterprise-gateway-entry.ts domains/enterprise-guard/enterprise-hook-entry.ts test/domains/enterprise-guard/enterprise-gateway.test.ts test/domains/enterprise-guard/enterprise-hook-entry.test.ts
git commit -m "feat: add enterprise guard composite gateway"
```

预期：PASS，Router 原有测试无变化。

## 任务 5：生成并发布自包含 Gateway runtime

**文件：**

- 修改：`config/repository-layout.json`
- 修改：`scripts/build/build-enterprise-guard-runtime.mjs`
- 修改：`assets/manifest.json`
- 修改：`domains/skill/platform-install.ts`
- 修改：`test/repository/enterprise-guard-runtime-assets.test.ts`
- 修改：`test/repository/repository-layout.test.ts`
- 创建：`assets/skills/comet/scripts/comet-enterprise-gateway.mjs`（构建生成）
- 删除：`assets/skills/comet/scripts/comet-enterprise-hook.mjs`

- [ ] **步骤 1：先把 repository 测试改为期望 Gateway**

```ts
expect(layout.enterpriseGuardRuntime).toEqual({
  entry: 'domains/enterprise-guard/enterprise-gateway-entry.ts',
  output: 'assets/skills/comet/scripts/comet-enterprise-gateway.mjs',
});
```

Runtime asset 测试断言：

```ts
expect(manifest.skills).toContain('comet/scripts/comet-enterprise-gateway.mjs');
expect(manifest.skills).not.toContain('comet/scripts/comet-enterprise-hook.mjs');
expect(source).toContain('comet.enterprise-hook-input.v1');
expect(source).toContain('No Comet project discovered');
```

保留危险 Bash 与超大 Write 的真实子进程阻断测试，再新增安全写入无 Comet 项目时退出 0。

- [ ] **步骤 2：运行 repository 测试验证失败**

```bash
npx vitest run test/repository/enterprise-guard-runtime-assets.test.ts test/repository/repository-layout.test.ts
```

预期：FAIL，布局和新产物不存在。

- [ ] **步骤 3：切换构建入口和 manifest**

把 `enterpriseGuardRuntime` 改成新 entry/output。构建脚本继续从布局读取单 entry/output。在 manifest 中用 Gateway 替换旧 Enterprise Hook；保留 `comet-hook-router.mjs`，因为其他 Hook 平台仍使用 Router。把 `NATIVE_SHARED_SKILL_PATHS` 和 `prepareNativeSkillInstallTarget` 的旧文件名替换为 Gateway。

- [ ] **步骤 4：构建资产并验证**

```bash
pnpm build:enterprise-guard-runtime
git rm assets/skills/comet/scripts/comet-enterprise-hook.mjs
npx vitest run test/repository/enterprise-guard-runtime-assets.test.ts test/repository/repository-layout.test.ts
node scripts/build/build-enterprise-guard-runtime.mjs --check
```

预期：PASS；新 Gateway 自包含且最新，旧产物从 Git 和 manifest 移除。

- [ ] **步骤 5：提交**

```bash
git add config/repository-layout.json scripts/build/build-enterprise-guard-runtime.mjs assets/manifest.json domains/skill/platform-install.ts test/repository/enterprise-guard-runtime-assets.test.ts test/repository/repository-layout.test.ts assets/skills/comet/scripts/comet-enterprise-gateway.mjs
git commit -m "build: publish enterprise guard gateway runtime"
```

## 任务 6：把 Claude 生命周期原子迁移为单 Gateway

**文件：**

- 修改：`domains/enterprise-guard/hook-lifecycle.ts`
- 修改：`test/domains/enterprise-guard/hook-lifecycle.test.ts`

- [ ] **步骤 1：把测试改成最终只有一个 Gateway**

构造同时包含用户 Hook、Router、旧 Enterprise Hook 的 settings，执行两次 `installEnterpriseGuard` 后断言：

```ts
expect(commands.filter((command) => command.includes('comet-enterprise-gateway.mjs'))).toHaveLength(
  1,
);
expect(commands.some((command) => command.includes('comet-hook-router.mjs'))).toBe(false);
expect(commands.some((command) => command.includes('comet-enterprise-hook.mjs'))).toBe(false);
expect(commands).toContain('node user-hook.mjs');
```

再通过 lifecycle dependencies 模拟 Gateway 安装失败，断言旧 Router/Enterprise 条目仍在。

- [ ] **步骤 2：运行测试验证失败**

运行 `npx vitest run test/domains/enterprise-guard/hook-lifecycle.test.ts`。

预期：FAIL，当前实现仍保留多条 Hook。

- [ ] **步骤 3：实现新旧 ownership 配置**

```ts
export const enterpriseGatewayHookConfig: Record<string, HookConfig> = {
  'comet/scripts/comet-enterprise-gateway.mjs': {
    matcher: 'Write|Edit|Bash',
    description: 'Enterprise Guard and Comet workflow enforcement',
    arguments: ['--platform', 'claude'],
  },
};

const RETIRED_ENTERPRISE_HOOK_CONFIG: Record<string, HookConfig> = {
  'comet/scripts/comet-enterprise-hook.mjs': {
    matcher: 'Write|Edit|Bash',
    description: 'Enterprise Guard hard-rule enforcement',
    arguments: ['--platform', 'claude'],
  },
};

const ROUTER_HOOK_CONFIG: Record<string, HookConfig> = {
  'comet/scripts/comet-hook-router.mjs': {
    matcher: 'Write|Edit',
    description: 'Route each write to the selected Comet Native or Classic phase guard',
  },
};
```

安装顺序必须是：安装/确认 Gateway 成功，再删除两个旧受管条目。清理失败返回 `status: 'failed'`。`inspectEnterpriseGuard` 只以 Gateway 唯一存在为健康条件，并把旧两条存在映射为可修复状态。`removeEnterpriseGuard` 同时移除 Gateway 和退休 Enterprise Hook；通用 Comet 卸载继续负责 Router。

- [ ] **步骤 4：验证幂等、失败安全和用户配置保留**

```bash
npx vitest run test/domains/enterprise-guard/hook-lifecycle.test.ts test/domains/skill/platform-inspect.test.ts test/domains/skill/uninstall.test.ts
```

预期：PASS；重复安装只有一个 Gateway，失败安装不破坏旧保护，用户 Hook 始终保留。

- [ ] **步骤 5：提交**

```bash
git add domains/enterprise-guard/hook-lifecycle.ts test/domains/enterprise-guard/hook-lifecycle.test.ts
git commit -m "feat: migrate claude to a single enterprise gateway"
```

## 任务 7：同步 init、update、Doctor、repair 和 uninstall

**文件：**

- 修改：`app/commands/doctor.ts`
- 修改：`test/app/init-e2e.test.ts`
- 修改：`test/app/update.test.ts`
- 修改：`test/app/doctor.test.ts`
- 修改：`test/app/uninstall.test.ts`

- [ ] **步骤 1：增加四类生命周期失败测试**

- `init-e2e`：Claude 最终配置包含一个 Gateway，不包含 Router/旧 Enterprise Hook；用户 Hook 保留。
- `update`：旧双 Hook 升级为一个 Gateway；重复 update 不产生重复条目。
- `doctor`：健康文案为 `exactly one managed Enterprise Gateway present`；旧双 Hook、缺失 Gateway 或 runtime 摘要不一致时返回 warn 和 repair 命令。
- `uninstall`：移除 Gateway 和退休 Enterprise Hook，不删除用户 Hook；完整 Comet 卸载后 Router 也不存在。

- [ ] **步骤 2：运行 app 测试验证失败**

```bash
npx vitest run test/app/init-e2e.test.ts test/app/update.test.ts test/app/doctor.test.ts test/app/uninstall.test.ts
```

预期：FAIL，Doctor 仍分别要求 Enterprise Hook 与 Router。

- [ ] **步骤 3：让 Doctor 对 Claude 只检查 Gateway**

在 `app/commands/doctor.ts` 增加与现有 `hookRouterRuntimePaths` 对称的路径函数：

```ts
const ENTERPRISE_GATEWAY_RUNTIME = 'comet/scripts/comet-enterprise-gateway.mjs';

function enterpriseGatewayRuntimePaths(
  baseDir: string,
  platform: Platform,
  scope: InstallScope,
): { source: string; destination: string } {
  return {
    source: path.join(getAssetsDir(), 'skills', ...ENTERPRISE_GATEWAY_RUNTIME.split('/')),
    destination: path.join(
      baseDir,
      getPlatformSkillsDir(platform, scope),
      'skills',
      ...ENTERPRISE_GATEWAY_RUNTIME.split('/'),
    ),
  };
}
```

在 `checkHookComponents` 读取 profile 后先处理 `composite-gateway` 安装策略。并行读取 Gateway source/destination，只有内容相同且 Hook inspection 健康时才通过：

```ts
if (usesEnterpriseGuardGateway(platform)) {
  const runtime = enterpriseGatewayRuntimePaths(baseDir, platform, scope);
  const [expected, installed] = await Promise.all([
    fs.readFile(runtime.source),
    fs.readFile(runtime.destination),
  ]);
  const inspection = await inspectEnterpriseGuard(baseDir, platform, scope);
  const healthy =
    expected.equals(installed) &&
    inspection.present &&
    !inspection.error &&
    !inspection.duplicatePresent &&
    !inspection.legacyPresent;
  return [
    {
      check: `enterprise gateway: ${platform.name} (${scope})`,
      status: healthy ? 'pass' : 'warn',
      message: healthy
        ? 'exactly one managed Enterprise Gateway present'
        : `${inspection.error ?? 'managed Enterprise Gateway missing'} — run: comet doctor --repair --scope ${scope}`,
    },
  ];
}
```

读取失败要转换为 warn，不得让 Doctor 崩溃。其余平台继续现有 Router 检查。

在 `repairDoctorState` 的两处 Hook 修复循环中按 coverage 选择复制对象：Claude 复制 Gateway source 到 destination，其他平台复制 Router。之后仍调用 `installEnterpriseGuard` 完成配置迁移。这样 repair 结束时 Claude 只有一个最新 Gateway；Gateway 复制或安装失败时抛出明确错误，不报告已修复。

- [ ] **步骤 4：运行生命周期测试**

```bash
npx vitest run test/app/init-e2e.test.ts test/app/update.test.ts test/app/doctor.test.ts test/app/uninstall.test.ts test/domains/enterprise-guard/hook-lifecycle.test.ts
```

预期：PASS。

- [ ] **步骤 5：提交**

```bash
git add app/commands/doctor.ts test/app/init-e2e.test.ts test/app/update.test.ts test/app/doctor.test.ts test/app/uninstall.test.ts
git commit -m "fix: report and repair the enterprise gateway lifecycle"
```

## 任务 8：更新覆盖文档、发布记录并完成高风险验证

**文件：**

- 修改：`docs/architecture/enterprise-guard/README.md`
- 修改：`docs/architecture/enterprise-guard/platform-capability-matrix.md`
- 修改：`docs/architecture/enterprise-guard/platform-coverage.md`
- 修改：`CHANGELOG.md`
- 修改：`package.json`（仅在当前分支尚未使用高于 master 的发布版本时）

- [ ] **步骤 1：确定发布比较基线**

```bash
git fetch origin master --tags
git show origin/master:package.json
node -p "require('./package.json').version"
git describe --tags --abbrev=0
git log "$(git describe --tags --abbrev=0)"..HEAD --oneline
```

预期：明确 master 版本、当前分支版本、上一个 tag 和用户可见候选变化。若当前分支已有高于 master 的版本条目，把本能力追加到同一版本；否则只提升一个符合仓库发布节奏的版本，并让 `package.json` 与 Changelog 一致。

- [ ] **步骤 2：更新能力矩阵和覆盖报告**

文档必须明确：

- Claude 使用单一 `comet-enterprise-gateway.mjs`，覆盖 `Write`、`Edit`、`Bash`。
- Guard 在项目发现和 Router 之前执行。
- Gateway 内部保证 Guard 先于 Router，但同级 Hook 并行且互相不可见，因此等级为 `best-effort`。
- OpenCode 仅登记 `plugin-hook` 宿主能力，插件未安装，等级仍为 `rules-and-ci`。
- 其他平台不因内部抽象升级而自动宣称强制阻断。

- [ ] **步骤 3：按最终用户视角写 Changelog**

在确定的版本条目中写一条最终能力，不记录 codec 抽取、测试迁移或中间清理过程：

```markdown
### Changed

- **Enterprise Guard gateway**: Claude Code now evaluates enterprise hard rules before Comet workflow routing within one local Gateway, fails closed when Guard evaluation or required audit persistence is unavailable, and reports peer-Hook ordering limits as best-effort with CI fallback.
```

若该版本已有 `### Changed`，追加到现有分组。根 README 不因内部架构调整而修改。

- [ ] **步骤 4：运行格式、lint、构建和全量测试**

```bash
npx prettier --check domains/enterprise-guard app/commands/doctor.ts scripts/build/build-enterprise-guard-runtime.mjs test/domains/enterprise-guard test/app/init-e2e.test.ts test/app/update.test.ts test/app/doctor.test.ts test/app/uninstall.test.ts test/repository/enterprise-guard-runtime-assets.test.ts test/repository/repository-layout.test.ts config/repository-layout.json assets/manifest.json package.json CHANGELOG.md
pnpm lint
pnpm build
pnpm test
git diff --check
git status --short
```

预期：全部检查退出 0；`git status --short` 只列出本任务预期的文档、Changelog、版本和构建产物变更。

- [ ] **步骤 5：提交发布材料**

```bash
git add docs/architecture/enterprise-guard CHANGELOG.md package.json
git commit -m "docs: document the enterprise guard gateway"
```

若构建或格式化产生未提交的预期资产变更，把对应明确路径加入同一提交；禁止使用 `git add -A`。

## 完成判定

1. Claude 的真实 Hook 配置中只有一个 Comet 受管 Gateway。
2. HARD 命中时 Router 未执行，危险工具调用被 exit 2 阻断。
3. Guard 放行后，现有 Classic/Native Router 行为和错误语义保持不变。
4. 非 Comet 项目仍执行 HARD 检查。
5. SOFT findings 不能持久化时，修改型工具安全失败。
6. 旧 Router + Enterprise Hook 可幂等迁移，Gateway 安装失败时旧保护不被提前删除。
7. 用户 Hook 在 install、update、repair 和 uninstall 中保留。
8. OpenCode 和未验证平台没有被错误升级为硬阻断。
9. Gateway runtime 自包含、manifest 已登记、freshness 检查通过。
10. lint、build、全量测试和 `git diff --check` 全部通过。
