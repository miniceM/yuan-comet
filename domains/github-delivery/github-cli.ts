import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runExternalCommand } from '../../platform/process/external-command.js';
import { object, requireCondition } from './validation.js';
import type { RemoteIssue, RemotePr } from './types.js';
export interface GithubClient {
  issue(number: number): RemoteIssue;
  issues(): RemoteIssue[];
  pr(number: number): RemotePr;
  prs(): RemotePr[];
  createIssue(title: string, body: string): string;
  updateIssue(number: number, body: string): void;
  createPr(title: string, body: string, base: string, head: string): string;
}
export class GithubOperationError extends Error {}

export class GithubCli implements GithubClient {
  constructor(
    readonly root: string,
    readonly repository: string,
  ) {
    requireCondition(
      /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(repository),
      'Repository must be owner/repo',
    );
  }
  private run(args: string[]): string {
    try {
      return runExternalCommand('gh', args, { cwd: this.root, timeoutMs: 60_000 });
    } catch (error) {
      const cause = error as Error & { stderr?: string; cause?: { code?: string } };
      const detail = cause.stderr ?? '';
      const kind =
        cause.cause?.code === 'ENOENT'
          ? 'gh-missing'
          : /auth login|not logged|authentication/i.test(detail)
            ? 'unauthenticated'
            : /403|permission|forbidden/i.test(detail)
              ? 'permission-denied'
              : /404|not found/i.test(detail)
                ? 'repository-unavailable'
                : 'remote-uncertain';
      // Do not echo raw subprocess output, which may contain credentials.
      throw new GithubOperationError(
        `${kind}: GitHub operation failed; check gh installation/authentication/repository access, then use delivery observe before retry`,
        { cause: error },
      );
    }
  }
  private api(endpoint: string): unknown {
    return JSON.parse(
      this.run(['api', `repos/${this.repository}/${endpoint}`, '--hostname', 'github.com']),
    );
  }
  private all(endpoint: string): unknown[] {
    const pages: unknown = JSON.parse(
      this.run([
        'api',
        `repos/${this.repository}/${endpoint}?state=all&per_page=100`,
        '--hostname',
        'github.com',
        '--paginate',
        '--slurp',
      ]),
    );
    requireCondition(
      Array.isArray(pages) && pages.every(Array.isArray),
      'Invalid paginated GitHub response',
    );
    return pages.flat();
  }
  private validateIssue(value: unknown): RemoteIssue {
    const issue = object(value);
    requireCondition(
      Number.isSafeInteger(issue.number) &&
        Number(issue.number) > 0 &&
        typeof issue.html_url === 'string' &&
        ['open', 'closed'].includes(String(issue.state)) &&
        (issue.body === null || typeof issue.body === 'string'),
      'Invalid GitHub issue response',
    );
    return issue as unknown as RemoteIssue;
  }
  private validatePr(value: unknown): RemotePr {
    const issue = this.validateIssue(value),
      pr = object(value);
    const base = object(pr.base),
      h = object(pr.head);
    requireCondition(
      typeof base.ref === 'string' &&
        typeof h.ref === 'string' &&
        typeof h.sha === 'string' &&
        typeof object(base.repo).full_name === 'string',
      'Invalid GitHub PR response',
    );
    requireCondition(
      pr.merged_at === null || typeof pr.merged_at === 'string',
      'Invalid merge state',
    );
    if (h.repo !== null)
      requireCondition(typeof object(h.repo).full_name === 'string', 'Invalid head repository');
    return { ...issue, ...pr } as unknown as RemotePr;
  }
  issue(number: number): RemoteIssue {
    return this.validateIssue(this.api(`issues/${number}`));
  }
  issues(): RemoteIssue[] {
    return this.all('issues')
      .map((v) => this.validateIssue(v))
      .filter((v) => !v.pull_request);
  }
  pr(number: number): RemotePr {
    return this.validatePr(this.api(`pulls/${number}`));
  }
  prs(): RemotePr[] {
    return this.all('pulls').map((v) => this.validatePr(v));
  }
  private bodyCommand(args: string[], body: string): string {
    const dir = mkdtempSync(path.join(tmpdir(), 'comet-delivery-'));
    try {
      const file = path.join(dir, 'body.md');
      writeFileSync(file, body, { mode: 0o600 });
      return this.run([...args, '--repo', `github.com/${this.repository}`, '--body-file', file]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  createIssue(title: string, body: string): string {
    return this.bodyCommand(['issue', 'create', '--title', title], body);
  }
  updateIssue(number: number, body: string): void {
    this.bodyCommand(['issue', 'edit', String(number)], body);
  }
  createPr(title: string, body: string, base: string, head: string): string {
    return this.bodyCommand(
      ['pr', 'create', '--title', title, '--base', base, '--head', head],
      body,
    );
  }
}
