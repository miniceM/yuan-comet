import type { EnterpriseCliCatalogEntry, EnterpriseCliConfig, EnterpriseCliId } from './types.js';

const entries: Record<EnterpriseCliId, EnterpriseCliCatalogEntry> = {
  iam: {
    command: 'iam',
    packageName: '@cli-tools/iam',
    version: '1.0.2',
    binName: 'iam',
    probeArgs: ['--help'],
    probeOutput: /\bauth\b/u,
  },
  dop: {
    command: 'dop',
    packageName: '@cli-tools/dop',
    version: '1.0.4',
    binName: 'dop',
    probeArgs: ['--help'],
    probeOutput: /\bchange\b/u,
  },
  gh: {
    command: 'gh',
    packageName: '@cli-tools/gh',
    version: '1.0.6',
    binName: 'gh',
    probeArgs: ['--version'],
    probeOutput: /\bgh version (?:gitee-cli|\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\b/u,
  },
};

export const ENTERPRISE_CLI_CONFIG: EnterpriseCliConfig = {
  // The enterprise registry is intentionally supplied by deployment/user config.
  registry: '',
  entries,
};

export function enterpriseCliEntries(): EnterpriseCliCatalogEntry[] {
  return Object.values(ENTERPRISE_CLI_CONFIG.entries);
}
