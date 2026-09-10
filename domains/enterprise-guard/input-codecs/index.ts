import type { EnterpriseGuardInputCodec, EnterpriseHookInput } from '../normalized-event.js';
import { claudeEnterpriseGuardCodec, parseClaudeEnterpriseHookInput } from './claude.js';
import { copilotEnterpriseGuardCodec, parseCopilotEnterpriseHookInput } from './copilot.js';
import { geminiEnterpriseGuardCodec, parseGeminiEnterpriseHookInput } from './gemini.js';
import { opencodeEnterpriseGuardCodec } from './opencode.js';
import { parseQwenEnterpriseHookInput, qwenEnterpriseGuardCodec } from './qwen.js';

export {
  claudeEnterpriseGuardCodec,
  copilotEnterpriseGuardCodec,
  geminiEnterpriseGuardCodec,
  opencodeEnterpriseGuardCodec,
  qwenEnterpriseGuardCodec,
  parseClaudeEnterpriseHookInput,
  parseCopilotEnterpriseHookInput,
  parseGeminiEnterpriseHookInput,
  parseQwenEnterpriseHookInput,
};

const BASE_CODECS: readonly EnterpriseGuardInputCodec[] = [
  claudeEnterpriseGuardCodec,
  qwenEnterpriseGuardCodec,
  geminiEnterpriseGuardCodec,
  copilotEnterpriseGuardCodec,
  opencodeEnterpriseGuardCodec,
];

// Mapping from platformId / codecId to the input parsing function
const PLATFORM_CODEC_RESOLVERS = new Map<string, (source: string) => EnterpriseHookInput>([
  ['claude', claudeEnterpriseGuardCodec.parse],
  ['codex', (source) => parseClaudeEnterpriseHookInput(source, 'codex')],
  ['amazon-q', (source) => parseClaudeEnterpriseHookInput(source, 'amazon-q')],
  ['grok', (source) => parseClaudeEnterpriseHookInput(source, 'grok')],
  ['trae', (source) => parseClaudeEnterpriseHookInput(source, 'trae')],
  ['trae-cn', (source) => parseClaudeEnterpriseHookInput(source, 'trae-cn')],
  ['dsh', (source) => parseClaudeEnterpriseHookInput(source, 'dsh')],
  ['qwen', qwenEnterpriseGuardCodec.parse],
  ['qoder', (source) => parseQwenEnterpriseHookInput(source, 'qoder')],
  ['codebuddy', (source) => parseQwenEnterpriseHookInput(source, 'codebuddy')],
  ['workbuddy', (source) => parseQwenEnterpriseHookInput(source, 'workbuddy')],
  ['oh-my-pi', (source) => parseQwenEnterpriseHookInput(source, 'oh-my-pi')],
  ['gemini', geminiEnterpriseGuardCodec.parse],
  ['github-copilot', copilotEnterpriseGuardCodec.parse],
  ['copilot', copilotEnterpriseGuardCodec.parse],
  ['opencode', opencodeEnterpriseGuardCodec.parse],
]);

// Also register base codecs by their codec ID
for (const codec of BASE_CODECS) {
  if (!PLATFORM_CODEC_RESOLVERS.has(codec.id)) {
    PLATFORM_CODEC_RESOLVERS.set(codec.id, codec.parse);
  }
}

export function hasEnterpriseGuardInputCodec(platformOrCodecId: string): boolean {
  return PLATFORM_CODEC_RESOLVERS.has(platformOrCodecId);
}

export function parseEnterpriseGuardInput(
  platformOrCodecId: string,
  source: string,
): EnterpriseHookInput {
  const resolver = PLATFORM_CODEC_RESOLVERS.get(platformOrCodecId);
  if (!resolver) {
    throw new Error(
      `Enterprise Guard input codec is unavailable for platform: ${platformOrCodecId}`,
    );
  }
  return resolver(source);
}
