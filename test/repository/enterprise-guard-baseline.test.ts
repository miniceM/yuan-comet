import { promises as fs } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const baselineRoot = path.resolve('docs/architecture/enterprise-guard');
const artifacts = [
  'README.md',
  'contracts/enterprise-hook-input.v1.schema.json',
  'contracts/enterprise-rule-result.v1.schema.json',
  'contracts/enterprise-exception.v1.schema.json',
  'policy.md',
  'threat-model.md',
  'platform-capability-matrix.md',
  'platform-coverage.md',
];

interface ContractSchema {
  $schema: string;
  additionalProperties: boolean;
  properties: Record<string, { const?: string; enum?: string[] }>;
  required: string[];
}

async function exists(artifact: string): Promise<boolean> {
  try {
    await fs.access(path.join(baselineRoot, artifact));
    return true;
  } catch {
    return false;
  }
}

async function readText(artifact: string): Promise<string> {
  return fs.readFile(path.join(baselineRoot, artifact), 'utf8');
}

async function readSchema(artifact: string): Promise<ContractSchema> {
  return JSON.parse(await readText(artifact)) as ContractSchema;
}

describe('enterprise guard design baseline', () => {
  it('ships versioned contracts, policy boundaries, and a safe capability matrix', async () => {
    const missing = (
      await Promise.all(
        artifacts.map(async (artifact) => ((await exists(artifact)) ? null : artifact)),
      )
    ).filter((artifact): artifact is string => artifact !== null);
    expect(missing).toEqual([]);

    const [input, result, exception, index, policy, threatModel, matrix, coverageReport] =
      await Promise.all([
        readSchema('contracts/enterprise-hook-input.v1.schema.json'),
        readSchema('contracts/enterprise-rule-result.v1.schema.json'),
        readSchema('contracts/enterprise-exception.v1.schema.json'),
        readText('README.md'),
        readText('policy.md'),
        readText('threat-model.md'),
        readText('platform-capability-matrix.md'),
        readText('platform-coverage.md'),
      ]);

    expect(input.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
    expect(input.additionalProperties).toBe(false);
    expect(input.properties.schemaVersion.const).toBe('comet.enterprise-hook-input.v1');
    expect(input.required).toEqual(
      expect.arrayContaining([
        'schemaVersion',
        'platform',
        'event',
        'workingDirectory',
        'tool',
        'command',
        'writes',
        'parse',
        'truncation',
      ]),
    );

    expect(result.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
    expect(result.additionalProperties).toBe(false);
    expect(result.properties.schemaVersion.const).toBe('comet.enterprise-rule-result.v1');
    expect(result.properties.enforcement.enum).toEqual(['hard', 'soft']);
    expect(result.properties.decision.enum).toEqual(['allow', 'deny', 'warn', 'abstain']);

    expect(exception.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
    expect(exception.additionalProperties).toBe(false);
    expect(exception.properties.schemaVersion.const).toBe('comet.enterprise-exception.v1');
    expect(exception.required).toEqual(
      expect.arrayContaining(['ruleId', 'reason', 'owner', 'expiresAt', 'approval', 'ci']),
    );

    expect(index).toContain('Issue #1');
    expect(index).toContain('Issue #2');
    for (const ruleId of [
      'EG-HARD-ENV-001',
      'EG-HARD-SECRET-001',
      'EG-HARD-RM-001',
      'EG-HARD-GIT-001',
    ]) {
      expect(policy).toContain(ruleId);
    }
    expect(policy).toContain('不接受命令、提交信息、提示词或写入内容中的内联旁路');
    expect(policy).toContain('未知输入与解析失败矩阵');

    expect(threatModel).toContain('项目级');
    expect(threatModel).toContain('企业受管全局');
    expect(threatModel).toContain('CI 兜底');
    expect(threatModel).toContain('不抵御能够修改本地 Hook 或安装文件的恶意主体');

    for (const platformId of [
      'claude',
      'codex',
      'windsurf',
      'github-copilot',
      'gemini',
      'grok',
      'amazon-q',
      'qwen',
      'kiro',
      'codebuddy',
      'workbuddy',
      'qoder',
      'trae',
      'trae-cn',
    ]) {
      expect(matrix).toContain(`\`${platformId}\``);
    }
    expect(matrix).toContain('未验证的平台禁止标记为“强制阻断”');
    expect(matrix).toContain('CI 兜底');
    expect(matrix).toContain('install / update / doctor / uninstall');
    expect(coverageReport).toContain('Claude Code');
    expect(coverageReport).toContain('尽力阻断（本地 Gateway）');
    expect(coverageReport).toContain('Write、Edit、Bash');
    expect(coverageReport).toContain('规则注入 + CI 兜底');
    expect(coverageReport).toContain('不抵御能够修改本地 Hook、配置或脚本的恶意主体');
    expect(matrix).toContain('Claude Code 已完成 Gateway 生命周期 Spike');
    expect(matrix).toContain('同级 Hook 并行执行');
    expect(matrix).toContain('其他平台不会因内部能力档案或抽象升级而自动宣称强制阻断');
  });
});
