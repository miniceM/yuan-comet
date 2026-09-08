import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'child_process';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

vi.mock('child_process', () => ({
  execFileSync: vi.fn(),
}));

const mockedExecFileSync = vi.mocked(execFileSync);

describe('codebase-memory integration', () => {
  let projectPath: string;
  let homeDir: string;
  let indexed = false;

  beforeEach(async () => {
    projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'comet-cbm-project-'));
    homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'comet-cbm-home-'));
    indexed = false;
    vi.resetAllMocks();
    vi.resetModules();
    mockedExecFileSync.mockImplementation((command: unknown, args?: unknown) => {
      const cmd = String(command);
      const commandArgs = Array.isArray(args) ? args.map(String) : [];
      if ((cmd === 'which' || cmd === 'where') && commandArgs[0] === 'codebase-memory-mcp') {
        return Buffer.from('/usr/local/bin/codebase-memory-mcp');
      }
      if (commandArgs[0] === '--version') return Buffer.from('0.8.1');
      if (commandArgs[0] === 'cli' && commandArgs[1] === 'list_projects') {
        return JSON.stringify({
          projects: indexed
            ? [
                {
                  id: 'project-1',
                  repo_path: path.resolve(projectPath),
                  status: 'ready',
                },
              ]
            : [],
        });
      }
      if (commandArgs[0] === 'cli' && commandArgs[1] === 'index_repository') {
        indexed = true;
      }
      return Buffer.from('ok');
    });
  });

  afterEach(async () => {
    await fs.rm(projectPath, { recursive: true, force: true });
    await fs.rm(homeDir, { recursive: true, force: true });
  });

  it('does not inspect or index when setup is skipped', async () => {
    const { setupCodebaseMemory } = await import('../../../domains/code-intelligence/index.js');
    const result = await setupCodebaseMemory({
      projectPath,
      scope: 'project',
      action: 'skip',
      platformIds: ['claude'],
      homeDir,
      quiet: true,
    });

    expect(result).toMatchObject({
      requested: 'skip',
      status: 'skipped',
      cliStatus: 'skipped',
      indexStatus: 'skipped',
    });
    expect(mockedExecFileSync).not.toHaveBeenCalled();
  });

  it('merges a project JSONC MCP entry without removing unrelated services or comments', async () => {
    const configPath = path.join(projectPath, '.mcp.json');
    await fs.writeFile(
      configPath,
      `{
  // User-owned server
  "mcpServers": { "other": { "command": "other-server" } }
}
`,
    );

    const { setupCodebaseMemory } = await import('../../../domains/code-intelligence/index.js');
    const result = await setupCodebaseMemory({
      projectPath,
      scope: 'project',
      action: 'install',
      platformIds: ['claude'],
      homeDir,
      quiet: true,
    });

    const output = await fs.readFile(configPath, 'utf8');
    expect(result).toMatchObject({
      status: 'installed',
      cliStatus: 'installed',
      indexStatus: 'ready',
      configuration: 'installed',
    });
    expect(output).toContain('// User-owned server');
    expect(output).toContain('"other"');
    expect(output).toContain('"codebase-memory-mcp"');
    expect(output).toContain('/usr/local/bin/codebase-memory-mcp');
  });

  it('keeps global setup from indexing the calling project', async () => {
    const { setupCodebaseMemory } = await import('../../../domains/code-intelligence/index.js');
    const result = await setupCodebaseMemory({
      projectPath,
      scope: 'global',
      action: 'install',
      platformIds: ['claude'],
      homeDir,
      quiet: true,
    });

    expect(result).toMatchObject({
      status: 'installed',
      indexStatus: 'not_applicable',
      freshness: 'not_applicable',
    });
    expect(
      mockedExecFileSync.mock.calls.some(([, args]) => {
        const commandArgs = Array.isArray(args) ? args.map(String) : [];
        return commandArgs.includes('index_repository');
      }),
    ).toBe(false);
  });

  it('does not overwrite a conflicting named MCP entry', async () => {
    const configPath = path.join(projectPath, '.mcp.json');
    const original = JSON.stringify(
      { mcpServers: { 'codebase-memory-mcp': { command: 'user-owned-server' } } },
      null,
      2,
    );
    await fs.writeFile(configPath, original);

    const { setupCodebaseMemory } = await import('../../../domains/code-intelligence/index.js');
    const result = await setupCodebaseMemory({
      projectPath,
      scope: 'project',
      action: 'install',
      platformIds: ['claude'],
      homeDir,
      quiet: true,
    });

    expect(result.configuration).toBe('failed');
    expect(result.agents).toContainEqual(
      expect.objectContaining({ platform: 'claude', status: 'conflict' }),
    );
    expect(await fs.readFile(configPath, 'utf8')).toBe(original);
  });

  it('uses the Codex TOML scope and preserves existing MCP sections', async () => {
    const configDir = path.join(homeDir, '.codex');
    const configPath = path.join(configDir, 'config.toml');
    await fs.mkdir(configDir, { recursive: true });
    await fs.writeFile(configPath, '# Keep this comment\n[mcp_servers.other]\ncommand = "other"\n');

    const { setupCodebaseMemory } = await import('../../../domains/code-intelligence/index.js');
    const result = await setupCodebaseMemory({
      projectPath,
      scope: 'global',
      action: 'install',
      platformIds: ['codex'],
      homeDir,
      quiet: true,
    });

    const output = await fs.readFile(configPath, 'utf8');
    expect(result.agents).toContainEqual(
      expect.objectContaining({ platform: 'codex', status: 'registered', scope: 'global' }),
    );
    expect(output).toContain('# Keep this comment');
    expect(output).toContain('[mcp_servers."codebase-memory-mcp"]');
  });

  it('initializes an exact project identity without writing Agent configuration', async () => {
    const { setupCodebaseMemory } = await import('../../../domains/code-intelligence/index.js');
    const result = await setupCodebaseMemory({
      projectPath,
      scope: 'project',
      action: 'init',
      platformIds: ['claude'],
      homeDir,
      quiet: true,
    });

    expect(result).toMatchObject({ status: 'installed', indexStatus: 'ready' });
    await expect(fs.access(path.join(projectPath, '.mcp.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(
      mockedExecFileSync.mock.calls.some(([, args]) => {
        const commandArgs = Array.isArray(args) ? args.map(String) : [];
        return commandArgs.includes('index_repository');
      }),
    ).toBe(true);
  });
});
