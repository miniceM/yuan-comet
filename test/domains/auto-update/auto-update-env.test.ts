import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  inspectInstallationIdentity,
  isDevSourceWorktree,
  isGlobalPackageRoot,
  resolveInstallationId,
} from '../../../domains/auto-update/auto-update-env.js';

describe('auto-update-env', () => {
  it('generates deterministic installationId for the same paths', () => {
    const pkgRoot = '/tmp/fake/package/root';
    const id1 = resolveInstallationId(pkgRoot, '/usr/local/bin/node');
    const id2 = resolveInstallationId(pkgRoot, '/usr/local/bin/node');
    expect(id1).toBe(id2);
    expect(id1.length).toBe(16);
  });

  it('generates different installationId for different Node executables or roots', () => {
    const id1 = resolveInstallationId('/tmp/root1', '/usr/bin/node');
    const id2 = resolveInstallationId('/tmp/root2', '/usr/bin/node');
    const id3 = resolveInstallationId('/tmp/root1', '/opt/homebrew/bin/node');
    expect(id1).not.toBe(id2);
    expect(id1).not.toBe(id3);
  });

  it('correctly identifies actual Comet source worktree as development environment', () => {
    const repoRoot = path.resolve(__dirname, '../../..');
    expect(isDevSourceWorktree(repoRoot)).toBe(true);

    const identity = inspectInstallationIdentity(repoRoot);
    expect(identity.isDevWorktree).toBe(true);
    expect(identity.isGlobal).toBe(false);
  });

  it('does NOT misidentify user project (with git and tsconfig) as Comet development environment', () => {
    const tmpDir = path.join(
      os.tmpdir(),
      `user-project-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    fs.mkdirSync(tmpDir, { recursive: true });
    try {
      // 模拟普通用户的项目
      fs.writeFileSync(
        path.join(tmpDir, 'package.json'),
        JSON.stringify({ name: 'my-business-app' }),
      );
      fs.writeFileSync(path.join(tmpDir, 'tsconfig.json'), '{}');
      fs.mkdirSync(path.join(tmpDir, '.git'));

      expect(isDevSourceWorktree(tmpDir)).toBe(false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('recognizes global node_modules package as global package', () => {
    const fakeGlobalDir = path.join(os.tmpdir(), `global-install-${Date.now()}`);
    const pkgDir = path.join(fakeGlobalDir, 'lib', 'node_modules', '@cli-tools', 'yuan-comet');
    fs.mkdirSync(pkgDir, { recursive: true });
    try {
      fs.writeFileSync(
        path.join(pkgDir, 'package.json'),
        JSON.stringify({ name: '@cli-tools/yuan-comet', version: '0.4.0' }),
      );
      expect(isGlobalPackageRoot(pkgDir)).toBe(true);
    } finally {
      fs.rmSync(fakeGlobalDir, { recursive: true, force: true });
    }
  });

  it('identifies project local node_modules dependency as non-global', () => {
    const fakeProjectDir = path.join(os.tmpdir(), `local-project-${Date.now()}`);
    const localPkgDir = path.join(fakeProjectDir, 'node_modules', '@cli-tools', 'yuan-comet');
    fs.mkdirSync(localPkgDir, { recursive: true });
    try {
      fs.writeFileSync(
        path.join(fakeProjectDir, 'package.json'),
        JSON.stringify({
          name: 'host-app',
          dependencies: { '@cli-tools/yuan-comet': '^0.4.0' },
        }),
      );
      fs.writeFileSync(
        path.join(localPkgDir, 'package.json'),
        JSON.stringify({ name: '@cli-tools/yuan-comet', version: '0.4.0' }),
      );

      expect(isGlobalPackageRoot(localPkgDir)).toBe(false);
    } finally {
      fs.rmSync(fakeProjectDir, { recursive: true, force: true });
    }
  });
});
