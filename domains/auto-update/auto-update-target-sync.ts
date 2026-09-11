import os from 'node:os';
import {
  hasUpdateFailures,
  updateSingleProject,
  type UpdateOptions,
} from '../../app/commands/update.js';
import { compareVersions } from '../../platform/version/version.js';
import {
  type SyncTargetInventoryOptions,
  type SyncTargetInventoryResult,
  type TargetSyncItem,
} from './auto-update-types.js';

export async function syncTargetInventory(
  inventory: TargetSyncItem[],
  options: SyncTargetInventoryOptions,
): Promise<SyncTargetInventoryResult> {
  const homeDir = options.homeDir ?? os.homedir();
  const log = options.log ?? (() => undefined);
  const updatedResults: TargetSyncItem[] = [];

  // 按 projectPath 分组，全局目标统一归到 homeDir
  const globalTargets = inventory.filter((item) => item.scope === 'global');
  const projectGroups = new Map<string, TargetSyncItem[]>();

  for (const item of inventory) {
    if (item.scope === 'project' && item.projectPath) {
      const existing = projectGroups.get(item.projectPath) ?? [];
      existing.push(item);
      projectGroups.set(item.projectPath, existing);
    }
  }

  // 1. 同步全局目标
  if (globalTargets.length > 0) {
    const pendingGlobals = globalTargets.filter(
      (item) => item.status !== 'success' && item.status !== 'stale_skipped',
    );
    if (pendingGlobals.length === 0) {
      updatedResults.push(...globalTargets);
    } else {
      const globalResults = await syncScopeGroup(homeDir, 'global', globalTargets, options, log);
      updatedResults.push(...globalResults);
    }
  }

  // 2. 同步项目目标
  for (const [projectPath, projectTargets] of projectGroups.entries()) {
    const pendingProjectTargets = projectTargets.filter(
      (item) => item.status !== 'success' && item.status !== 'stale_skipped',
    );
    if (pendingProjectTargets.length === 0) {
      updatedResults.push(...projectTargets);
      continue;
    }

    const projectResults = await syncScopeGroup(
      projectPath,
      'project',
      projectTargets,
      options,
      log,
    );
    updatedResults.push(...projectResults);
  }

  const hasFailures = updatedResults.some((item) => item.status === 'failed');
  const allCompleted =
    !hasFailures &&
    updatedResults.every(
      (item) =>
        item.status === 'success' ||
        item.status === 'stale_skipped' ||
        item.status === 'unsupported_skipped' ||
        item.status === 'higher_version_skipped',
    );

  return {
    allCompleted,
    hasFailures,
    results: updatedResults,
  };
}

async function syncScopeGroup(
  rootPath: string,
  scope: 'global' | 'project',
  targets: TargetSyncItem[],
  options: SyncTargetInventoryOptions,
  log: (message: string) => void,
): Promise<TargetSyncItem[]> {
  const results: TargetSyncItem[] = targets.map((t) => ({ ...t }));
  const pendingTargets = results.filter((t) => t.status === 'pending' || t.status === 'failed');

  if (pendingTargets.length === 0) {
    return results;
  }

  // 防降级检查：若目标实际版本高于 targetVersion，安全跳过
  for (const target of pendingTargets) {
    if (target.actualVersion && compareVersions(target.actualVersion, options.targetVersion) > 0) {
      target.status = 'higher_version_skipped';
      target.error = `target already at higher version ${target.actualVersion}`;
    }
  }

  const runnableTargets = pendingTargets.filter(
    (t) => t.status === 'pending' || t.status === 'failed',
  );
  if (runnableTargets.length === 0) {
    return results;
  }

  // 针对每一个 platform 平台执行无交互更新
  for (const target of runnableTargets) {
    const updateOpts: UpdateOptions = {
      json: true,
      scope,
      targetScopes: [scope],
      platform: target.platform,
      installMode: target.installMode,
      skipPackageSelfUpdate: true,
      skipNpm: true,
      skipSelfUpdate: true,
      currentProject: scope === 'project',
      allProjects: false,
    };

    try {
      const projectResult = await updateSingleProject(rootPath, updateOpts, log);
      const isFailed = hasUpdateFailures(projectResult);

      if (isFailed) {
        target.status = 'failed';
        const componentFailure =
          projectResult.skills.targets.find((t) => t.failed > 0)?.reason ||
          projectResult.rules.targets.find((t) => t.failed > 0)?.reason ||
          projectResult.hooks.targets.find((t) => t.failed > 0)?.reason ||
          'component update failed';
        target.error = componentFailure;
      } else {
        target.status = 'success';
        target.actualVersion = options.targetVersion;
        target.error = undefined;
      }
    } catch (error) {
      target.status = 'failed';
      target.error = error instanceof Error ? error.message : String(error);
    }
  }

  return results;
}
