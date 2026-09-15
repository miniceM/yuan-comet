import { readFileSync } from 'node:fs';
import path from 'node:path';
import { runGitCommand } from '../../platform/process/git.js';
import { existsSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import type { DeliveryRecord } from './types.js';
import { hash, list, object, requireCondition, text } from './validation.js';
export function sourceText(root: string, ref: string): string {
  requireCondition(!path.isAbsolute(ref), 'Acceptance source must be project-relative');
  const target = path.resolve(root, ref);
  requireCondition(existsSync(target), `Acceptance source not found: ${ref}`);
  const file = realpathSync(target);
  const relative = path.relative(realpathSync(root), file);
  requireCondition(
    relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative),
    'Acceptance source escaped project',
  );
  return readFileSync(file, 'utf8');
}
export function syncManifest(
  root: string,
  old: DeliveryRecord['scope'] | null,
  value: unknown,
): DeliveryRecord['scope'] {
  const input = object(value);
  const confirmation = text(input.confirmation, 'Scope confirmation');
  const seen = new Set<string>();
  let next = Math.max(0, ...(old?.items ?? []).map((i) => Number(i.key.slice(3)))) + 1;
  const items = list(input.items, 'Acceptance items').map((raw) => {
    const item = object(raw);
    const key =
      item.key === undefined ? `AC-${String(next++).padStart(2, '0')}` : text(item.key, 'AC key');
    requireCondition(/^AC-\d{2,}$/.test(key) && !seen.has(key), 'Duplicate or invalid AC key');
    seen.add(key);
    const previous = old?.items.find((i) => i.key === key);
    requireCondition(
      !old || previous || item.key === undefined,
      'New AC must receive a fresh generated key',
    );
    const source = text(item.source, 'Acceptance source');
    const content = text(item.text, 'Acceptance text');
    requireCondition(
      item.retired === undefined || typeof item.retired === 'boolean',
      'retired must be boolean',
    );
    const retired = item.retired === true;
    requireCondition(
      retired || sourceText(root, source).includes(content),
      `Acceptance ${key} not found in source ${source}`,
    );
    return {
      key,
      source,
      sourceHash: retired ? (previous?.sourceHash ?? '') : hash(sourceText(root, source)),
      text: content,
      internalRef: text(item.internalRef, 'Internal reference'),
      retired,
      revision: previous
        ? previous.revision +
          Number(
            previous.text !== content || previous.retired !== retired || previous.source !== source,
          )
        : 1,
    };
  });
  for (const previous of old?.items ?? [])
    requireCondition(
      seen.has(previous.key),
      `AC ${previous.key} cannot disappear; retire it with confirmation`,
    );
  const keys =
    input.committedKeys === undefined
      ? items.filter((i) => !i.retired).map((i) => i.key)
      : list(input.committedKeys, 'Committed keys').map((k) => text(k, 'AC key'));
  requireCondition(
    keys.length > 0 &&
      new Set(keys).size === keys.length &&
      keys.every((k) => items.some((i) => i.key === k && !i.retired)),
    'Committed scope must be nonempty, unique and active',
  );
  const digest = hash({ items, committedKeys: keys });
  if (old && old.hash !== digest)
    requireCondition(
      confirmation !== old.confirmation,
      'Scope change requires a new explicit confirmation reference',
    );
  return {
    revision: old ? old.revision + Number(old.hash !== digest) : 1,
    confirmation,
    items,
    committedKeys: keys,
    hash: digest,
  };
}
export function assertSources(root: string, record: DeliveryRecord): void {
  for (const item of record.scope.items.filter((i) => !i.retired)) {
    if (existsSync(path.resolve(root, item.source))) {
      runGitCommand(root, ['ls-files', '--error-unmatch', '--', item.source]);
      requireCondition(
        hash(sourceText(root, item.source)) === item.sourceHash,
        `Acceptance source changed: ${item.key}; sync scope first`,
      );
    } else {
      const files = runGitCommand(root, ['ls-files', '-z']).split('\0').filter(Boolean);
      const matches = files.filter(
        (file) =>
          path.basename(file) === path.basename(item.source) &&
          hash(sourceText(root, file)) === item.sourceHash,
      );
      requireCondition(
        matches.length === 1,
        `Acceptance source missing or ambiguous after archive: ${item.key}; sync source location`,
      );
    }
  }
}
