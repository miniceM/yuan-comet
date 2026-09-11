import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  calculateBackoffDelay,
  readSchedulerState,
  readTransactionState,
  reconcileTransactionWithDisk,
  writeSchedulerState,
  writeTransactionState,
} from '../../../domains/auto-update/auto-update-state.js';
import type { AutoUpdateTransaction } from '../../../domains/auto-update/auto-update-types.js';

describe('auto-update-state', () => {
  let tmpHome: string;
  let fakePkgRoot: string;

  beforeEach(() => {
    tmpHome = path.join(
      os.tmpdir(),
      `state-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    fakePkgRoot = path.join(tmpHome, 'installed-package');
    fs.mkdirSync(fakePkgRoot, { recursive: true });
  });

  it('calculates exponential backoff delay correctly with bounds', () => {
    expect(calculateBackoffDelay(0)).toBe(0);
    expect(calculateBackoffDelay(1, 1000, 10000)).toBe(1000);
    expect(calculateBackoffDelay(2, 1000, 10000)).toBe(2000);
    expect(calculateBackoffDelay(3, 1000, 10000)).toBe(4000);
    expect(calculateBackoffDelay(4, 1000, 10000)).toBe(8000);
    expect(calculateBackoffDelay(5, 1000, 10000)).toBe(10000); // 达到上限
  });

  it('atomically reads and writes scheduler and transaction states independently', () => {
    const instId = 'inst-abc';

    writeSchedulerState(
      {
        schemaVersion: 1,
        installationId: instId,
        checkFailures: 0,
        hasPendingTransaction: true,
      },
      tmpHome,
    );

    const scheduler = readSchedulerState(instId, tmpHome);
    expect(scheduler).not.toBeNull();
    expect(scheduler!.hasPendingTransaction).toBe(true);

    const txn: AutoUpdateTransaction = {
      schemaVersion: 1,
      transactionId: 'txn-123',
      installationId: instId,
      phase: 'checked',
      currentVersion: '0.4.0',
      targetVersion: '0.4.1',
      packageRoot: fakePkgRoot,
      checkFailures: 0,
      installFailures: 0,
      targets: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    writeTransactionState(txn, tmpHome);
    const readTxn = readTransactionState(instId, tmpHome);
    expect(readTxn).not.toBeNull();
    expect(readTxn!.transactionId).toBe('txn-123');
    expect(readTxn!.phase).toBe('checked');
  });

  it('detects corrupted package on disk (missing manifest or bin)', () => {
    // 只有 package.json，缺少 bin/comet.js 等关键文件
    fs.writeFileSync(path.join(fakePkgRoot, 'package.json'), JSON.stringify({ version: '0.4.1' }));

    const txn: AutoUpdateTransaction = {
      schemaVersion: 1,
      transactionId: 'txn-corrupt',
      installationId: 'inst-1',
      phase: 'package_installing',
      currentVersion: '0.4.0',
      targetVersion: '0.4.1',
      packageRoot: fakePkgRoot,
      checkFailures: 0,
      installFailures: 0,
      targets: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const result = reconcileTransactionWithDisk(txn);
    expect(result.action).toBe('retry_install');
    expect(result.isCorrupted).toBe(true);
  });

  it('reconciles crash window: package_installing state advances to package_installed if disk is complete and matched', () => {
    // 构造完整的 0.4.1 包
    fs.writeFileSync(path.join(fakePkgRoot, 'package.json'), JSON.stringify({ version: '0.4.1' }));
    fs.mkdirSync(path.join(fakePkgRoot, 'bin'), { recursive: true });
    fs.mkdirSync(path.join(fakePkgRoot, 'dist', 'app', 'cli'), { recursive: true });
    fs.mkdirSync(path.join(fakePkgRoot, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(fakePkgRoot, 'bin', 'comet.js'), '#!/usr/bin/env node');
    fs.writeFileSync(path.join(fakePkgRoot, 'dist', 'app', 'cli', 'index.js'), '// cli');
    fs.writeFileSync(path.join(fakePkgRoot, 'assets', 'manifest.json'), '{}');

    const txn: AutoUpdateTransaction = {
      schemaVersion: 1,
      transactionId: 'txn-crash',
      installationId: 'inst-1',
      phase: 'package_installing',
      currentVersion: '0.4.0',
      targetVersion: '0.4.1',
      packageRoot: fakePkgRoot,
      checkFailures: 0,
      installFailures: 0,
      targets: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const result = reconcileTransactionWithDisk(txn);
    expect(result.action).toBe('advance_to_installed');
    expect(result.actualVersion).toBe('0.4.1');
    expect(result.isCorrupted).toBe(false);
  });

  it('prevents downgrade: supersedes transaction when disk package was upgraded externally to higher version', () => {
    // 构造实际更高版本 0.4.2
    fs.writeFileSync(path.join(fakePkgRoot, 'package.json'), JSON.stringify({ version: '0.4.2' }));
    fs.mkdirSync(path.join(fakePkgRoot, 'bin'), { recursive: true });
    fs.mkdirSync(path.join(fakePkgRoot, 'dist', 'app', 'cli'), { recursive: true });
    fs.mkdirSync(path.join(fakePkgRoot, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(fakePkgRoot, 'bin', 'comet.js'), '#!/usr/bin/env node');
    fs.writeFileSync(path.join(fakePkgRoot, 'dist', 'app', 'cli', 'index.js'), '// cli');
    fs.writeFileSync(path.join(fakePkgRoot, 'assets', 'manifest.json'), '{}');

    const txn: AutoUpdateTransaction = {
      schemaVersion: 1,
      transactionId: 'txn-higher',
      installationId: 'inst-1',
      phase: 'package_installing',
      currentVersion: '0.4.0',
      targetVersion: '0.4.1', // 原目标 0.4.1，但外部已经是 0.4.2！
      packageRoot: fakePkgRoot,
      checkFailures: 0,
      installFailures: 0,
      targets: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const result = reconcileTransactionWithDisk(txn);
    expect(result.action).toBe('supersede_with_newer');
    expect(result.actualVersion).toBe('0.4.2');
  });
});
