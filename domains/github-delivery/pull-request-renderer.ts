import type { DeliveryRecord } from './types.js';
export function marker(record: DeliveryRecord, operation?: string): string {
  return `<!-- comet:delivery=${record.id}${operation ? ` operation=${operation}` : ''} -->`;
}
export function acceptanceBlock(record: DeliveryRecord): string {
  return [
    `<!-- comet:acceptance:start delivery=${record.id} -->`,
    ...record.scope.items.map(
      (i) =>
        `- [ ] ${i.key} (r${i.revision}${i.retired ? ', retired' : ''}): ${i.text.replaceAll('\n', ' ')}`,
    ),
    `<!-- comet:acceptance:end delivery=${record.id} -->`,
  ].join('\n');
}
export function managedBody(record: DeliveryRecord, existing: string): string {
  const start = `<!-- comet:acceptance:start delivery=${record.id} -->`,
    end = `<!-- comet:acceptance:end delivery=${record.id} -->`;
  const a = existing.indexOf(start),
    b = existing.indexOf(end);
  if (a === -1 && b === -1) return `${existing}\n\n${acceptanceBlock(record)}\n${marker(record)}`;
  if (
    a < 0 ||
    b < a ||
    existing.indexOf(start, a + start.length) !== -1 ||
    existing.indexOf(end, b + end.length) !== -1
  )
    throw new Error('Ambiguous managed acceptance block; resolve issue content conflict');
  return existing.slice(0, a) + acceptanceBlock(record) + existing.slice(b + end.length);
}
export function issueBody(record: DeliveryRecord, operation: string): string {
  const s = record.summary;
  return `## Background\n\n${s.background}\n\n## Changes\n\n${s.changes}\n\n## Impact\n\n${s.impact}\n\n## Non-goals\n\n${s.nonGoals}\n\n## Acceptance\n\n${acceptanceBlock(record)}\n\n${marker(record, operation)}\n`;
}
export function prBody(
  record: DeliveryRecord,
  operation: string,
  resolution: 'full' | 'partial',
): string {
  const s = record.summary,
    v = record.verifications.at(-1)!;
  const cell = (value: string): string => value.replaceAll('|', '\\|').replaceAll('\n', '<br>');
  const rows = record.scope.items
    .filter((i) => !i.retired)
    .map((i) => {
      const included = record.scope.committedKeys.includes(i.key),
        evidence = v.items.find((e) => e.key === i.key);
      return `| ${i.key} | ${included ? (evidence?.status ?? 'not-run') : 'Outside this delivery'} | ${cell(included ? (evidence?.evidence.join('; ') ?? '') : 'Issue remains open')} |`;
    });
  const allResolves = new Set(record.reviews.flatMap((r) => r.resolves ?? []));
  const reviewLines = record.reviews.map((r) => {
    const resolvesTag =
      r.resolves && r.resolves.length > 0 ? `; resolves: ${r.resolves.join(', ')}` : '';
    const findingLines = r.findings.map(
      (f) =>
        `  - ${f.severity} [${f.id}]: ${f.text} (${f.resolved || allResolves.has(f.id) ? 'resolved' : 'open'})`,
    );
    const sub = findingLines.length > 0 ? `\n${findingLines.join('\n')}` : '';
    return `- ${r.kind}: ${r.base}..${r.head}; reviewer: ${r.reviewer}; evidence: ${r.evidence}${resolvesTag}${sub}`;
  });
  return `## Summary\n\n${s.changes}\n\n## Scope / Impact\n\n${s.impact}\n\n## Compatibility / Migration / Rollback\n\n${s.compatibility}\n\n## Acceptance\n\n| AC | Result | Evidence |\n| --- | --- | --- |\n${rows.join('\n')}\n\n## Review\n\n${reviewLines.join('\n')}\n\n## Verification\n\nLocal evidence recorded for ${v.head}.\n${v.items.map((i) => `- ${i.key}: ${i.status} — ${i.reason}`).join('\n')}\n\nCI: Pending; local verification does not prove CI passed.\n\n## Issue\n\n${resolution === 'full' ? 'Closes' : 'Related to'} #${record.issue!.number}\n\n${marker(record, operation)}\n`;
}
