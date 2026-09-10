import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

import {
  enterpriseExceptionsFile,
  readEnterpriseExceptions,
} from '../../../domains/enterprise-guard/exceptions.js';

const validException = {
  schemaVersion: 'comet.enterprise-exception.v1' as const,
  exceptionId: 'EGE-123',
  ruleId: 'EG-HARD-ENV-001',
  scope: { kind: 'path' as const, value: 'config/.env' },
  reason: 'Protected release workflow reviewed the generated file.',
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
    conclusion: 'passed' as const,
    protectedRef: 'refs/heads/main',
  },
  status: 'active' as const,
};

describe('Enterprise Guard exception reader', () => {
  it('reads the versioned exception envelope from the project-local location', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'comet-eg-exceptions-'));
    const file = enterpriseExceptionsFile(projectRoot);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(
      file,
      `${JSON.stringify({ schemaVersion: 'comet.enterprise-exceptions.v1', exceptions: [validException] })}\n`,
      'utf8',
    );

    await expect(readEnterpriseExceptions(projectRoot)).resolves.toEqual([validException]);
  });

  it('treats malformed or wildcard exception records as absent', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'comet-eg-exceptions-'));
    const file = enterpriseExceptionsFile(projectRoot);
    await mkdir(dirname(file), { recursive: true });

    await writeFile(file, '{not-json}\n', 'utf8');
    await expect(readEnterpriseExceptions(projectRoot)).resolves.toEqual([]);

    await writeFile(
      file,
      `${JSON.stringify({
        schemaVersion: 'comet.enterprise-exceptions.v1',
        exceptions: [{ ...validException, scope: { kind: 'path', value: '*' } }],
      })}\n`,
      'utf8',
    );
    await expect(readEnterpriseExceptions(projectRoot)).resolves.toEqual([]);
  });
});
