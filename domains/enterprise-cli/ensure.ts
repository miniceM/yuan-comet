import { execFileSync } from 'node:child_process';
import { mkdir, open, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolveWindowsCommand } from '../../platform/process/spawn-command.js';
import { ENTERPRISE_CLI_CONFIG } from './catalog.js';
import type {
  EnterpriseCliCatalogEntry,
  EnterpriseCliCommandResult,
  EnterpriseCliCommandRunner,
  EnterpriseCliConfig,
  EnterpriseCliId,
  EnterpriseCliResult,
  EnterpriseCliToolResult,
  EnsureEnterpriseCliOptions,
} from './types.js';

const PROBE_TIMEOUT_MS = 5_000;
const NPM_TIMEOUT_MS = 180_000;
const NPM_METADATA_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_LENGTH = 1_000_000;
const TOOL_IDS: EnterpriseCliId[] = ['iam', 'dop', 'gh'];

function trimOutput(value: string): string {
  return value.length > MAX_OUTPUT_LENGTH ? `${value.slice(0, MAX_OUTPUT_LENGTH)}…` : value;
}

function defaultRunner(
  command: string,
  args: readonly string[],
  options: { timeoutMs: number; env: NodeJS.ProcessEnv },
): EnterpriseCliCommandResult {
  const cwd = process.cwd();
  const resolved =
    process.platform === 'win32' ? resolveWindowsCommand(command, options.env, cwd) : command;
  const extension = path.win32.extname(resolved).toLowerCase();
  const isWindowsBatch =
    process.platform === 'win32' && (extension === '.cmd' || extension === '.bat');
  try {
    const stdout = execFileSync(resolved, [...args], {
      cwd,
      env: options.env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: options.timeoutMs,
      maxBuffer: MAX_OUTPUT_LENGTH,
      windowsHide: true,
      shell: isWindowsBatch,
    });
    return { exitCode: 0, stdout: String(stdout), stderr: '' };
  } catch (error) {
    const typed = error as NodeJS.ErrnoException & {
      status?: number;
      stdout?: string | Buffer;
      stderr?: string | Buffer;
      signal?: string;
    };
    const text = (value: string | Buffer | undefined): string =>
      Buffer.isBuffer(value) ? value.toString('utf8') : (value ?? '');
    return {
      exitCode: typeof typed.status === 'number' ? typed.status : 1,
      stdout: text(typed.stdout),
      stderr: text(typed.stderr) || typed.message || '',
      timedOut: typed.signal === 'SIGTERM' || typed.code === 'ETIMEDOUT',
    };
  }
}

function mergeConfig(options: EnsureEnterpriseCliOptions): EnterpriseCliConfig {
  const env = options.env ?? process.env;
  const registry =
    env.COMET_ENTERPRISE_NPM_REGISTRY ?? options.config?.registry ?? ENTERPRISE_CLI_CONFIG.registry;
  return {
    registry,
    entries: {
      ...ENTERPRISE_CLI_CONFIG.entries,
      ...(options.config?.entries ?? {}),
    },
  };
}

