import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import type {
  EnterpriseGuardDecision,
  EnterpriseHookInput,
  EnterpriseRuleResult,
} from './normalized-event.js';

const FINDINGS_FILE_NAME = 'findings.jsonl';
const LOCK_SUFFIX = '.lock';
const LOCK_RETRY_LIMIT = 80;
const LOCK_STALE_MS = 30_000;

export type EnterpriseFinding = {
  schemaVersion: 'comet.enterprise-finding.v1';
  createdAt: string;
  ruleId: string;
  ruleVersion: number;
  enforcement: 'hard' | 'soft';
  decision: 'deny' | 'warn';
  tool: string | null;
  path: string | null;
  fingerprint: string;
  exceptionId: string | null;
};

export type EnterpriseFindingsReport = {
  findings: EnterpriseFinding[];
  integrityErrors: string[];
  status: 'clear' | 'warn' | 'blocked';
};

function sha256(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function findingDirectory(projectRoot: string): string {
  return path.resolve(projectRoot, '.comet', 'enterprise-guard');
}

export function enterpriseFindingsFile(projectRoot: string): string {
  return path.join(findingDirectory(projectRoot), FINDINGS_FILE_NAME);
}

async function clearStaleLock(lockPath: string): Promise<void> {
  try {
    const stat = await fs.stat(lockPath);
    if (Date.now() - stat.mtimeMs > LOCK_STALE_MS)
      await fs.rm(lockPath, { recursive: true, force: true });
  } catch {
    // A lock can disappear while another Hook process releases it.
  }
}

async function withFindingsLock<T>(target: string, operation: () => Promise<T>): Promise<T> {
  const lockPath = `${target}${LOCK_SUFFIX}`;
  await fs.mkdir(path.dirname(target), { recursive: true });
  for (let attempt = 0; attempt < LOCK_RETRY_LIMIT; attempt++) {
    try {
      await fs.mkdir(lockPath);
      try {
        return await operation();
      } finally {
        await fs.rm(lockPath, { recursive: true, force: true });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      await clearStaleLock(lockPath);
      await delay(Math.min(2 + attempt, 20));
    }
  }
  throw new Error('Enterprise Guard findings lock did not become available');
}

function findingPath(input: EnterpriseHookInput): string | null {
  return input.writes.find((write) => write.path.value)?.path.value ?? null;
}

function toFinding(
  input: EnterpriseHookInput,
  result: EnterpriseRuleResult,
  createdAt: string,
): EnterpriseFinding {
  return {
    schemaVersion: 'comet.enterprise-finding.v1',
    createdAt,
    ruleId: result.ruleId,
    ruleVersion: result.ruleVersion,
    enforcement: result.enforcement,
    decision: result.decision as 'deny' | 'warn',
    tool: input.tool.name.value,
    path: findingPath(input),
    fingerprint: sha256(`${result.ruleId}\u0000${result.inputDigest}\u0000${result.decision}`),
    exceptionId: result.exceptionId,
  };
}

/** Persist only schema-shaped, redaction-safe deny/warn results for one Hook event. */
export async function recordEnterpriseFindings(
  projectRoot: string,
  input: EnterpriseHookInput,
  decision: EnterpriseGuardDecision,
  now: Date = new Date(),
): Promise<number> {
  const findings = decision.results
    .filter(
      (result): result is EnterpriseRuleResult & { decision: 'deny' | 'warn' } =>
        result.decision === 'deny' || result.decision === 'warn',
    )
    .map((result) => toFinding(input, result, now.toISOString()));
  if (findings.length === 0) return 0;
  const serialized = findings.map((finding) => JSON.stringify(finding)).join('\n') + '\n';
  await withFindingsLock(enterpriseFindingsFile(projectRoot), async () => {
    await fs.appendFile(enterpriseFindingsFile(projectRoot), serialized, 'utf8');
  });
  return findings.length;
}

function isFinding(value: unknown): value is EnterpriseFinding {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const finding = value as Record<string, unknown>;
  const knownKeys = new Set([
    'schemaVersion',
    'createdAt',
    'ruleId',
    'ruleVersion',
    'enforcement',
    'decision',
    'tool',
    'path',
    'fingerprint',
    'exceptionId',
  ]);
  return (
    Object.keys(finding).every((key) => knownKeys.has(key)) &&
    finding.schemaVersion === 'comet.enterprise-finding.v1' &&
    typeof finding.createdAt === 'string' &&
    /^EG-(?:HARD|SOFT)-[A-Z]+-[0-9]{3}$/u.test(String(finding.ruleId)) &&
    Number.isInteger(finding.ruleVersion) &&
    (finding.enforcement === 'hard' || finding.enforcement === 'soft') &&
    (finding.decision === 'deny' || finding.decision === 'warn') &&
    (typeof finding.tool === 'string' || finding.tool === null) &&
    (typeof finding.path === 'string' || finding.path === null) &&
    /^sha256:[a-f0-9]{64}$/u.test(String(finding.fingerprint)) &&
    (typeof finding.exceptionId === 'string' || finding.exceptionId === null)
  );
}

/** Read findings for L4 review. Corruption is a blocking integrity result, never a silent skip. */
export async function readEnterpriseFindings(
  projectRoot: string,
): Promise<EnterpriseFindingsReport> {
  let source: string;
  try {
    source = await fs.readFile(enterpriseFindingsFile(projectRoot), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { findings: [], integrityErrors: [], status: 'clear' };
    }
    return {
      findings: [],
      integrityErrors: ['Unable to read Enterprise Guard findings'],
      status: 'blocked',
    };
  }
  const findings: EnterpriseFinding[] = [];
  const integrityErrors: string[] = [];
  for (const [index, line] of source.split('\n').entries()) {
    if (!line) continue;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (!isFinding(parsed)) throw new Error('schema mismatch');
      findings.push(parsed);
    } catch {
      integrityErrors.push(`Malformed Enterprise Guard finding at line ${index + 1}`);
    }
  }
  const hasHardDenial = findings.some(
    (finding) => finding.enforcement === 'hard' && finding.decision === 'deny',
  );
  const hasWarning = findings.some((finding) => finding.decision === 'warn');
  return {
    findings,
    integrityErrors,
    status: integrityErrors.length > 0 || hasHardDenial ? 'blocked' : hasWarning ? 'warn' : 'clear',
  };
}
