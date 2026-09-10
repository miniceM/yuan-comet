import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { EnterpriseExceptionRecord } from './policy-engine.js';

type UnknownRecord = Record<string, unknown>;

const EXCEPTION_SCHEMA_VERSION = 'comet.enterprise-exceptions.v1';
const RECORD_SCHEMA_VERSION = 'comet.enterprise-exception.v1';
const SCOPE_KINDS = new Set(['path', 'command', 'repository', 'branch']);

function isRecord(value: unknown): value is UnknownRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isExceptionRecord(value: unknown): value is EnterpriseExceptionRecord {
  if (!isRecord(value) || value.schemaVersion !== RECORD_SCHEMA_VERSION) return false;
  if (
    !isNonEmptyString(value.exceptionId) ||
    !isNonEmptyString(value.ruleId) ||
    !isNonEmptyString(value.reason) ||
    !isNonEmptyString(value.owner) ||
    !isNonEmptyString(value.expiresAt) ||
    !['active', 'revoked', 'expired'].includes(String(value.status)) ||
    !isRecord(value.scope) ||
    !SCOPE_KINDS.has(String(value.scope.kind)) ||
    !isNonEmptyString(value.scope.value) ||
    value.scope.value.includes('*') ||
    !isRecord(value.approval) ||
    !isNonEmptyString(value.approval.changeId) ||
    !isNonEmptyString(value.approval.approvedBy) ||
    !isNonEmptyString(value.approval.approvedAt) ||
    !isNonEmptyString(value.approval.protectedRef) ||
    !isRecord(value.ci) ||
    !isNonEmptyString(value.ci.provider) ||
    !isNonEmptyString(value.ci.runId) ||
    value.ci.conclusion !== 'passed' ||
    value.ci.protectedRef !== value.approval.protectedRef
  ) {
    return false;
  }

  return (
    Number.isFinite(Date.parse(value.expiresAt)) &&
    Number.isFinite(Date.parse(value.approval.approvedAt))
  );
}

export function enterpriseExceptionsFile(projectRoot: string): string {
  return join(projectRoot, '.comet', 'enterprise-guard', 'exceptions.json');
}

export async function readEnterpriseExceptions(
  projectRoot: string,
): Promise<EnterpriseExceptionRecord[]> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(enterpriseExceptionsFile(projectRoot), 'utf8'));
  } catch {
    return [];
  }

  if (
    !isRecord(parsed) ||
    parsed.schemaVersion !== EXCEPTION_SCHEMA_VERSION ||
    !Array.isArray(parsed.exceptions)
  ) {
    return [];
  }

  return parsed.exceptions.every(isExceptionRecord) ? parsed.exceptions : [];
}
