import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  compareVersions,
  getCurrentVersion,
  getLatestVersion,
} from '../../platform/version/version.js';
import { inspectInstallationIdentity } from './auto-update-env.js';
import { AutoUpdateLock } from './auto-update-lock.js';
import { logAutoUpdate } from './auto-update-logger.js';
import { planUpdateInventory, supersedeUpdateInventory } from './auto-update-planner.js';
import {
  archiveTransaction,
  calculateBackoffDelay,
  CHECK_INTERVAL_MS,
  readSchedulerState,
  readTransactionState,
  reconcileTransactionWithDisk,
  writeSchedulerState,
  writeTransactionState,
} from './auto-update-state.js';
import type { AutoUpdateSchedulerState, AutoUpdateTransaction } from './auto-update-types.js';

export interface RunWorkerOptions {
  packageRoot?: string;
  homeDir?: string;
  forceCheck?: boolean;
}

export async function runAutoUpdateWorker(options: RunWorkerOptions = {}): Promise<void> {
  const homeDir = options.homeDir ?? os.homedir();
  const packageRoot =
    options.packageRoot ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

  logAutoUpdate(`Worker started for package: ${packageRoot}`, homeDir);

  // 1. 前置安全守卫
  if (process.env.COMET_NO_AUTO_UPDATE === '1' || process.env.CI === 'true') {
    logAutoUpdate(
      'Auto update disabled by environment variable (COMET_NO_AUTO_UPDATE or CI)',
      homeDir,
    );
    return;
  }

  const identity = inspectInstallationIdentity(packageRoot);
  if (identity.isDevWorktree) {
    logAutoUpdate('Development source worktree detected, safely skipping auto update', homeDir);
    return;
  }

  if (!identity.isGlobal) {
    logAutoUpdate('Non-global package installation detected, safely skipping auto update', homeDir);
    return;
  }

  // 2. 获取用户级全局写入互斥锁
  const lock = await AutoUpdateLock.acquire({
    installationId: identity.installationId,
    homeDir,
  });

  if (!lock) {
    logAutoUpdate(
      'Failed to acquire global update lock; another update process is running',
      homeDir,
    );
    return;
  }

  try {
    let transaction = readTransactionState(identity.installationId, homeDir);
    const scheduler = readSchedulerState(identity.installationId, homeDir) ?? {
      schemaVersion: 1,
      installationId: identity.installationId,
      checkFailures: 0,
      hasPendingTransaction: false,
    };

    // 3. 恢复优先检查：存在未完成事务
    if (transaction && transaction.phase !== 'completed') {
      logAutoUpdate(
        `Found active transaction ${transaction.transactionId} at phase: ${transaction.phase}`,
        homeDir,
      );

      // 检查指数退避是否到期
      if (transaction.nextRetryAfter) {
        const retryTime = new Date(transaction.nextRetryAfter).getTime();
        if (Date.now() < retryTime) {
          logAutoUpdate(
            `Transaction is in backoff until ${transaction.nextRetryAfter}, skipping for now`,
            homeDir,
          );
          return;
        }
      }

      // 双向核对磁盘实际版本与完整性
      const reconciliation = reconcileTransactionWithDisk(transaction);
      logAutoUpdate(
        `Disk reconciliation result: ${reconciliation.action} (actual version: ${reconciliation.actualVersion})`,
        homeDir,
      );

      if (reconciliation.action === 'supersede_with_newer' && reconciliation.actualVersion) {
        logAutoUpdate(
          `Disk package already upgraded to newer version ${reconciliation.actualVersion}, superseding transaction`,
          homeDir,
        );
        transaction.phase = 'superseded';
        transaction.targetVersion = reconciliation.actualVersion;
        transaction.targets = supersedeUpdateInventory(
          transaction.targets,
          reconciliation.actualVersion,
        );
        writeTransactionState(transaction, homeDir);
      } else if (reconciliation.action === 'advance_to_installed') {
        transaction.phase = 'package_installed';
        writeTransactionState(transaction, homeDir);
      }

      // 若已经处于或推进至 package_installed 或 assets_syncing，直接交接执行资产刷新
      if (
        transaction.phase === 'package_installed' ||
        transaction.phase === 'assets_syncing' ||
        transaction.phase === 'superseded'
      ) {
        await executeHandoverSync(transaction, lock, homeDir, identity.canonicalPackageRoot);
        return;
      }
    }

    // 4. 空闲状态：检查是否到达检查周期
    const currentVersion = getCurrentVersion();
    const now = Date.now();
    if (!options.forceCheck && scheduler.nextCheckAt) {
      const nextCheckTime = new Date(scheduler.nextCheckAt).getTime();
      if (now < nextCheckTime) {
        logAutoUpdate(
          `Check cooldown active until ${scheduler.nextCheckAt}, skipping check`,
          homeDir,
        );
        return;
      }
    }

    logAutoUpdate(
      `Checking npm registry for latest version (current: ${currentVersion})...`,
      homeDir,
    );
    const latestVersion = await getLatestVersion();

    if (!latestVersion) {
      logAutoUpdate('Failed to fetch latest version from registry', homeDir);
      scheduler.checkFailures += 1;
      const delay = calculateBackoffDelay(scheduler.checkFailures);
      scheduler.nextCheckAt = new Date(now + delay).toISOString();
      writeSchedulerState(scheduler, homeDir);
      return;
    }

    logAutoUpdate(`Registry latest version: ${latestVersion}`, homeDir);
    scheduler.lastCheckAt = new Date(now).toISOString();
    scheduler.nextCheckAt = new Date(now + CHECK_INTERVAL_MS).toISOString();
    scheduler.checkFailures = 0;
    writeSchedulerState(scheduler, homeDir);

    if (compareVersions(latestVersion, currentVersion) <= 0) {
      logAutoUpdate(`Comet is already up-to-date (${currentVersion})`, homeDir);
      return;
    }

    // 5. 发现新版本：初始化新事务
    logAutoUpdate(
      `New version available: ${latestVersion} > ${currentVersion}. Planning inventory...`,
      homeDir,
    );
    const targets = await planUpdateInventory(latestVersion, homeDir);
    const transactionId = `txn_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    transaction = {
      schemaVersion: 1,
      transactionId,
      installationId: identity.installationId,
      phase: 'checked',
      currentVersion,
      targetVersion: latestVersion,
      packageRoot: identity.canonicalPackageRoot,
      checkFailures: 0,
      installFailures: 0,
      targets,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    // 先写事务，再标记 scheduler.hasPendingTransaction = true
    writeTransactionState(transaction, homeDir);
    scheduler.hasPendingTransaction = true;
    writeSchedulerState(scheduler, homeDir);

    // 6. 候选包命令验证与安装
    transaction.phase = 'package_installing';
    writeTransactionState(transaction, homeDir);

    logAutoUpdate(
      `Installing package @cli-tools/yuan-comet@${latestVersion} via npm install -g...`,
      homeDir,
    );
    const installSuccess = await executePackageInstall(latestVersion, lock);
    if (!installSuccess) {
      logAutoUpdate('npm install -g failed', homeDir);
      handleInstallFailure(transaction, scheduler, 'npm install failed', homeDir);
      return;
    }

    // 核对安装结果
    const postRecon = reconcileTransactionWithDisk(transaction);
    if (
      postRecon.action !== 'advance_to_installed' &&
      postRecon.action !== 'ready_for_sync' &&
      postRecon.action !== 'supersede_with_newer'
    ) {
      logAutoUpdate('Package verification failed after npm install', homeDir);
      handleInstallFailure(
        transaction,
        scheduler,
        'package integrity check failed after install',
        homeDir,
      );
      return;
    }

    transaction.phase = 'package_installed';
    writeTransactionState(transaction, homeDir);

    // 7. 新版交接执行资产刷新
    await executeHandoverSync(transaction, lock, homeDir, identity.canonicalPackageRoot);
  } catch (error) {
    logAutoUpdate(
      `Worker caught unexpected error: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
      homeDir,
    );
  } finally {
    await lock.release();
    logAutoUpdate('Worker released lock and exited', homeDir);
  }
}

