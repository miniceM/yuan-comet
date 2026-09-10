import { createHash } from 'node:crypto';
import path from 'node:path';

import { isWriteTool } from './normalized-event.js';
import type {
  Decision,
  Enforcement,
  EnterpriseGuardDecision,
  EnterpriseHookInput,
  EnterpriseRuleResult,
} from './normalized-event.js';

export type {
  CapturedString,
  CapturedJson,
  EnterpriseGuardDecision,
  EnterpriseHookInput,
  EnterpriseRuleResult,
} from './normalized-event.js';
export {
  MAX_ENTERPRISE_HOOK_FIELD_BYTES,
  MAX_ENTERPRISE_HOOK_INPUT_BYTES,
} from './normalized-event.js';
export { parseClaudeEnterpriseHookInput } from './input-codecs/claude.js';

type ExceptionScopeKind = 'path' | 'branch' | 'repository' | 'command';

export type EnterpriseExceptionRecord = {
  schemaVersion: 'comet.enterprise-exception.v1';
  exceptionId: string;
  ruleId: string;
  scope: { kind: ExceptionScopeKind; value: string };
  reason: string;
  owner: string;
  expiresAt: string;
  approval: { changeId: string; approvedBy: string; approvedAt: string; protectedRef: string };
  ci: { provider: string; runId: string; conclusion: 'passed'; protectedRef: string };
  status: 'active' | 'revoked' | 'expired';
};

export type EnterprisePolicyOptions = {
  exceptions?: readonly EnterpriseExceptionRecord[];
  now?: Date;
  protectedBranches?: readonly string[];
};

