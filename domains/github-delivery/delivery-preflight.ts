import { runGitCommand, gitWorktreeIsClean } from '../../platform/process/git.js';
import type { DeliveryRecord } from './types.js';
import { requireCondition } from './validation.js';
import { assertReview, head } from './review-receipt.js';
import { assertSources } from './acceptance-manifest.js';
import { authorize } from './authorization.js';

export function assertRepositoryBinding(
  root: string,
  binding: Pick<DeliveryRecord['binding'], 'repository' | 'remote'>,
): void {
  const urls = runGitCommand(root, ['remote', 'get-url', '--push', '--all', binding.remote])
    .split('\n')
    .filter(Boolean);
  requireCondition(urls.length > 0, 'No push URL configured for the delivery remote');
  for (const url of urls) {
    const match = /^(?:https:\/\/github\.com\/|git@github\.com:)([^\s]+?)(?:\.git)?$/.exec(url);
    requireCondition(
      match && match[1].toLowerCase() === binding.repository.toLowerCase(),
      'Push remote does not match the bound GitHub repository',
    );
  }
}

export function assertBinding(root: string, record: DeliveryRecord): void {
  const b = record.binding;
  requireCondition(
    runGitCommand(root, ['branch', '--show-current']) === b.head,
    'Wrong delivery head branch',
  );
  requireCondition(b.head !== b.base, 'Delivery cannot push the target branch');
  if (b.repository.toLowerCase() === 'minicem/yuan-comet')
    requireCondition(b.base === 'enterprise/main', 'Enterprise delivery requires enterprise/main');
  assertRepositoryBinding(root, b);
  requireCondition(gitWorktreeIsClean(root), 'Delivery requires a clean committed worktree');
}
export function assertRemoteBaseline(root: string, record: DeliveryRecord): void {
  const result = runGitCommand(root, [
    'ls-remote',
    '--heads',
    record.binding.remote,
    `refs/heads/${record.binding.base}`,
  ]);
  requireCondition(
    result !== '',
    'Remote base branch does not exist; cannot verify review baseline',
  );
  const remoteBaseSha = result.split(/\s/)[0];
  // The binding baseSha (merge-base of local base and HEAD at bind time) must be an ancestor of
  // the current remote base.  If the local base was ahead of the remote at bind time, the
  // merge-base would be too recent and the review would miss commits that are part of the PR diff.
  try {
    runGitCommand(root, ['merge-base', '--is-ancestor', record.binding.baseSha, remoteBaseSha]);
  } catch {
    requireCondition(
      false,
      'Review baseline is ahead of the remote target branch; the PR would contain unreviewed code. ' +
        'Re-bind after syncing the local base branch with the remote',
    );
  }
}
export function preflight(
  root: string,
  record: DeliveryRecord,
  resolution: 'full' | 'partial' = 'full',
  action: 'push' | 'pull-request:create' | 'pull-request:update' = 'pull-request:create',
): void {
  assertBinding(root, record);
  assertRemoteBaseline(root, record);
  requireCondition(
    !record.pr?.drifted,
    record.pr?.driftReason ?? 'Observed PR drift blocks delivery',
  );
  requireCondition(record.issue, 'Bind an issue before PR delivery');
  requireCondition(record.scope.committedKeys.length > 0, 'Empty acceptance scope');
  requireCondition(
    record.issue.scopeHash === record.scope.hash,
    'Issue acceptance has not been synchronized',
  );
  if (resolution === 'full')
    requireCondition(
      record.scope.items
        .filter((i) => !i.retired)
        .every((i) => record.scope.committedKeys.includes(i.key)),
      'Partial acceptance cannot close the issue',
    );
  assertSources(root, record);
  assertReview(root, record);
  authorize(record, 'push');
  if (action !== 'push') authorize(record, action);
}
export function remoteHead(root: string, record: DeliveryRecord): string | null {
  const result = runGitCommand(root, [
    'ls-remote',
    '--heads',
    record.binding.remote,
    `refs/heads/${record.binding.head}`,
  ]);
  return result ? result.split(/\s/)[0] : null;
}
export function assertPushed(root: string, record: DeliveryRecord): void {
  requireCondition(
    remoteHead(root, record) === head(root),
    'Remote branch does not match the reviewed HEAD; push or resolve drift',
  );
}