function handleInstallFailure(
  transaction: AutoUpdateTransaction,
  scheduler: AutoUpdateSchedulerState,
  reason: string,
  homeDir: string,
): void {
  transaction.installFailures += 1;
  transaction.lastFailureReason = reason;
  const delay = calculateBackoffDelay(transaction.installFailures);
  const nextRetry = new Date(Date.now() + delay).toISOString();
  transaction.nextRetryAfter = nextRetry;
  writeTransactionState(transaction, homeDir);

  scheduler.nextCheckAt = nextRetry;
  writeSchedulerState(scheduler, homeDir);
}

async function executePackageInstall(version: string, lock: AutoUpdateLock): Promise<boolean> {
  // 通过独立包装进程或 npm 命令安装，并向 lock 登记 PID
  return new Promise((resolve) => {
    const child = spawn(
      'npm',
      [
        'install',
        '-g',
        `@cli-tools/yuan-comet@${version}`,
        '--registry',
        'https://registry.npmjs.org',
      ],
      {
        stdio: 'ignore',
        shell: process.platform === 'win32',
      },
    );

    if (child.pid) {
      lock.registerActiveWorkerPid(child.pid);
    }

    child.on('error', () => resolve(false));
    child.on('close', (code) => {
      resolve(code === 0);
    });
  });
}

