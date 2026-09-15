import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import * as git from '../../../platform/process/git.js';
import { GithubDelivery, DeliveryStore, hash } from '../../../domains/github-delivery/index.js';
import type {
  DeliveryRecord,
  RemoteIssue,
  RemotePr,
} from '../../../domains/github-delivery/types.js';
import { GithubCli, GithubOperationError } from '../../../domains/github-delivery/github-cli.js';
import { GitCommandError } from '../../../platform/process/git.js';
import { finishNativePullRequest } from '../../../domains/comet-native/native-pull-request-finish.js';
import type { GithubClient } from '../../../domains/github-delivery/github-cli.js';
import {
  findWorkflowDelivery,
  pushWorkflowDelivery,
} from '../../../domains/github-delivery/workflow-adapter.js';

import { finishArchivedNativeWorkspace } from '../../../domains/comet-native/native-workspace-finish.js';
import { nativeProjectPaths } from '../../../domains/comet-native/native-paths.js';
import type { NativeChangeState } from '../../../domains/comet-native/native-types.js';

class FakeGithub implements GithubClient {
  issueRows: RemoteIssue[] = [];
  prRows: RemotePr[] = [];
  issueWrites = 0;
  prWrites = 0;
  loseResponse = false;
  failBeforeCreate = false;
  issue(number: number) {
    const row = this.issueRows.find((i) => i.number === number);
    if (!row) throw new Error('404');
    return structuredClone(row);
  }
  issues() {
    return structuredClone(this.issueRows);
  }
  pr(number: number) {
    const row = this.prRows.find((i) => i.number === number);
    if (!row) throw new Error('404');
    const copy = structuredClone(row);
    if (remoteSha && copy.state === 'open') {
      copy.head.sha = remoteSha;
    }
    return copy;
  }
  prs() {
    return structuredClone(this.prRows).map((r) => {
      if (remoteSha && r.state === 'open') {
        r.head.sha = remoteSha;
      }
      return r;
    });
  }
  createIssue(_title: string, body: string) {
    this.issueWrites++;
    if (this.failBeforeCreate) throw new Error('network unavailable');
    const n = this.issueRows.length + 1;
    this.issueRows.push({
      number: n,
      html_url: `https://github.com/acme/test/issues/${n}`,
      state: 'open',
      body,
    });
    if (this.loseResponse) throw new Error('response lost');
    return this.issueRows.at(-1)!.html_url;
  }
  updateIssue(number: number, body: string) {
    this.issueWrites++;
    this.issueRows.find((i) => i.number === number)!.body = body;
  }
  createPr(_title: string, body: string, base: string, head: string) {
    this.prWrites++;
    const n = this.prRows.length + 1;
    this.prRows.push({
      number: n,
      html_url: `https://github.com/acme/test/pull/${n}`,
      state: 'open',
      body,
      merged_at: null,
      base: { ref: base, repo: { full_name: 'acme/test' } },
      head: { ref: head, sha: currentHead(), repo: { full_name: 'acme/test' } },
    });
    if (this.loseResponse) throw new Error('response lost');
    return this.prRows.at(-1)!.html_url;
  }
}
let root: string,
  client: FakeGithub,
  service: GithubDelivery,
  remoteSha: string | null,
  remoteBaseSha: string | null;
