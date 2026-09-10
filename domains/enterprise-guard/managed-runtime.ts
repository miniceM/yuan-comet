import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const ENTERPRISE_GUARD_SCHEMA_VERSION = 1;
export const ENTERPRISE_GUARD_MANIFEST_FILE = 'enterprise-guard-manifest.json';
export const ENTERPRISE_GUARD_CURRENT_POINTER_FILE = 'current.json';

export const ENTERPRISE_GUARD_BUILTIN_RULES = [
  'EG-HARD-INPUT-001',
  'EG-HARD-ENV-001',
  'EG-HARD-SECRET-001',
  'EG-HARD-RM-001',
  'EG-HARD-GIT-001',
  'EG-HARD-AUDIT-001',
  'EG-HARD-INTEGRITY-001',
] as const;

export interface EnterpriseGuardManifestFileEntry {
  fileName: string;
  sha256: string;
  executable?: boolean;
}

export interface EnterpriseGuardManifest {
  schemaVersion: number;
  version: string;
  compatibleCliRange: string;
  rules: readonly string[];
  files: Record<string, EnterpriseGuardManifestFileEntry>;
}

export interface EnterpriseGuardCurrentPointer {
  schemaVersion: number;
  activeVersion: string;
  activePath: string;
  installedAt: string;
  manifestDigest: string;
}

export interface ManagedRuntimeInspectionResult {
  status: 'healthy' | 'missing' | 'outdated' | 'tampered' | 'corrupted';
  activeVersion?: string;
  activePath?: string;
  pointerPresent: boolean;
  manifestPresent: boolean;
  manifestDigestMatch: boolean;
  schemaCompatible: boolean;
  filesComplete: boolean;
  filesIntegrityMatch: boolean;
  permissionsValid: boolean;
  reasons: string[];
}

export function computeSha256(content: Buffer | string): string {
  const buffer = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
  return createHash('sha256').update(buffer).digest('hex');
}

export function resolveEnterpriseGuardStorageRoot(overrideRoot?: string): string {
  if (overrideRoot && overrideRoot.trim()) return path.resolve(overrideRoot);
  const envOverride = process.env.COMET_ENTERPRISE_GUARD_RUNTIME_ROOT;
  if (envOverride && envOverride.trim()) return path.resolve(envOverride);
  return path.join(os.homedir(), '.comet', 'enterprise-guard');
}

export function resolveManagedVersionDir(version: string, storageRoot?: string): string {
  return path.join(resolveEnterpriseGuardStorageRoot(storageRoot), 'versions', version);
}

export function resolveManagedCurrentPointerPath(storageRoot?: string): string {
  return path.join(
    resolveEnterpriseGuardStorageRoot(storageRoot),
    ENTERPRISE_GUARD_CURRENT_POINTER_FILE,
  );
}

