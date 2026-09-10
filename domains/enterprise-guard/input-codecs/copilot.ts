import { MAX_ENTERPRISE_HOOK_INPUT_BYTES } from '../normalized-event.js';
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

function parseToolArgs(rawArgs: unknown): { parsed: JsonRecord; rawString: string | null } {
  if (isRecord(rawArgs)) return { parsed: rawArgs, rawString: null };
  if (typeof rawArgs === 'string') {
    const trimmed = rawArgs.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        const val = JSON.parse(trimmed) as unknown;
        if (isRecord(val)) return { parsed: val, rawString: trimmed };
      } catch {
        // Fall back to treating as plain string
      }
    }
    return { parsed: {}, rawString: trimmed };
  }
  return { parsed: {}, rawString: null };
}

export function parseCopilotEnterpriseHookInput(
  source: string,
  platformId = 'github-copilot',
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

  const rawArgs = parsed.toolArgs ?? parsed.tool_args ?? parsed.tool_input ?? parsed.arguments;
  const { parsed: toolInputValue, rawString: argsString } = parseToolArgs(rawArgs);

  const workingDirectory = boundedString(
    parsed.cwd ?? parsed.workspaceRoot ?? parsed.working_directory,
  );
  const toolName = boundedString(parsed.toolName ?? parsed.tool_name ?? parsed.name);
  const toolInput = boundedJson(isRecord(rawArgs) ? rawArgs : toolInputValue);
  const command = boundedString(
    toolInputValue.command ??
      toolInputValue.cmd ??
      (toolName.value === 'runCommand' ? argsString : null),
  );
  fields.push(
    truncationField('workingDirectory', workingDirectory),
    truncationField('tool.name', toolName),
    truncationField('tool.input', toolInput),
    truncationField('command', command),
  );

  const pathValue = boundedString(
    toolInputValue.filePath ??
      toolInputValue.file_path ??
      toolInputValue.path ??
      toolInputValue.targetFile ??
      toolInputValue.target_file,
  );
  const fragmentValue = boundedString(
    toolInputValue.content ??
      toolInputValue.new_string ??
      toolInputValue.patch ??
      toolInputValue.patchText ??
      (isNormalizedWriteTool(toolName.value) ? argsString : null),
  );
  const writes =
    toolName.value && isNormalizedWriteTool(toolName.value)
      ? [
          {
            operation: detectWriteOperation(toolName.value),
            path: pathValue,
            fragment: fragmentValue,
          },
        ]
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
    typeof parsed.hookEventName === 'string' && parsed.hookEventName.trim()
      ? parsed.hookEventName.trim()
      : 'preToolUse';

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

export const copilotEnterpriseGuardCodec: EnterpriseGuardInputCodec = {
  id: 'copilot',
  parse: (source: string) => parseCopilotEnterpriseHookInput(source, 'github-copilot'),
};
