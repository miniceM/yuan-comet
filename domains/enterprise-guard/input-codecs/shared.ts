import {
  MAX_ENTERPRISE_HOOK_FIELD_BYTES,
  MAX_ENTERPRISE_HOOK_INPUT_BYTES,
} from '../normalized-event.js';
import type { CapturedJson, CapturedString, EnterpriseHookInput } from '../normalized-event.js';

export type TruncationField = {
  path: string;
  capturedBytes: number;
  originalBytes: number;
  truncated: boolean;
};

export type JsonRecord = Record<string, unknown>;

export function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function boundedString(
  value: unknown,
  maxBytes = MAX_ENTERPRISE_HOOK_FIELD_BYTES,
): CapturedString {
  if (typeof value !== 'string') {
    return { value: null, capturedBytes: 0, originalBytes: 0, truncated: false };
  }
  const bytes = Buffer.from(value, 'utf8');
  const captured = bytes.subarray(0, maxBytes);
  return {
    value: captured.toString('utf8'),
    capturedBytes: captured.length,
    originalBytes: bytes.length,
    truncated: bytes.length > maxBytes,
  };
}

export function boundedJson(value: unknown): CapturedJson {
  const serialized = JSON.stringify(value ?? null);
  const captured = boundedString(serialized);
  return {
    value: captured.truncated ? null : (value ?? null),
    capturedBytes: captured.capturedBytes,
    originalBytes: captured.originalBytes,
    truncated: captured.truncated,
  };
}

export function truncationField(
  fieldPath: string,
  value: CapturedString | CapturedJson,
): TruncationField {
  return {
    path: fieldPath,
    capturedBytes: value.capturedBytes,
    originalBytes: value.originalBytes,
    truncated: value.truncated,
  };
}

export function rawInput(source: string): {
  source: string;
  field: TruncationField;
} {
  const bytes = Buffer.from(source, 'utf8');
  const captured = bytes.subarray(0, MAX_ENTERPRISE_HOOK_INPUT_BYTES);
  return {
    source: captured.toString('utf8'),
    field: {
      path: 'raw',
      capturedBytes: captured.length,
      originalBytes: bytes.length,
      truncated: bytes.length > MAX_ENTERPRISE_HOOK_INPUT_BYTES,
    },
  };
}

const WRITE_TOOL_CANONICAL_NAMES = new Set([
  'write',
  'writefile',
  'writefiles',
  'write_file',
  'writefiletool',
  'create',
  'createfile',
  'createfiles',
  'create_file',
  'edit',
  'editfile',
  'editfiles',
  'edit_file',
  'strreplaceeditor',
  'str_replace_editor',
  'searchreplace',
  'search_replace',
  'applypatch',
  'apply_patch',
  'patch',
]);

export function isNormalizedWriteTool(name: string | null): boolean {
  if (!name) return false;
  const normalized = name.toLowerCase().replace(/[^a-z0-9]+/gu, '');
  return WRITE_TOOL_CANONICAL_NAMES.has(normalized);
}

export function detectWriteOperation(
  toolName: string | null,
): EnterpriseHookInput['writes'][number]['operation'] {
  if (!toolName) return 'unknown';
  const lower = toolName.toLowerCase();
  if (
    lower.includes('create') ||
    lower === 'write' ||
    lower === 'writefile' ||
    lower === 'writefiles' ||
    lower === 'write_file'
  ) {
    return 'create';
  }
  if (lower.includes('edit') || lower.includes('replace') || lower.includes('patch')) {
    return 'edit';
  }
  if (lower.includes('delete') || lower.includes('remove')) {
    return 'delete';
  }
  return 'unknown';
}
