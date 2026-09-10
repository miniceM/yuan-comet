import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const argv = process.argv.slice(2);
const rootIndex = argv.indexOf('--root');
const repositoryRoot = resolve(rootIndex >= 0 ? (argv[rootIndex + 1] ?? '.') : '.');
const baselinePath =
  'docs/architecture/enterprise-guard/contracts/enterprise-guard-baseline.v1.json';

const errors = [];

function readText(relativePath) {
  try {
    return readFileSync(resolve(repositoryRoot, relativePath), 'utf8');
  } catch {
    errors.push(`Missing required Enterprise Guard artifact: ${relativePath}`);
    return '';
  }
}

function readJson(relativePath) {
  const source = readText(relativePath);
  if (!source) return null;
  try {
    return JSON.parse(source);
  } catch {
    errors.push(`Invalid Enterprise Guard JSON artifact: ${relativePath}`);
    return null;
  }
}

function requireText(source, expected, location) {
  if (!source.includes(expected)) errors.push(`Enterprise Guard baseline mismatch in ${location}`);
}

const baseline = readJson(baselinePath);
if (
  !baseline ||
  baseline.schemaVersion !== 'comet.enterprise-guard-baseline.v1' ||
  !Array.isArray(baseline.ruleIds) ||
  baseline.ruleIds.some((ruleId) => typeof ruleId !== 'string')
) {
  errors.push('Invalid Enterprise Guard baseline definition');
}

const policy = readText('docs/architecture/enterprise-guard/policy.md');
const policyEngine = readText('domains/enterprise-guard/policy-engine.ts');
const findings = readText('domains/enterprise-guard/findings.ts');
const exceptionReader = readText('domains/enterprise-guard/exceptions.ts');
const gatewayBundle = readText('assets/skills/comet/scripts/comet-enterprise-gateway.mjs');
const runnerBundle = readText('assets/skills/comet/scripts/comet-enterprise-runner.mjs');
const pluginBundle = readText('assets/skills/comet/plugins/comet-enterprise-guard.mjs');
const reviewProtocol = readText('docs/architecture/enterprise-guard/review-consumption.md');
const packageJson = readJson('package.json');

const contracts = [
  [
    'docs/architecture/enterprise-guard/contracts/enterprise-hook-input.v1.schema.json',
    baseline?.inputSchemaVersion,
  ],
  [
    'docs/architecture/enterprise-guard/contracts/enterprise-rule-result.v1.schema.json',
    baseline?.ruleResultSchemaVersion,
  ],
  [
    'docs/architecture/enterprise-guard/contracts/enterprise-finding.v1.schema.json',
    baseline?.findingSchemaVersion,
  ],
  [
    'docs/architecture/enterprise-guard/contracts/enterprise-exception.v1.schema.json',
    baseline?.exceptionSchemaVersion,
  ],
];
for (const [contractPath, schemaVersion] of contracts) {
  const contract = readJson(contractPath);
  if (
    typeof schemaVersion !== 'string' ||
    contract?.properties?.schemaVersion?.const !== schemaVersion
  ) {
    errors.push(`Enterprise Guard schema baseline mismatch: ${contractPath}`);
  }
}

if (baseline && Array.isArray(baseline.ruleIds)) {
  for (const ruleId of baseline.ruleIds) {
    requireText(policy, ruleId, 'policy catalog');
    requireText(policyEngine, ruleId, 'policy engine');
    requireText(gatewayBundle, ruleId, 'published Hook bundle');
    requireText(runnerBundle, ruleId, 'published Runner bundle');
  }
}

const gitBoundary = readText('domains/enterprise-guard/git-boundary.ts');
const checkFindings = readText('scripts/lint/check-enterprise-findings.mjs');

requireText(findings, baseline?.findingSchemaVersion ?? '', 'findings writer');
requireText(exceptionReader, 'readEnterpriseExceptions', 'exception reader');
requireText(gitBoundary, 'evaluatePreCommit', 'git boundary pre-commit');
requireText(gitBoundary, 'evaluatePrePush', 'git boundary pre-push');
requireText(checkFindings, 'readEnterpriseFindings', 'CI findings consumer');
requireText(reviewProtocol, 'readEnterpriseFindings', 'L4 review protocol');
requireText(reviewProtocol, '/sdd-review', 'L4 review protocol');
requireText(reviewProtocol, 'pnpm run lint:enterprise-guard', 'L7 review protocol');
requireText(
  pluginBundle,
  'comet.enterprise-managed-opencode-guard.v1',
  'published OpenCode plugin bundle',
);

if (
  !packageJson ||
  packageJson.scripts?.['lint:enterprise-guard'] !==
    'node scripts/lint/enterprise-guard-baseline.mjs' ||
  packageJson.scripts?.['check:enterprise-guard'] !==
    'node scripts/lint/check-enterprise-findings.mjs' ||
  typeof packageJson.scripts?.lint !== 'string' ||
  !packageJson.scripts.lint.includes('pnpm run lint:enterprise-guard')
) {
  errors.push('Enterprise Guard baseline lint is not wired into the repository lint command');
}

if (errors.length > 0) {
  console.error('Enterprise Guard baseline integrity failed.');
  for (const error of errors) console.error(`- ${error}`);
  process.exitCode = 1;
} else {
  console.log('Enterprise Guard baseline integrity passed.');
  try {
    const { execFileSync } = await import('node:child_process');
    execFileSync(
      process.execPath,
      ['scripts/lint/check-enterprise-findings.mjs', '--root', repositoryRoot],
      { stdio: 'inherit' },
    );
  } catch {
    process.exitCode = 1;
  }
}
