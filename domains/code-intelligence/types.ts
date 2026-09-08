import type { InstallScope } from '../../platform/install/types.js';

export type CodebaseMemoryAction = 'install' | 'init' | 'skip' | 'auto';

export type CodebaseMemoryStepStatus = 'installed' | 'skipped' | 'failed';

export type CodebaseMemoryCliStatus =
  'installed' | 'missing' | 'incompatible' | 'unknown' | 'skipped';

export type CodebaseMemoryIndexStatus =
  'not_applicable' | 'missing' | 'indexing' | 'ready' | 'stale' | 'failed' | 'unknown' | 'skipped';

export type CodebaseMemoryFreshness = 'current' | 'stale' | 'unknown' | 'not_applicable';

export type CodebaseMemoryAgentStatus =
  'registered' | 'missing' | 'conflict' | 'invalid' | 'unsupported';

export interface CodebaseMemoryAgentDiagnostic {
  platform: string;
  name: string;
  scope: InstallScope;
  status: CodebaseMemoryAgentStatus;
  configPath: string | null;
  detail: string;
}

export interface CodebaseMemoryIndexDiagnostic {
  status: CodebaseMemoryIndexStatus;
  freshness: CodebaseMemoryFreshness;
  projectId: string | null;
  projectPath: string;
  detail: string;
  remediation: string | null;
}

export interface CodebaseMemorySetupDiagnostic {
  requested: CodebaseMemoryAction;
  status: CodebaseMemoryStepStatus;
  configured: boolean;
  cliStatus: CodebaseMemoryCliStatus;
  indexStatus: CodebaseMemoryIndexStatus;
  freshness: CodebaseMemoryFreshness;
  agents: CodebaseMemoryAgentDiagnostic[];
  repairable: boolean;
  remediation: string | null;
  detail: string;
  program: CodebaseMemoryStepStatus;
  configuration: CodebaseMemoryStepStatus;
  index: CodebaseMemoryStepStatus;
  failures: string[];
}

export interface CodebaseMemorySetupOptions {
  projectPath: string;
  scope: InstallScope;
  action: Exclude<CodebaseMemoryAction, 'auto'>;
  platformIds?: readonly string[];
  homeDir?: string;
  quiet?: boolean;
}

export interface CodebaseMemoryRepairResult {
  repaired: boolean;
  diagnostic: CodebaseMemorySetupDiagnostic;
}
