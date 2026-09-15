import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { runGitCommand, gitWorktreeIsClean } from '../../platform/process/git.js';
import type { DeliveryRecord, Verification, Review, Evidence, ReviewFinding } from './types.js';
import { hash, object, text, list, requireCondition } from './validation.js';
import { assertSources } from './acceptance-manifest.js';
export function head(root: string): string {
  return runGitCommand(root, ['rev-parse', 'HEAD']);
}
export function diffHash(root: string, base: string, end: string): string {
  requireCondition(
    /^[a-f0-9]{40,64}$/.test(base) && /^[a-f0-9]{40,64}$/.test(end),
    'Invalid commit SHA',
  );
  runGitCommand(root, ['merge-base', '--is-ancestor', base, end]);
  return hash(runGitCommand(root, ['diff', '--binary', base, end]));
}
export function recordVerification(
  root: string,
  record: DeliveryRecord,
  value: unknown,
): Verification {
  requireCondition(
    gitWorktreeIsClean(root),
    'Commit the reviewed/verified changes before recording evidence',
  );
  assertSources(root, record);
  const input = object(value);
  requireCondition(
    input.head === head(root) && input.manifest === record.scope.hash,
    'Verification HEAD or manifest is stale',
  );
  const seen = new Set<string>();
  const items = list(input.items, 'Verification items').map((raw): Evidence => {
    const item = object(raw),
      key = text(item.key, 'AC key');
    const ac = record.scope.items.find((i) => i.key === key);
    requireCondition(
      ac && !ac.retired && !seen.has(key) && ac.revision === item.revision,
      'Unknown, duplicate or stale verification AC',
    );
    seen.add(key);
    requireCondition(
      item.status === 'passed' || item.status === 'failed' || item.status === 'not-run',
      'Invalid verification status',
    );
    const evidence = list(item.evidence, 'Evidence').map((e) => text(e, 'Evidence reference'));
    requireCondition(item.status !== 'passed' || evidence.length > 0, 'PASS requires evidence');
    return {
      key,
      revision: ac.revision,
      status: item.status,
      evidence,
      reason: text(item.reason, 'Verification reason'),
    };
  });
  requireCondition(
    record.scope.committedKeys.every((k) => seen.has(k)),
    'Verification must report every committed AC',
  );
  const snapshot = { head: input.head as string, manifest: record.scope.hash, items };
  const result = { ...snapshot, hash: hash(snapshot) };
  record.verifications.push(result);
  return result;
}
export function currentVerification(record: DeliveryRecord): Verification {
  const verification = record.verifications.at(-1);
  requireCondition(
    verification && verification.manifest === record.scope.hash,
    'Missing or stale verification; run verification for current scope',
  );
  requireCondition(
    verification.hash === verificationDigest(verification),
    'Verification snapshot hash mismatch',
  );
  for (const key of record.scope.committedKeys) {
    const ac = record.scope.items.find((i) => i.key === key);
    const matches = verification.items.filter((i) => i.key === key);
    requireCondition(
      ac &&
        !ac.retired &&
        matches.length === 1 &&
        matches[0].revision === ac.revision &&
        matches[0].status === 'passed' &&
        matches[0].evidence.length > 0,
      `Acceptance ${key} is not effectively passed`,
    );
  }
  return verification;
}
export function recordReview(root: string, record: DeliveryRecord, value: unknown): Review {
  requireCondition(gitWorktreeIsClean(root), 'Review requires a clean committed worktree');
  const input = object(value),
    current = head(root),
    verification = currentVerification(record);
  requireCondition(
    input.head === current &&
      input.manifest === record.scope.hash &&
      input.verification === verification.hash,
    'Review context is stale',
  );
  const reviewer = text(input.reviewer, 'Reviewer execution'),
    builder = text(input.builder, 'Builder execution');
  requireCondition(
    reviewer !== builder,
    'Review must be performed by a distinct reviewer execution',
  );
  requireCondition(
    input.kind === 'full' || input.kind === 'delta',
    'Review kind must be full or delta',
  );
  const parent =
    input.kind === 'delta' ? record.reviews.find((r) => r.id === input.parent) : undefined;
  const base = input.kind === 'full' ? record.binding.baseSha : parent?.head;
  requireCondition(
    base && input.base === base,
    'Review base must match full baseline or parent receipt HEAD',
  );
  if (parent)
    requireCondition(
      parent.manifest === record.scope.hash,
      'Manifest changed; require full review',
    );
  requireCondition(
    verification.head === current,
    'Record current verification before review; use archive verification carry only for inspected nonbehavioral deltas',
  );
  const resolves =
    input.resolves !== undefined
      ? list(input.resolves, 'Resolves').map((r) => text(r, 'Resolved finding ID'))
      : [];
  const historicalFindings = new Map<string, ReviewFinding>();
  const resolvedIds = new Set<string>();
  for (const prev of record.reviews) {
    for (const f of prev.findings) {
      historicalFindings.set(f.id, f);
      if (f.resolved) resolvedIds.add(f.id);
    }
    for (const resId of prev.resolves ?? []) {
      resolvedIds.add(resId);
    }
  }
  for (const resId of resolves) {
    requireCondition(historicalFindings.has(resId), `Cannot resolve unknown finding ID: ${resId}`);
    requireCondition(!resolvedIds.has(resId), `Finding ID ${resId} is already resolved`);
    resolvedIds.add(resId);
  }
  const seenFindingIds = new Set<string>();
  const findings = list(input.findings, 'Review findings').map((raw, index): ReviewFinding => {
    const f = object(raw);
    requireCondition(
      f.severity === 'critical' || f.severity === 'important' || f.severity === 'suggestion',
      'Invalid finding severity',
    );
    requireCondition(typeof f.resolved === 'boolean', 'Finding resolved must be boolean');
    const id =
      typeof f.id === 'string' && f.id.trim()
        ? f.id.trim()
        : `finding-${record.reviews.length + 1}-${index + 1}`;
    requireCondition(!seenFindingIds.has(id), `Duplicate finding ID in review: ${id}`);
    requireCondition(
      !historicalFindings.has(id),
      `Finding ID already exists in prior review: ${id}`,
    );
    seenFindingIds.add(id);
    return { id, severity: f.severity, resolved: f.resolved, text: text(f.text, 'Finding text') };
  });
  const receipt: Review = {
    id: randomUUID(),
    kind: input.kind,
    parent: parent?.id ?? null,
    base,
    head: current,
    diff: diffHash(root, base, current),
    manifest: record.scope.hash,
    verification: verification.hash,
    reviewer,
    builder,
    evidence: text(input.evidence, 'Review evidence'),
    findings,
    resolves,
  };
  record.reviews.push(receipt);
  return receipt;
}
export function assertReview(root: string, record: DeliveryRecord): void {
  const verification = currentVerification(record);
  requireCondition(verification.head === head(root), 'Verification does not cover final HEAD');
  let receipt = record.reviews.at(-1);
  requireCondition(
    receipt && receipt.head === head(root) && receipt.verification === verification.hash,
    'Review missing or stale for final HEAD',
  );
  const seen = new Set<string>();
  while (receipt) {
    requireCondition(!seen.has(receipt.id), 'Cyclic review chain');
    seen.add(receipt.id);
    requireCondition(
      receipt.manifest === record.scope.hash &&
        receipt.diff === diffHash(root, receipt.base, receipt.head),
      'Review coverage is stale',
    );
    requireCondition(
      receipt.reviewer !== receipt.builder && receipt.evidence,
      'Invalid review execution',
    );
    const historical = record.verifications.find((v) => v.hash === receipt!.verification);
    requireCondition(
      historical && historical.head === receipt.head && historical.manifest === receipt.manifest,
      'Missing historical verification snapshot',
    );
    if (receipt.kind === 'full') {
      requireCondition(
        receipt.parent === null && receipt.base === record.binding.baseSha,
        'Invalid full review baseline',
      );
      break;
    }
    const parent: Review | undefined = record.reviews.find((r) => r.id === receipt!.parent);
    requireCondition(parent && parent.head === receipt.base, 'Broken review coverage chain');
    receipt = parent;
  }
  // A new full or delta review must not silently discard unresolved blockers from prior reviews.
  // Calculate remaining unresolved critical and important findings across all recorded receipts.
  // Any historical blocker must be explicitly resolved by a review receipt on the active verified chain.
  const unresolvedBlockers = new Map<string, ReviewFinding>();
  for (const review of record.reviews) {
    for (const f of review.findings) {
      if (f.severity !== 'suggestion' && !f.resolved) {
        unresolvedBlockers.set(f.id, f);
      }
    }
  }
  for (const review of record.reviews) {
    if (seen.has(review.id)) {
      for (const resId of review.resolves ?? []) {
        unresolvedBlockers.delete(resId);
      }
    }
  }
  requireCondition(unresolvedBlockers.size === 0, 'Unresolved review findings');
}

