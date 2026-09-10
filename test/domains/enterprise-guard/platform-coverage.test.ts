import { describe, expect, it } from 'vitest';

import { enterpriseGuardPlatformProfile } from '../../../domains/enterprise-guard/platform-profiles.js';
import {
  enterpriseGuardCoverage,
  hasManagedEntry,
  isEnterpriseGuardEnforcedPlatform,
  usesEnterpriseGuardGateway,
  usesEnterpriseGuardPlugin,
} from '../../../domains/enterprise-guard/platform-coverage.js';
import { PLATFORMS } from '../../../platform/install/platforms.js';

describe('Enterprise Guard platform coverage', () => {
  it('installs the Claude Gateway without overstating peer-Hook ordering guarantees', () => {
    const claude = PLATFORMS.find((platform) => platform.id === 'claude');
    expect(claude).toBeDefined();

    expect(enterpriseGuardCoverage(claude!)).toMatchObject({
      level: 'best-effort',
      installationScope: 'project or user-local',
      enforcedTools: ['Write', 'Edit', 'Bash'],
      fallback: 'local Gateway + rules injection + CI fallback; peer Hook ordering is not final',
    });
    expect(isEnterpriseGuardEnforcedPlatform(claude!)).toBe(false);
    expect(usesEnterpriseGuardGateway(claude!)).toBe(true);
  });

  it('labels every other Hook platform as rules injection and CI fallback', () => {
    const fallbackPlatforms = PLATFORMS.filter(
      (platform) => platform.supportsHooks && platform.id !== 'claude',
    );
    expect(fallbackPlatforms).not.toHaveLength(0);

    for (const platform of fallbackPlatforms) {
      expect(enterpriseGuardCoverage(platform)).toMatchObject({
        level: 'rules-and-ci',
        installationScope: 'rules only',
        enforcedTools: [],
        fallback: 'rules injection + CI fallback',
      });
      expect(isEnterpriseGuardEnforcedPlatform(platform)).toBe(false);
      expect(usesEnterpriseGuardGateway(platform)).toBe(false);
    }
  });

  it('separates host capability and registered input codec from verified enforcement', () => {
    expect(enterpriseGuardPlatformProfile({ id: 'claude' })).toEqual({
      platformId: 'claude',
      host: 'command-hook',
      inputCodec: 'claude',
      decisionCodec: 'comet-command-hook',
      installStrategy: 'composite-gateway',
      enforcement: 'best-effort',
      coveredTools: ['Write', 'Edit', 'Bash'],
      orderingGuarantee: 'unknown',
    });

    expect(enterpriseGuardPlatformProfile({ id: 'qwen' })).toEqual({
      platformId: 'qwen',
      host: 'command-hook',
      inputCodec: 'qwen',
      decisionCodec: 'comet-command-hook',
      installStrategy: 'not-installed',
      enforcement: 'none',
      coveredTools: ['write_file', 'edit_file', 'execute_command', 'Write', 'Edit', 'Bash'],
      orderingGuarantee: 'unknown',
    });

    expect(enterpriseGuardPlatformProfile({ id: 'gemini' })).toEqual({
      platformId: 'gemini',
      host: 'command-hook',
      inputCodec: 'gemini',
      decisionCodec: 'comet-command-hook',
      installStrategy: 'not-installed',
      enforcement: 'none',
      coveredTools: ['WriteFile', 'EditFile', 'Shell'],
      orderingGuarantee: 'unknown',
    });

    expect(enterpriseGuardPlatformProfile({ id: 'github-copilot' })).toEqual({
      platformId: 'github-copilot',
      host: 'command-hook',
      inputCodec: 'copilot',
      decisionCodec: 'copilot-json',
      installStrategy: 'not-installed',
      enforcement: 'none',
      coveredTools: ['editFiles', 'runCommand', 'applyPatch'],
      orderingGuarantee: 'unknown',
    });

    expect(enterpriseGuardPlatformProfile({ id: 'opencode' })).toMatchObject({
      host: 'plugin-hook',
      inputCodec: 'opencode',
      decisionCodec: 'opencode-plugin',
      installStrategy: 'managed-plugin',
      enforcement: 'best-effort',
      coveredTools: ['bash', 'write', 'edit', 'apply_patch', 'delete', 'remove', 'erase'],
      orderingGuarantee: 'unknown',
    });
    expect(enterpriseGuardCoverage({ id: 'opencode' })).toMatchObject({
      level: 'best-effort',
      installationScope: 'project or user-local',
      enforcedTools: ['bash', 'write', 'edit', 'apply_patch', 'delete', 'remove', 'erase'],
      fallback:
        'local managed plugin + rules injection + CI fallback; plugin ordering is not final',
    });
    expect(isEnterpriseGuardEnforcedPlatform({ id: 'opencode' })).toBe(false);
    expect(usesEnterpriseGuardPlugin({ id: 'opencode' })).toBe(true);
    expect(hasManagedEntry({ id: 'opencode' })).toBe(true);
    expect(hasManagedEntry({ id: 'claude' })).toBe(true);
    expect(hasManagedEntry({ id: 'codex' })).toBe(false);
  });
});