async function executeHandoverSync(
  transaction: AutoUpdateTransaction,
  lock: AutoUpdateLock,
  homeDir: string,
  packageRoot: string,
): Promise<void> {
  logAutoUpdate(`Initiating handover sync for transaction ${transaction.transactionId}`, homeDir);
  transaction.phase = 'handshake_pending';
  writeTransactionState(transaction, homeDir);

  const binPath = path.join(packageRoot, 'bin', 'comet.js');
  // 启动新版 CLI 的同步入口，带握手等待
  const child = spawn(
    process.execPath,
    [
      binPath,
      'auto-update-internal-sync',
      '--transaction',
      transaction.transactionId,
      '--wait-for-auth',
    ],
    {
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );

  if (!child.pid) {
    logAutoUpdate('Failed to spawn new CLI process for handover', homeDir);
    return;
  }

  // 1. 登记 activeWorkerPid
  lock.registerActiveWorkerPid(child.pid);
  transaction.phase = 'assets_syncing';
  writeTransactionState(transaction, homeDir);

  // 2. 发送授权握手信号
  try {
    child.stdin.write('START\n');
  } catch {
    logAutoUpdate('Failed to write authorization token to child stdin', homeDir);
  }

  // 3. 等待子进程完成
  await new Promise<void>((resolve) => {
    child.on('close', (code) => {
      logAutoUpdate(`Handover sync child exited with code: ${code}`, homeDir);
      resolve();
    });
    child.on('error', (err) => {
      logAutoUpdate(`Handover sync child error: ${err.message}`, homeDir);
      resolve();
    });
  });

  // 4. Supervisor 终审核对
  const latestTxn = readTransactionState(transaction.installationId, homeDir);
  if (!latestTxn) {
    logAutoUpdate('Transaction state disappeared after handover', homeDir);
    return;
  }

  const allCompleted = latestTxn.targets.every(
    (t) =>
      t.status === 'success' ||
      t.status === 'stale_skipped' ||
      t.status === 'unsupported_skipped' ||
      t.status === 'higher_version_skipped',
  );

  const scheduler = readSchedulerState(transaction.installationId, homeDir);

  if (allCompleted) {
    logAutoUpdate(
      `All targets completed successfully for transaction ${latestTxn.transactionId}! Marking completed.`,
      homeDir,
    );
    latestTxn.phase = 'completed';
    writeTransactionState(latestTxn, homeDir);
    if (scheduler) {
      scheduler.hasPendingTransaction = false;
      scheduler.checkFailures = 0;
      writeSchedulerState(scheduler, homeDir);
    }
    archiveTransaction(latestTxn, homeDir);
  } else {
    logAutoUpdate(`Some targets failed in transaction ${latestTxn.transactionId}`, homeDir);
    if (scheduler) {
      handleInstallFailure(latestTxn, scheduler, 'some targets failed during sync', homeDir);
    }
  }
}
