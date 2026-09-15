import { readFileSync, existsSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const external = vi.hoisted(() => ({ runExternalCommand: vi.fn() }));
vi.mock('../../../platform/process/external-command.js', () => external);
import { GithubCli, GithubOperationError } from '../../../domains/github-delivery/github-cli.js';
const issue = {
  number: 1,
  html_url: 'https://github.com/acme/test/issues/1',
  state: 'closed',
  body: 'acceptance',
};
beforeEach(() => {
  external.runExternalCommand.mockReset();
});
describe('GitHub CLI boundary', () => {
  it('reads every pagination page including closed objects', () => {
    external.runExternalCommand.mockReturnValue(
      JSON.stringify([[issue], [{ ...issue, number: 2 }]]),
    );
    expect(new GithubCli('.', 'acme/test').issues()).toHaveLength(2);
    expect(external.runExternalCommand).toHaveBeenCalledWith(
      'gh',
      [
        'api',
        'repos/acme/test/issues?state=all&per_page=100',
        '--hostname',
        'github.com',
        '--paginate',
        '--slurp',
      ],
      expect.anything(),
    );
  });
  it('passes literal Markdown via a private temporary body file and explicit targets', () => {
    let bodyFile = '';
    const body = 'literal `code` and $(do-not-execute)\n\nCloses #1';
    external.runExternalCommand.mockImplementation((command: string, args: string[]) => {
      expect(command).toBe('gh');
      expect(args).toContain('--repo');
      expect(args).toContain('github.com/acme/test');
      expect(args).toContain('--base');
      expect(args).toContain('--head');
      expect(args).not.toContain('--fill');
      bodyFile = args[args.indexOf('--body-file') + 1];
      expect(readFileSync(bodyFile, 'utf8')).toBe(body);
      return 'https://github.com/acme/test/pull/2';
    });
    new GithubCli('.', 'acme/test').createPr('Title', body, 'main', 'codex/task');
    expect(existsSync(bodyFile)).toBe(false);
  });
  it.each([
    [{ cause: { code: 'ENOENT' } }, 'gh-missing', true],
    [{ stderr: 'run gh auth login' }, 'unauthenticated', true],
    [{ stderr: 'HTTP 403 secret-test-token' }, 'permission-denied', true],
    [{ stderr: 'HTTP 404' }, 'repository-unavailable', true],
    [{ stderr: 'network unavailable' }, 'remote-uncertain', false],
  ])(
    'reports safe actionable errors without echoing subprocess secrets',
    (failure, kind, definitelyNotApplied) => {
      external.runExternalCommand.mockImplementation(() => {
        throw Object.assign(new Error('private'), failure);
      });
      try {
        new GithubCli('.', 'acme/test').issue(1);
        throw new Error('expected failure');
      } catch (error) {
        expect((error as Error).message).toContain(kind);
        expect((error as Error).message).not.toContain('secret-test-token');
        expect(error).toBeInstanceOf(GithubOperationError);
        expect((error as GithubOperationError).definitelyNotApplied).toBe(definitelyNotApplied);
      }
    },
  );
  it('rejects malformed pagination rather than treating it as an empty result', () => {
    external.runExternalCommand.mockReturnValue('{"message":"incomplete"}');
    expect(() => new GithubCli('.', 'acme/test').prs()).toThrow('paginated');
  });
});