function validRegistry(registry: string): boolean {
  if (!registry) return false;
  try {
    const parsed = new URL(registry);
    return (
      (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
      !parsed.username &&
      !parsed.password &&
      !parsed.search &&
      !parsed.hash
    );
  } catch {
    return false;
  }
}

function packageOverride(env: NodeJS.ProcessEnv, id: EnterpriseCliId): string | undefined {
  return env[`COMET_ENTERPRISE_${id.toUpperCase()}_PACKAGE`];
}

function packageSpec(entry: EnterpriseCliCatalogEntry, env: NodeJS.ProcessEnv): string {
  const override = packageOverride(env, entry.command);
  return override ?? `${entry.packageName}@${entry.version}`;
}

function packageVersion(entry: EnterpriseCliCatalogEntry, env: NodeJS.ProcessEnv): string {
  const spec = packageSpec(entry, env);
  return spec.slice(spec.lastIndexOf('@') + 1);
}

function validPackageSpec(value: string): boolean {
  return /^@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*@[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/u.test(
    value,
  );
}

function displayError(result: EnterpriseCliCommandResult): string {
  const detail = trimOutput(result.stderr || result.stdout)
    .replace(/\s+/gu, ' ')
    .replace(/(https?:\/\/)([^\s/:@]+):([^\s/@]+)@/giu, '$1$2:[redacted]@')
    .replace(/(?:token|password|_authToken)\s*[=:]\s*[^\s,;]+/giu, (value) => {
      const separator = value.match(/[=:]/u)?.[0] ?? '=';
      return `${value.slice(0, value.indexOf(separator) + 1)}[redacted]`;
    })
    .trim();
  return detail || `process exited with code ${result.exitCode}`;
}

function resultFor(
  entry: EnterpriseCliCatalogEntry,
  action: EnterpriseCliToolResult['action'],
  reasonCode: EnterpriseCliToolResult['reasonCode'],
  detail?: string,
): EnterpriseCliToolResult {
  return {
    command: entry.command,
    packageName: entry.packageName,
    version: entry.version,
    action,
    reasonCode,
    ...(detail ? { detail: trimOutput(detail) } : {}),
  };
}

function probe(
  entry: EnterpriseCliCatalogEntry,
  env: NodeJS.ProcessEnv,
  runCommand: EnterpriseCliCommandRunner,
): EnterpriseCliToolResult {
  const result = runCommand(entry.command, entry.probeArgs, { timeoutMs: PROBE_TIMEOUT_MS, env });
  if (result.timedOut) return resultFor(entry, 'failed', 'probe-timeout', displayError(result));
  if (result.exitCode !== 0) {
    const reasonCode = /not found|not recognized|enoent|cannot find/iu.test(
      `${result.stderr} ${result.stdout}`,
    )
      ? 'missing'
      : 'unusable';
    return resultFor(entry, 'failed', reasonCode, displayError(result));
  }
  const output = `${result.stdout}\n${result.stderr}`;
  if (!entry.probeOutput.test(output)) {
    return resultFor(entry, 'failed', 'unusable', 'CLI output did not match the expected contract');
  }
  return resultFor(entry, 'reused', 'available');
}

function npmRegistryArgs(registry: string): string[] {
  return [`--@cli-tools:registry=${registry}`];
}

function npmFailureReason(
  result: EnterpriseCliCommandResult,
): EnterpriseCliToolResult['reasonCode'] {
  const output = `${result.stderr}\n${result.stdout}`;
  if (result.timedOut) return 'install-timeout';
  if (/enoent|npm(?:\.cmd)?[^\n]*(?:not found|not recognized)/iu.test(output)) {
    return 'npm-unavailable';
  }
  if (/allow.?scripts|install scripts? blocked|scripts? blocked/iu.test(output)) {
    return 'install-scripts-blocked';
  }
  if (/401|403|unauthorized|forbidden/iu.test(output)) return 'registry-auth';
  if (/404|not found|no matching version/iu.test(output)) return 'package-unavailable';
  if (/eacces|permission denied/iu.test(output)) return 'permission-denied';
  if (/enotfound|eai_again|network|fetch failed/iu.test(output)) return 'network-error';
  return 'install-failed';
}

function verifyPackageMetadata(
  entry: EnterpriseCliCatalogEntry,
  registry: string,
  env: NodeJS.ProcessEnv,
  runCommand: EnterpriseCliCommandRunner,
  protectedCommands: ReadonlySet<EnterpriseCliId>,
): EnterpriseCliToolResult | null {
  const result = runCommand(
    'npm',
    ['view', packageSpec(entry, env), 'version', 'bin', '--json', ...npmRegistryArgs(registry)],
    { timeoutMs: NPM_METADATA_TIMEOUT_MS, env },
  );
  if (result.timedOut) return resultFor(entry, 'failed', 'probe-timeout', displayError(result));
  if (result.exitCode !== 0) {
    return resultFor(entry, 'failed', npmFailureReason(result), displayError(result));
  }
  let metadata: unknown;
  try {
    metadata = JSON.parse(result.stdout);
  } catch {
    return resultFor(entry, 'failed', 'bin-mismatch', 'Registry metadata is not valid JSON');
  }
  const version =
    typeof metadata === 'object' && metadata !== null && 'version' in metadata
      ? (metadata as { version?: unknown }).version
      : undefined;
  if (version !== packageVersion(entry, env)) {
    return resultFor(
      entry,
      'failed',
      'package-unavailable',
      'Registry returned a different version',
    );
  }
  const bin =
    typeof metadata === 'object' && metadata !== null && 'bin' in metadata
      ? (metadata as { bin?: unknown }).bin
      : undefined;
  const binNames =
    typeof bin === 'string'
      ? [entry.binName]
      : bin && typeof bin === 'object'
        ? Object.keys(bin)
        : [];
  if (!binNames.includes(entry.binName)) {
    return resultFor(
      entry,
      'failed',
      'bin-mismatch',
      `Package metadata does not expose ${entry.binName}`,
    );
  }
  const conflictingCommand = binNames.find(
    (name): name is EnterpriseCliId =>
      name !== entry.binName &&
      (name === 'iam' || name === 'dop' || name === 'gh') &&
      protectedCommands.has(name),
  );
  if (conflictingCommand) {
    return resultFor(
      entry,
      'failed',
      'bin-conflict',
      `Package metadata would overwrite the existing ${conflictingCommand} command`,
    );
  }
  return null;
}

function installEntry(
  entry: EnterpriseCliCatalogEntry,
  registry: string,
  env: NodeJS.ProcessEnv,
  runCommand: EnterpriseCliCommandRunner,
  protectedCommands: ReadonlySet<EnterpriseCliId>,
): EnterpriseCliToolResult {
  const metadataFailure = verifyPackageMetadata(
    entry,
    registry,
    env,
    runCommand,
    protectedCommands,
  );
  if (metadataFailure) return metadataFailure;
  const result = runCommand(
    'npm',
    [
      'install',
      '--global',
      '--no-fund',
      '--no-audit',
      packageSpec(entry, env),
      ...npmRegistryArgs(registry),
    ],
    { timeoutMs: NPM_TIMEOUT_MS, env },
  );
  if (
    /allow.?scripts|install scripts? blocked|scripts? blocked/iu.test(
      `${result.stderr}\n${result.stdout}`,
    )
  ) {
    return resultFor(entry, 'failed', 'install-scripts-blocked', displayError(result));
  }
  if (result.exitCode !== 0) {
    return resultFor(entry, 'failed', npmFailureReason(result), displayError(result));
  }
  return resultFor(entry, 'installed', 'available');
}

async function acquireInstallLock(homeDir: string): Promise<() => Promise<void>> {
  const directory = path.join(homeDir, '.comet');
  const lockPath = path.join(directory, 'enterprise-cli-install.lock');
  await mkdir(directory, { recursive: true });
  try {
    const handle = await open(lockPath, 'wx');
    await handle.writeFile(`${process.pid}\n`, 'utf8');
    await handle.close();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error('enterprise CLI installation is already running', { cause: error });
    }
    throw error;
  }
  return async () => {
    await unlink(lockPath).catch(() => undefined);
  };
}

function withFinalProbe(
  tools: EnterpriseCliToolResult[],
  config: EnterpriseCliConfig,
  env: NodeJS.ProcessEnv,
  runCommand: EnterpriseCliCommandRunner,
): EnterpriseCliToolResult[] {
  return tools.map((tool) => {
    const entry = config.entries[tool.command];
    if (tool.action !== 'installed') return tool;
    const verified = probe(entry, env, runCommand);
    if (verified.action === 'reused') return tool;
    const reasonCode =
      verified.reasonCode === 'missing' || verified.reasonCode === 'unusable'
        ? 'postcheck-failed'
        : verified.reasonCode;
    return { ...tool, action: 'failed', reasonCode, detail: verified.detail };
  });
}

function nextActions(): string[] {
  return [
    'Run `iam auth login --system <system>` and complete the interactive login.',
    'Run `iam auth status --json` and confirm the required credentials have status `logged`.',
  ];
}

function recoveryActions(failures: readonly EnterpriseCliToolResult[]): string[] {
  const blockedPackages = failures
    .filter((failure) => failure.reasonCode === 'install-scripts-blocked')
    .map((failure) => `${failure.packageName}@${failure.version}`);
  if (blockedPackages.length === 0) return [];
  return [
    `Allow install scripts for ${blockedPackages.join(', ')} according to enterprise npm policy, then rerun \`comet init\`.`,
  ];
}

export async function ensureEnterpriseCli(
  options: EnsureEnterpriseCliOptions = {},
): Promise<EnterpriseCliResult> {
  const env = options.env ?? process.env;
  const config = mergeConfig(options);
  const runCommand = options.runCommand ?? defaultRunner;
  const entries = TOOL_IDS.map((id) => config.entries[id]);
  let tools = entries.map((entry) => probe(entry, env, runCommand));
  const missing = tools.filter((tool) => tool.reasonCode === 'missing');
  const broken = tools.filter((tool) => tool.action === 'failed' && tool.reasonCode !== 'missing');
  if (broken.length > 0) {
    return {
      status: 'incomplete',
      tools,
      failures: broken,
      nextActions: recoveryActions(broken),
    };
  }
  if (missing.length === 0) {
    return { status: 'complete', tools, failures: [], nextActions: nextActions() };
  }
  if (!config.registry) {
    const failures = tools.map((tool) =>
      tool.reasonCode === 'missing'
        ? {
            ...tool,
            reasonCode: 'configuration-missing' as const,
            detail: 'Enterprise npm registry is not configured',
          }
        : tool,
    );
    return {
      status: 'incomplete',
      tools: failures,
      failures: failures.filter((tool) => tool.action === 'failed'),
      nextActions: [],
    };
  }
  if (!validRegistry(config.registry)) {
    const failures = missing.map((tool) => ({
      ...tool,
      reasonCode: 'configuration-invalid' as const,
      detail: 'Enterprise npm registry must be a valid HTTP(S) URL',
    }));
    return {
      status: 'incomplete',
      tools: tools.map(
        (tool) => failures.find((failure) => failure.command === tool.command) ?? tool,
      ),
      failures,
      nextActions: [],
    };
  }
  const invalidPackage = missing.find(
    (tool) => !validPackageSpec(packageSpec(config.entries[tool.command], env)),
  );
  if (invalidPackage) {
    const failure = resultFor(
      config.entries[invalidPackage.command],
      'failed',
      'configuration-invalid',
      'Enterprise package overrides must use a scoped package and exact semantic version',
    );
    return {
      status: 'incomplete',
      tools: tools.map((tool) => (tool.command === failure.command ? failure : tool)),
      failures: [failure],
      nextActions: [],
    };
  }
  let releaseLock: (() => Promise<void>) | undefined;
  try {
    if (options.acquireLock !== false) {
      releaseLock = await acquireInstallLock(options.homeDir ?? os.homedir());
    }
    const installedTools = [...tools];
    const protectedCommands = new Set(
      tools.filter((tool) => tool.action === 'reused').map((tool) => tool.command),
    );
    let halted = false;
    for (const tool of missing) {
      const index = installedTools.findIndex((candidate) => candidate.command === tool.command);
      if (halted) {
        installedTools[index] = {
          ...tool,
          action: 'not-run',
          reasonCode: 'install-failed',
          detail: 'Skipped because an earlier enterprise CLI installation failed',
        };
        continue;
      }
      const entry = config.entries[tool.command];
      const installed = installEntry(entry, config.registry, env, runCommand, protectedCommands);
      installedTools[index] = installed;
      halted = installed.action === 'failed';
    }
    tools = installedTools;
    tools = withFinalProbe(tools, config, env, runCommand);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const failures = missing.map((tool) =>
      resultFor(
        config.entries[tool.command],
        'failed',
        /already running/iu.test(detail) ? 'installation-busy' : 'install-failed',
        detail,
      ),
    );
    return {
      status: 'incomplete',
      tools,
      failures,
      nextActions: recoveryActions(failures),
    };
  } finally {
    await releaseLock?.();
  }
  const failures = tools.filter((tool) => tool.action === 'failed');
  return {
    status: failures.length > 0 ? 'incomplete' : 'complete',
    tools,
    failures,
    nextActions: failures.length > 0 ? recoveryActions(failures) : nextActions(),
  };
}
