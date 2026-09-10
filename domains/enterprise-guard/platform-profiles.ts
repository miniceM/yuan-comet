import type { Platform } from '../../platform/install/platforms.js';

export type EnterpriseGuardCoverageLevel =
  | 'enforced-managed'
  | 'enforced-project'
  | 'enforced-managed-plugin'
  | 'best-effort'
  | 'rules-and-ci';

export interface EnterpriseGuardPlatformProfile {
  platformId: string;
  host: 'command-hook' | 'plugin-hook' | 'native-boundary' | 'none';
  inputCodec: string | null;
  decisionCodec: string | null;
  installStrategy: 'composite-gateway' | 'managed-plugin' | 'not-installed';
  enforcement: 'managed' | 'project' | 'managed-plugin' | 'best-effort' | 'none';
  coveredTools: readonly string[];
  orderingGuarantee: 'final' | 'verified' | 'unknown';
}

const CLAUDE_PROFILE: EnterpriseGuardPlatformProfile = {
  platformId: 'claude',
  host: 'command-hook',
  inputCodec: 'claude',
  decisionCodec: 'comet-command-hook',
  installStrategy: 'composite-gateway',
  enforcement: 'best-effort',
  coveredTools: ['Write', 'Edit', 'Bash'],
  orderingGuarantee: 'unknown',
};

const CODEX_PROFILE: EnterpriseGuardPlatformProfile = {
  platformId: 'codex',
  host: 'command-hook',
  inputCodec: 'claude',
  decisionCodec: 'comet-command-hook',
  installStrategy: 'not-installed',
  enforcement: 'none',
  coveredTools: ['Write', 'Edit', 'Bash'],
  orderingGuarantee: 'unknown',
};

const AMAZON_Q_PROFILE: EnterpriseGuardPlatformProfile = {
  platformId: 'amazon-q',
  host: 'command-hook',
  inputCodec: 'claude',
  decisionCodec: 'comet-command-hook',
  installStrategy: 'not-installed',
  enforcement: 'none',
  coveredTools: ['write_file', 'edit_file', 'bash', 'run_command'],
  orderingGuarantee: 'unknown',
};

const QWEN_PROFILE: EnterpriseGuardPlatformProfile = {
  platformId: 'qwen',
  host: 'command-hook',
  inputCodec: 'qwen',
  decisionCodec: 'comet-command-hook',
  installStrategy: 'not-installed',
  enforcement: 'none',
  coveredTools: ['write_file', 'edit_file', 'execute_command', 'Write', 'Edit', 'Bash'],
  orderingGuarantee: 'unknown',
};

const GEMINI_PROFILE: EnterpriseGuardPlatformProfile = {
  platformId: 'gemini',
  host: 'command-hook',
  inputCodec: 'gemini',
  decisionCodec: 'comet-command-hook',
  installStrategy: 'not-installed',
  enforcement: 'none',
  coveredTools: ['WriteFile', 'EditFile', 'Shell'],
  orderingGuarantee: 'unknown',
};

const GITHUB_COPILOT_PROFILE: EnterpriseGuardPlatformProfile = {
  platformId: 'github-copilot',
  host: 'command-hook',
  inputCodec: 'copilot',
  decisionCodec: 'copilot-json',
  installStrategy: 'not-installed',
  enforcement: 'none',
  coveredTools: ['editFiles', 'runCommand', 'applyPatch'],
  orderingGuarantee: 'unknown',
};

const TRAE_PROFILE: EnterpriseGuardPlatformProfile = {
  platformId: 'trae',
  host: 'command-hook',
  inputCodec: 'claude',
  decisionCodec: 'comet-command-hook',
  installStrategy: 'not-installed',
  enforcement: 'none',
  coveredTools: ['Write', 'Edit', 'Bash'],
  orderingGuarantee: 'unknown',
};

const TRAE_CN_PROFILE: EnterpriseGuardPlatformProfile = {
  platformId: 'trae-cn',
  host: 'command-hook',
  inputCodec: 'claude',
  decisionCodec: 'comet-command-hook',
  installStrategy: 'not-installed',
  enforcement: 'none',
  coveredTools: ['Write', 'Edit', 'Bash'],
  orderingGuarantee: 'unknown',
};

const OH_MY_PI_PROFILE: EnterpriseGuardPlatformProfile = {
  platformId: 'oh-my-pi',
  host: 'command-hook',
  inputCodec: 'qwen',
  decisionCodec: 'comet-command-hook',
  installStrategy: 'not-installed',
  enforcement: 'none',
  coveredTools: ['write_file', 'edit_file', 'execute_command', 'Write', 'Edit', 'Bash'],
  orderingGuarantee: 'unknown',
};

const DSH_PROFILE: EnterpriseGuardPlatformProfile = {
  platformId: 'dsh',
  host: 'command-hook',
  inputCodec: 'claude',
  decisionCodec: 'comet-command-hook',
  installStrategy: 'not-installed',
  enforcement: 'none',
  coveredTools: ['Write', 'Edit', 'Bash'],
  orderingGuarantee: 'unknown',
};

const OPENCODE_PROFILE: EnterpriseGuardPlatformProfile = {
  platformId: 'opencode',
  host: 'plugin-hook',
  inputCodec: 'opencode',
  decisionCodec: 'opencode-plugin',
  installStrategy: 'managed-plugin',
  enforcement: 'best-effort',
  coveredTools: ['bash', 'write', 'edit', 'apply_patch', 'delete', 'remove', 'erase'],
  orderingGuarantee: 'unknown',
};

const PROFILES = new Map<string, EnterpriseGuardPlatformProfile>([
  ['claude', CLAUDE_PROFILE],
  ['codex', CODEX_PROFILE],
  ['amazon-q', AMAZON_Q_PROFILE],
  ['qwen', QWEN_PROFILE],
  ['gemini', GEMINI_PROFILE],
  ['github-copilot', GITHUB_COPILOT_PROFILE],
  ['trae', TRAE_PROFILE],
  ['trae-cn', TRAE_CN_PROFILE],
  ['oh-my-pi', OH_MY_PI_PROFILE],
  ['dsh', DSH_PROFILE],
  ['opencode', OPENCODE_PROFILE],
]);

const UNINSTRUMENTED_PROFILE: Omit<EnterpriseGuardPlatformProfile, 'platformId'> = {
  host: 'none',
  inputCodec: null,
  decisionCodec: null,
  installStrategy: 'not-installed',
  enforcement: 'none',
  coveredTools: [],
  orderingGuarantee: 'unknown',
};

export function enterpriseGuardPlatformProfile(
  platform: Pick<Platform, 'id'>,
): EnterpriseGuardPlatformProfile {
  const profile = PROFILES.get(platform.id);
  if (profile) return profile;
  return { platformId: platform.id, ...UNINSTRUMENTED_PROFILE };
}
