import { createHash } from 'node:crypto';
export function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
export function requireCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
export function object(value: unknown): Record<string, unknown> {
  requireCondition(
    value !== null && typeof value === 'object' && !Array.isArray(value),
    'Expected an object',
  );
  return value as Record<string, unknown>;
}
export function text(value: unknown, label: string): string {
  requireCondition(
    typeof value === 'string' && value.trim().length > 0 && value.length <= 100_000,
    `${label} must be nonempty text`,
  );
  return value;
}
export function list(value: unknown, label: string): unknown[] {
  requireCondition(
    Array.isArray(value) && value.length <= 2048,
    `${label} must be a bounded array`,
  );
  return value;
}
