import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { compareVersions } from '../../platform/version/version.js';
import type { AutoUpdateSchedulerState, AutoUpdateTransaction } from './auto-update-types.js';

export const BASE_BACKOFF_MS = 60_000; // 1 分钟
export const MAX_BACKOFF_MS = 24 * 60 * 60_000; // 24 小时
export const CHECK_INTERVAL_MS = 30 * 60_000; // 30 分钟

export function getAutoUpdateDir(installationId: string, homeDir = os.homedir()): string {
  return path.join(homeDir, '.comet', 'auto-update', installationId);
}

export function getSchedulerFilePath(installationId: string, homeDir = os.homedir()): string {
  return path.join(getAutoUpdateDir(installationId, homeDir), 'scheduler.json');
}

export function getTransactionFilePath(installationId: string, homeDir = os.homedir()): string {
  return path.join(getAutoUpdateDir(installationId, homeDir), 'transaction.json');
}

export function calculateBackoffDelay(
  failures: number,
  baseMs = BASE_BACKOFF_MS,
  maxMs = MAX_BACKOFF_MS,
): number {
  if (failures <= 0) return 0;
  const exp = Math.min(failures, 10);
  const delay = baseMs * Math.pow(2, exp - 1);
  return Math.min(delay, maxMs);
}

// ---------------------------
// 调度元数据读写 (Scheduler)
// ---------------------------

export function readSchedulerState(
  installationId: string,
  homeDir = os.homedir(),
): AutoUpdateSchedulerState | null {
  const filePath = getSchedulerFilePath(installationId, homeDir);
  try {
    if (!fs.existsSync(filePath)) return null;
    const content = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(content) as AutoUpdateSchedulerState;
    if (parsed && parsed.schemaVersion === 1 && parsed.installationId === installationId) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

export function writeSchedulerState(state: AutoUpdateSchedulerState, homeDir = os.homedir()): void {
  const dir = getAutoUpdateDir(state.installationId, homeDir);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const filePath = getSchedulerFilePath(state.installationId, homeDir);
  atomicWriteJson(filePath, state);
}

// ---------------------------
// 事务数据读写 (Transaction)
// ---------------------------

export function readTransactionState(
  installationId: string,
  homeDir = os.homedir(),
): AutoUpdateTransaction | null {
  const filePath = getTransactionFilePath(installationId, homeDir);
  try {
    if (!fs.existsSync(filePath)) return null;
    const content = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(content) as AutoUpdateTransaction;
    if (parsed && parsed.schemaVersion === 1 && parsed.installationId === installationId) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

export function writeTransactionState(
  transaction: AutoUpdateTransaction,
  homeDir = os.homedir(),
): void {
  const dir = getAutoUpdateDir(transaction.installationId, homeDir);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const filePath = getTransactionFilePath(transaction.installationId, homeDir);
  transaction.updatedAt = new Date().toISOString();
  atomicWriteJson(filePath, transaction);
}

export function archiveTransaction(
  transaction: AutoUpdateTransaction,
  homeDir = os.homedir(),
): void {
  const filePath = getTransactionFilePath(transaction.installationId, homeDir);
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch {
    // ignore
  }
}

// ---------------------------
// 磁盘双向核对与恢复决策
// ---------------------------

export interface DiskReconciliationResult {
  action: 'advance_to_installed' | 'retry_install' | 'supersede_with_newer' | 'ready_for_sync';
  actualVersion: string | null;
  isCorrupted: boolean;
}

export function inspectPackageIntegrity(packageRoot: string): {
  version: string | null;
  isComplete: boolean;
} {
  try {
    const pkgJsonPath = path.join(packageRoot, 'package.json');
    if (!fs.existsSync(pkgJsonPath)) {
      return { version: null, isComplete: false };
    }
    const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8')) as { version?: string };
    const version = typeof pkg.version === 'string' ? pkg.version : null;
    if (!version) return { version: null, isComplete: false };

    // 关键文件验证：bin/comet.js, dist/app/cli/index.js, assets/manifest.json
    const binExists = fs.existsSync(path.join(packageRoot, 'bin', 'comet.js'));
    const distExists = fs.existsSync(path.join(packageRoot, 'dist', 'app', 'cli', 'index.js'));
    const manifestExists = fs.existsSync(path.join(packageRoot, 'assets', 'manifest.json'));

    const isComplete = binExists && distExists && manifestExists;
    return { version, isComplete };
  } catch {
    return { version: null, isComplete: false };
  }
}

export function reconcileTransactionWithDisk(
  transaction: AutoUpdateTransaction,
): DiskReconciliationResult {
  const { version: actualVersion, isComplete } = inspectPackageIntegrity(transaction.packageRoot);

  if (!actualVersion || !isComplete) {
    return {
      action: 'retry_install',
      actualVersion,
      isCorrupted: true,
    };
  }

  // 1. 若实际版本已经高于目标版本，安全提升目标版本并接续刷新
  if (compareVersions(actualVersion, transaction.targetVersion) > 0) {
    return {
      action: 'supersede_with_newer',
      actualVersion,
      isCorrupted: false,
    };
  }

  // 2. 若实际版本等于目标版本且完整
  if (actualVersion === transaction.targetVersion) {
    if (transaction.phase === 'package_installing' || transaction.phase === 'package_verified') {
      return {
        action: 'advance_to_installed',
        actualVersion,
        isCorrupted: false,
      };
    }
    return {
      action: 'ready_for_sync',
      actualVersion,
      isCorrupted: false,
    };
  }

  // 3. 实际版本小于目标版本
  return {
    action: 'retry_install',
    actualVersion,
    isCorrupted: false,
  };
}

function atomicWriteJson(targetFile: string, data: unknown): void {
  const dir = path.dirname(targetFile);
  const tmpFile = path.join(
    dir,
    `.tmp.${path.basename(targetFile)}.${Date.now()}.${Math.random().toString(36).slice(2)}`,
  );
  fs.writeFileSync(tmpFile, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmpFile, targetFile);
}