function verificationDigest(verification: Verification): string {
  return hash({
    head: verification.head,
    manifest: verification.manifest,
    items: verification.items,
    ...(verification.carry ? { carry: verification.carry } : {}),
  });
}
export function carryVerification(
  root: string,
  record: DeliveryRecord,
  value: unknown,
): Verification {
  requireCondition(gitWorktreeIsClean(root), 'Commit archive changes before carry');
  const input = object(value),
    previous = currentVerification(record),
    current = head(root);
  requireCondition(
    input.head === current && input.parent === previous.hash,
    'Carry context is stale',
  );
  assertSources(root, record);
  const diff = diffHash(root, previous.head, current);
  // Only identical-content document renames (not implementation/Skill/config renames)
  // or an empty commit can retain evidence without rerunning verification.
  const changes = runGitCommand(root, ['diff', '--name-status', '-M100%', previous.head, current])
    .split('\n')
    .filter(Boolean);
  for (const change of changes) {
    const [status, before, after] = change.split('\t');
    requireCondition(
      status === 'R100' &&
        record.scope.items.some((item) => item.source === before) &&
        after?.includes('/archive/') &&
        [before, after].every(
          (file) =>
            file &&
            !/^(?:app|domains|platform|assets|scripts|test|config|\.)[/]/.test(file) &&
            path.extname(file) === '.md',
        ),
      'Archive delta changes content or behavior; rerun affected verification',
    );
  }
  const snapshot = { head: previous.head, manifest: previous.manifest, items: previous.items };
  const next = {
    ...snapshot,
    head: current,
    carry: {
      parent: previous.hash,
      diff,
      evidence: text(input.evidence, 'Archive applicability evidence'),
    },
  };
  const result = { ...next, hash: hash(next) };
  record.verifications.push(result);
  return result;
}
