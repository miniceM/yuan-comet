import { MAX_ENTERPRISE_HOOK_INPUT_BYTES, isWriteTool } from '../normalized-event.js';
import type { EnterpriseGuardInputCodec, EnterpriseHookInput } from '../normalized-event.js';
import {
  boundedJson,
  boundedString,
  detectWriteOperation,
  isNormalizedWriteTool,
  isRecord,
  rawInput,
  truncationField,
  type JsonRecord,
} from './shared.js';

function writeOperation(
  toolName: string | null,
): EnterpriseHookInput['writes'][number]['operation'] {
  if (toolName === 'Write') return 'create';
  if (toolName === 'Edit') return 'edit';
  return detectWriteOperation(toolName);
}

/** Convert Claude Code raw PreToolUse stdin into the versioned EnterpriseHookInput v1 contract. */
export function parseClaudeEnterpriseHookInput(
  source: string,
  platformId = 'claude',
): EnterpriseHookInput {
  const raw = rawInput(source);
  const fields = [raw.field];
  let parsed: JsonRecord = {};
  let parse: EnterpriseHookInput['parse'] = { status: 'complete', errors: [] };
  try {
    const value = JSON.parse(raw.source) as unknown;
    if (!isRecord(value)) throw new Error('Hook input must be a JSON object');
    parsed = value;
  } catch (error) {
    parse = {
      status: raw.field.truncated ? 'partial' : 'failed',
      errors: [
        error instanceof Error
          ? error.message.replace(/\s+at position \d+$/u, '')
          : 'Invalid JSON input',
      ],
    };
  }
  const toolInputValue = isRecord(parsed.tool_input) ? parsed.tool_input : {};
  const workingDirectory = boundedString(parsed.cwd ?? parsed.working_directory);
  const toolName = boundedString(parsed.tool_name ?? parsed.toolName);
  const toolInput = boundedJson(toolInputValue);
  const command = boundedString(toolInputValue.command ?? toolInputValue.cmd);
  fields.push(
    truncationField('workingDirectory', workingDirectory),
    truncationField('tool.name', toolName),
    truncationField('tool.input', toolInput),
    truncationField('command', command),
  );

  const pathValue = boundedString(
    toolInputValue.file_path ??
      toolInputValue.path ??
      toolInputValue.filePath ??
      toolInputValue.target_file ??
      toolInputValue.targetFile,
  );
  const fragmentValue = boundedString(
    toolInputValue.content ??
      toolInputValue.new_string ??
      toolInputValue.patch ??
      toolInputValue.replacement_content,
  );
  const writes =
    toolName.value && (isWriteTool(toolName.value) || isNormalizedWriteTool(toolName.value))
      ? [{ operation: writeOperation(toolName.value), path: pathValue, fragment: fragmentValue }]
      : [];
  for (const [index, write] of writes.entries()) {
    fields.push(
      truncationField(`writes.${index}.path`, write.path),
      truncationField(`writes.${index}.fragment`, write.fragment),
    );
  }
  if (parse.status === 'complete' && fields.some((field) => field.truncated)) {
    parse = { status: 'partial', errors: ['Hook input exceeded a bounded capture limit'] };
  }

  const eventName =
    typeof parsed.hook_event_name === 'string' && parsed.hook_event_name.trim()
      ? parsed.hook_event_name.trim()
      : 'PreToolUse';

  return {
    schemaVersion: 'comet.enterprise-hook-input.v1',
    platform: { id: platformId, surface: 'project', version: null },
    event: { name: eventName, preAction: true, blockingCapable: true },
    workingDirectory,
    tool: { name: toolName, input: toolInput },
    command,
    writes,
    parse,
    truncation: { maxCapturedBytes: MAX_ENTERPRISE_HOOK_INPUT_BYTES, fields },
  };
}

export const claudeEnterpriseGuardCodec: EnterpriseGuardInputCodec = {
  id: 'claude',
  parse: (source: string) => parseClaudeEnterpriseHookInput(source, 'claude'),
};
