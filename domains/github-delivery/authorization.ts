import type { Action, DeliveryRecord } from './types.js';
import { object, text, requireCondition } from './validation.js';
export function grant(record: DeliveryRecord, value: unknown): void {
  const input = object(value);
  requireCondition(
    ['issue:create', 'issue:update', 'push', 'pull-request:create'].includes(String(input.action)),
    'Unsupported authorization action',
  );
  const action = input.action as Action;
  if (action === 'issue:update')
    requireCondition(record.issue !== null, 'Bind an issue before granting update');
  record.grants.push({
    action,
    source: text(input.source, 'Explicit user authorization reference'),
    grantedAt: new Date().toISOString(),
    issueNumber: action === 'issue:update' ? record.issue!.number : null,
  });
}
export function authorize(record: DeliveryRecord, action: Action): void {
  requireCondition(
    record.grants.some(
      (g) =>
        g.action === action &&
        (action !== 'issue:update' || g.issueNumber === record.issue?.number),
    ),
    `Missing explicit authorization: ${action}`,
  );
}
