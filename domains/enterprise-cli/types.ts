export type EnterpriseCliId = 'iam' | 'dop' | 'gh';

export type EnterpriseCliAction = 'reused' | 'installed' | 'failed' | 'not-run';

export type EnterpriseCliReasonCode =
  | 'available'
  | 'missing'
  | 'unusable'
  | 'probe-timeout'
  | 'configuration-missing'
  | 'configuration-invalid'
  | 'npm-unavailable'
  | 'registry-auth'
  | 'package-unavailable'
  | 'bin-mismatch'
  | 'bin-conflict'
  | 'permission-denied'
  | 'network-error'
  | 'install-scripts-blocked'
  | 'install-timeout'
  | 'install-failed'
  | 'postcheck-failed'
  | 'path-not-ready'
  | 'installation-busy';

export interface EnterpriseCliToolResult {
  command: EnterpriseCliId;
  packageName: string;
  version: string;
  action: EnterpriseCliAction;
  reasonCode: EnterpriseCliReasonCode;
  path?: string;
  detail?: string;
}

export interface EnterpriseCliResult {
  status: 'complete' | 'incomplete';
  tools: EnterpriseCliToolResult[];
  failures: EnterpriseCliToolResult[];
  nextActions: string[];
}

export interface EnterpriseCliCatalogEntry {
  command: EnterpriseCliId;
  packageName: string;
  version: string;
  binName: string;
  probeArgs: readonly string[];
  probeOutput: RegExp;
}

export interface EnterpriseCliConfig {
  registry: string;
  entries: Record<EnterpriseCliId, EnterpriseCliCatalogEntry>;
}

export interface EnterpriseCliCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
}

export type EnterpriseCliCommandRunner = (
  command: string,
  args: readonly string[],
  options: { timeoutMs: number; env: NodeJS.ProcessEnv },
) => EnterpriseCliCommandResult;

export interface EnsureEnterpriseCliOptions {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  config?: Partial<EnterpriseCliConfig>;
  runCommand?: EnterpriseCliCommandRunner;
  acquireLock?: boolean;
}