function command(...args: string[]): string {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
}
function currentHead() {
  return command('rev-parse', 'HEAD');
}
function bind(workflow = 'classic') {
  return service.bind({
    repository: 'acme/test',
    workflow,
    change: 'delivery',
    base: 'main',
    head: 'codex/delivery',
    remote: 'origin',
    summary: {
      title: 'Delivery',
      background: 'Problem',
      changes: 'Change',
      impact: 'Impact',
      nonGoals: 'No merge',
      compatibility: 'No migration',
    },
    scope: {
      confirmation: 'user:initial',
      items: [
        { source: 'docs/requirements.md', internalRef: 'scenario-1', text: 'First acceptance' },
        { source: 'docs/requirements.md', internalRef: 'scenario-2', text: 'Second acceptance' },
      ],
    },
  });
}
function grantAll(r: DeliveryRecord) {
  for (const action of ['issue:create', 'push', 'pull-request:create'])
    service.local(r.id, 'grant', { action, source: 'user:explicit' });
}
function verify(r: DeliveryRecord, status = 'passed') {
  r = service.store.read(r.id);
  return service.local(r.id, 'verify', {
    head: currentHead(),
    manifest: r.scope.hash,
    items: r.scope.committedKeys.map((key) => ({
      key,
      revision: r.scope.items.find((i) => i.key === key)!.revision,
      status,
      evidence: ['test:observed'],
      reason: 'Observed test result',
    })),
  });
}
function review(r: DeliveryRecord, extra = {}) {
  r = service.store.read(r.id);
  return service.local(r.id, 'review', {
    head: currentHead(),
    base: r.binding.baseSha,
    manifest: r.scope.hash,
    verification: r.verifications.at(-1)!.hash,
    kind: 'full',
    reviewer: 'review-execution',
    builder: 'build-execution',
    evidence: 'review:report',
    findings: [],
    ...extra,
  });
}
function ready(workflow = 'classic') {
  let r = bind(workflow);
  grantAll(r);
  r = service.issue(r.id);
  r = verify(r);
  return review(r);
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'comet-delivery-test-'));
  command('init', '-q', '-b', 'main');
  command('config', 'user.name', 'Test');
  command('config', 'user.email', 'test@example.invalid');
  mkdirSync(path.join(root, 'docs'));
  writeFileSync(path.join(root, 'docs/requirements.md'), 'First acceptance\nSecond acceptance\n');
  command('add', '.');
  command('commit', '-qm', 'initial');
  command('switch', '-qc', 'codex/delivery');
  command('remote', 'add', 'origin', 'https://github.com/acme/test.git');
  remoteSha = null;
  remoteBaseSha = command('rev-parse', 'refs/heads/main');
  const real = git.runGitCommand;
  vi.spyOn(git, 'runGitCommand').mockImplementation((cwd, args) => {
    if (args[0] === 'ls-remote') {
      const refPattern = args.at(-1) ?? '';
      if (refPattern.includes('codex/delivery'))
        return remoteSha ? `${remoteSha}\trefs/heads/codex/delivery` : '';
      if (refPattern.includes('main'))
        return remoteBaseSha ? `${remoteBaseSha}\trefs/heads/main` : '';
      return '';
    }
    if (args[0] === 'push') {
      remoteSha = args.at(-1)!.split(':')[0];
      return '';
    }
    return real(cwd, args);
  });
  client = new FakeGithub();
  service = new GithubDelivery(root, () => client);
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

