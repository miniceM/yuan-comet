import { promises as fs } from 'fs';
import { readFile, readdir } from 'fs/promises';
import path from 'path';

import { copyFile, removeFile } from '../../platform/fs/file-system.js';
import type { Platform } from '../../platform/install/platforms.js';
import { getPlatformSkillsDir } from '../../platform/install/platforms.js';
import type { InstallScope } from '../../platform/install/types.js';
import {
  getAssetsDir,
  installManagedHooksForPlatform,
  type HookConfig,
  type HookInstallResult,
} from '../skill/platform-install.js';
import {
  inspectManagedHooksForPlatform,
  type HookInspectionResult,
} from '../skill/platform-inspect.js';
import { removeManagedHooksForPlatform, type RemovalResult } from '../skill/uninstall.js';
import {
  activateManagedRuntimeVersion,
  cleanUnusedManagedRuntimeVersions,
  ENTERPRISE_GUARD_MANIFEST_FILE,
  type EnterpriseGuardManifest,
  inspectManagedRuntime,
  prepareManagedRuntimeVersion,
} from './managed-runtime.js';
import {
  enterpriseGuardCoverage,
  usesEnterpriseGuardGateway,
  usesEnterpriseGuardPlugin,
} from './platform-coverage.js';

export async function readPublishedEnterpriseGuardManifest(): Promise<EnterpriseGuardManifest> {
  const assetsDir = getAssetsDir();
  const manifestPath = path.join(assetsDir, 'skills', 'comet', ENTERPRISE_GUARD_MANIFEST_FILE);
  const raw = await readFile(manifestPath, 'utf8');
  return JSON.parse(raw) as EnterpriseGuardManifest;
}

export async function readPublishedRuntimeFiles(
  manifest: EnterpriseGuardManifest,
): Promise<Record<string, Buffer>> {
  const assetsDir = getAssetsDir();
  const files: Record<string, Buffer> = {};
  for (const [key, entry] of Object.entries(manifest.files)) {
    const relPath =
      key === 'opencodePlugin'
        ? path.join('skills', 'comet', 'plugins', entry.fileName)
        : path.join('skills', 'comet', 'scripts', entry.fileName);
    const filePath = path.join(assetsDir, relPath);
    files[key] = await readFile(filePath);
  }
  return files;
}

export async function ensureManagedRuntimeReady(storageRoot?: string): Promise<{
  versionDir: string;
  manifest: EnterpriseGuardManifest;
}> {
  const manifest = await readPublishedEnterpriseGuardManifest();
  const sourceFiles = await readPublishedRuntimeFiles(manifest);
  const prepared = await hookLifecycleDependencies.prepareManagedRuntimeVersion({
    storageRoot,
    sourceManifest: manifest,
    sourceFiles,
  });
  await hookLifecycleDependencies.activateManagedRuntimeVersion(manifest.version, { storageRoot });
  return { versionDir: prepared.versionDir, manifest };
}

export const hookLifecycleDependencies = {
  installManagedHooksForPlatform,
  removeManagedHooksForPlatform,
  inspectManagedHooksForPlatform,
  prepareManagedRuntimeVersion,
  activateManagedRuntimeVersion,
  inspectManagedRuntime,
  cleanUnusedManagedRuntimeVersions,
  ensureManagedRuntimeReady: async (storageRoot?: string) => {
    try {
      return await ensureManagedRuntimeReady(storageRoot);
    } catch {
      return null;
    }
  },
};

/** OpenCode auto-discovers .js plugins; .mjs files are silently ignored. */
export const OPENCODE_PLUGIN_FILE = 'comet-enterprise-guard.js';
const OPENCODE_PLUGIN_ASSET_FILE = 'comet-enterprise-guard.mjs';
export const OPENCODE_RUNNER_FILE = 'comet-enterprise-runner.mjs';
export const OPENCODE_PLUGIN_MARKER = 'comet.enterprise-managed-opencode-guard.v1';

function opencodePluginPaths(baseDir: string, platform: Platform, scope: InstallScope) {
  const platformBase = path.join(baseDir, getPlatformSkillsDir(platform, scope));
  const assetsDir = getAssetsDir();
  return {
    pluginSource: path.join(assetsDir, 'skills', 'comet', 'plugins', OPENCODE_PLUGIN_ASSET_FILE),
    runnerSource: path.join(assetsDir, 'skills', 'comet', 'scripts', OPENCODE_RUNNER_FILE),
    runnerDestination: path.join(platformBase, 'skills', 'comet', 'scripts', OPENCODE_RUNNER_FILE),
    pluginDestination: path.join(platformBase, 'plugins', OPENCODE_PLUGIN_FILE),
  };
}

