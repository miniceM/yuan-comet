import type { EnterpriseGuardEvaluation } from '../normalized-event.js';

export const OPENCODE_GUARD_DECISION_SCHEMA_VERSION = 'comet.enterprise-guard-decision.v1';

export type OpenCodeGuardDecision = {
  schemaVersion: typeof OPENCODE_GUARD_DECISION_SCHEMA_VERSION;
  allowed: boolean;
  ruleId: string | null;
  reason: string;
  warningRuleIds: readonly string[];
  parseStatus: string;
};

/** Render the minimal, redacted decision contract consumed by the OpenCode plugin bridge. */
export function renderOpenCodeRunnerDecision(evaluation: EnterpriseGuardEvaluation): string {
  const decision: OpenCodeGuardDecision = {
    schemaVersion: OPENCODE_GUARD_DECISION_SCHEMA_VERSION,
    allowed: evaluation.decision.allowed,
    ruleId: evaluation.decision.ruleId,
    reason: evaluation.decision.reason,
    warningRuleIds: [...evaluation.decision.warningRuleIds],
    parseStatus: evaluation.input.parse.status,
  };
  return JSON.stringify(decision);
}

export function failedOpenCodeRunnerDecision(reason: string): string {
  return JSON.stringify({
    schemaVersion: OPENCODE_GUARD_DECISION_SCHEMA_VERSION,
    allowed: false,
    ruleId: 'EG-HARD-AUDIT-001',
    reason,
    warningRuleIds: [],
    parseStatus: 'unavailable',
  } satisfies OpenCodeGuardDecision);
}

/** The bridge must fail closed when the managed Runner output cannot be trusted. */
export function parseOpenCodeRunnerDecision(source: string): OpenCodeGuardDecision {
  try {
    const value = JSON.parse(source) as unknown;
    if (
      typeof value !== 'object' ||
      value === null ||
      (value as Record<string, unknown>).schemaVersion !== OPENCODE_GUARD_DECISION_SCHEMA_VERSION ||
      typeof (value as Record<string, unknown>).allowed !== 'boolean' ||
      typeof (value as Record<string, unknown>).reason !== 'string'
    ) {
      throw new Error('invalid decision schema');
    }
    const decision = value as Record<string, unknown>;
    return {
      schemaVersion: OPENCODE_GUARD_DECISION_SCHEMA_VERSION,
      allowed: decision.allowed as boolean,
      ruleId:
        typeof decision.ruleId === 'string' || decision.ruleId === null
          ? (decision.ruleId as string | null)
          : null,
      reason: decision.reason as string,
      warningRuleIds: Array.isArray(decision.warningRuleIds)
        ? decision.warningRuleIds.filter((item): item is string => typeof item === 'string')
        : [],
      parseStatus: typeof decision.parseStatus === 'string' ? decision.parseStatus : 'unknown',
    };
  } catch (error) {
    return {
      schemaVersion: OPENCODE_GUARD_DECISION_SCHEMA_VERSION,
      allowed: false,
      ruleId: 'EG-HARD-INPUT-001',
      reason: `Enterprise Guard failed closed: ${
        error instanceof Error ? error.message : 'invalid Runner output'
      }`,
      warningRuleIds: [],
      parseStatus: 'unavailable',
    };
  }
}
