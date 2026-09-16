import { GitCommandError } from '../../platform/process/git.js';
import { DeliveryStore } from './store.js';
import { requireCondition } from './validation.js';
import { GithubDelivery } from './service.js';
import type { DeliveryRecord, Workflow } from './types.js';
export function findWorkflowDelivery(
  root: string,
  workflow: Workflow,
  change: string,
): DeliveryRecord | null {
  try {
    return (
      new DeliveryStore(root)
        .records()
        .find((r) => r.binding.workflow === workflow && r.binding.change === change) ?? null
    );
  } catch (error) {
    if (
      error instanceof GitCommandError &&
      /not a git repository|cannot change to/i.test(error.stderr)
    )
      return null;
    throw error;
  }
}
export function pushWorkflowDelivery(
  root: string,
  workflow: Workflow,
  change: string,
  expected?: { base: string; head: string; remote: string },
): boolean {
  const record = findWorkflowDelivery(root, workflow, change);
  if (!record) return false;
  if (expected)
    requireCondition(
      record.binding.base === expected.base &&
        record.binding.head === expected.head &&
        record.binding.remote === expected.remote,
      'Workflow target does not match delivery binding',
    );
  const service = new GithubDelivery(root);
  const resolution = record.scope.items
    .filter((i) => !i.retired)
    .every((i) => record.scope.committedKeys.includes(i.key))
    ? 'full'
    : 'partial';
  service.push(record.id, resolution);
  return true;
}
export function finishWorkflowDelivery(
  root: string,
  workflow: Workflow,
  change: string,
  provider?: (record: DeliveryRecord, body: string) => void,
  expected?: { base: string; head: string; remote: string },
): DeliveryRecord | null {
  const record = findWorkflowDelivery(root, workflow, change);
  if (!record) return null;
  if (expected)
    requireCondition(
      record.binding.base === expected.base &&
        record.binding.head === expected.head &&
        record.binding.remote === expected.remote,
      'Workflow target does not match delivery binding',
    );
  const service = new GithubDelivery(root);
  const resolution = record.scope.items
    .filter((i) => !i.retired)
    .every((i) => record.scope.committedKeys.includes(i.key))
    ? 'full'
    : 'partial';
  return service.pr(record.id, resolution, provider);
}
