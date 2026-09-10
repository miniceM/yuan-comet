import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  enterpriseFindingsFile,
  readEnterpriseFindings,
  recordEnterpriseFindings,
} from '../../../domains/enterprise-guard/findings.js';
import {
  evaluateEnterpriseHookInput,
  parseClaudeEnterpriseHookInput,
} from '../../../domains/enterprise-guard/policy-engine.js';

describe('enterprise guard findings', () => {
  let projectRoot: string;

  beforeEach(async () => {
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'comet-enterprise-findings-'));
  });

  afterEach(async () => {
    await fs.rm(projectRoot, { recursive: true, force: true });
  });

  it('serializes concurrent findings without persisting sensitive values', async () => {
    const syntheticToken = `AKIA${'0'.repeat(16)}`;
    const input = parseClaudeEnterpriseHookInput(
      JSON.stringify({
        cwd: projectRoot,
        tool_name: 'Write',
        tool_input: { file_path: 'src/config.ts', content: `AWS_ACCESS_KEY_ID=${syntheticToken}` },
      }),
    );
    const decision = evaluateEnterpriseHookInput(input);

    await Promise.all(
      Array.from({ length: 12 }, () => recordEnterpriseFindings(projectRoot, input, decision)),
    );

    const report = await readEnterpriseFindings(projectRoot);
    const stored = await fs.readFile(enterpriseFindingsFile(projectRoot), 'utf8');
    expect(report.integrityErrors).toEqual([]);
    expect(report.status).toBe('blocked');
    expect(report.findings).toHaveLength(12);
    expect(report.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          schemaVersion: 'comet.enterprise-finding.v1',
          ruleId: 'EG-HARD-SECRET-001',
          enforcement: 'hard',
          decision: 'deny',
          tool: 'Write',
          fingerprint: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
        }),
      ]),
    );
    expect(stored).not.toContain(syntheticToken);
    expect(stored).not.toContain('AWS_ACCESS_KEY_ID');
  });

  it('makes malformed findings a blocking review-integrity result', async () => {
    const target = enterpriseFindingsFile(projectRoot);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, '{not-json}\n', 'utf8');

    await expect(readEnterpriseFindings(projectRoot)).resolves.toMatchObject({
      status: 'blocked',
      integrityErrors: [expect.stringContaining('line 1')],
    });
  });

  it('returns clear status when no findings file exists', async () => {
    const report = await readEnterpriseFindings(projectRoot);
    expect(report.status).toBe('clear');
    expect(report.findings).toEqual([]);
    expect(report.integrityErrors).toEqual([]);
  });

  it('returns warn status when only soft warning findings exist', async () => {
    const target = enterpriseFindingsFile(projectRoot);
    await fs.mkdir(path.dirname(target), { recursive: true });
    const softFinding = {
      schemaVersion: 'comet.enterprise-finding.v1',
      createdAt: new Date().toISOString(),
      ruleId: 'EG-SOFT-SECRET-002',
      ruleVersion: 1,
      enforcement: 'soft',
      decision: 'warn',
      tool: 'Write',
      path: 'src/token.ts',
      fingerprint: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      exceptionId: null,
    };
    await fs.writeFile(target, `${JSON.stringify(softFinding)}\n`, 'utf8');

    const report = await readEnterpriseFindings(projectRoot);
    expect(report.status).toBe('warn');
    expect(report.findings).toHaveLength(1);
    expect(report.integrityErrors).toEqual([]);
  });

  it('detects schema mismatches as integrity errors', async () => {
    const target = enterpriseFindingsFile(projectRoot);
    await fs.mkdir(path.dirname(target), { recursive: true });
    const invalidFinding = {
      schemaVersion: 'comet.enterprise-finding.v1',
      createdAt: new Date().toISOString(),
      ruleId: 'INVALID-RULE-FORMAT',
      ruleVersion: 1,
      enforcement: 'hard',
      decision: 'deny',
    };
    await fs.writeFile(target, `${JSON.stringify(invalidFinding)}\n`, 'utf8');

    const report = await readEnterpriseFindings(projectRoot);
    expect(report.status).toBe('blocked');
    expect(report.integrityErrors).toHaveLength(1);
    expect(report.integrityErrors[0]).toContain('line 1');
  });
});
