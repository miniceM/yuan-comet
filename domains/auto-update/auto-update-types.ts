export type AutoUpdatePhase =
  | 'idle'
  | 'checked'
  | 'package_verified'
  | 'package_installing'
  | 'package_installed'
  | 'handshake_pending'
  | 'assets_syncing'
  | 'completed'
  | 'superseded';

export type TargetSyncStatus =
  | 'pending'
  | 'success'
  | 'failed'
  | 'stale_skipped'
  | 'unsupported_skipped'
  | 'higher_version_skipped';

export interface TargetSyncItem {
  id: string; // e.g. "global:claude" | "project:/abs/path:gemini"
  scope: 'global' | 'project';
  platform: string;
  platformName?: string;
  projectPath?: string;
  installMode: 'copy' | 'symlink';
  expectedVersion: string;
  actualVersion?: string;
  status: TargetSyncStatus;
  error?: string;
}

export interface AutoUpdateTransaction {
  schemaVersion: 1;
  transactionId: string;
  installationId: string;
  phase: AutoUpdatePhase;
  currentVersion: string;
  targetVersion: string;
  packageRoot: string;
  cliPath?: string;
  checkFailures: number;
  installFailures: number;
  nextRetryAfter?: string;
  lastFailureReason?: string;
  targets: TargetSyncItem[];
  createdAt: string;
  updatedAt: string;
}

export interface AutoUpdateSchedulerState {
  schemaVersion: 1;
  installationId: string;
  lastCheckAt?: string;
  nextCheckAt?: string;
  checkFailures: number;
  hasPendingTransaction: boolean;
}

export interface GlobalUpdateLockData {
  supervisorPid: number;
  activeWorkerPid?: number;
  hostname: string;
  token: string;
  installationId: string;
  startedAt: string;
  heartbeatAt: string;
  uncleanTermination?: boolean;
}

export interface SyncTargetInventoryOptions {
  transactionId: string;
  lockToken: string;
  targetVersion: string;
  protocolVersion: 1;
  homeDir?: string;
  log?: (message: string) => void;
}

export interface SyncTargetInventoryResult {
  allCompleted: boolean;
  hasFailures: boolean;
  results: TargetSyncItem[];
}