describe('GitHub delivery contracts', () => {
  it.each(['classic', 'native'])(
    'runs %s issue → verification → review → PR without changing workflow state',
    (workflow) => {
      const r = ready(workflow);
      service.push(r.id, 'full');
      const result = service.pr(r.id, 'full');
      expect(result.pr?.state).toBe('open');
      expect(result.issueClosure).toBe('pending');
      expect(client.prRows[0].body).toContain('Closes #1');
      expect(client.prRows[0].body).toContain('CI: Pending');
      expect(command('status', '--porcelain')).toBe('');
      expect(findWorkflowDelivery(root, workflow as 'classic' | 'native', 'delivery')?.id).toBe(
        r.id,
      );
    },
  );
  it('keeps local-only projects independent from GitHub', () => {
    expect(findWorkflowDelivery(root, 'native', 'unbound')).toBeNull();
    expect(pushWorkflowDelivery(root, 'native', 'unbound')).toBe(false);
    expect(client.issueWrites).toBe(0);
  });
  it('does not create issues without action authorization', () => {
    const r = bind();
    expect(() => service.issue(r.id)).toThrow('authorization');
    expect(client.issueWrites).toBe(0);
  });
  it('binds an existing issue only after current scope confirmation and preserves user text on sync', () => {
    const r = bind();
    client.createIssue('existing', 'Human content\nFirst acceptance\nSecond acceptance');
    expect(() => service.issue(r.id, { number: 1 })).toThrow('confirmation');
    service.issue(r.id, {
      number: 1,
      expectedBodyHash: hash(client.issue(1).body),
      scopeConfirmation: 'user:all criteria',
    });
    expect(() => service.syncIssue(r.id, { expectedBodyHash: hash(client.issue(1).body) })).toThrow(
      'authorization',
    );
    service.local(r.id, 'grant', { action: 'issue:update', source: 'user:sync' });
    service.syncIssue(r.id, { expectedBodyHash: hash(client.issue(1).body) });
    expect(client.issue(1).body).toMatch(/^Human content/);
    expect(client.issueRows).toHaveLength(1);
  });
  it('recovers issue creation with a lost response and does not duplicate', () => {
    const r = bind();
    grantAll(r);
    client.loseResponse = true;
    service.issue(r.id);
    service.issue(r.id);
    expect(client.issueWrites).toBe(1);
  });
  it('never retries uncertain issue creation after an empty observation', () => {
    const r = bind();
    grantAll(r);
    client.failBeforeCreate = true;
    expect(() => service.issue(r.id)).toThrow('not yet observable');
    client.failBeforeCreate = false;
    expect(() => service.issue(r.id)).toThrow('uncertain');
    expect(client.issueWrites).toBe(1);
  });
  it.each(['failed', 'not-run'])('blocks %s acceptance even when other items passed', (status) => {
    let r = bind();
    grantAll(r);
    service.issue(r.id);
    r = verify(r, status);
    expect(() => review(r)).toThrow('not effectively passed');
    expect(() => service.pr(r.id, 'full')).toThrow();
    expect(client.prWrites).toBe(0);
  });
  it('rejects duplicate evidence and a review from the builder execution', () => {
    const r = ready();
    expect(() => review(r, { reviewer: 'build-execution' })).toThrow('distinct');
    const v = r.verifications.at(-1)!;
    expect(() =>
      service.local(r.id, 'verify', {
        head: v.head,
        manifest: v.manifest,
        items: [v.items[0], v.items[0]],
      }),
    ).toThrow('duplicate');
  });
  it('invalidates verification when scope changes and cannot restore it by review', () => {
    let r = ready();
    r = service.local(r.id, 'scope', {
      confirmation: 'user:partial',
      items: r.scope.items,
      committedKeys: ['AC-01'],
    });
    expect(() => review(r)).toThrow('stale verification');
    expect(() => service.check(r.id, 'full')).toThrow();
  });
  it('preserves public AC identity on wording revision and prevents disappearing AC', () => {
    let r = bind();
    writeFileSync(
      path.join(root, 'docs/requirements.md'),
      'First acceptance revised\nSecond acceptance\n',
    );
    const items = r.scope.items.map((i) => ({
      ...i,
      text: i.key === 'AC-01' ? 'First acceptance revised' : i.text,
    }));
    r = service.local(r.id, 'scope', { confirmation: 'user:revision', items });
    expect(r.scope.items[0].key).toBe('AC-01');
    expect(r.scope.items[0].revision).toBe(2);
    expect(() =>
      service.local(r.id, 'scope', { confirmation: 'user:remove', items: items.slice(1) }),
    ).toThrow('cannot disappear');
  });
  it('enforces partial scope while listing remaining issue criteria without closing', () => {
    let r = bind();
    r = service.local(r.id, 'scope', {
      confirmation: 'user:partial',
      items: r.scope.items,
      committedKeys: ['AC-01'],
    });
    grantAll(r);
    service.issue(r.id);
    r = review(verify(r));
    expect(() => service.check(r.id, 'full')).toThrow('Partial');
    service.push(r.id, 'partial');
    service.pr(r.id, 'partial');
    expect(client.prRows[0].body).toContain('Outside this delivery');
    expect(client.prRows[0].body).toContain('Related to #1');
    expect(client.prRows[0].body).not.toContain('Closes #1');
  });
  it('blocks stale HEAD until both verification and review cover new code', () => {
    let r = ready();
    writeFileSync(path.join(root, 'code.ts'), 'new code');
    command('add', '.');
    command('commit', '-qm', 'code');
    expect(() => service.check(r.id, 'full')).toThrow('final HEAD');
    r = verify(r);
    expect(() => service.check(r.id, 'full')).toThrow('stale');
    review(r);
    expect(() => service.check(r.id, 'full')).not.toThrow();
  });
  it('carries evidence across identical document archive renames and requires a linked review', () => {
    let r = ready();
    mkdirSync(path.join(root, 'docs/archive'));
    command('mv', 'docs/requirements.md', 'docs/archive/requirements.md');
    command('commit', '-qm', 'archive');
    r = service.local(r.id, 'carry', {
      head: currentHead(),
      parent: r.verifications.at(-1)!.hash,
      evidence: 'archive inspected',
    });
    expect(() => service.check(r.id, 'full')).toThrow('stale');
    review(r, { kind: 'delta', parent: r.reviews.at(-1)!.id, base: r.reviews.at(-1)!.head });
    expect(() => service.check(r.id, 'full')).not.toThrow();
  });
  it('does not allow archive carry over code or semantic doc changes', () => {
    const r = ready();
    writeFileSync(path.join(root, 'code.ts'), 'new code');
    command('add', '.');
    command('commit', '-qm', 'code');
    expect(() =>
      service.local(r.id, 'carry', {
        head: currentHead(),
        parent: r.verifications.at(-1)!.hash,
        evidence: 'claimed metadata',
      }),
    ).toThrow('changes content');
  });
  it('rejects unresolved important findings even on a fresh receipt', () => {
    const r = ready();
    review(r, { findings: [{ severity: 'important', resolved: false, text: 'bug' }] });
    expect(() => service.check(r.id, 'full')).toThrow('Unresolved');
  });
  it.each(['closed', 'merged'])(
    'observes a %s PR after response loss instead of recreating',
    (status) => {
      const r = ready();
      service.push(r.id, 'full');
      client.loseResponse = true;
      service.pr(r.id, 'full');
      client.prRows[0].state = 'closed';
      client.prRows[0].merged_at = status === 'merged' ? new Date().toISOString() : null;
      const result = service.pr(r.id, 'full');
      expect(result.pr?.state).toBe(status === 'merged' ? 'merged' : 'closed-unmerged');
      expect(client.prWrites).toBe(1);
    },
  );
  it('records deterministic write failures as retryable after the prerequisite is fixed', () => {
    const r = bind();
    grantAll(r);
    const create = vi.spyOn(client, 'createIssue').mockImplementationOnce(() => {
      throw new GithubOperationError(
        'permission-denied',
        'permission-denied: GitHub operation failed',
      );
    });
    expect(() => service.issue(r.id)).toThrow('permission-denied');
    expect(service.store.read(r.id).operations[0].status).toBe('failed');
    const recovered = service.issue(r.id);
    expect(recovered.issue?.number).toBe(1);
    expect(recovered.operations.map((operation) => operation.status)).toEqual([
      'failed',
      'completed',
    ]);
    expect(create).toHaveBeenCalledTimes(2);
  });
  it('records a merged PR target drift without reporting issue closure', () => {
    const r = ready();
    service.push(r.id, 'full');
    service.pr(r.id, 'full');
    client.prRows[0].base.ref = 'other';
    client.prRows[0].merged_at = new Date().toISOString();
    client.prRows[0].state = 'closed';
    client.issueRows[0].state = 'closed';
    const result = service.observe(r.id);
    expect(result.pr?.drifted).toBe(true);
    expect(result.pr?.driftReason).toContain('target branch');
    expect(result.issueClosure).toBe('pending');
  });
  it('keeps the reviewed delivery SHA when an appended commit is merged', () => {
    const r = ready();
    service.push(r.id, 'full');
    const created = service.pr(r.id, 'full');
    const deliveredSha = created.pr!.sha;
    const appendedSha = 'b'.repeat(40);
    client.prRows[0].head.sha = appendedSha;
    client.prRows[0].merged_at = new Date().toISOString();
    client.prRows[0].state = 'closed';
    client.issueRows[0].state = 'closed';
    const result = service.observe(r.id);
    expect(result.pr).toMatchObject({
      state: 'merged',
      sha: deliveredSha,
      observedSha: appendedSha,
      drifted: true,
    });
    expect(result.pr?.driftReason).toContain('verified and reviewed');
    expect(result.issueClosure).toBe('pending');
    expect(() => service.check(r.id, 'full')).toThrow('verified and reviewed');
  });
  it('records merged and issue closed as separate observations', () => {
    const r = ready();
    service.push(r.id, 'full');
    service.pr(r.id, 'full');
    client.prRows[0].merged_at = new Date().toISOString();
    client.prRows[0].state = 'closed';
    expect(service.observe(r.id).issueClosure).toBe('pending');
    client.issueRows[0].state = 'closed';
    expect(service.observe(r.id).issueClosure).toBe('closed');
  });
  it('rejects a changed push repository and final remote SHA drift', () => {
    const r = ready();
    command('remote', 'set-url', 'origin', 'https://github.com/other/repo.git');
    expect(() => service.push(r.id, 'full')).toThrow('remote');
    command('remote', 'set-url', 'origin', 'https://github.com/acme/test.git');
    expect(() => service.pr(r.id, 'full')).toThrow('Remote branch');
  });
  it('validates repository binding before issue create and update access', () => {
    command('remote', 'set-url', 'origin', 'https://github.com/other/repo.git');
    expect(() => bind()).toThrow('remote');
    expect(client.issueWrites).toBe(0);

    command('remote', 'set-url', 'origin', 'https://github.com/acme/test.git');
    const r = bind();
    grantAll(r);
    command('remote', 'set-url', 'origin', 'https://github.com/other/repo.git');
    expect(() => service.issue(r.id)).toThrow('remote');
    expect(client.issueWrites).toBe(0);
    command('remote', 'set-url', 'origin', 'https://github.com/acme/test.git');
    service.issue(r.id);
    service.local(r.id, 'grant', { action: 'issue:update', source: 'user:sync' });
    const writes = client.issueWrites;
    command('remote', 'set-url', 'origin', 'https://github.com/other/repo.git');
    expect(() => service.syncIssue(r.id, { expectedBodyHash: hash(client.issue(1).body) })).toThrow(
      'remote',
    );
    expect(client.issueWrites).toBe(writes);
  });
  it('does not let a fork PR with the same branch name block same-repository creation', () => {
    const r = ready();
    service.push(r.id, 'full');
    client.prRows.push({
      number: 99,
      html_url: 'https://github.com/acme/test/pull/99',
      state: 'open',
      body: 'fork pull request',
      merged_at: null,
      base: { ref: 'main', repo: { full_name: 'acme/test' } },
      head: { ref: 'codex/delivery', sha: currentHead(), repo: { full_name: 'fork/test' } },
    });
    const result = service.pr(r.id, 'full');
    expect(client.prWrites).toBe(1);
    expect(result.pr?.number).not.toBe(99);
    expect(result.pr?.drifted).toBe(false);
  });
  it('keeps prepared journals on disk before creating a remote object', () => {
    const r = ready();
    service.push(r.id, 'full');
    const original = client.createPr.bind(client);
    vi.spyOn(client, 'createPr').mockImplementation((...args) => {
      expect(service.store.read(r.id).operations.at(-1)?.status).toBe('prepared');
      return original(...args);
    });
    service.pr(r.id, 'full');
  });
  it('shares state between linked worktrees without writing tracked files', () => {
    const r = bind(),
      linked = `${root}-linked`;
    command('worktree', 'add', '-qb', 'codex/other', linked);
    try {
      const other = new DeliveryStore(linked);
      expect(other.read(r.id).id).toBe(r.id);
      expect(command('status', '--porcelain')).toBe('');
    } finally {
      command('worktree', 'remove', linked);
    }
  });
  it('routes bound Native PR finish through the shared acceptance and review checks', () => {
    const r = ready('native');
    service.push(r.id, 'full');
    vi.spyOn(GithubCli.prototype, 'issue').mockImplementation((n) => client.issue(n));
    vi.spyOn(GithubCli.prototype, 'pr').mockImplementation((n) => client.pr(n));
    vi.spyOn(GithubCli.prototype, 'prs').mockImplementation(() => client.prs());
    vi.spyOn(GithubCli.prototype, 'createPr').mockImplementation((...args) =>
      client.createPr(...args),
    );
    const result = finishNativePullRequest({
      projectRoot: root,
      changeName: 'delivery',
      transactionId: 'tx',
      remote: 'origin',
      baseBranch: 'main',
      headBranch: 'codex/delivery',
      headSha: currentHead(),
      config: null,
    });
    expect(result.provider).toBe('github-cli');
    expect(client.prRows[0].body).toContain('## Acceptance');
  });
  it('rejects issue body drift outside the managed acceptance block', () => {
    const r = ready();
    service.push(r.id, 'full');
    client.issueRows[0].body += '\nNew requirement';
    expect(() => service.pr(r.id, 'full')).toThrow('scope drift');
    service.observe(r.id);
    expect(() => service.check(r.id, 'full')).toThrow('synchronized');
    expect(client.prWrites).toBe(0);
  });
  it('checks the whole acceptance source rather than only old matching text', () => {
    const r = ready();
    writeFileSync(
      path.join(root, 'docs/requirements.md'),
      'First acceptance\nSecond acceptance\nThird new requirement\n',
    );
    command('add', '.');
    command('commit', '-qm', 'scope drift');
    expect(() => verify(r)).toThrow('Acceptance source changed');
  });
  it('reports a missing acceptance source instead of leaking a raw path error', () => {
    const r = bind();
    expect(() =>
      service.local(r.id, 'scope', {
        confirmation: 'user:missing',
        items: [{ source: 'docs/missing.md', internalRef: 'scenario-3', text: 'Third acceptance' }],
      }),
    ).toThrow('Acceptance source not found: docs/missing.md');
    expect(() =>
      service.bind({
        repository: 'acme/test',
        workflow: 'classic',
        change: 'other',
        base: 'main',
        head: 'codex/delivery',
        remote: 'origin',
        summary: {
          title: 'Delivery',
          background: 'Problem',
          changes: 'Change',
          impact: 'Impact',
          nonGoals: 'No merge',
          compatibility: 'No migration',
        },
        scope: {
          confirmation: 'user:missing',
          items: [{ source: 'docs/absent.md', internalRef: 'scenario-1', text: 'Gone' }],
        },
      }),
    ).toThrow('Acceptance source not found: docs/absent.md');
  });
  it('rejects a broken or blocking parent review even with a clean final delta', () => {
    let r = ready();
    review(r, { findings: [{ severity: 'important', resolved: false, text: 'original bug' }] });
    r = service.store.read(r.id);
    command('commit', '--allow-empty', '-qm', 'archive');
    r = service.local(r.id, 'carry', {
      head: currentHead(),
      parent: r.verifications.at(-1)!.hash,
      evidence: 'empty archive commit',
    });
    review(r, { kind: 'delta', parent: r.reviews.at(-1)!.id, base: r.reviews.at(-1)!.head });
    expect(() => service.check(r.id, 'full')).toThrow('Unresolved');
  });
  it('rejects stale writes, concurrent mutations and traversal ids', () => {
    const r = bind(),
      stale = service.store.read(r.id);
    service.local(r.id, 'grant', { action: 'push', source: 'user' });
    expect(() => service.store.save(stale)).toThrow('revision');
    expect(() => service.store.locked(() => service.store.locked(() => undefined))).toThrow(
      'locked',
    );
    expect(() => service.store.read('../escape')).toThrow('Invalid');
    expect(readFileSync(path.join(service.store.directory, `${r.id}.json`), 'utf8')).not.toContain(
      'token',
    );
  });
  it('rejects push when local base is ahead of remote base (P1-1: unreviewed code)', () => {
    // Normal ready() binds baseSha = merge-base(local main, HEAD).
    // When remote main is behind local main, baseSha is ahead of remote base,
    // meaning the PR would contain commits X (local-only on main) + Y (feature)
    // but review only covers Y. Preflight must reject this.
    const initialSha = command('rev-list', '--max-parents=0', 'HEAD');

    // Add a local-only commit to main (not pushed to remote)
    command('switch', '-q', 'main');
    writeFileSync(path.join(root, 'local-only.txt'), 'not pushed');
    command('add', '.');
    command('commit', '-qm', 'local-only commit on main');
    const localMainSha = command('rev-parse', 'HEAD');
    command('switch', '-q', 'codex/delivery');

    // Merge local main into feature so merge-base picks up the local main commit
    command('merge', '-q', '--no-edit', 'main');

    // Remote base is still at the initial commit (before the local-only commit)
    remoteBaseSha = initialSha;

    // Bind a new delivery — baseSha will be localMainSha (ahead of remote)
    const service2 = new GithubDelivery(root, () => client);
    const r2 = service2.bind({
      repository: 'acme/test',
      workflow: 'classic',
      change: 'baseline-test',
      base: 'main',
      head: 'codex/delivery',
      remote: 'origin',
      summary: {
        title: 'Test',
        background: 'bg',
        changes: 'ch',
        impact: 'im',
        nonGoals: 'ng',
        compatibility: 'co',
      },
      scope: {
        confirmation: 'user:initial',
        items: [
          { source: 'docs/requirements.md', internalRef: 'scenario-1', text: 'First acceptance' },
        ],
      },
    });
    // baseSha should be the local main commit, which is ahead of remoteBaseSha
    expect(r2.binding.baseSha).toBe(localMainSha);
    for (const action of ['issue:create', 'push', 'pull-request:create'] as const)
      service2.local(r2.id, 'grant', { action, source: 'user:explicit' });
    service2.issue(r2.id);
    const r2read = service2.store.read(r2.id);
    service2.local(r2.id, 'verify', {
      head: currentHead(),
      manifest: r2read.scope.hash,
      items: r2read.scope.committedKeys.map((key) => ({
        key,
        revision: r2read.scope.items.find((i) => i.key === key)!.revision,
        status: 'passed',
        evidence: ['test:observed'],
        reason: 'Observed test result',
      })),
    });
    const r2v = service2.store.read(r2.id);
    service2.local(r2.id, 'review', {
      head: currentHead(),
      base: r2v.binding.baseSha,
      manifest: r2v.scope.hash,
      verification: r2v.verifications.at(-1)!.hash,
      kind: 'full',
      reviewer: 'review-execution',
      builder: 'build-execution',
      evidence: 'review:report',
      findings: [],
    });
    // preflight should reject because baseSha is ahead of remote base
    expect(() => service2.push(r2.id, 'full')).toThrow('Review baseline is ahead');
  });
  it('rejects multiple push URLs targeting different repositories (P1-2: pushurl bypass)', () => {
    command('remote', 'set-url', '--push', '--add', 'origin', 'https://github.com/evil/repo.git');
    expect(() => bind()).toThrow('remote');
  });
  it('rejects a new clean full review when a prior full review has unresolved findings (P1-3: review bypass)', () => {
    // First full review with unresolved important finding
    let r = ready();
    review(r, { findings: [{ severity: 'important', resolved: false, text: 'security issue' }] });
    // Second full review with no findings — should NOT bypass the prior blocker
    review(r);
    expect(() => service.check(r.id, 'full')).toThrow('Unresolved');
  });
  it('records git push authentication failures as retryable failed, not permanent uncertain (P1-4)', () => {
    const r = ready();
    const real = vi.mocked(git.runGitCommand);
    const originalImpl = real.getMockImplementation()!;
    real.mockImplementation((cwd, args) => {
      if (args[0] === 'push') {
        throw new GitCommandError(cwd, args, 'fatal: Authentication failed for remote');
      }
      return originalImpl(cwd, args);
    });
    expect(() => service.push(r.id, 'full')).toThrow();
    expect(service.store.read(r.id).operations.at(-1)?.status).toBe('failed');
    // After fixing authentication, push should succeed (not blocked by uncertain)
    real.mockImplementation(originalImpl);
    service.push(r.id, 'full');
    expect(
      service.store
        .read(r.id)
        .operations.filter((o) => o.kind === 'push')
        .map((o) => o.status),
    ).toEqual(['failed', 'completed']);
  });
  it('blocks bound Native finish=push when push authorization is missing (no git push executed)', async () => {
    let r = bind('native');
    // Only grant issue:create, do not grant push
    service.local(r.id, 'grant', { action: 'issue:create', source: 'user:explicit' });
    r = service.issue(r.id);
    r = verify(r);
    r = review(r);

    const paths = await nativeProjectPaths(root, '.');
    const state = {
      name: 'delivery',
      spec_changes: [],
    } as unknown as NativeChangeState;
    mkdirSync(path.join(root, 'archive'), { recursive: true });
    writeFileSync(path.join(root, 'archive/report.md'), 'done');
    command('add', '.');
    command('commit', '-qm', 'archive changes');
    r = verify(r);
    r = review(r);

    // Without push grant, Native finish=push must be blocked by missing authorization and no git push must occur
    await expect(
      finishArchivedNativeWorkspace({
        paths,
        state,
        name: 'delivery',
        archiveDir: path.join(root, 'archive'),
        transactionId: 'tx',
        plan: {
          finish: 'push',
          changeRoot: root,
          primaryRoot: root,
          changeBranch: 'codex/delivery',
          targetBranch: 'main',
          targetRoot: null,
          remote: 'origin',
          isolation: 'branch',
          pullRequestFinish: null,
        },
      }),
    ).rejects.toThrow(/push/i);
    expect(remoteSha).toBeNull();
  });
  it('recovers delivery when a previous unresolved important finding is explicitly resolved in a subsequent review', () => {
    let r = ready();
    // Review 1 reports an unresolved important finding
    review(r, {
      findings: [
        { id: 'sec-1', severity: 'important', resolved: false, text: 'SQL injection risk' },
      ],
    });
    expect(() => service.check(r.id, 'full')).toThrow('Unresolved review findings');

    // Builder adds fix commit and records fresh verification
    writeFileSync(path.join(root, 'fix.txt'), 'fixed');
    command('add', '.');
    command('commit', '-qm', 'fix SQL injection');
    r = verify(r);

    // Review 2 with no resolves still fails (clean review cannot bypass blocker)
    review(r, {
      kind: 'delta',
      parent: r.reviews.at(-1)!.id,
      base: r.reviews.at(-1)!.head,
    });
    expect(() => service.check(r.id, 'full')).toThrow('Unresolved review findings');

    // Review 3 explicitly resolves the finding
    review(r, {
      kind: 'delta',
      parent: r.reviews.at(-1)!.id,
      base: r.reviews.at(-1)!.head,
      resolves: ['sec-1'],
    });
    expect(() => service.check(r.id, 'full')).not.toThrow();

    // Delivery can proceed to push and PR
    service.push(r.id, 'full');
    const res = service.pr(r.id, 'full');
    expect(res.pr?.state).toBe('open');
    expect(client.prRows[0].body).toContain('resolves: sec-1');
  });
  it('allows pushing new verified commit to update open PR and updating PR expected SHA', () => {
    const r = ready();
    service.push(r.id, 'full');
    const created = service.pr(r.id, 'full');
    expect(created.pr?.state).toBe('open');

    // Local adds a fix commit (e.g. for CI or review feedback)
    writeFileSync(path.join(root, 'ci-fix.txt'), 'ci fixed');
    command('add', '.');
    command('commit', '-qm', 'fix for CI failure');
    const secondSha = currentHead();

    // Verify and review the new commit
    verify(r);
    review(r, {
      kind: 'delta',
      parent: r.reviews.at(-1)!.id,
      base: r.reviews.at(-1)!.head,
    });

    // Push new commit to update the open PR
    const pushed = service.push(r.id, 'full');
    expect(pushed.push?.sha).toBe(secondSha);
    expect(pushed.pr?.sha).toBe(secondSha);
    expect(pushed.pr?.drifted).toBe(false);

    // Observe reflects open PR with updated SHA and no drift
    const observed = service.observe(r.id);
    expect(observed.pr?.state).toBe('open');
    expect(observed.pr?.sha).toBe(secondSha);
    expect(observed.pr?.drifted).toBe(false);
  });
  it('allows creating a replacement PR after a prior PR was closed-unmerged', () => {
    const r = ready();
    service.push(r.id, 'full');
    const created = service.pr(r.id, 'full');
    expect(created.pr?.number).toBe(1);

    // PR1 is closed unmerged on GitHub
    client.prRows[0].state = 'closed';
    client.prRows[0].merged_at = null;
    const observed = service.observe(r.id);
    expect(observed.pr?.state).toBe('closed-unmerged');
    expect(observed.issueClosure).toBe('pending');
    expect(client.issueRows[0].state).toBe('open');

    // Local fixes the change with a new commit
    writeFileSync(path.join(root, 'replacement.txt'), 'replacement fix');
    command('add', '.');
    command('commit', '-qm', 'fix after closed PR');
    const newHead = currentHead();
    verify(r);
    review(r, {
      kind: 'delta',
      parent: r.reviews.at(-1)!.id,
      base: r.reviews.at(-1)!.head,
    });

    // Push new commit and create replacement PR
    service.push(r.id, 'full');
    const replacement = service.pr(r.id, 'full');
    expect(client.prWrites).toBe(2);
    expect(replacement.pr?.number).toBe(2);
    expect(replacement.pr?.state).toBe('open');
    expect(replacement.pr?.sha).toBe(newHead);
    expect(replacement.issueClosure).toBe('pending');
  });
  it('persists scopeConfirmation and confirmedBodyHash when binding existing issue and preserves them on observe', () => {
    const r = bind();
    grantAll(r);
    // Create an existing issue in the remote client first
    client.createIssue(
      'Existing issue',
      'Initial existing issue text\n\n<!-- comet:delivery=existing -->',
    );
    const issueNum = 1;
    const initialBodyHash = hash(client.issueRows[0].body);

    const bound = service.issue(r.id, {
      number: issueNum,
      expectedBodyHash: initialBodyHash,
      scopeConfirmation: 'User verified scope confirmation for issue #1',
    });

    expect(bound.issue).toMatchObject({
      number: issueNum,
      bodyHash: initialBodyHash,
      confirmedBodyHash: initialBodyHash,
      scopeConfirmation: 'User verified scope confirmation for issue #1',
    });

    // When observing / syncing issue later, the audit confirmation must be retained
    const observed = service.observe(r.id);
    expect(observed.issue?.scopeConfirmation).toBe('User verified scope confirmation for issue #1');
    expect(observed.issue?.confirmedBodyHash).toBe(initialBodyHash);
  });
  it('rejects resolves declared on an abandoned or unlinked review branch (resolves must be on active chain)', () => {
    let r = ready();
    // Review 1 reports a blocker
    review(r, {
      findings: [{ id: 'vuln-1', severity: 'critical', resolved: false, text: 'critical vuln' }],
    });
    expect(() => service.check(r.id, 'full')).toThrow('Unresolved review findings');

    // Builder creates commit A and records verification
    writeFileSync(path.join(root, 'commit-a.txt'), 'commit a');
    command('add', '.');
    command('commit', '-qm', 'commit a');
    verify(r);

    // An unlinked delta review claims to resolve vuln-1 on commit A
    review(r, {
      kind: 'delta',
      parent: r.reviews.at(-1)!.id,
      base: r.reviews.at(-1)!.head,
      resolves: ['vuln-1'],
    });

    // But then an alternative fix commit B is made
    writeFileSync(path.join(root, 'commit-b.txt'), 'commit b');
    command('add', '.');
    command('commit', '-qm', 'commit b');
    verify(r);

    // Active chain is a new full review on commit B that forgot to resolve vuln-1
    review(r);

    // Since the resolving review is NOT on the active chain of the latest review,
    // the critical finding vuln-1 must still block preflight!
    expect(() => service.check(r.id, 'full')).toThrow('Unresolved review findings');
  });
});
