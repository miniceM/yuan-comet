import { describe, expect, it } from 'vitest';
import { ensureEnterpriseCli } from '../../../domains/enterprise-cli/index.js';
import type { EnterpriseCliCommandRunner } from '../../../domains/enterprise-cli/types.js';

function runnerFor(
  responses: Record<string, { exitCode?: number; stdout?: string; stderr?: string }>,
): EnterpriseCliCommandRunner {
  return (command, args) => {
    const key = `${command} ${args.join(' ')}`;
    const response = responses[key] ?? {};
    return {
      exitCode: response.exitCode ?? 0,
      stdout: response.stdout ?? '',
      stderr: response.stderr ?? '',
    };
  };
}

const availableResponses = {
  'iam --help': { stdout: 'IAM CLI\n  auth Authenticate with IAM\n' },
  'dop --help': { stdout: 'DOP CLI\n  change Manage changes\n' },
  'gh --version': { stdout: 'gh version gitee-cli 1.0.6\n' },
};

describe('enterprise CLI installation', () => {
  it('reuses all available commands without requiring a registry', async () => {
    const result = await ensureEnterpriseCli({
      acquireLock: false,
      runCommand: runnerFor(availableResponses),
    });

    expect(result.status).toBe('complete');
    expect(result.tools.map((tool) => tool.action)).toEqual(['reused', 'reused', 'reused']);
    expect(result.nextActions[0]).toContain('iam auth login --system');
  });

  it('reports missing registry before invoking npm', async () => {
    const calls: string[] = [];
    const result = await ensureEnterpriseCli({
      acquireLock: false,
      runCommand: (command, args, options) => {
        calls.push(`${command} ${args.join(' ')}`);
        return runnerFor({
          'iam --help': { exitCode: 1, stderr: 'command not found' },
          'dop --help': availableResponses['dop --help'],
          'gh --version': { exitCode: 1, stderr: 'not found' },
        })(command, args, options);
      },
    });

    expect(result.status).toBe('incomplete');
    expect(result.failures.map((failure) => failure.reasonCode)).toEqual([
      'configuration-missing',
      'configuration-missing',
    ]);
    expect(calls.some((call) => call.startsWith('npm '))).toBe(false);
  });

  it('installs missing commands from the configured registry and postchecks them', async () => {
    const calls: string[] = [];
    let installed = false;
    const result = await ensureEnterpriseCli({
      acquireLock: false,
      env: { ...process.env, COMET_ENTERPRISE_NPM_REGISTRY: 'http://registry.internal/npm-local/' },
      runCommand: (command, args, options) => {
        calls.push(`${command} ${args.join(' ')}`);
        if (command === 'iam' && args[0] === '--help') {
          return installed
            ? { exitCode: 0, stdout: 'IAM CLI auth\n', stderr: '' }
            : { exitCode: 1, stdout: '', stderr: 'not found' };
        }
        if (command === 'npm' && args[0] === 'view') {
          return {
            exitCode: 0,
            stdout: JSON.stringify({ version: '1.0.2', bin: { iam: 'bin/iam.js' } }),
            stderr: '',
          };
        }
        if (command === 'npm' && args[0] === 'install') {
          installed = true;
          return { exitCode: 0, stdout: 'changed 1 package\n', stderr: '' };
        }
        return runnerFor(availableResponses)(command, args, options);
      },
    });

    expect(result.status).toBe('complete');
    expect(result.tools.find((tool) => tool.command === 'iam')).toMatchObject({
      action: 'installed',
      reasonCode: 'available',
    });
    expect(calls).toContain(
      'npm install --global --no-fund --no-audit @cli-tools/iam@1.0.2 --@cli-tools:registry=http://registry.internal/npm-local/',
    );
  });

  it('reports blocked install scripts instead of accepting the npm exit code', async () => {
    const result = await ensureEnterpriseCli({
      acquireLock: false,
      env: { ...process.env, COMET_ENTERPRISE_NPM_REGISTRY: 'http://registry.internal/npm-local/' },
      runCommand: (command, args, options) => {
        if (command === 'gh') return { exitCode: 1, stdout: '', stderr: 'not found' };
        if (command === 'npm' && args[0] === 'view') {
          return {
            exitCode: 0,
            stdout: JSON.stringify({ version: '1.0.6', bin: { gh: 'bin/gh.js' } }),
            stderr: '',
          };
        }
        if (command === 'npm' && args[0] === 'install') {
          return { exitCode: 0, stdout: '', stderr: 'install scripts blocked by allowScripts' };
        }
        return runnerFor(availableResponses)(command, args, options);
      },
    });

    expect(result.status).toBe('incomplete');
    expect(result.failures.find((failure) => failure.command === 'gh')).toMatchObject({
      reasonCode: 'install-scripts-blocked',
    });
    expect(result.nextActions.join(' ')).toContain('enterprise npm policy');
  });

  it('blocks a package whose metadata would overwrite an available enterprise command', async () => {
    const result = await ensureEnterpriseCli({
      acquireLock: false,
      env: { ...process.env, COMET_ENTERPRISE_NPM_REGISTRY: 'http://registry.internal/npm-local/' },
      runCommand: (command, args, options) => {
        if (command === 'iam') return { exitCode: 1, stdout: '', stderr: 'not found' };
        if (command === 'npm' && args[0] === 'view') {
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              version: '1.0.2',
              bin: { iam: 'bin/iam.js', dop: 'bin/dop.js' },
            }),
            stderr: '',
          };
        }
        return runnerFor(availableResponses)(command, args, options);
      },
    });

    expect(result.status).toBe('incomplete');
    expect(result.failures.find((failure) => failure.command === 'iam')).toMatchObject({
      reasonCode: 'bin-conflict',
    });
  });

  it('reports a postcheck failure when npm succeeds but the command remains unavailable', async () => {
    const result = await ensureEnterpriseCli({
      acquireLock: false,
      env: { ...process.env, COMET_ENTERPRISE_NPM_REGISTRY: 'http://registry.internal/npm-local/' },
      runCommand: (command, args, options) => {
        if (command === 'iam') return { exitCode: 1, stdout: '', stderr: 'not found' };
        if (command === 'npm' && args[0] === 'view') {
          return {
            exitCode: 0,
            stdout: JSON.stringify({ version: '1.0.2', bin: { iam: 'bin/iam.js' } }),
            stderr: '',
          };
        }
        if (command === 'npm' && args[0] === 'install') {
          return { exitCode: 0, stdout: 'changed 1 package\n', stderr: '' };
        }
        return runnerFor(availableResponses)(command, args, options);
      },
    });

    expect(result.status).toBe('incomplete');
    expect(result.failures.find((failure) => failure.command === 'iam')).toMatchObject({
      reasonCode: 'postcheck-failed',
    });
  });
});
