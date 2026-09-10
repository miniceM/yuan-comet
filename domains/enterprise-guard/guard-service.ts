import { readEnterpriseExceptions } from './exceptions.js';
import { recordEnterpriseFindings } from './findings.js';
import { parseEnterpriseGuardInput } from './input-codecs/index.js';
import type { EnterpriseGuardEvaluation } from './normalized-event.js';
import { evaluateEnterpriseHookInput } from './policy-engine.js';

export interface GuardServiceRequest {
  platformId: string;
  source: string;
  projectRoot: string | null;
}

export interface GuardServiceDependencies {
  readExceptions(root: string): ReturnType<typeof readEnterpriseExceptions>;
  recordFindings: typeof recordEnterpriseFindings;
}

const DEFAULT_DEPENDENCIES: GuardServiceDependencies = {
  readExceptions: readEnterpriseExceptions,
  recordFindings: recordEnterpriseFindings,
};

/**
 * Evaluate one Hook event and persist redacted audit findings.
 * Callers must not persist findings again based on the returned decision;
 * persistence failures are already fail-closed here.
 */
export async function evaluateEnterpriseGuardSource(
  request: GuardServiceRequest,
  overrides: Partial<GuardServiceDependencies> = {},
): Promise<EnterpriseGuardEvaluation> {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...overrides };
  const input = parseEnterpriseGuardInput(request.platformId, request.source);
  const auditRoot = request.projectRoot ?? input.workingDirectory.value;
  const exceptions = auditRoot ? await dependencies.readExceptions(auditRoot) : [];
  let decision = evaluateEnterpriseHookInput(input, { exceptions });

  // Only SOFT warnings trigger audit persistence; pure HARD denials
  // short-circuit without touching the filesystem by design.
  if (decision.warningRuleIds.length > 0) {
    if (!auditRoot) {
      decision = {
        ...decision,
        allowed: false,
        ruleId: 'EG-HARD-AUDIT-001',
        reason: 'Enterprise Guard audit persistence is unavailable',
      };
    } else {
      try {
        await dependencies.recordFindings(auditRoot, input, decision);
      } catch {
        decision = {
          ...decision,
          allowed: false,
          ruleId: 'EG-HARD-AUDIT-001',
          reason: 'Enterprise Guard audit persistence is unavailable',
        };
      }
    }
  }
  return { input, decision };
}
