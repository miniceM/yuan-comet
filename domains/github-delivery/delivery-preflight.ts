import { runGitCommand, gitWorktreeIsClean } from '../../platform/process/git.js';
import type { DeliveryRecord } from './types.js';
import { requireCondition } from './validation.js';
import { assertReview, head } from './review-receipt.js';
import { assertSources } from './acceptance-manifest.js';
import { authorize } from './authorization.js';
export function assertBinding(root: string, record: DeliveryRecord): void {
  const b = record.binding;
  requireCondition(
    runGitCommand(root, ['branch', '--show-current']) === b.head,
    'Wrong delivery head branch',
  );
  requireCondition(b.head !== b.base, 'Delivery cannot push the target branch');
  if (b.repository.toLowerCase() === 'minicem/yuan-comet')
    requireCondition(b.base === 'enterprise/main', 'Enterprise delivery requires enterprise/main');
  const remote = runGitCommand(root, ['remote', 'get-url', '--push', b.remote]);
  const match = /^(?:https:\/\/github\.com\/|git@github\.com:)([^\s]+?)(?:\.git)?$/.exec(remote);
  requireCondition(
    match && match[1].toLowerCase() === b.repository.toLowerCase(),
    'Push remote does not match the bound GitHub repository',
  );
  requireCondition(gitWorktreeIsClean(root), 'Delivery requires a clean committed worktree');
}
export function preflight(
  root: string,
  record: DeliveryRecord,
  resolution: 'full' | 'partial' = 'full',
  action: 'push' | 'pull-request:create' = 'pull-request:create',
): void {
  assertBinding(root, record);
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
  if (action === 'pull-request:create') authorize(record, 'pull-request:create');
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
