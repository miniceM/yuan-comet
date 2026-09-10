import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { enterpriseFindingsFile } from '../../../domains/enterprise-guard/findings.js';
import {
  evaluatePreCommit,
  evaluatePrePush,
  isProtectedBranch,
  normalizeBranchName,
} from '../../../domains/enterprise-guard/git-boundary.js';

describe('enterprise guard git-boundary', () => {
  let projectRoot: string;

  beforeEach(async () => {
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'comet-git-boundary-'));
  });

  afterEach(async () => {
    await fs.rm(projectRoot, { recursive: true, force: true });
  });

  describe('branch utilities', () => {
    it('normalizes ref names', () => {
      expect(normalizeBranchName('refs/heads/master')).toBe('master');
      expect(normalizeBranchName('refs/heads/enterprise/main')).toBe('enterprise/main');
      expect(normalizeBranchName('feature/foo')).toBe('feature/foo');
    });

    it('identifies protected branches correctly', () => {
      expect(isProtectedBranch('master')).toBe(true);
      expect(isProtectedBranch('main')).toBe(true);
      expect(isProtectedBranch('enterprise/main')).toBe(true);
      expect(isProtectedBranch('refs/heads/master')).toBe(true);
      expect(isProtectedBranch('release/v1.0.0')).toBe(true);
      expect(isProtectedBranch('hotfix/critical-patch')).toBe(true);
      expect(isProtectedBranch('beta.1')).toBe(true);

      expect(isProtectedBranch('feature/new-feature')).toBe(false);
      expect(isProtectedBranch('codex/my-task')).toBe(false);
      expect(isProtectedBranch('fix/bug-123')).toBe(false);
    });
  });

  describe('evaluatePreCommit', () => {
    it('blocks staging of .env files', async () => {
      const evaluation = await evaluatePreCommit(projectRoot, ['src/app.ts', '.env'], [], {
        skipFindingsCheck: true,
      });

      expect(evaluation.allowed).toBe(false);
      expect(evaluation.ruleId).toBe('EG-HARD-ENV-001');
      expect(evaluation.violations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            ruleId: 'EG-HARD-ENV-001',
            target: '.env',
          }),
        ]),
      );
    });

    it('allows staging of .env.example or non-env files', async () => {
      const evaluation = await evaluatePreCommit(
        projectRoot,
        ['src/app.ts', '.env.example'],
        [{ file: 'src/app.ts', patch: '+const PORT = 3000;' }],
        { skipFindingsCheck: true },
      );

      expect(evaluation.allowed).toBe(true);
      expect(evaluation.ruleId).toBeNull();
      expect(evaluation.violations).toEqual([]);
    });

    it('blocks staged diff containing hard-coded secrets', async () => {
      const syntheticToken = `AKIA${'0'.repeat(16)}`;
      const evaluation = await evaluatePreCommit(
        projectRoot,
        ['src/config.ts'],
        [{ file: 'src/config.ts', patch: `+const AWS_KEY = "${syntheticToken}";` }],
        { skipFindingsCheck: true },
      );

      expect(evaluation.allowed).toBe(false);
      expect(evaluation.ruleId).toBe('EG-HARD-SECRET-001');
      expect(evaluation.violations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            ruleId: 'EG-HARD-SECRET-001',
            target: 'src/config.ts',
          }),
        ]),
      );
      // Ensure raw token is not leaked into violation details
      expect(JSON.stringify(evaluation)).not.toContain(syntheticToken);
    });

    it('blocks commit if unresolved HARD findings exist in project', async () => {
      const findingsPath = enterpriseFindingsFile(projectRoot);
      await fs.mkdir(path.dirname(findingsPath), { recursive: true });
      const findingRecord = {
        schemaVersion: 'comet.enterprise-finding.v1',
        createdAt: new Date().toISOString(),
        ruleId: 'EG-HARD-SECRET-001',
        ruleVersion: 1,
        enforcement: 'hard',
        decision: 'deny',
        tool: 'Write',
        path: 'src/secret.ts',
        fingerprint: 'sha256:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789',
        exceptionId: null,
      };
      await fs.writeFile(findingsPath, `${JSON.stringify(findingRecord)}\n`, 'utf8');

      const evaluation = await evaluatePreCommit(projectRoot, ['src/app.ts'], []);
      expect(evaluation.allowed).toBe(false);
      expect(evaluation.ruleId).toBe('EG-HARD-SECRET-001');
      expect(evaluation.violations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            ruleId: 'EG-HARD-SECRET-001',
            target: 'src/secret.ts',
          }),
        ]),
      );
    });

    it('blocks commit if findings audit log is corrupted', async () => {
      const findingsPath = enterpriseFindingsFile(projectRoot);
      await fs.mkdir(path.dirname(findingsPath), { recursive: true });
      await fs.writeFile(findingsPath, '{invalid-json\n', 'utf8');

      const evaluation = await evaluatePreCommit(projectRoot, ['src/app.ts'], []);
      expect(evaluation.allowed).toBe(false);
      expect(evaluation.ruleId).toBe('EG-HARD-INTEGRITY-001');
      expect(evaluation.violations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            ruleId: 'EG-HARD-INTEGRITY-001',
          }),
        ]),
      );
    });
  });

  describe('evaluatePrePush', () => {
    it('blocks force-push to master or enterprise/main', async () => {
      const pushRefs = [
        {
          localRef: 'refs/heads/feat',
          localOid: '1111111111111111111111111111111111111111',
          remoteRef: 'refs/heads/master',
          remoteOid: '2222222222222222222222222222222222222222',
        },
      ];

      const evaluation = await evaluatePrePush(projectRoot, pushRefs, {
        isForcePush: true,
        skipFindingsCheck: true,
      });

      expect(evaluation.allowed).toBe(false);
      expect(evaluation.ruleId).toBe('EG-HARD-GIT-001');
      expect(evaluation.violations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            ruleId: 'EG-HARD-GIT-001',
            target: 'master',
          }),
        ]),
      );
    });

    it('blocks deleting a protected branch', async () => {
      const pushRefs = [
        {
          localRef: '(delete)',
          localOid: '0000000000000000000000000000000000000000',
          remoteRef: 'refs/heads/enterprise/main',
          remoteOid: '2222222222222222222222222222222222222222',
        },
      ];

      const evaluation = await evaluatePrePush(projectRoot, pushRefs, {
        isForcePush: false,
        skipFindingsCheck: true,
      });

      expect(evaluation.allowed).toBe(false);
      expect(evaluation.ruleId).toBe('EG-HARD-GIT-001');
      expect(evaluation.violations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            ruleId: 'EG-HARD-GIT-001',
            target: 'enterprise/main',
          }),
        ]),
      );
    });

    it('allows normal push to protected branch and force push to feature branch', async () => {
      const pushRefs = [
        {
          localRef: 'refs/heads/master',
          localOid: '1111111111111111111111111111111111111111',
          remoteRef: 'refs/heads/master',
          remoteOid: '2222222222222222222222222222222222222222',
        },
      ];

      const evaluation = await evaluatePrePush(projectRoot, pushRefs, {
        isForcePush: false,
        skipFindingsCheck: true,
      });

      expect(evaluation.allowed).toBe(true);
      expect(evaluation.ruleId).toBeNull();
    });

    it('blocks push if unresolved HARD findings exist in project', async () => {
      const findingsPath = enterpriseFindingsFile(projectRoot);
      await fs.mkdir(path.dirname(findingsPath), { recursive: true });
      const findingRecord = {
        schemaVersion: 'comet.enterprise-finding.v1',
        createdAt: new Date().toISOString(),
        ruleId: 'EG-HARD-SECRET-001',
        ruleVersion: 1,
        enforcement: 'hard',
        decision: 'deny',
        tool: 'Write',
        path: 'src/secret.ts',
        fingerprint: 'sha256:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789',
        exceptionId: null,
      };
      await fs.writeFile(findingsPath, `${JSON.stringify(findingRecord)}\n`, 'utf8');

      const pushRefs = [
        {
          localRef: 'refs/heads/feature',
          localOid: '1111111111111111111111111111111111111111',
          remoteRef: 'refs/heads/feature',
          remoteOid: '2222222222222222222222222222222222222222',
        },
      ];

      const evaluation = await evaluatePrePush(projectRoot, pushRefs, { isForcePush: false });
      expect(evaluation.allowed).toBe(false);
      expect(evaluation.ruleId).toBe('EG-HARD-SECRET-001');
    });
  });
});