async function readPluginFile(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function managedPluginFiles(directory: string): Promise<string[]> {
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    const managed: string[] = [];
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const content = await readPluginFile(path.join(directory, entry.name));
      if (content?.includes(OPENCODE_PLUGIN_MARKER)) managed.push(path.join(directory, entry.name));
    }
    return managed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

async function installOpenCodeGuard(
  baseDir: string,
  platform: Platform,
  scope: InstallScope,
): Promise<HookInstallResult> {
  const paths = opencodePluginPaths(baseDir, platform, scope);
  try {
    const existing = await readPluginFile(paths.pluginDestination);
    if (existing && !existing.includes(OPENCODE_PLUGIN_MARKER)) {
      return { status: 'failed', reason: 'managed plugin path contains a user-owned plugin' };
    }
    const duplicate = (await managedPluginFiles(path.dirname(paths.pluginDestination))).filter(
      (filePath) => filePath !== paths.pluginDestination,
    );
    if (duplicate.length > 0) {
      return { status: 'failed', reason: 'another managed OpenCode Guard plugin already exists' };
    }
    await hookLifecycleDependencies.ensureManagedRuntimeReady();
    await copyFile(paths.runnerSource, paths.runnerDestination);
    if (process.platform !== 'win32') {
      try {
        await fs.chmod(paths.runnerDestination, 0o755);
      } catch {
        // ignore
      }
    }
    await copyFile(paths.pluginSource, paths.pluginDestination);
    return { status: 'installed' };
  } catch (error) {
    return { status: 'failed', reason: (error as Error).message };
  }
}

async function inspectOpenCodeGuard(
  baseDir: string,
  platform: Platform,
  scope: InstallScope,
): Promise<HookInspectionResult> {
  const paths = opencodePluginPaths(baseDir, platform, scope);
  try {
    const plugin = await readPluginFile(paths.pluginDestination);
    const managedElsewhere = (await managedPluginFiles(path.dirname(paths.pluginDestination))).some(
      (filePath) => filePath !== paths.pluginDestination,
    );
    if (!plugin && !managedElsewhere) {
      return { present: false };
    }
    const reasons: string[] = [];
    const runner = await readPluginFile(paths.runnerDestination);
    const pluginSource = await readPluginFile(paths.pluginSource);
    const runnerSource = await readPluginFile(paths.runnerSource);
    if (!plugin) {
      reasons.push('managed plugin missing');
    } else if (!plugin.includes(OPENCODE_PLUGIN_MARKER)) {
      return {
        present: false,
        managedPresent: true,
        duplicatePresent: managedElsewhere,
        error: 'managed plugin path contains a user-owned plugin',
      };
    } else if (pluginSource !== null && plugin !== pluginSource) {
      reasons.push('outdated managed plugin runtime');
    }
    if (!runner) reasons.push('managed runner missing');
    else if (runnerSource !== null && runner !== runnerSource) {
      reasons.push('outdated managed runner runtime');
    }
    if (managedElsewhere) reasons.push('duplicate managed OpenCode Guard plugin remains');
    if (reasons.length > 0) {
      return {
        present: Boolean(plugin?.includes(OPENCODE_PLUGIN_MARKER)),
        managedPresent: true,
        duplicatePresent: managedElsewhere,
        error: reasons.join('; '),
      };
    }
    return { present: true };
  } catch (error) {
    return { present: false, managedPresent: true, error: (error as Error).message };
  }
}

async function removeOpenCodeGuard(
  baseDir: string,
  platform: Platform,
  scope: InstallScope,
): Promise<RemovalResult> {
  const paths = opencodePluginPaths(baseDir, platform, scope);
  try {
    const plugin = await readPluginFile(paths.pluginDestination);
    if (!plugin) return { removed: 0, failed: 0 };
    if (!plugin.includes(OPENCODE_PLUGIN_MARKER)) {
      return {
        removed: 0,
        failed: 1,
        reason: 'managed plugin path contains a user-owned plugin',
      };
    }
    const pluginRemoved = await removeFile(paths.pluginDestination);
    const runnerRemoved = await removeManagedRunner(paths);
    return { removed: (pluginRemoved ? 1 : 0) + (runnerRemoved ? 1 : 0), failed: 0 };
  } catch (error) {
    return { removed: 0, failed: 1, reason: (error as Error).message };
  }
}

async function removeManagedRunner(paths: Awaited<ReturnType<typeof opencodePluginPaths>>) {
  const runner = await readPluginFile(paths.runnerDestination);
  if (!runner) return false;
  const runnerSource = await readPluginFile(paths.runnerSource);
  if (runnerSource !== null && runner !== runnerSource) return false;
  return removeFile(paths.runnerDestination);
}

export function enterpriseGatewayHookConfigForPlatform(
  platform: Platform,
): Record<string, HookConfig> {
  return {
    'comet/scripts/comet-enterprise-gateway.mjs': {
      matcher: platform.hookMatcher ?? 'Write|Edit|Bash',
      description: 'Enterprise Guard and Comet workflow enforcement',
      arguments: ['--platform', platform.id],
    },
  };
}

export const enterpriseGatewayHookConfig: Record<string, HookConfig> = {
  'comet/scripts/comet-enterprise-gateway.mjs': {
    matcher: 'Write|Edit|Bash',
    description: 'Enterprise Guard and Comet workflow enforcement',
    arguments: ['--platform', 'claude'],
  },
};

function retiredEnterpriseHookConfigForPlatform(platform: Platform): Record<string, HookConfig> {
  return {
    'comet/scripts/comet-enterprise-hook.mjs': {
      matcher: platform.hookMatcher ?? 'Write|Edit|Bash',
      description: 'Enterprise Guard hard-rule enforcement',
      arguments: ['--platform', platform.id],
    },
  };
}

const ROUTER_HOOK_CONFIG: Record<string, HookConfig> = {
  'comet/scripts/comet-hook-router.mjs': {
    matcher: 'Write|Edit',
    description: 'Route each write to the selected Comet Native or Classic phase guard',
  },
};

function retiredManagedHookConfigsForPlatform(platform: Platform): Record<string, HookConfig> {
  return {
    ...retiredEnterpriseHookConfigForPlatform(platform),
    ...ROUTER_HOOK_CONFIG,
  };
}

function supportsEnterpriseGuard(platform: Platform): boolean {
  return (
    usesEnterpriseGuardPlugin(platform) ||
    (Boolean(platform.supportsHooks) && usesEnterpriseGuardGateway(platform))
  );
}

function unsupportedPlatformReason(platform: Platform): string {
  return `Enterprise Guard uses ${enterpriseGuardCoverage(platform).fallback} on ${platform.name}`;
}

export async function installEnterpriseGuard(
  baseDir: string,
  platform: Platform,
  scope: InstallScope,
): Promise<HookInstallResult> {
  if (!supportsEnterpriseGuard(platform)) {
    return { status: 'skipped', reason: unsupportedPlatformReason(platform) };
  }
  if (usesEnterpriseGuardPlugin(platform)) {
    return installOpenCodeGuard(baseDir, platform, scope);
  }
  await hookLifecycleDependencies.ensureManagedRuntimeReady();
  const gatewayConfig = enterpriseGatewayHookConfigForPlatform(platform);
  let install: HookInstallResult;
  try {
    install = await hookLifecycleDependencies.installManagedHooksForPlatform(
      baseDir,
      platform,
      scope,
      gatewayConfig,
      { allowGlobal: true },
    );
  } catch (err) {
    return { status: 'failed', reason: (err as Error).message };
  }
  if (install.status !== 'installed') return install;

  let cleanup: RemovalResult;
  try {
    cleanup = await hookLifecycleDependencies.removeManagedHooksForPlatform(
      baseDir,
      platform,
      scope,
      retiredManagedHookConfigsForPlatform(platform),
    );
  } catch {
    cleanup = { removed: 0, failed: 1 };
  }
  if (cleanup.failed > 0) {
    return {
      status: 'failed',
      reason: 'enterprise Gateway installed but legacy Hook cleanup failed',
      cleanupFailed: cleanup.failed,
    };
  }
  return install;
}

export async function inspectEnterpriseGuard(
  baseDir: string,
  platform: Platform,
  scope: InstallScope,
): Promise<HookInspectionResult> {
  if (!supportsEnterpriseGuard(platform)) return { present: false };
  if (usesEnterpriseGuardPlugin(platform)) {
    return inspectOpenCodeGuard(baseDir, platform, scope);
  }
  const gatewayConfig = enterpriseGatewayHookConfigForPlatform(platform);
  const gateway = await hookLifecycleDependencies.inspectManagedHooksForPlatform(
    baseDir,
    platform,
    scope,
    gatewayConfig,
  );
  if (gateway.error) return gateway;
  const retired = await hookLifecycleDependencies.inspectManagedHooksForPlatform(
    baseDir,
    platform,
    scope,
    retiredManagedHookConfigsForPlatform(platform),
  );
  if (retired.error) {
    if (retired.present || retired.managedPresent) return { ...gateway, legacyPresent: true };
    return { ...gateway, present: false, error: retired.error };
  }
  const retiredPresent = retired.present || retired.managedPresent || retired.legacyPresent;
  return retiredPresent ? { ...gateway, legacyPresent: true } : gateway;
}

export async function removeEnterpriseGuard(
  baseDir: string,
  platform: Platform,
  scope: InstallScope,
): Promise<RemovalResult> {
  if (!supportsEnterpriseGuard(platform)) return { removed: 0, failed: 0 };
  if (usesEnterpriseGuardPlugin(platform)) {
    return removeOpenCodeGuard(baseDir, platform, scope);
  }
  const gatewayConfig = enterpriseGatewayHookConfigForPlatform(platform);
  const gateway = await hookLifecycleDependencies.removeManagedHooksForPlatform(
    baseDir,
    platform,
    scope,
    gatewayConfig,
  );
  const retired = await hookLifecycleDependencies.removeManagedHooksForPlatform(
    baseDir,
    platform,
    scope,
    retiredEnterpriseHookConfigForPlatform(platform),
  );
  const result = {
    removed: gateway.removed + retired.removed,
    failed: gateway.failed + retired.failed,
  };
  await hookLifecycleDependencies.cleanUnusedManagedRuntimeVersions().catch(() => []);
  return result;
}
