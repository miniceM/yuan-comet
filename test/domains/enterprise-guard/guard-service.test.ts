import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { enterpriseExceptionsFile } from '../../../domains/enterprise-guard/exceptions.js';
import { evaluateEnterpriseGuardSource } from '../../../domains/enterprise-guard/guard-service.js';
import { enterpriseFindingsFile } from '../../../domains/enterprise-guard/findings.js';

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

  it('never touches the audit filesystem for a pure HARD denial', async () => {
    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'comet-enterprise-guard-'));
    try {
      const result = await evaluateEnterpriseGuardSource({
        platformId: 'claude',
        source: JSON.stringify({
          cwd: projectRoot,
          tool_name: 'Bash',
          tool_input: { command: 'rm -rf /' },
        }),
        projectRoot,
      });

      expect(result.decision.allowed).toBe(false);
      expect(result.decision.ruleId).toBe('EG-HARD-RM-001');
      await expect(fs.access(enterpriseFindingsFile(projectRoot))).rejects.toMatchObject({
        code: 'ENOENT',
      });
    } finally {
      await fs.rm(projectRoot, { recursive: true, force: true });
    }
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

  it('fails closed when SOFT findings have no audit root', async () => {
    const recordFindings = vi.fn();
    const result = await evaluateEnterpriseGuardSource(
      {
        platformId: 'claude',
        source: JSON.stringify({
          tool_name: 'Bash',
          tool_input: { command: 'git push --force origin feature/demo' },
        }),
        projectRoot: null,
      },
      { recordFindings },
    );

    expect(result.decision).toMatchObject({
      allowed: false,
      ruleId: 'EG-HARD-AUDIT-001',
      reason: 'Enterprise Guard audit persistence is unavailable',
    });
    expect(recordFindings).not.toHaveBeenCalled();
  });

  it('writes only redacted findings when a HARD deny also emits a SOFT warning', async () => {
    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'comet-enterprise-guard-'));
    try {
      const result = await evaluateEnterpriseGuardSource({
        platformId: 'claude',
        source: JSON.stringify({
          cwd: projectRoot,
          tool_name: 'Write',
          tool_input: { file_path: '.env', content: 'TOKEN=softvalue1234' },
        }),
        projectRoot,
      });
      const stored = await fs.readFile(enterpriseFindingsFile(projectRoot), 'utf8');

      expect(result.decision.allowed).toBe(false);
      expect(result.decision.ruleId).toBe('EG-HARD-ENV-001');
      expect(stored).toContain('EG-SOFT-SECRET-002');
      expect(stored).not.toContain('softvalue1234');
      expect(stored).not.toContain('TOKEN');
    } finally {
      await fs.rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('consumes only a project-local approved exception before emitting audit findings', async () => {
    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'comet-enterprise-guard-'));
    try {
      const exceptionsFile = enterpriseExceptionsFile(projectRoot);
      await fs.mkdir(path.dirname(exceptionsFile), { recursive: true });
      await fs.writeFile(
        exceptionsFile,
        `${JSON.stringify({
          schemaVersion: 'comet.enterprise-exceptions.v1',
          exceptions: [
            {
              schemaVersion: 'comet.enterprise-exception.v1',
              exceptionId: 'EGE-HOOK-123',
              ruleId: 'EG-HARD-ENV-001',
              scope: { kind: 'path', value: 'config/.env' },
              reason: 'Protected workflow reviewed the generated file.',
              owner: 'security@example.test',
              expiresAt: '2026-12-31T00:00:00.000Z',
              approval: {
                changeId: 'CHG-123',
                approvedBy: 'security@example.test',
                approvedAt: '2026-08-31T00:00:00.000Z',
                protectedRef: 'refs/heads/main',
              },
              ci: {
                provider: 'github-actions',
                runId: '456',
                conclusion: 'passed',
                protectedRef: 'refs/heads/main',
              },
              status: 'active',
            },
          ],
        })}\n`,
        'utf8',
      );

      const result = await evaluateEnterpriseGuardSource({
        platformId: 'claude',
        source: JSON.stringify({
          cwd: projectRoot,
          tool_name: 'Write',
          tool_input: { file_path: 'config/.env', content: 'TOKEN=value' },
        }),
        projectRoot,
      });
      const stored = await fs.readFile(enterpriseFindingsFile(projectRoot), 'utf8');

      expect(result.decision.allowed).toBe(true);
      expect(stored).toContain('EGE-HOOK-123');
      expect(stored).toContain('EG-HARD-ENV-001');
    } finally {
      await fs.rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('fails closed without exposing Hook input when findings cannot be persisted', async () => {
    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'comet-enterprise-guard-'));
    try {
      await fs.writeFile(path.join(projectRoot, '.comet'), 'not-a-directory\n', 'utf8');
      const result = await evaluateEnterpriseGuardSource({
        platformId: 'claude',
        source: JSON.stringify({
          cwd: projectRoot,
          tool_name: 'Write',
          tool_input: { file_path: '.env', content: 'TOKEN=internal-value' },
        }),
        projectRoot,
      });

      expect(result.decision).toMatchObject({
        allowed: false,
        ruleId: 'EG-HARD-AUDIT-001',
        reason: 'Enterprise Guard audit persistence is unavailable',
      });
      expect(result.decision.reason).not.toContain('internal-value');
    } finally {
      await fs.rm(projectRoot, { recursive: true, force: true });
    }
  });
});
