import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  planUpdateInventory,
  supersedeUpdateInventory,
} from '../../../domains/auto-update/auto-update-planner.js';
import { syncTargetInventory } from '../../../domains/auto-update/auto-update-target-sync.js';
import type { TargetSyncItem } from '../../../domains/auto-update/auto-update-types.js';

describe('auto-update-sync', () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = path.join(
      os.tmpdir(),
      `sync-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    fs.mkdirSync(tmpHome, { recursive: true });
  });

  it('supersedes update inventory: updates expectedVersion and invalidates old success status to pending', () => {
    const existingTargets: TargetSyncItem[] = [
      {
        id: 'global:claude',
        scope: 'global',
        platform: 'claude',
        installMode: 'copy',
        expectedVersion: '0.4.1',
        actualVersion: '0.4.1',
        status: 'success', // 旧版本成功
      },
      {
        id: 'project:/fake/app:gemini',
        scope: 'project',
        platform: 'gemini',
        projectPath: '/fake/app',
        installMode: 'symlink',
        expectedVersion: '0.4.1',
        status: 'failed',
        error: 'disk full',
      },
      {
        id: 'project:/removed/app:stale',
        scope: 'project',
        platform: 'unknown',
        projectPath: '/removed/app',
        installMode: 'copy',
        expectedVersion: '0.4.1',
        status: 'stale_skipped',
      },
    ];

    const superseded = supersedeUpdateInventory(existingTargets, '0.4.2');

    // 1. 旧版本的 success 必须重置为 pending，expectedVersion 提升为 0.4.2
    expect(superseded[0].status).toBe('pending');
    expect(superseded[0].expectedVersion).toBe('0.4.2');
    expect(superseded[0].actualVersion).toBeUndefined();

    // 2. 失败项目重置为 pending，expectedVersion 提升为 0.4.2
    expect(superseded[1].status).toBe('pending');
    expect(superseded[1].expectedVersion).toBe('0.4.2');

    // 3. stale_skipped 保持 stale_skipped，但 expectedVersion 同样更新
    expect(superseded[2].status).toBe('stale_skipped');
    expect(superseded[2].expectedVersion).toBe('0.4.2');
  });

  it('marks nonexistent registered project as stale_skipped during planning', async () => {
    // 在 installations.json 中登记一个假的不存在的路径
    const cometDir = path.join(tmpHome, '.comet');
    fs.mkdirSync(cometDir, { recursive: true });
    const registryPath = path.join(cometDir, 'installations.json');
    fs.writeFileSync(
      registryPath,
      JSON.stringify({
        schemaVersion: 1,
        updatedAt: new Date().toISOString(),
        projects: [
          {
            path: '/path/does/not/exist/anymore',
            canonicalPath: '/path/does/not/exist/anymore',
            addedAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            lastSeenAt: new Date().toISOString(),
            lastSource: 'init',
            lastTargets: [{ platform: 'claude', language: 'en' }],
          },
        ],
      }),
      'utf8',
    );

    const targets = await planUpdateInventory('0.4.1', tmpHome);
    const staleTarget = targets.find((t) => t.status === 'stale_skipped');
    expect(staleTarget).toBeDefined();
    expect(staleTarget!.projectPath).toBe('/path/does/not/exist/anymore');
  });

  it('prevents asset downgrade when actual asset version is higher than targetVersion', async () => {
    const targets: TargetSyncItem[] = [
      {
        id: 'global:claude',
        scope: 'global',
        platform: 'claude',
        installMode: 'copy',
        expectedVersion: '0.4.1',
        actualVersion: '0.4.5', // 目标本身已经是更高版本！
        status: 'pending',
      },
    ];

    const result = await syncTargetInventory(targets, {
      transactionId: 'txn-test',
      lockToken: 'token',
      targetVersion: '0.4.1',
      protocolVersion: 1,
      homeDir: tmpHome,
    });

    expect(result.results[0].status).toBe('higher_version_skipped');
    expect(result.allCompleted).toBe(true);
    expect(result.hasFailures).toBe(false);
  });
});