const AWS_ACCESS_KEY = /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/u;
const PRIVATE_KEY = /-----BEGIN(?: [A-Z0-9]{1,40})? PRIVATE KEY-----/u;
const SECRET_ASSIGNMENT =
  /\b(?:api[_-]?key|access[_-]?key|secret|token|password)\b\s*=\s*[^\s'"`]{8,}/iu;
const RULE_VERSION = 1;
export const DEFAULT_PROTECTED_BRANCHES = new Set(['main', 'master']);

function sha256(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function inputDigest(input: EnterpriseHookInput): string {
  return sha256(
    JSON.stringify({
      platform: input.platform.id,
      event: input.event.name,
      tool: input.tool.name.value,
      cwd: input.workingDirectory.value,
      command: input.command.value,
      writes: input.writes.map((write) => [
        write.operation,
        write.path.value,
        write.fragment.value,
      ]),
      parse: input.parse.status,
      truncation: input.truncation.fields.map((field) => [field.path, field.truncated]),
    }),
  );
}

function result(
  input: EnterpriseHookInput,
  ruleId: string,
  enforcement: Enforcement,
  decision: Decision,
  reason: string,
  evidence: EnterpriseRuleResult['evidence'] = [],
): EnterpriseRuleResult {
  return {
    schemaVersion: 'comet.enterprise-rule-result.v1',
    ruleId,
    ruleVersion: RULE_VERSION,
    enforcement,
    decision,
    reason,
    evidence,
    exceptionId: null,
    inputDigest: inputDigest(input),
  };
}

function isBashTool(name: string | null): boolean {
  return name === 'Bash';
}

export function isEnvironmentFile(value: string): boolean {
  const normalized = value.replaceAll('\\', '/').toLowerCase();
  const basename = normalized.slice(normalized.lastIndexOf('/') + 1);
  return (
    /^\.env(?:\.[^/]+)?$/u.test(basename) &&
    !/\.env\.(?:example|sample)(?:\.[^/]+)?$/u.test(basename)
  );
}

function isExamplePlaceholder(value: string): boolean {
  return /^(?:replace[-_ ]?me|your[-_ ]?(?:key|token|secret)|example|changeme)$/iu.test(
    value.trim(),
  );
}

export function containsHardSecret(value: string): boolean {
  if (AWS_ACCESS_KEY.test(value) || PRIVATE_KEY.test(value)) return true;
  const assignment = value.match(
    /\b(?:api[_-]?key|access[_-]?key|secret|token|password)\b\s*=\s*([^\s'"`]+)/iu,
  );
  return Boolean(
    assignment?.[1] && assignment[1].length >= 16 && !isExamplePlaceholder(assignment[1]),
  );
}

export function containsSoftSecret(value: string): boolean {
  return SECRET_ASSIGNMENT.test(value) && !containsHardSecret(value);
}

function commandSegments(command: string): string[][] {
  return command
    .split(/&&|\|\||[;|&()\n]/u)
    .map((segment) => segment.trim().split(/\s+/u).filter(Boolean))
    .filter((tokens) => tokens.length > 0);
}

function commandName(token: string): string {
  return token.split('/').at(-1) ?? token;
}

function hasRecursiveAndForce(tokens: readonly string[]): boolean {
  const shortFlags = tokens.filter((token) => /^-[^-]+$/u.test(token)).join('');
  return (
    (shortFlags.includes('r') && shortFlags.includes('f')) ||
    (tokens.includes('--recursive') && tokens.includes('--force'))
  );
}

function protectedDeleteTarget(target: string, workingDirectory: string | null): boolean {
  if (!target || target === '/' || target === '.' || target === '..' || target === '~') return true;
  if (target.includes('*') || target.includes('?') || target.includes('$') || target.includes('`'))
    return true;
  if (!workingDirectory) return true;
  const root = path.resolve(workingDirectory);
  const resolved = path.resolve(root, target);
  return (
    resolved === root ||
    root.startsWith(`${resolved}${path.sep}`) ||
    resolved === path.parse(resolved).root
  );
}

function recursiveDelete(input: EnterpriseHookInput): 'deny' | 'warn' | 'abstain' {
  const command = input.command.value;
  if (!command) return 'abstain';
  for (const tokens of commandSegments(command)) {
    const rmIndex = tokens.findIndex((token) => commandName(token) === 'rm');
    if (rmIndex < 0) continue;
    const commandTokens = tokens.slice(rmIndex + 1);
    if (!hasRecursiveAndForce(commandTokens)) continue;
    const targets = commandTokens.filter(
      (token) => !token.startsWith('-') && token !== 'sudo' && token !== 'command',
    );
    if (
      targets.length === 0 ||
      targets.some((target) => protectedDeleteTarget(target, input.workingDirectory.value))
    ) {
      return 'deny';
    }
    return 'warn';
  }
  return 'abstain';
}

function normalizedBranch(value: string): string {
  const branch = value.includes(':') ? (value.split(':').at(-1) ?? '') : value;
  return branch.replace(/^refs\/heads\//u, '');
}

function forcePush(
  input: EnterpriseHookInput,
  protectedBranches: ReadonlySet<string>,
): 'deny' | 'warn' | 'abstain' {
  const command = input.command.value;
  if (!command) return 'abstain';
  for (const tokens of commandSegments(command)) {
    const gitIndex = tokens.findIndex((token) => commandName(token) === 'git');
    if (gitIndex < 0) continue;
    const pushIndex = tokens.findIndex((token, index) => index > gitIndex && token === 'push');
    if (pushIndex < 0) continue;
    const pushTokens = tokens.slice(pushIndex + 1);
    const forced = pushTokens.some(
      (token) => token === '-f' || token === '--force' || token.startsWith('--force-with-lease'),
    );
    if (!forced) continue;
    const targets = pushTokens.filter((token) => !token.startsWith('-'));
    const branch = targets.length >= 2 ? normalizedBranch(targets[1]) : null;
    if (!branch || protectedBranches.has(branch)) return 'deny';
    return 'warn';
  }
  return 'abstain';
}

function aggregate(results: EnterpriseRuleResult[]): EnterpriseGuardDecision {
  const blocking = results.find(
    (candidate) => candidate.enforcement === 'hard' && candidate.decision === 'deny',
  );
  const warningRuleIds = results
    .filter((candidate) => candidate.decision === 'warn')
    .map((candidate) => candidate.ruleId);
  return {
    allowed: !blocking,
    ruleId: blocking?.ruleId ?? null,
    reason: blocking ? `Enterprise Guard blocked ${blocking.ruleId}: ${blocking.reason}` : '',
    warningRuleIds,
    results,
  };
}

function inputFailure(input: EnterpriseHookInput): EnterpriseRuleResult {
  return result(input, 'EG-HARD-INPUT-001', 'hard', 'deny', 'Required Hook input is unavailable', [
    { kind: 'parse', subject: input.parse.status, redacted: true },
  ]);
}

/** Evaluate each Enterprise Guard rule independently, then aggregate platform-safe HARD/SOFT decisions. */
function exceptionIsValid(exception: EnterpriseExceptionRecord, now: Date): boolean {
  if (
    exception.schemaVersion !== 'comet.enterprise-exception.v1' ||
    exception.status !== 'active' ||
    !/^EGE-[A-Z0-9-]+$/u.test(exception.exceptionId) ||
    !/^EG-(?:HARD|SOFT)-[A-Z]+-[0-9]{3}$/u.test(exception.ruleId) ||
    !['path', 'command', 'repository', 'branch'].includes(exception.scope.kind) ||
    !exception.scope.value ||
    exception.scope.value.includes('*') ||
    exception.reason.length < 16 ||
    exception.reason.length > 500 ||
    !exception.owner ||
    !exception.approval.changeId ||
    !exception.approval.approvedBy ||
    !exception.approval.approvedAt ||
    !exception.approval.protectedRef ||
    !exception.ci.provider ||
    !exception.ci.runId ||
    exception.ci.conclusion !== 'passed' ||
    exception.ci.protectedRef !== exception.approval.protectedRef
  ) {
    return false;
  }

  const expiresAt = Date.parse(exception.expiresAt);
  const approvedAt = Date.parse(exception.approval.approvedAt);
  return Number.isFinite(expiresAt) && Number.isFinite(approvedAt) && expiresAt > now.getTime();
}

function exceptionApplies(
  exception: EnterpriseExceptionRecord,
  input: EnterpriseHookInput,
  rule: EnterpriseRuleResult,
): boolean {
  if (exception.ruleId !== rule.ruleId || rule.decision !== 'deny') return false;

  switch (exception.scope.kind) {
    case 'path':
      return input.writes.some((write) => write.path.value === exception.scope.value);
    case 'command':
      return input.command.value === exception.scope.value;
    case 'repository':
      return input.workingDirectory.value === exception.scope.value;
    case 'branch': {
      const commandTokens = (input.command.value ?? '').trim().split(/\s+/u);
      return commandTokens.some(
        (token) => token === exception.scope.value || token.endsWith(`:${exception.scope.value}`),
      );
    }
    default:
      return false;
  }
}

function applyException(
  rule: EnterpriseRuleResult,
  input: EnterpriseHookInput,
  exceptions: readonly EnterpriseExceptionRecord[],
  now: Date,
): EnterpriseRuleResult {
  const exception = exceptions.find(
    (candidate) => exceptionIsValid(candidate, now) && exceptionApplies(candidate, input, rule),
  );
  if (!exception) return rule;

  return {
    ...rule,
    decision: 'warn',
    reason: 'A bounded Enterprise Guard exception requires review',
    evidence: [
      ...rule.evidence,
      { kind: 'exception', subject: 'approved-exception', redacted: true },
    ],
    exceptionId: exception.exceptionId,
  };
}

export function evaluateEnterpriseHookInput(
  input: EnterpriseHookInput,
  options: EnterprisePolicyOptions = {},
): EnterpriseGuardDecision {
  const toolName = input.tool.name.value;
  if (input.parse.status !== 'complete') {
    return aggregate([inputFailure(input)]);
  }
  if (
    isWriteTool(toolName) &&
    (input.writes.length !== 1 ||
      input.writes[0].path.value === null ||
      input.writes[0].path.value.trim() === '' ||
      input.writes[0].fragment.value === null)
  ) {
    return aggregate([inputFailure(input)]);
  }
  if (isBashTool(toolName) && !input.command.value) return aggregate([inputFailure(input)]);
  if (input.writes.length > 0 && !isWriteTool(toolName)) {
    const isDelete = input.writes.some((write) => write.operation === 'delete');
    return aggregate([
      result(
        input,
        'EG-HARD-INPUT-001',
        'hard',
        'deny',
        isDelete
          ? 'Unsupported delete operation cannot be verified'
          : 'Unknown mutating tool cannot be verified',
        [
          {
            kind: 'policy',
            subject: isDelete ? 'unsupported-delete-operation' : 'unknown-mutating-tool',
            redacted: true,
          },
        ],
      ),
    ]);
  }

  const results: EnterpriseRuleResult[] = [];
  const write = input.writes[0];
  if (isWriteTool(toolName) && write) {
    const text = write.fragment.value ?? '';
    const envWrite = Boolean(write.path.value && isEnvironmentFile(write.path.value));
    const hardSecret = containsHardSecret(text);
    const softSecret = containsSoftSecret(text);
    results.push(
      result(
        input,
        'EG-HARD-ENV-001',
        'hard',
        envWrite ? 'deny' : 'allow',
        envWrite
          ? 'Environment file writes are not permitted'
          : 'No environment-file write detected',
        write.path.value ? [{ kind: 'path', subject: write.path.value, redacted: true }] : [],
      ),
      result(
        input,
        'EG-HARD-SECRET-001',
        'hard',
        hardSecret ? 'deny' : 'allow',
        hardSecret
          ? 'High-confidence credential material is not permitted'
          : 'No high-confidence credential material detected',
        [{ kind: 'write-fragment', subject: 'write-payload', redacted: true }],
      ),
      result(
        input,
        'EG-SOFT-SECRET-002',
        'soft',
        softSecret ? 'warn' : 'abstain',
        softSecret ? 'Credential-like material requires review' : 'Rule not applicable',
        [{ kind: 'write-fragment', subject: 'write-payload', redacted: true }],
      ),
    );
  } else {
    results.push(
      result(input, 'EG-HARD-ENV-001', 'hard', 'abstain', 'Rule not applicable'),
      result(input, 'EG-HARD-SECRET-001', 'hard', 'abstain', 'Rule not applicable'),
      result(input, 'EG-SOFT-SECRET-002', 'soft', 'abstain', 'Rule not applicable'),
    );
  }

  if (isBashTool(toolName)) {
    const command = input.command.value ?? '';
    const deleteDecision = recursiveDelete(input);
    const pushDecision = forcePush(
      input,
      new Set(options.protectedBranches ?? DEFAULT_PROTECTED_BRANCHES),
    );
    const hardSecret = containsHardSecret(command);
    const softSecret = containsSoftSecret(command);
    results.push(
      result(
        input,
        'EG-HARD-RM-001',
        'hard',
        deleteDecision === 'deny' ? 'deny' : deleteDecision === 'warn' ? 'allow' : 'abstain',
        deleteDecision === 'deny'
          ? 'Recursive forced deletion targets a protected or unresolved path'
          : deleteDecision === 'warn'
            ? 'Deletion is outside protected paths'
            : 'Rule not applicable',
        deleteDecision === 'abstain'
          ? []
          : [{ kind: 'command', subject: 'recursive-delete', redacted: true }],
      ),
      result(
        input,
        'EG-SOFT-DELETE-002',
        'soft',
        deleteDecision === 'warn' ? 'warn' : 'abstain',
        deleteDecision === 'warn' ? 'Broad deletion requires review' : 'Rule not applicable',
        deleteDecision === 'warn'
          ? [{ kind: 'command', subject: 'recursive-delete', redacted: true }]
          : [],
      ),
      result(
        input,
        'EG-HARD-GIT-001',
        'hard',
        pushDecision === 'deny' ? 'deny' : pushDecision === 'warn' ? 'allow' : 'abstain',
        pushDecision === 'deny'
          ? 'Force push targets a protected or unresolved branch'
          : pushDecision === 'warn'
            ? 'Force push targets a non-protected branch'
            : 'Rule not applicable',
        pushDecision === 'abstain'
          ? []
          : [{ kind: 'command', subject: 'force-push', redacted: true }],
      ),
      result(
        input,
        'EG-SOFT-GIT-002',
        'soft',
        pushDecision === 'warn' ? 'warn' : 'abstain',
        pushDecision === 'warn'
          ? 'Non-protected force push requires review'
          : 'Rule not applicable',
        pushDecision === 'warn' ? [{ kind: 'command', subject: 'force-push', redacted: true }] : [],
      ),
      result(
        input,
        'EG-HARD-SECRET-001',
        'hard',
        hardSecret ? 'deny' : 'abstain',
        hardSecret ? 'High-confidence credential material is not permitted' : 'Rule not applicable',
        [{ kind: 'command', subject: 'command-arguments', redacted: true }],
      ),
      result(
        input,
        'EG-SOFT-SECRET-002',
        'soft',
        softSecret ? 'warn' : 'abstain',
        softSecret ? 'Credential-like material requires review' : 'Rule not applicable',
        [{ kind: 'command', subject: 'command-arguments', redacted: true }],
      ),
    );
  } else {
    results.push(
      result(input, 'EG-HARD-RM-001', 'hard', 'abstain', 'Rule not applicable'),
      result(input, 'EG-SOFT-DELETE-002', 'soft', 'abstain', 'Rule not applicable'),
      result(input, 'EG-HARD-GIT-001', 'hard', 'abstain', 'Rule not applicable'),
      result(input, 'EG-SOFT-GIT-002', 'soft', 'abstain', 'Rule not applicable'),
    );
  }

  const now = options.now ?? new Date();
  const exceptions = options.exceptions ?? [];
  return aggregate(results.map((rule) => applyException(rule, input, exceptions, now)));
}
