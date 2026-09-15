import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  openSync,
  closeSync,
  readdirSync,
} from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { runGitCommand } from '../../platform/process/git.js';
import type { DeliveryRecord } from './types.js';
import { requireCondition } from './validation.js';
export function deliveryDirectory(root: string): string {
  const common = runGitCommand(root, ['rev-parse', '--git-common-dir']);
  return path.resolve(root, common, 'comet', 'github-delivery');
}
export class DeliveryStore {
  readonly directory: string;
  constructor(readonly root: string) {
    this.directory = deliveryDirectory(root);
  }
  private file(id: string): string {
    requireCondition(/^[a-f0-9-]{36}$/.test(id), 'Invalid delivery id');
    return path.join(this.directory, `${id}.json`);
  }
  read(id: string): DeliveryRecord {
    const result = JSON.parse(readFileSync(this.file(id), 'utf8')) as DeliveryRecord;
    requireCondition(
      result.schema === 'comet.github-delivery.v1' &&
        result.id === id &&
        Number.isSafeInteger(result.revision),
      'Invalid delivery record',
    );
    return result;
  }
  records(): DeliveryRecord[] {
    if (!existsSync(this.directory)) return [];
    return readdirSync(this.directory)
      .filter((f) => /^[a-f0-9-]{36}\.json$/.test(f))
      .map((f) => this.read(f.slice(0, -5)));
  }
  save(record: DeliveryRecord): void {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const file = this.file(record.id);
    if (existsSync(file))
      requireCondition(
        this.read(record.id).revision === record.revision,
        'Delivery revision conflict; reload before retry',
      );
    const next = { ...record, revision: record.revision + 1 };
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify(next, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
      renameSync(temporary, file);
      record.revision = next.revision;
    } finally {
      if (existsSync(temporary)) unlinkSync(temporary);
    }
  }
  locked<T>(fn: () => T): T {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const lock = path.join(this.directory, 'mutation.lock');
    let fd: number;
    try {
      fd = openSync(lock, 'wx', 0o600);
    } catch {
      throw new Error(
        `Delivery mutation locked; inspect ${lock} and its owner before recovering an interrupted operation`,
      );
    }
    try {
      writeFileSync(fd, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
      return fn();
    } finally {
      closeSync(fd);
      unlinkSync(lock);
    }
  }
}
