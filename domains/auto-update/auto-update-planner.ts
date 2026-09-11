import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { detectInstalledCometTargets } from '../../app/commands/update.js';
import { listProjectRegistryEntries } from '../../platform/install/project-registry.js';
import type { TargetSyncItem } from './auto-update-types.js';

export async function planUpdateInventory(
  targetVersion: string,
  homeDir = os.homedir(),
): Promise<TargetSyncItem[]> {
  const items: TargetSyncItem[] = [];

  // 1. 全局目标
  try {
    const globalTargets = await detectInstalledCometTargets(homeDir, {
      scopes: ['global'],
      globalBaseDir: homeDir,
    });
    for (const target of globalTargets) {
      items.push({
        id: `global:${target.platform.id}`,
        scope: 'global',
        platform: target.platform.id,
        platformName: target.platform.name,
        installMode: 'copy', // 全局默认 copy
        expectedVersion: targetVersion,
        status: 'pending',
      });
    }
  } catch {
    // ignore
  }

  // 2. 已登记项目目标
  try {
    const registryProjects = await listProjectRegistryEntries({ homeDir, strict: false });
    for (const entry of registryProjects) {
      const projectPath = entry.path;
      if (!fs.existsSync(projectPath)) {
        items.push({
          id: `project:${projectPath}:stale`,
          scope: 'project',
          platform: 'unknown',
          projectPath,
          installMode: 'copy',
          expectedVersion: targetVersion,
          status: 'stale_skipped',
          error: 'project directory no longer exists',
        });
        continue;
      }

      try {
        const projectTargets = await detectInstalledCometTargets(projectPath, {
          scopes: ['project'],
        });
        for (const target of projectTargets) {
          // 探测是否为 symlink 安装模式
          const skillsSymlink = path.join(projectPath, '.comet', 'skills');
          const isSymlink = fs.existsSync(skillsSymlink);

          items.push({
            id: `project:${projectPath}:${target.platform.id}`,
            scope: 'project',
            platform: target.platform.id,
            platformName: target.platform.name,
            projectPath,
            installMode: isSymlink ? 'symlink' : 'copy',
            expectedVersion: targetVersion,
            status: 'pending',
          });
        }
      } catch (err) {
        items.push({
          id: `project:${projectPath}:failed`,
          scope: 'project',
          platform: 'unknown',
          projectPath,
          installMode: 'copy',
          expectedVersion: targetVersion,
          status: 'failed',
          error: `failed to inspect project: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }
  } catch {
    // ignore
  }

  return items;
}

export function supersedeUpdateInventory(
  existingTargets: TargetSyncItem[],
  newerVersion: string,
): TargetSyncItem[] {
  return existingTargets.map((item) => {
    // stale_skipped 保持不变，其他（包括之前的 success）全部重置为 pending，以新版本重评
    if (item.status === 'stale_skipped') {
      return {
        ...item,
        expectedVersion: newerVersion,
      };
    }
    return {
      ...item,
      expectedVersion: newerVersion,
      actualVersion: undefined,
      status: 'pending',
      error: undefined,
    };
  });
}
