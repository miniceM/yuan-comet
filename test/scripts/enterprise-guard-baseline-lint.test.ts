import { execFile } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const projectRoot = fileURLToPath(new URL('../..', import.meta.url));
const lintScript = join(projectRoot, 'scripts', 'lint', 'enterprise-guard-baseline.mjs');

describe('Enterprise Guard baseline integrity lint', () => {
  it('accepts the checked-in policy, contracts, and runtime baseline', async () => {
    const { stdout } = await execFileAsync(process.execPath, [lintScript, '--root', projectRoot]);

    expect(stdout).toContain('Enterprise Guard baseline integrity passed');
  });

  it('fails closed when a repository does not contain the required baseline artifacts', async () => {
    const incompleteRoot = await mkdtemp(join(tmpdir(), 'comet-eg-baseline-'));

    await expect(
      execFileAsync(process.execPath, [lintScript, '--root', incompleteRoot]),
    ).rejects.toMatchObject({
      code: 1,
    });
  });
});
