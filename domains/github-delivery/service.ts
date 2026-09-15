import { randomUUID } from 'node:crypto';
import {
  runGitCommand,
  assertValidGitBranchName,
  GitCommandError,
} from '../../platform/process/git.js';
import type { DeliveryRecord, Operation, RemoteIssue, RemotePr } from './types.js';
import { DeliveryStore } from './store.js';
import { GithubCli, GithubOperationError, type GithubClient } from './github-cli.js';
import { hash, object, text, requireCondition } from './validation.js';
import { syncManifest } from './acceptance-manifest.js';
import { authorize, grant } from './authorization.js';
import { head, recordReview, recordVerification, carryVerification } from './review-receipt.js';
import {
  preflight,
  assertBinding,
  assertPushed,
  assertRepositoryBinding,
  remoteHead,
} from './delivery-preflight.js';
import {
  issueBody,
  managedBody,
  marker,
  acceptanceBlock,
  prBody,
} from './pull-request-renderer.js';

export class GithubDelivery {
  readonly store: DeliveryStore;
  constructor(
    readonly root: string,
    readonly clientFactory: (repository: string) => GithubClient = (repo) =>
      new GithubCli(root, repo),
  ) {
    this.store = new DeliveryStore(root);
  }
  bind(value: unknown): DeliveryRecord {
    return this.store.locked(() => {
      const input = object(value),
        repository = text(input.repository, 'Repository');
      requireCondition(
        /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository),
        'Repository must be owner/repo',
      );
      requireCondition(
        input.workflow === 'classic' || input.workflow === 'native',
        'Unsupported workflow',
      );
      const change = text(input.change, 'Change');
      requireCondition(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(change), 'Invalid change');
      const base = text(input.base, 'Base'),
        branch = text(input.head, 'Head'),
        remote = text(input.remote, 'Remote');
      assertValidGitBranchName(this.root, base);
      assertValidGitBranchName(this.root, branch);
      requireCondition(/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(remote), 'Invalid remote');
      assertRepositoryBinding(this.root, { repository, remote });
      const existing = this.store
        .records()
        .find((r) => r.binding.workflow === input.workflow && r.binding.change === change);
      if (existing) {
        requireCondition(
          existing.binding.repository === repository &&
            existing.binding.base === base &&
            existing.binding.head === branch &&
            existing.binding.remote === remote,
          'Existing binding cannot silently change targets',
        );
        return existing;
      }
      const summary = object(input.summary);
      const record: DeliveryRecord = {
        schema: 'comet.github-delivery.v1',
        id: randomUUID(),
        revision: 0,
        binding: {
          repository,
          workflow: input.workflow,
          change,
          base,
          head: branch,
          remote,
          baseSha: runGitCommand(this.root, ['merge-base', `refs/heads/${base}`, 'HEAD']),
        },
        summary: {
          title: text(summary.title, 'Title'),
          background: text(summary.background, 'Background'),
          changes: text(summary.changes, 'Changes'),
          impact: text(summary.impact, 'Impact'),
          nonGoals: text(summary.nonGoals, 'Non-goals'),
          compatibility: text(summary.compatibility, 'Compatibility'),
        },
        scope: syncManifest(this.root, null, input.scope),
        issue: null,
        verifications: [],
        reviews: [],
        grants: [],
        operations: [],
        push: null,
        pr: null,
        observedAt: null,
        issueClosure: 'pending',
      };
      // Binding is local and must not require gh or a clean implementation worktree.
      requireCondition(
        runGitCommand(this.root, ['branch', '--show-current']) === branch && base !== branch,
        'Bind the current feature branch, not the target',
      );
      if (repository.toLowerCase() === 'minicem/yuan-comet')
        requireCondition(
          base === 'enterprise/main',
          'Enterprise delivery requires enterprise/main',
        );
      this.store.save(record);
      return record;
    });
  }
  private mutation<T>(id: string, fn: (record: DeliveryRecord, client: GithubClient) => T): T {
    return this.store.locked(() => {
      const record = this.store.read(id);
      const result = fn(record, this.clientFactory(record.binding.repository));
      this.store.save(record);
      return result;
    });
  }
  local(id: string, action: string, input: unknown): DeliveryRecord {
    return this.mutation(id, (record) => {
      if (action === 'scope') record.scope = syncManifest(this.root, record.scope, input);
      else if (action === 'grant') grant(record, input);
      else if (action === 'verify') recordVerification(this.root, record, input);
      else if (action === 'carry') carryVerification(this.root, record, input);
      else if (action === 'review') recordReview(this.root, record, input);
      else throw new Error('Unknown local delivery action');
      return record;
    });
  }
  private prepared(
    record: DeliveryRecord,
    kind: Operation['kind'],
    body: (id: string) => string,
  ): Operation {
    const pending = record.operations.find(
      (o) => o.kind === kind && (o.status === 'prepared' || o.status === 'uncertain'),
    );
    requireCondition(
      !pending,
      `Uncertain ${kind}; use observe to reconcile operation ${pending?.id} before retry`,
    );
    const id = randomUUID();
    const op: Operation = { id, kind, body: body(id), head: head(this.root), status: 'prepared' };
    record.operations.push(op);
    this.store.save(record);
    return op;
  }
  private static isDefinitelyNotApplied(error: unknown): boolean {
    if (error instanceof GithubOperationError) return error.definitelyNotApplied;
    if (error instanceof GitCommandError) {
      return /permission denied|authentication|could not read|non-fast-forward|rejected|denied/i.test(
        error.stderr,
      );
    }
    return false;
  }
  private execute(
    record: DeliveryRecord,
    op: Operation,
    write: () => void,
    observe: () => boolean,
  ): void {
    let writeFailure: unknown;
    try {
      write();
    } catch (error) {
      writeFailure = error;
      op.status = GithubDelivery.isDefinitelyNotApplied(error) ? 'failed' : 'uncertain';
      this.store.save(record);
      if (op.status === 'failed') throw error;
    }
    try {
      requireCondition(
        observe(),
        writeFailure instanceof GithubOperationError
          ? writeFailure.message
          : 'Remote result not yet observable; use delivery observe, do not repeat create',
      );
      op.status = 'completed';
      this.store.save(record);
    } catch (error) {
      op.status = 'uncertain';
      this.store.save(record);
      throw error;
    }
  }
  private bindIssue(record: DeliveryRecord, issue: RemoteIssue, confirmed = false): void {
    requireCondition(!issue.pull_request, 'Cannot bind a pull request as an issue');
    requireCondition(
      !record.issue || record.issue.number === issue.number,
      'Cannot silently replace issue binding',
    );
    record.issue = {
      number: issue.number,
      url: issue.html_url,
      state: issue.state,
      bodyHash: confirmed || !record.issue ? hash(issue.body ?? '') : record.issue.bodyHash,
      scopeHash:
        (issue.body ?? '').includes(acceptanceBlock(record)) &&
        (confirmed || !record.issue || record.issue.bodyHash === hash(issue.body ?? ''))
          ? record.scope.hash
          : null,
    };
  }
  inspectIssue(id: string, value: unknown): { issue: RemoteIssue; bodyHash: string } {
    const record = this.store.read(id),
      input = object(value);
    const number = input.number ?? record.issue?.number;
    requireCondition(
      Number.isSafeInteger(number) && Number(number) > 0,
      'Provide a valid issue number',
    );
    const issue = this.clientFactory(record.binding.repository).issue(Number(number));
    return { issue, bodyHash: hash(issue.body ?? '') };
  }
  issue(id: string, value: unknown = {}): DeliveryRecord {
    return this.mutation(id, (record, client) => {
      assertRepositoryBinding(this.root, record.binding);
      const input = object(value);
      if (input.number !== undefined) {
        requireCondition(
          Number.isSafeInteger(input.number) && Number(input.number) > 0,
          'Invalid issue number',
        );
        const issue = client.issue(Number(input.number));
        requireCondition(
          input.expectedBodyHash === hash(issue.body ?? '') &&
            typeof input.scopeConfirmation === 'string' &&
            input.scopeConfirmation.trim(),
          'Existing issue requires current body hash and explicit whole-issue scope confirmation',
        );
        requireCondition(issue.state === 'open', 'Cannot bind a closed issue');
        this.bindIssue(record, issue);
        return record;
      }
      if (record.issue) return record;
      const previous = record.operations.find(
        (o) => o.kind === 'issue:create' && o.status !== 'failed',
      );
      if (previous) {
        requireCondition(
          this.reconcileIssue(record, client, previous),
          'Issue create is uncertain; observe before retry',
        );
        return record;
      }
      authorize(record, 'issue:create');
      const matches = client
        .issues()
        .filter((i) => (i.body ?? '').includes(`comet:delivery=${record.id}`));
      requireCondition(matches.length <= 1, 'Multiple matching issues; reconcile manually');
      if (matches[0]) {
        this.bindIssue(record, matches[0]);
        return record;
      }
      const op = this.prepared(record, 'issue:create', (operation) => issueBody(record, operation));
      this.execute(
        record,
        op,
        () => {
          assertRepositoryBinding(this.root, record.binding);
          client.createIssue(record.summary.title, op.body);
        },
        () => this.reconcileIssue(record, client, op),
      );
      return record;
    });
  }
  private reconcileIssue(record: DeliveryRecord, client: GithubClient, op: Operation): boolean {
    const issues = op.remoteRef
      ? [client.issue(op.remoteRef)]
      : client.issues().filter((i) => (i.body ?? '').includes(marker(record, op.id)));
    requireCondition(issues.length <= 1, 'Multiple matching issues; cannot reconcile');
    if (!issues[0]) return false;
    this.bindIssue(record, issues[0]);
    op.remoteRef = issues[0].number;
    op.status = 'completed';
    return true;
  }
  syncIssue(id: string, value: unknown): DeliveryRecord {
    return this.mutation(id, (record, client) => {
      assertRepositoryBinding(this.root, record.binding);
      requireCondition(record.issue, 'Bind issue first');
      authorize(record, 'issue:update');
      const issue = client.issue(record.issue.number),
        input = object(value);
      requireCondition(issue.state === 'open', 'Issue is closed');
      requireCondition(
        input.expectedBodyHash === hash(issue.body ?? ''),
        'Issue changed; re-read before updating',
      );
      const body = managedBody(record, issue.body ?? '');
      if (body === issue.body) {
        this.bindIssue(record, issue, true);
        return record;
      }
      const op = this.prepared(record, 'issue:update', () => body);
      op.remoteRef = issue.number;
      this.store.save(record);
      this.execute(
        record,
        op,
        () => {
          assertRepositoryBinding(this.root, record.binding);
          requireCondition(
            hash(client.issue(issue.number).body ?? '') === input.expectedBodyHash,
            'Concurrent issue edit detected',
          );
          client.updateIssue(issue.number, body);
        },
        () => {
          const observed = client.issue(issue.number);
          this.bindIssue(record, observed, observed.body === body);
          return observed.body === body;
        },
      );
      return record;
    });
  }
  check(id: string, resolution: 'full' | 'partial'): DeliveryRecord {
    const r = this.store.read(id);
    preflight(this.root, r, resolution);
    return r;
  }
  push(id: string, resolution: 'full' | 'partial'): DeliveryRecord {
    return this.mutation(id, (record, client) => {
      preflight(this.root, record, resolution, 'push');
      const priorPr = record.operations.find(
        (op) => op.kind === 'pull-request:create' && op.status !== 'failed',
      );
      if (priorPr) {
        requireCondition(
          this.reconcilePr(record, client, priorPr, priorPr.resolution ?? 'partial'),
          'PR create is uncertain; observe before any push',
        );
        requireCondition(
          record.pr?.state === 'open',
          'PR already closed or merged; do not recreate its remote branch',
        );
      }
      if (record.push?.sha === head(this.root))
        requireCondition(
          remoteHead(this.root, record) === record.push.sha,
          'Previously pushed branch drifted; do not overwrite during recovery',
        );
      if (remoteHead(this.root, record) === head(this.root)) {
        record.push = { sha: head(this.root), observedAt: new Date().toISOString() };
        return record;
      }
      const op = this.prepared(record, 'push', () => '');
      this.execute(
        record,
        op,
        () => {
          assertRepositoryBinding(this.root, record.binding);
          runGitCommand(this.root, [
            'push',
            '--',
            record.binding.remote,
            `${op.head}:refs/heads/${record.binding.head}`,
          ]);
        },
        () => {
          if (remoteHead(this.root, record) !== op.head) return false;
          record.push = { sha: op.head, observedAt: new Date().toISOString() };
          return true;
        },
      );
      return record;
    });
  }
  private capturePr(
    record: DeliveryRecord,
    pr: RemotePr,
    resolution: 'full' | 'partial',
    expectedSha: string,
  ): boolean {
    const repository = record.binding.repository.toLowerCase();
    const driftReason =
      pr.base.repo.full_name.toLowerCase() !== repository
        ? 'PR repository drifted from delivery binding'
        : pr.base.ref !== record.binding.base
          ? 'PR target branch drifted from delivery binding'
          : pr.head.repo?.full_name.toLowerCase() !== repository
            ? 'PR head repository drifted from delivery binding'
            : pr.head.ref !== record.binding.head
              ? 'PR head branch drifted from delivery binding'
              : pr.head.sha !== expectedSha
                ? 'PR HEAD drifted from the verified and reviewed delivery SHA'
                : null;
    record.pr = {
      number: pr.number,
      url: pr.html_url,
      state: pr.merged_at ? 'merged' : pr.state === 'closed' ? 'closed-unmerged' : 'open',
      sha: expectedSha,
      observedSha: pr.head.sha,
      drifted: driftReason !== null,
      driftReason,
      resolution,
    };
    return driftReason === null;
  }
  private deliveredPrSha(record: DeliveryRecord, number: number): string {
    return (
      record.operations.find(
        (operation) => operation.kind === 'pull-request:create' && operation.remoteRef === number,
      )?.head ??
      record.pr?.sha ??
      ''
    );
  }
  private reconcilePr(
    record: DeliveryRecord,
    client: GithubClient,
    op: Operation,
    resolution: 'full' | 'partial',
  ): boolean {
    const matches = op.remoteRef
      ? [client.pr(op.remoteRef)]
      : client.prs().filter((p) => (p.body ?? '').includes(marker(record, op.id)));
    requireCondition(matches.length <= 1, 'Multiple matching PRs; cannot reconcile');
    const pr = matches[0];
    if (!pr) return false;
    const matchesDelivery = this.capturePr(record, pr, resolution, op.head);
    op.remoteRef = pr.number;
    op.status = 'completed';
    this.store.save(record);
    requireCondition(
      matchesDelivery,
      record.pr?.driftReason ?? 'PR drifted from the verified and reviewed delivery',
    );
    if (!pr.merged_at && pr.state === 'open') {
      requireCondition(
        pr.body === op.body,
        'PR exists but body changed; inspect acceptance and issue relation before continuing',
      );
      requireCondition(
        pr.head.sha === head(this.root),
        'Existing PR does not deliver current local HEAD',
      );
    }
    return true;
  }
  pr(
    id: string,
    resolution: 'full' | 'partial',
    provider?: (record: DeliveryRecord, body: string) => void,
  ): DeliveryRecord {
    return this.mutation(id, (record, client) => {
      const prior = record.operations.find(
        (o) => o.kind === 'pull-request:create' && o.status !== 'failed',
      );
      if (prior) {
        requireCondition(
          this.reconcilePr(
            record,
            client,
            prior,
            prior.resolution ?? record.pr?.resolution ?? resolution,
          ),
          'PR create uncertain; observe only',
        );
        if (record.pr?.state === 'open')
          preflight(this.root, record, prior.resolution ?? resolution);
        return record;
      }
      preflight(this.root, record, resolution);
      assertPushed(this.root, record);
      const issue = client.issue(record.issue!.number);
      requireCondition(
        issue.state === 'open' &&
          (issue.body ?? '').includes(acceptanceBlock(record)) &&
          hash(issue.body ?? '') === record.issue!.bodyHash,
        'Issue scope drift or issue closed; reconcile before PR',
      );
      requireCondition(
        !client
          .prs()
          .some(
            (p) =>
              p.state === 'open' &&
              p.head.ref === record.binding.head &&
              p.base.ref === record.binding.base &&
              p.head.repo?.full_name.toLowerCase() === record.binding.repository.toLowerCase(),
          ),
        'An existing PR needs explicit reconciliation; will not create duplicate',
      );
      const op = this.prepared(record, 'pull-request:create', (operation) =>
        prBody(record, operation, resolution),
      );
      op.resolution = resolution;
      this.store.save(record);
      this.execute(
        record,
        op,
        () => {
          assertRepositoryBinding(this.root, record.binding);
          assertPushed(this.root, record);
          if (provider) provider(record, op.body);
          else
            client.createPr(
              record.summary.title,
              op.body,
              record.binding.base,
              record.binding.head,
            );
        },
        () => this.reconcilePr(record, client, op, resolution),
      );
      return record;
    });
  }
  observe(id: string): DeliveryRecord {
    return this.mutation(id, (record, client) => {
      for (const op of record.operations.filter(
        (o) => o.status === 'prepared' || o.status === 'uncertain',
      )) {
        if (op.kind === 'issue:create') this.reconcileIssue(record, client, op);
        else if (op.kind === 'pull-request:create')
          this.reconcilePr(record, client, op, op.resolution ?? 'partial');
        else if (op.kind === 'issue:update' && op.remoteRef) {
          const issue = client.issue(op.remoteRef);
          if (issue.body === op.body) {
            op.status = 'completed';
            this.bindIssue(record, issue, true);
          }
        } else if (op.kind === 'push') {
          assertBinding(this.root, record);
          if (remoteHead(this.root, record) === op.head) {
            op.status = 'completed';
            record.push = { sha: op.head, observedAt: new Date().toISOString() };
          }
        }
      }
      if (record.pr)
        this.capturePr(
          record,
          client.pr(record.pr.number),
          record.pr.resolution,
          this.deliveredPrSha(record, record.pr.number),
        );
      if (record.issue) this.bindIssue(record, client.issue(record.issue.number));
      record.issueClosure = record.pr?.drifted
        ? 'pending'
        : record.pr?.resolution === 'partial'
          ? 'not-applicable'
          : record.pr?.state === 'merged' && record.issue?.state === 'closed'
            ? 'closed'
            : 'pending';
      record.observedAt = new Date().toISOString();
      return record;
    });
  }
}