export async function readJsonIfExists<T>(filePath: string): Promise<T | null> {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function atomicWriteFile(targetPath: string, content: string | Buffer): Promise<void> {
  const dir = path.dirname(targetPath);
  await fs.mkdir(dir, { recursive: true });
  const temporaryPath = `${targetPath}.tmp.${process.pid}.${randomUUID()}`;
  await fs.writeFile(temporaryPath, content);
  await fs.rename(temporaryPath, targetPath);
}

/**
 * Verify that all files listed in manifest exist in the directory and match their expected sha256.
 */
export async function verifyRuntimeDirectoryIntegrity(
  directory: string,
  manifest: EnterpriseGuardManifest,
): Promise<{ valid: boolean; reasons: string[] }> {
  const reasons: string[] = [];
  for (const [key, entry] of Object.entries(manifest.files)) {
    const filePath = path.join(directory, entry.fileName);
    try {
      const content = await fs.readFile(filePath);
      const actualHash = computeSha256(content);
      if (actualHash !== entry.sha256) {
        reasons.push(
          `file ${entry.fileName} (${key}) sha256 mismatch: expected ${entry.sha256}, got ${actualHash}`,
        );
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        reasons.push(`file ${entry.fileName} (${key}) is missing`);
      } else {
        reasons.push(`file ${entry.fileName} (${key}) read error: ${(error as Error).message}`);
      }
    }
  }
  return { valid: reasons.length === 0, reasons };
}

export interface PrepareManagedRuntimeOptions {
  storageRoot?: string;
  sourceManifest: EnterpriseGuardManifest;
  sourceFiles: Record<string, Buffer | string>; // key -> file content
}

/**
 * Atomically prepare a managed version directory.
 * Writes to a temporary directory, validates all digests, and renames to final versions/<version>.
 * Prevents partial writes or broken installations on interruption.
 */
export async function prepareManagedRuntimeVersion(
  options: PrepareManagedRuntimeOptions,
): Promise<{ versionDir: string; reused: boolean }> {
  const { storageRoot, sourceManifest, sourceFiles } = options;
  const version = sourceManifest.version;
  const finalDir = resolveManagedVersionDir(version, storageRoot);

  // Check if finalDir already exists and is completely intact
  const existingManifest = await readJsonIfExists<EnterpriseGuardManifest>(
    path.join(finalDir, ENTERPRISE_GUARD_MANIFEST_FILE),
  );
  if (existingManifest && existingManifest.version === version) {
    const check = await verifyRuntimeDirectoryIntegrity(finalDir, existingManifest);
    if (check.valid) {
      return { versionDir: finalDir, reused: true };
    }
  }

  const versionsRoot = path.dirname(finalDir);
  await fs.mkdir(versionsRoot, { recursive: true });
  const temporaryDir = path.join(versionsRoot, `${version}.tmp.${process.pid}.${randomUUID()}`);
  await fs.mkdir(temporaryDir, { recursive: true });

  try {
    // 1. Write files
    for (const [key, entry] of Object.entries(sourceManifest.files)) {
      const content = sourceFiles[key];
      if (content === undefined) {
        throw new Error(
          `Missing source file content for runtime entry "${key}" (${entry.fileName})`,
        );
      }
      const destPath = path.join(temporaryDir, entry.fileName);
      await fs.writeFile(destPath, content);
      if (entry.executable && process.platform !== 'win32') {
        await fs.chmod(destPath, 0o755);
      }
    }

    // 2. Write manifest
    await fs.writeFile(
      path.join(temporaryDir, ENTERPRISE_GUARD_MANIFEST_FILE),
      JSON.stringify(sourceManifest, null, 2) + '\n',
      'utf8',
    );

    // 3. Verify digests in temporaryDir before atomic rename
    const verify = await verifyRuntimeDirectoryIntegrity(temporaryDir, sourceManifest);
    if (!verify.valid) {
      throw new Error(`Integrity check failed before activation: ${verify.reasons.join('; ')}`);
    }

    // 4. If destination directory already exists (e.g. corrupted previous attempt), remove it cleanly first
    try {
      await fs.rm(finalDir, { recursive: true, force: true });
    } catch {
      // ignore
    }

    // 5. Atomic switch
    await fs.rename(temporaryDir, finalDir);
    return { versionDir: finalDir, reused: false };
  } catch (error) {
    // Clean up temporary directory on failure
    try {
      await fs.rm(temporaryDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
    throw error;
  }
}

/**
 * Atomically update the current pointer file to activate a version.
 */
export async function activateManagedRuntimeVersion(
  version: string,
  options?: { storageRoot?: string },
): Promise<EnterpriseGuardCurrentPointer> {
  const versionDir = resolveManagedVersionDir(version, options?.storageRoot);
  const manifestPath = path.join(versionDir, ENTERPRISE_GUARD_MANIFEST_FILE);
  const manifestRaw = await fs.readFile(manifestPath, 'utf8');

  const pointer: EnterpriseGuardCurrentPointer = {
    schemaVersion: ENTERPRISE_GUARD_SCHEMA_VERSION,
    activeVersion: version,
    activePath: versionDir,
    installedAt: new Date().toISOString(),
    manifestDigest: `sha256:${computeSha256(manifestRaw)}`,
  };

  const pointerPath = resolveManagedCurrentPointerPath(options?.storageRoot);
  await atomicWriteFile(pointerPath, JSON.stringify(pointer, null, 2) + '\n');
  return pointer;
}

/**
 * Inspect the current managed runtime installation against expected version and manifest.
 */
export async function inspectManagedRuntime(options?: {
  storageRoot?: string;
  expectedVersion?: string;
  expectedManifest?: EnterpriseGuardManifest;
}): Promise<ManagedRuntimeInspectionResult> {
  const reasons: string[] = [];
  const pointerPath = resolveManagedCurrentPointerPath(options?.storageRoot);
  const pointer = await readJsonIfExists<EnterpriseGuardCurrentPointer>(pointerPath);

  if (!pointer) {
    return {
      status: 'missing',
      pointerPresent: false,
      manifestPresent: false,
      manifestDigestMatch: false,
      schemaCompatible: false,
      filesComplete: false,
      filesIntegrityMatch: false,
      permissionsValid: false,
      reasons: ['managed runtime pointer (current.json) is missing'],
    };
  }

  const schemaCompatible = pointer.schemaVersion === ENTERPRISE_GUARD_SCHEMA_VERSION;
  if (!schemaCompatible) {
    reasons.push(
      `unsupported schema version ${pointer.schemaVersion}; expected ${ENTERPRISE_GUARD_SCHEMA_VERSION}`,
    );
  }

  const versionDir =
    pointer.activePath || resolveManagedVersionDir(pointer.activeVersion, options?.storageRoot);
  const manifestPath = path.join(versionDir, ENTERPRISE_GUARD_MANIFEST_FILE);
  let manifest: EnterpriseGuardManifest | null = null;
  let manifestRaw = '';

  try {
    manifestRaw = await fs.readFile(manifestPath, 'utf8');
    manifest = JSON.parse(manifestRaw) as EnterpriseGuardManifest;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      reasons.push(`managed version manifest is missing: ${manifestPath}`);
    } else {
      reasons.push(`managed version manifest is corrupted: ${(err as Error).message}`);
    }
  }

  const manifestPresent = Boolean(manifest);
  let manifestDigestMatch = true;
  if (manifestRaw && pointer.manifestDigest) {
    const actualManifestDigest = `sha256:${computeSha256(manifestRaw)}`;
    if (actualManifestDigest !== pointer.manifestDigest) {
      manifestDigestMatch = false;
      reasons.push(
        `manifest digest mismatch: expected ${pointer.manifestDigest}, got ${actualManifestDigest}`,
      );
    }
  }

  let filesComplete = true;
  let filesIntegrityMatch = true;
  let permissionsValid = true;

  const targetManifest = manifest ?? options?.expectedManifest;
  if (targetManifest) {
    for (const [key, entry] of Object.entries(targetManifest.files)) {
      const filePath = path.join(versionDir, entry.fileName);
      try {
        const stats = await fs.stat(filePath);
        if (!stats.isFile()) {
          filesComplete = false;
          reasons.push(`managed file is not a regular file: ${entry.fileName}`);
          continue;
        }
        if (entry.executable && process.platform !== 'win32') {
          const mode = stats.mode & 0o777;
          if ((mode & 0o111) === 0) {
            permissionsValid = false;
            reasons.push(`managed executable file is not executable: ${entry.fileName}`);
          }
        }
        const content = await fs.readFile(filePath);
        const actualHash = computeSha256(content);
        if (actualHash !== entry.sha256) {
          filesIntegrityMatch = false;
          reasons.push(`file sha256 mismatch for ${entry.fileName} (${key})`);
        }
      } catch (err) {
        filesComplete = false;
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          reasons.push(`managed file missing: ${entry.fileName}`);
        } else {
          reasons.push(`unable to inspect file ${entry.fileName}: ${(err as Error).message}`);
        }
      }
    }
  } else {
    filesComplete = false;
    filesIntegrityMatch = false;
  }

  const isOutdated = Boolean(
    options?.expectedVersion && pointer.activeVersion !== options.expectedVersion,
  );
  if (isOutdated) {
    reasons.push(
      `outdated runtime version ${pointer.activeVersion}; expected ${options!.expectedVersion}`,
    );
  }

  let status: ManagedRuntimeInspectionResult['status'] = 'healthy';
  if (!manifestPresent || !filesComplete) {
    status = 'missing';
  } else if (!manifestDigestMatch || !filesIntegrityMatch) {
    status = 'tampered';
  } else if (!schemaCompatible || !permissionsValid) {
    status = 'corrupted';
  } else if (isOutdated) {
    status = 'outdated';
  }

  return {
    status,
    activeVersion: pointer.activeVersion,
    activePath: versionDir,
    pointerPresent: true,
    manifestPresent,
    manifestDigestMatch,
    schemaCompatible,
    filesComplete,
    filesIntegrityMatch,
    permissionsValid,
    reasons,
  };
}

/**
 * Remove obsolete runtime versions while preserving the active version.
 */
export async function cleanUnusedManagedRuntimeVersions(options?: {
  storageRoot?: string;
  keepVersions?: readonly string[];
}): Promise<string[]> {
  const root = resolveEnterpriseGuardStorageRoot(options?.storageRoot);
  const versionsDir = path.join(root, 'versions');
  const removed: string[] = [];

  const pointer = await readJsonIfExists<EnterpriseGuardCurrentPointer>(
    path.join(root, ENTERPRISE_GUARD_CURRENT_POINTER_FILE),
  );
  const activeVersion = pointer?.activeVersion;
  const keep = new Set<string>([...(options?.keepVersions ?? [])]);
  if (activeVersion) keep.add(activeVersion);

  try {
    const entries = await fs.readdir(versionsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (!keep.has(entry.name)) {
        await fs.rm(path.join(versionsDir, entry.name), { recursive: true, force: true });
        removed.push(entry.name);
      }
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  return removed;
}

/**
 * Remove managed runtime pointer and optionally the entire storage root if requested.
 */
export async function removeManagedRuntimePointer(options?: {
  storageRoot?: string;
  removeEntireRoot?: boolean;
}): Promise<boolean> {
  const root = resolveEnterpriseGuardStorageRoot(options?.storageRoot);
  if (options?.removeEntireRoot) {
    try {
      await fs.rm(root, { recursive: true, force: true });
      return true;
    } catch {
      return false;
    }
  }
  const pointerPath = resolveManagedCurrentPointerPath(options?.storageRoot);
  try {
    await fs.unlink(pointerPath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}
