import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  activateManagedRuntimeVersion,
  cleanUnusedManagedRuntimeVersions,
  computeSha256,
  ENTERPRISE_GUARD_BUILTIN_RULES,
  ENTERPRISE_GUARD_MANIFEST_FILE,
  ENTERPRISE_GUARD_SCHEMA_VERSION,
  inspectManagedRuntime,
  prepareManagedRuntimeVersion,
  removeManagedRuntimePointer,
  resolveEnterpriseGuardStorageRoot,
  resolveManagedCurrentPointerPath,
  resolveManagedVersionDir,
  type EnterpriseGuardManifest,
} from '../../../domains/enterprise-guard/managed-runtime.js';

describe('enterprise guard managed-runtime', () => {
  let temporaryRoot: string;

  beforeEach(async () => {
    temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'comet-managed-runtime-test-'));
  });

  afterEach(async () => {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  });

  function createSampleManifest(version = '1.0.0'): EnterpriseGuardManifest {
    const gatewayContent = '#!/usr/bin/env node\nconsole.log("gateway");\n';
    const runnerContent = '#!/usr/bin/env node\nconsole.log("runner");\n';
    const pluginContent = 'export default function plugin() {};\n';

    return {
      schemaVersion: ENTERPRISE_GUARD_SCHEMA_VERSION,
      version,
      compatibleCliRange: '>=1.0.0',
      rules: ENTERPRISE_GUARD_BUILTIN_RULES,
      files: {
        gateway: {
          fileName: 'comet-enterprise-gateway.mjs',
          sha256: computeSha256(gatewayContent),
          executable: true,
        },
        runner: {
          fileName: 'comet-enterprise-runner.mjs',
          sha256: computeSha256(runnerContent),
          executable: true,
        },
        opencodePlugin: {
          fileName: 'comet-enterprise-guard.mjs',
          sha256: computeSha256(pluginContent),
          executable: false,
        },
      },
    };
  }

  function createSampleFiles(): Record<string, string> {
    return {
      gateway: '#!/usr/bin/env node\nconsole.log("gateway");\n',
      runner: '#!/usr/bin/env node\nconsole.log("runner");\n',
      opencodePlugin: 'export default function plugin() {};\n',
    };
  }

  it('resolves storage root and paths correctly', () => {
    const root = resolveEnterpriseGuardStorageRoot(temporaryRoot);
    expect(root).toBe(path.resolve(temporaryRoot));
    expect(resolveManagedVersionDir('0.4.0', temporaryRoot)).toBe(
      path.join(temporaryRoot, 'versions', '0.4.0'),
    );
    expect(resolveManagedCurrentPointerPath(temporaryRoot)).toBe(
      path.join(temporaryRoot, 'current.json'),
    );
  });

  it('atomically prepares a version directory with verified digest integrity', async () => {
    const manifest = createSampleManifest('0.4.0');
    const sourceFiles = createSampleFiles();

    const prepared = await prepareManagedRuntimeVersion({
      storageRoot: temporaryRoot,
      sourceManifest: manifest,
      sourceFiles,
    });

    expect(prepared.reused).toBe(false);
    expect(prepared.versionDir).toBe(path.join(temporaryRoot, 'versions', '0.4.0'));

    // Verify files exist in destination
    const writtenManifest = JSON.parse(
      await fs.readFile(path.join(prepared.versionDir, ENTERPRISE_GUARD_MANIFEST_FILE), 'utf8'),
    ) as EnterpriseGuardManifest;
    expect(writtenManifest.version).toBe('0.4.0');
    expect(writtenManifest.rules).toEqual(ENTERPRISE_GUARD_BUILTIN_RULES);

    for (const entry of Object.values(manifest.files)) {
      const fileContent = await fs.readFile(path.join(prepared.versionDir, entry.fileName), 'utf8');
      expect(computeSha256(fileContent)).toBe(entry.sha256);
    }

    // No leftover temporary directories in versions
    const versionsEntries = await fs.readdir(path.join(temporaryRoot, 'versions'));
    expect(versionsEntries).toEqual(['0.4.0']);

    // Re-running preparation for same intact version should reuse it
    const repeated = await prepareManagedRuntimeVersion({
      storageRoot: temporaryRoot,
      sourceManifest: manifest,
      sourceFiles,
    });
    expect(repeated.reused).toBe(true);
  });

  it('fails safely and cleans up temporary directory if digest check fails during preparation', async () => {
    const manifest = createSampleManifest('0.4.0');
    const sourceFiles = createSampleFiles();
    // Tamper source content so sha256 won't match manifest
    sourceFiles.gateway = 'corrupted content';

    await expect(
      prepareManagedRuntimeVersion({
        storageRoot: temporaryRoot,
        sourceManifest: manifest,
        sourceFiles,
      }),
    ).rejects.toThrow(/Integrity check failed before activation/u);

    // Ensure versions/0.4.0 does not exist and no temporary directories left
    const versionsDir = path.join(temporaryRoot, 'versions');
    const entries = await fs.readdir(versionsDir);
    expect(entries).toEqual([]);
  });

  it('atomically activates a prepared version and updates current.json', async () => {
    const manifest = createSampleManifest('0.4.0');
    const sourceFiles = createSampleFiles();
    await prepareManagedRuntimeVersion({
      storageRoot: temporaryRoot,
      sourceManifest: manifest,
      sourceFiles,
    });

    const pointer = await activateManagedRuntimeVersion('0.4.0', { storageRoot: temporaryRoot });
    expect(pointer.activeVersion).toBe('0.4.0');
    expect(pointer.activePath).toBe(path.join(temporaryRoot, 'versions', '0.4.0'));
    expect(pointer.schemaVersion).toBe(ENTERPRISE_GUARD_SCHEMA_VERSION);
    expect(pointer.manifestDigest.startsWith('sha256:')).toBe(true);

    const pointerOnDisk = JSON.parse(
      await fs.readFile(resolveManagedCurrentPointerPath(temporaryRoot), 'utf8'),
    );
    expect(pointerOnDisk.activeVersion).toBe('0.4.0');
  });

  it('inspects runtime health across missing, healthy, outdated and tampered states', async () => {
    // 1. Missing state
    const missing = await inspectManagedRuntime({ storageRoot: temporaryRoot });
    expect(missing.status).toBe('missing');
    expect(missing.pointerPresent).toBe(false);

    // 2. Prepare and activate -> Healthy state
    const manifest1 = createSampleManifest('0.4.0');
    await prepareManagedRuntimeVersion({
      storageRoot: temporaryRoot,
      sourceManifest: manifest1,
      sourceFiles: createSampleFiles(),
    });
    await activateManagedRuntimeVersion('0.4.0', { storageRoot: temporaryRoot });

    const healthy = await inspectManagedRuntime({
      storageRoot: temporaryRoot,
      expectedVersion: '0.4.0',
    });
    expect(healthy.status).toBe('healthy');
    expect(healthy.manifestDigestMatch).toBe(true);
    expect(healthy.filesIntegrityMatch).toBe(true);

    // 3. Outdated state
    const outdated = await inspectManagedRuntime({
      storageRoot: temporaryRoot,
      expectedVersion: '0.5.0',
    });
    expect(outdated.status).toBe('outdated');
    expect(outdated.reasons.some((r) => r.includes('outdated runtime version'))).toBe(true);

    // 4. Tampered state (modify one file)
    await fs.writeFile(
      path.join(healthy.activePath!, 'comet-enterprise-gateway.mjs'),
      'malicious edit',
      'utf8',
    );
    const tampered = await inspectManagedRuntime({
      storageRoot: temporaryRoot,
      expectedVersion: '0.4.0',
    });
    expect(tampered.status).toBe('tampered');
    expect(tampered.filesIntegrityMatch).toBe(false);
  });

  it('cleans up unused runtime versions while preserving active and specified versions', async () => {
    const files = createSampleFiles();
    for (const v of ['0.2.0', '0.3.0', '0.4.0']) {
      await prepareManagedRuntimeVersion({
        storageRoot: temporaryRoot,
        sourceManifest: createSampleManifest(v),
        sourceFiles: files,
      });
    }

    // Active version is 0.4.0
    await activateManagedRuntimeVersion('0.4.0', { storageRoot: temporaryRoot });

    // Clean, but keep 0.3.0 as rollback backup
    const removed = await cleanUnusedManagedRuntimeVersions({
      storageRoot: temporaryRoot,
      keepVersions: ['0.3.0'],
    });

    expect(removed).toEqual(['0.2.0']);
    const remaining = await fs.readdir(path.join(temporaryRoot, 'versions'));
    expect(remaining.sort()).toEqual(['0.3.0', '0.4.0'].sort());
  });

  it('removes pointer on pointer cleanup', async () => {
    const manifest = createSampleManifest('0.4.0');
    await prepareManagedRuntimeVersion({
      storageRoot: temporaryRoot,
      sourceManifest: manifest,
      sourceFiles: createSampleFiles(),
    });
    await activateManagedRuntimeVersion('0.4.0', { storageRoot: temporaryRoot });

    const pointerPath = resolveManagedCurrentPointerPath(temporaryRoot);
    expect(await fs.stat(pointerPath)).toBeDefined();

    const removed = await removeManagedRuntimePointer({ storageRoot: temporaryRoot });
    expect(removed).toBe(true);
    await expect(fs.stat(pointerPath)).rejects.toThrow();

    // Repeated removal returns false without crashing
    expect(await removeManagedRuntimePointer({ storageRoot: temporaryRoot })).toBe(false);
  });
});
