import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { githubDeliveryCommand } from '../../app/commands/github-delivery.js';
const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
describe('delivery CLI', () => {
  it('lists local bindings as JSON without invoking GitHub', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'delivery-cli-'));
    roots.push(root);
    execFileSync('git', ['init', '-q', root]);
    const out = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await githubDeliveryCommand('list', { path: root });
    expect(JSON.parse(String(out.mock.calls[0][0]))).toEqual({
      status: 'success',
      action: 'list',
      result: [],
    });
  });
  it('rejects unknown resolution and missing binding id', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'delivery-cli-'));
    roots.push(root);
    execFileSync('git', ['init', '-q', root]);
    await expect(
      githubDeliveryCommand('pr', { path: root, resolution: 'unchecked' }),
    ).rejects.toThrow('resolution');
    await expect(githubDeliveryCommand('pr', { path: root })).rejects.toThrow('--id');
  });
});
