import { readEnterpriseFindings } from './findings.js';
import {
  containsHardSecret,
  DEFAULT_PROTECTED_BRANCHES,
  isEnvironmentFile,
} from './policy-engine.js';

export type GitBoundaryViolation = {
  ruleId: string;
  target: string;
  detail: string;
};

export type GitPreCommitEvaluation = {
  allowed: boolean;
  ruleId: string | null;
  reason: string;
  violations: GitBoundaryViolation[];
};

export type GitPushRef = {
  localRef: string;
  localOid: string;
  remoteRef: string;
  remoteOid: string;
};

export type GitPrePushEvaluation = {
  allowed: boolean;
  ruleId: string | null;
  reason: string;
  violations: GitBoundaryViolation[];
};

const ENTERPRISE_DEFAULT_PROTECTED_BRANCHES = new Set([
  ...DEFAULT_PROTECTED_BRANCHES,
  'enterprise/main',
]);

const ZERO_OID = '0000000000000000000000000000000000000000';

export function normalizeBranchName(ref: string): string {
  if (ref.startsWith('refs/heads/')) {
    return ref.slice('refs/heads/'.length);
  }
  return ref;
}

export function isProtectedBranch(branch: string, additionalProtected?: Iterable<string>): boolean {
  const normalized = normalizeBranchName(branch);
  const protectedSet = additionalProtected
    ? new Set([...ENTERPRISE_DEFAULT_PROTECTED_BRANCHES, ...additionalProtected])
    : ENTERPRISE_DEFAULT_PROTECTED_BRANCHES;

  if (protectedSet.has(normalized)) return true;

  for (const pattern of protectedSet) {
    if (pattern.endsWith('/*')) {
      const prefix = pattern.slice(0, -2);
      if (normalized === prefix || normalized.startsWith(`${prefix}/`)) {
        return true;
      }
    }
  }

  return (
    normalized.startsWith('release/') ||
    normalized.startsWith('hotfix/') ||
    normalized.startsWith('beta')
  );
}

export async function evaluatePreCommit(
  projectRoot: string,
  stagedFiles: readonly string[],
  stagedDiffs: readonly { file: string; patch: string }[],
  options: { skipFindingsCheck?: boolean } = {},
): Promise<GitPreCommitEvaluation> {
  const violations: GitBoundaryViolation[] = [];

  // 1. Check for environment files in staged files
  for (const file of stagedFiles) {
    if (isEnvironmentFile(file)) {
      violations.push({
        ruleId: 'EG-HARD-ENV-001',
        target: file,
        detail: 'Direct modification or staging of environment file is forbidden',
      });
    }
  }

  // 2. Check staged content for high-confidence secrets
  for (const diff of stagedDiffs) {
    const lines = diff.patch.split('\n');
    for (const line of lines) {
      if (line.startsWith('+') && !line.startsWith('+++')) {
        const addedContent = line.slice(1);
        if (containsHardSecret(addedContent)) {
          violations.push({
            ruleId: 'EG-HARD-SECRET-001',
            target: diff.file,
            detail: 'High-confidence credential material detected in staged diff',
          });
          break;
        }
      }
    }
  }

  // 3. Check existing findings
  if (!options.skipFindingsCheck) {
    const report = await readEnterpriseFindings(projectRoot);
    if (report.status === 'blocked') {
      if (report.integrityErrors.length > 0) {
        violations.push({
          ruleId: 'EG-HARD-INTEGRITY-001',
          target: '.comet/enterprise-guard/findings.jsonl',
          detail: `Findings audit log is malformed or unreadable: ${report.integrityErrors.join(', ')}`,
        });
      }

      const hardDenials = report.findings.filter(
        (f) => f.enforcement === 'hard' && f.decision === 'deny',
      );
      for (const finding of hardDenials) {
        violations.push({
          ruleId: finding.ruleId,
          target: finding.path ?? finding.tool ?? 'project',
          detail: `Unresolved HARD finding (fingerprint: ${finding.fingerprint})`,
        });
      }
    }
  }

  if (violations.length > 0) {
    const primaryRule = violations[0].ruleId;
    return {
      allowed: false,
      ruleId: primaryRule,
      reason: `Enterprise Guard pre-commit blocked: ${violations.map((v) => `${v.ruleId} (${v.target})`).join(', ')}`,
      violations,
    };
  }

  return {
    allowed: true,
    ruleId: null,
    reason: '',
    violations: [],
  };
}

export async function evaluatePrePush(
  projectRoot: string,
  pushRefs: readonly GitPushRef[],
  options: {
    isForcePush?: boolean;
    protectedBranches?: Iterable<string>;
    skipFindingsCheck?: boolean;
  } = {},
): Promise<GitPrePushEvaluation> {
  const violations: GitBoundaryViolation[] = [];

  for (const ref of pushRefs) {
    const targetBranch = normalizeBranchName(ref.remoteRef);
    const protectedBranch = isProtectedBranch(targetBranch, options.protectedBranches);

    if (protectedBranch) {
      // Deleting a protected branch
      if (ref.localOid === ZERO_OID || ref.localRef === '(delete)') {
        violations.push({
          ruleId: 'EG-HARD-GIT-001',
          target: targetBranch,
          detail: `Deleting protected branch "${targetBranch}" is forbidden`,
        });
        continue;
      }

      // Force-pushing to a protected branch
      if (options.isForcePush) {
        violations.push({
          ruleId: 'EG-HARD-GIT-001',
          target: targetBranch,
          detail: `Force-pushing to protected branch "${targetBranch}" is forbidden`,
        });
      }
    }
  }

  // Check unresolved findings
  if (!options.skipFindingsCheck) {
    const report = await readEnterpriseFindings(projectRoot);
    if (report.status === 'blocked') {
      if (report.integrityErrors.length > 0) {
        violations.push({
          ruleId: 'EG-HARD-INTEGRITY-001',
          target: '.comet/enterprise-guard/findings.jsonl',
          detail: `Findings audit log is malformed or unreadable: ${report.integrityErrors.join(', ')}`,
        });
      }

      const hardDenials = report.findings.filter(
        (f) => f.enforcement === 'hard' && f.decision === 'deny',
      );
      for (const finding of hardDenials) {
        violations.push({
          ruleId: finding.ruleId,
          target: finding.path ?? finding.tool ?? 'project',
          detail: `Unresolved HARD finding (fingerprint: ${finding.fingerprint})`,
        });
      }
    }
  }

  if (violations.length > 0) {
    const primaryRule = violations[0].ruleId;
    return {
      allowed: false,
      ruleId: primaryRule,
      reason: `Enterprise Guard pre-push blocked: ${violations.map((v) => `${v.ruleId} (${v.target})`).join(', ')}`,
      violations,
    };
  }

  return {
    allowed: true,
    ruleId: null,
    reason: '',
    violations: [],
  };
}
