import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { executeEnterpriseGateway } from '../../../domains/enterprise-guard/enterprise-gateway.js';

async function createCometProject(): Promise<string> {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'comet-enterprise-gateway-'));
  await fs.mkdir(path.join(projectRoot, '.comet'), { recursive: true });
  await fs.writeFile(
    path.join(projectRoot, '.comet', 'config.yaml'),
    'schema: comet.project.v1\ndefault_workflow: native\nworkflows: [native]\nnative:\n  artifact_root: docs\n',
  );
  return projectRoot;
}

describe('Enterprise Guard composite gateway', () => {
  it('short-circuits Router when Enterprise Guard denies', async () => {
    const inspectRouter = vi.fn();
    const output = await executeEnterpriseGateway(
      ['--platform', 'claude', '--project-root', '/workspace/comet'],
      JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'rm -rf /' } }),
      { inspectRouter },
    );
    expect(output.exitCode).toBe(2);
    expect(output.stderr).toContain('EG-HARD-RM-001');
    expect(inspectRouter).not.toHaveBeenCalled();
  });

  it('returns Router denial after Guard allows the same raw input', async () => {
    const projectRoot = await createCometProject();
    try {
      const output = await executeEnterpriseGateway(
        ['--platform', 'claude', '--project-root', projectRoot],
        JSON.stringify({
          cwd: projectRoot,
          tool_name: 'Write',
          tool_input: { file_path: 'openspec/changes/demo/tasks.md', content: '- [x] task' },
        }),
        { inspectRouter: vi.fn().mockResolvedValue({ allowed: false, reason: 'phase denied' }) },
      );
      expect(output).toEqual({ exitCode: 2, stdout: '', stderr: 'phase denied\n' });
    } finally {
      await fs.rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('denies HARD input without a Comet project', async () => {
    const inspectRouter = vi.fn();
    const output = await executeEnterpriseGateway(
      ['--platform', 'claude'],
      JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'rm -rf /' } }),
      { inspectRouter },
    );
    expect(output.exitCode).toBe(2);
    expect(output.stdout).toBe('');
    expect(output.stderr).toContain('EG-HARD-RM-001');
    expect(inspectRouter).not.toHaveBeenCalled();
  });

  it('denies harmful Write and Edit input without exposing Hook secrets', async () => {
    const inspectRouter = vi.fn();
    const inputs = [
      {
        tool_name: 'Write',
        tool_input: { file_path: '.env', content: 'TOKEN=value' },
      },
      {
        tool_name: 'Edit',
        tool_input: {
          file_path: 'src/config.ts',
          new_string: `const key = '${'AKIA' + '0'.repeat(16)}';`,
        },
      },
    ];

    for (const input of inputs) {
      const output = await executeEnterpriseGateway(
        ['--platform', 'claude'],
        JSON.stringify(input),
        { inspectRouter },
      );
      expect(output.exitCode).toBe(2);
      expect(output.stdout).toBe('');
      expect(output.stderr).toContain('Enterprise Guard blocked EG-HARD-');
      expect(output.stderr).not.toContain('TOKEN=value');
      expect(output.stderr).not.toContain('AKIA');
    }
    expect(inspectRouter).not.toHaveBeenCalled();
  });

  it('allows safe non-Comet writes without invoking the Router', async () => {
    const inspectRouter = vi.fn();
    const output = await executeEnterpriseGateway(
      ['--platform', 'claude'],
      JSON.stringify({
        tool_name: 'Write',
        tool_input: { file_path: 'src/config.ts', content: 'export const port = 3000;' },
      }),
      { inspectRouter },
    );
    expect(output).toEqual({ exitCode: 0, stdout: '', stderr: '' });
    expect(inspectRouter).not.toHaveBeenCalled();
  });

  it('allows safe PreToolUse input through the Router', async () => {
    const projectRoot = await createCometProject();
    const inspectRouter = vi
      .fn()
      .mockResolvedValue({ allowed: true, reason: 'allowed by workflow' });
    try {
      const output = await executeEnterpriseGateway(
        ['--platform', 'claude', '--project-root', projectRoot],
        JSON.stringify({
          hook_event_name: 'PreToolUse',
          tool_name: 'Write',
          tool_input: { file_path: 'src/config.ts', content: 'export const port = 3000;' },
        }),
        { inspectRouter },
      );
      expect(output).toEqual({ exitCode: 0, stdout: '', stderr: '' });
      expect(inspectRouter).toHaveBeenCalledWith(
        projectRoot,
        expect.objectContaining({ intent: 'write', targets: ['src/config.ts'] }),
      );
    } finally {
      await fs.rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('denies oversized raw input instead of discarding policy context', async () => {
    const inspectRouter = vi.fn();
    const output = await executeEnterpriseGateway(
      ['--platform', 'claude'],
      JSON.stringify({
        tool_name: 'Write',
        tool_input: { file_path: '.env', content: 'x'.repeat(300 * 1024) },
      }),
      { inspectRouter },
    );
    expect(output).toMatchObject({ exitCode: 2, stdout: '' });
    expect(output.stderr).toContain('EG-HARD-INPUT-001');
    expect(inspectRouter).not.toHaveBeenCalled();
  });

  it('rejects malformed arguments and unknown platforms with usage output', async () => {
    const inspectRouter = vi.fn();
    for (const args of [
      [],
      ['--unknown'],
      ['--platform', 'unknown'],
      ['--platform', 'claude', '--project-root', '--platform'],
    ]) {
      const output = await executeEnterpriseGateway(args, '{}', { inspectRouter });
      expect(output.exitCode).toBe(64);
      expect(output.stdout).toBe('');
      expect(output.stderr).toContain(
        'Usage: comet-enterprise-gateway --platform <platform-id> [--project-root <project-root>]',
      );
    }
    expect(inspectRouter).not.toHaveBeenCalled();
    await expect(executeEnterpriseGateway([], '{}')).resolves.toMatchObject({
      exitCode: 64,
      stderr: expect.stringContaining('--platform is required'),
    });
    await expect(executeEnterpriseGateway(['--unknown'], '{}')).resolves.toMatchObject({
      exitCode: 64,
      stderr: expect.stringContaining('Unknown argument: --unknown'),
    });
    await expect(executeEnterpriseGateway(['--platform', 'unknown'], '{}')).resolves.toMatchObject({
      exitCode: 64,
      stderr: expect.stringContaining('unsupported Hook platform: unknown'),
    });
    await expect(
      executeEnterpriseGateway(['--platform', 'claude', '--project-root', '--platform'], '{}'),
    ).resolves.toMatchObject({
      exitCode: 64,
      stderr: expect.stringContaining('--project-root requires a value'),
    });
  });

  it('treats whitelisted platforms without a Guard codec as usage errors', async () => {
    const inspectRouter = vi.fn();
    const output = await executeEnterpriseGateway(
      ['--platform', 'windsurf'],
      JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'rm -rf /' } }),
      { inspectRouter },
    );
    expect(output.exitCode).toBe(64);
    expect(output.stdout).toBe('');
    expect(output.stderr).toContain(
      'Enterprise Guard input codec is unavailable for platform: windsurf',
    );
    expect(inspectRouter).not.toHaveBeenCalled();
  });

  it('fails closed when Router inspection rejects', async () => {
    const projectRoot = await createCometProject();
    try {
      const output = await executeEnterpriseGateway(
        ['--platform', 'claude', '--project-root', projectRoot],
        JSON.stringify({
          tool_name: 'Write',
          tool_input: { file_path: 'src/config.ts', content: 'export const port = 3000;' },
        }),
        { inspectRouter: vi.fn().mockRejectedValue(new Error('inspection failed')) },
      );
      expect(output.exitCode).toBe(2);
      expect(output.stderr).toContain('Comet Hook Router failed closed during project discovery');
    } finally {
      await fs.rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('fails closed when Enterprise Guard evaluation rejects', async () => {
    const inspectRouter = vi.fn();
    const output = await executeEnterpriseGateway(
      ['--platform', 'claude'],
      JSON.stringify({
        tool_name: 'Write',
        tool_input: { file_path: 'src/config.ts', content: 'export const port = 3000;' },
      }),
      {
        evaluateGuard: vi.fn().mockRejectedValue(new Error('guard unavailable')),
        inspectRouter,
      },
    );

    expect(output).toEqual({
      exitCode: 2,
      stdout: '',
      stderr: 'Enterprise Guard failed closed: internal evaluation unavailable\n',
    });
    expect(inspectRouter).not.toHaveBeenCalled();
  });
});
