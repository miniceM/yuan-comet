export const MAX_ENTERPRISE_HOOK_INPUT_BYTES = 256 * 1024;
export const MAX_ENTERPRISE_HOOK_FIELD_BYTES = 64 * 1024;

export type Enforcement = 'hard' | 'soft';
export type Decision = 'allow' | 'deny' | 'warn' | 'abstain';
export type ParseStatus = 'complete' | 'partial' | 'failed' | 'unavailable';

export type CapturedString = {
  value: string | null;
  capturedBytes: number;
  originalBytes: number;
  truncated: boolean;
};

export type CapturedJson = {
  value: unknown;
  capturedBytes: number;
  originalBytes: number;
  truncated: boolean;
};

export type EnterpriseHookInput = {
  schemaVersion: 'comet.enterprise-hook-input.v1';
  platform: {
    id: string;
    surface: 'project' | 'managed-global' | 'ci' | 'unknown';
    version?: string | null;
  };
  event: { name: string; preAction: boolean; blockingCapable: boolean };
  workingDirectory: CapturedString;
  tool: { name: CapturedString; input: CapturedJson };
  command: CapturedString;
  writes: Array<{
    operation: 'create' | 'edit' | 'delete' | 'rename' | 'unknown';
    path: CapturedString;
    fragment: CapturedString;
  }>;
  parse: { status: ParseStatus; errors: string[] };
  truncation: {
    maxCapturedBytes: number;
    fields: Array<{
      path: string;
      capturedBytes: number;
      originalBytes: number;
      truncated: boolean;
    }>;
  };
};

export type EnterpriseRuleResult = {
  schemaVersion: 'comet.enterprise-rule-result.v1';
  ruleId: string;
  ruleVersion: number;
  enforcement: Enforcement;
  decision: Decision;
  reason: string;
  evidence: Array<{
    kind: 'path' | 'command' | 'write-fragment' | 'parse' | 'policy' | 'exception';
    subject: string;
    redacted?: boolean;
  }>;
  exceptionId: string | null;
  inputDigest: string;
};

export type EnterpriseGuardDecision = {
  allowed: boolean;
  ruleId: string | null;
  reason: string;
  warningRuleIds: string[];
  results: EnterpriseRuleResult[];
};

export type EnterpriseGuardHost = 'command-hook' | 'plugin-hook' | 'native-boundary';

export interface EnterpriseGuardInputCodec {
  readonly id: string;
  parse(source: string): EnterpriseHookInput;
}

export interface EnterpriseGuardEvaluation {
  input: EnterpriseHookInput;
  decision: EnterpriseGuardDecision;
}

export function isWriteTool(name: string | null): boolean {
  return name === 'Write' || name === 'Edit';
}
