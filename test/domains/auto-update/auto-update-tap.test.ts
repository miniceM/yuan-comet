import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

describe('auto-update-tap', () => {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
  const cometBin = path.join(repoRoot, 'bin', 'comet.js');

  it('runs workflow resolve and outputs valid JSON without being affected by auto-update tap', async () => {
    // 执行 comet workflow resolve . --json
    const child = spawn(process.execPath, [cometBin, 'workflow', 'resolve', repoRoot, '--json'], {
      cwd: repoRoot,
      env: { ...process.env, COMET_NO_AUTO_UPDATE: '1' }, // 开发仓库下测试
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += String(d)));
    child.stderr.on('data', (d) => (stderr += String(d)));

    const exitCode = await new Promise<number>((resolve) => child.on('close', resolve));

    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.schema).toBe('comet.workflow-resolution.v1');
    expect(parsed.workflow).toBeDefined();
  });

  it('does NOT trigger or crash on workflow resolve --help', async () => {
    const child = spawn(process.execPath, [cometBin, 'workflow', 'resolve', '--help'], {
      cwd: repoRoot,
    });

    let stdout = '';
    child.stdout.on('data', (d) => (stdout += String(d)));
    const exitCode = await new Promise<number>((resolve) => child.on('close', resolve));

    expect(exitCode).toBe(0);
    expect(stdout).toContain('Usage: comet workflow resolve');
  });

  it('preserves error exitCode when workflow resolve fails on invalid arguments', async () => {
    const child = spawn(
      process.execPath,
      [cometBin, 'workflow', 'resolve', '--unknown-invalid-arg'],
      {
        cwd: repoRoot,
      },
    );

    const exitCode = await new Promise<number>((resolve) => child.on('close', resolve));
    expect(exitCode).not.toBe(0);
  });

  it('runs Commander route with --activate and outputs valid JSON', async () => {
    const child = spawn(
      process.execPath,
      [cometBin, 'workflow', 'resolve', repoRoot, '--activate', '--json'],
      {
        cwd: repoRoot,
        env: { ...process.env, COMET_NO_AUTO_UPDATE: '1' },
      },
    );

    let stdout = '';
    child.stdout.on('data', (d) => (stdout += String(d)));
    const exitCode = await new Promise<number>((resolve) => child.on('close', resolve));

    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.schema).toBe('comet.workflow-resolution.v1');
  });
});
