import { execFileSync } from 'child_process';
import fs from 'fs';
import { promises as fsp } from 'fs';
import os from 'os';
import path from 'path';
import { applyEdits, modify, parse as parseJsonc } from 'jsonc-parser';
import { parse as parseToml } from 'smol-toml';
import { parse as parseYaml, parseDocument } from 'yaml';
import { getNpmExecutable } from '../integrations/openspec.js';
import type { InstallScope } from '../../platform/install/types.js';
import type {
  CodebaseMemoryAction,
  CodebaseMemoryAgentDiagnostic,
  CodebaseMemoryAgentStatus,
  CodebaseMemoryCliStatus,
  CodebaseMemoryFreshness,
  CodebaseMemoryIndexDiagnostic,
  CodebaseMemoryIndexStatus,
  CodebaseMemoryRepairResult,
  CodebaseMemorySetupDiagnostic,
  CodebaseMemorySetupOptions,
  CodebaseMemoryStepStatus,
} from './types.js';

const CODEBASE_MEMORY_PACKAGE = 'codebase-memory-mcp';
const CODEBASE_MEMORY_VERSION = '0.8.1';
const CODEBASE_MEMORY_SERVICE = 'codebase-memory-mcp';
const CONFIG_LOCK_TIMEOUT_MS = 10_000;
const CONFIG_LOCK_RETRY_MS = 40;

type ConfigFormat = 'json' | 'jsonc' | 'toml' | 'yaml';
type ConfigStyle = 'standard' | 'opencode';

interface ConfigCandidate {
  scope: InstallScope;
  path: string;
  format: ConfigFormat;
  style: ConfigStyle;
  /** Conditional clients must already have the exact config file. */
  existingOnly?: boolean;
}

interface CodebaseMemoryTarget {
  platform: string;
  name: string;
  candidates: ConfigCandidate[];
}

interface ConfigInspection {
  status: Extract<CodebaseMemoryAgentStatus, 'registered' | 'missing' | 'conflict' | 'invalid'>;
  configPath: string | null;
  detail: string;
}

interface ConfigWriteResult {
  status: Extract<CodebaseMemoryAgentStatus, 'registered' | 'missing' | 'conflict' | 'invalid'>;
  configPath: string | null;
  detail: string;
  changed: boolean;
}

interface CliResult {
  output: string;
  command: string;
}

function platformCommandName(command: string): string {
  return process.platform === 'win32' ? `${command}.exe` : command;
}

function resolveCommandOnPath(command: string): string | null {
  try {
    const checker = process.platform === 'win32' ? 'where' : 'which';
    const result = execFileSync(checker, [command], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 10_000,
      shell: process.platform === 'win32',
    });
    if (result === undefined || result === null) return null;
    const resolved = String(result).trim().split(/\r?\n/u)[0];
    return resolved || null;
  } catch {
    return null;
  }
}

function resolvePnpmGlobalCommand(command: string): string | null {
  try {
    const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
    const binDir = execFileSync(pnpm, ['bin', '-g'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 10_000,
      shell: process.platform === 'win32',
    }).trim();
    if (!binDir) return null;
    const candidates =
      process.platform === 'win32'
        ? [`${command}.cmd`, `${command}.exe`, `${command}.ps1`, command]
        : [command];
    for (const candidate of candidates) {
      const candidatePath = path.join(binDir, candidate);
      if (fs.existsSync(candidatePath)) return candidatePath;
    }
  } catch {
    // pnpm is optional; npm and PATH are checked separately.
  }
  return null;
}

export function resolveCodebaseMemoryCommand(): string | null {
  return (
    resolveCommandOnPath(CODEBASE_MEMORY_SERVICE) ??
    resolvePnpmGlobalCommand(platformCommandName(CODEBASE_MEMORY_SERVICE))
  );
}

function homePath(homeDir: string | undefined, environmentName: string, fallback: string): string {
  const home = path.resolve(homeDir ?? os.homedir());
  if (homeDir === undefined) {
    const configured = process.env[environmentName];
    if (configured?.trim()) return path.resolve(configured);
  }
  return path.join(home, fallback);
}

function jsonCandidate(
  scope: InstallScope,
  filePath: string,
  style: ConfigStyle = 'standard',
  format: ConfigFormat = 'json',
  existingOnly = false,
): ConfigCandidate {
  return { scope, path: filePath, style, format, existingOnly };
}

function codebaseMemoryTargets(projectPath: string, homeDir?: string): CodebaseMemoryTarget[] {
  const project = path.resolve(projectPath);
  const home = path.resolve(homeDir ?? os.homedir());
  const opencodeConfig =
    homeDir === undefined && process.env.OPENCODE_CONFIG?.trim()
      ? path.resolve(process.env.OPENCODE_CONFIG)
      : path.join(home, '.config', 'opencode', 'opencode.json');
  const hermesHome = homePath(homeDir, 'HERMES_HOME', '.hermes');
  const codexHome = homePath(homeDir, 'CODEX_HOME', '.codex');
  const kiloHome = path.join(home, '.config', 'kilo');
  const ompHome =
    homeDir === undefined && (process.env.OMP_PROFILE || process.env.PI_CODING_AGENT_DIR)
      ? path.resolve(process.env.OMP_PROFILE ?? process.env.PI_CODING_AGENT_DIR!)
      : path.join(home, '.omp', 'agent');

  return [
    {
      platform: 'claude',
      name: 'Claude Code',
      candidates: [
        jsonCandidate('global', path.join(home, '.claude.json')),
        jsonCandidate('project', path.join(project, '.mcp.json')),
      ],
    },
    {
      platform: 'cursor',
      name: 'Cursor',
      candidates: [
        jsonCandidate('global', path.join(home, '.cursor', 'mcp.json')),
        jsonCandidate('project', path.join(project, '.cursor', 'mcp.json')),
      ],
    },
    {
      platform: 'codex',
      name: 'Codex CLI',
      candidates: [
        jsonCandidate('global', path.join(codexHome, 'config.toml'), 'standard', 'toml'),
      ],
    },
    {
      platform: 'opencode',
      name: 'OpenCode',
      candidates: [
        jsonCandidate('global', opencodeConfig, 'opencode', 'jsonc'),
        jsonCandidate('global', opencodeConfig.replace(/\.jsonc?$/u, '.json'), 'opencode', 'json'),
        jsonCandidate('project', path.join(project, 'opencode.json'), 'opencode'),
        jsonCandidate('project', path.join(project, 'opencode.jsonc'), 'opencode', 'jsonc'),
      ],
    },
    {
      platform: 'gemini',
      name: 'Gemini CLI',
      candidates: [
        jsonCandidate('global', path.join(home, '.gemini', 'settings.json')),
        jsonCandidate('project', path.join(project, '.gemini', 'settings.json')),
      ],
    },
    {
      platform: 'antigravity',
      name: 'Antigravity',
      candidates: [
        jsonCandidate('global', path.join(home, '.gemini', 'config', 'mcp_config.json')),
        jsonCandidate('global', path.join(home, '.gemini', 'antigravity', 'mcp_config.json')),
      ],
    },
    {
      platform: 'antigravity2',
      name: 'Antigravity 2.0',
      candidates: [
        jsonCandidate('global', path.join(home, '.gemini', 'config', 'mcp_config.json')),
      ],
    },
    {
      platform: 'kiro',
      name: 'Kiro',
      candidates: [
        jsonCandidate('global', path.join(home, '.kiro', 'settings', 'mcp.json')),
        jsonCandidate('project', path.join(project, '.kiro', 'settings', 'mcp.json')),
      ],
    },
    {
      platform: 'qwen',
      name: 'Qwen Code',
      candidates: [
        jsonCandidate('global', path.join(home, '.qwen', 'settings.json')),
        jsonCandidate('project', path.join(project, '.qwen', 'settings.json')),
      ],
    },
    {
      platform: 'kilocode',
      name: 'Kilo Code',
      candidates: [jsonCandidate('global', path.join(kiloHome, 'kilo.jsonc'), 'standard', 'jsonc')],
    },
    {
      platform: 'factory',
      name: 'Factory Droid',
      candidates: [
        jsonCandidate('global', path.join(home, '.factory', 'mcp.json')),
        jsonCandidate('project', path.join(project, '.factory', 'mcp.json')),
      ],
    },
    {
      platform: 'crush',
      name: 'Crush',
      candidates: [jsonCandidate('global', path.join(home, '.config', 'crush', 'crush.json'))],
    },
    {
      platform: 'codebuddy',
      name: 'CodeBuddy',
      candidates: [
        jsonCandidate('global', path.join(home, '.codebuddy', '.mcp.json')),
        jsonCandidate('project', path.join(project, '.codebuddy', '.mcp.json')),
      ],
    },
    {
      platform: 'bob',
      name: 'Bob Shell',
      candidates: [jsonCandidate('global', path.join(home, '.bob', 'mcp_settings.json'))],
    },
    {
      platform: 'oh-my-pi',
      name: 'Oh My Pi',
      candidates: [jsonCandidate('global', path.join(ompHome, 'mcp.json'))],
    },
    {
      platform: 'hermes',
      name: 'Hermes Agent',
      candidates: [
        jsonCandidate('global', path.join(hermesHome, 'config.yaml'), 'standard', 'yaml'),
      ],
    },
    {
      platform: 'continue',
      name: 'Continue',
      candidates: [
        jsonCandidate(
          'global',
          homeDir === undefined && process.env.CBM_CONTINUE_CONFIG_PATH?.trim()
            ? path.resolve(process.env.CBM_CONTINUE_CONFIG_PATH)
            : path.join(home, '.continue', 'config.yaml'),
          'standard',
          'yaml',
          true,
        ),
      ],
    },
    {
      platform: 'trae',
      name: 'Trae',
      candidates: conditionalConfigCandidate('global', homeDir, 'CBM_TRAE_CONFIG_PATH'),
    },
    {
      platform: 'roocode',
      name: 'RooCode',
      candidates: conditionalConfigCandidate('global', homeDir, 'CBM_ROO_CONFIG_PATH'),
    },
  ];
}

function conditionalConfigCandidate(
  scope: InstallScope,
  homeDir: string | undefined,
  environmentName: string,
): ConfigCandidate[] {
  if (homeDir !== undefined || !process.env[environmentName]?.trim()) return [];
  return [
    jsonCandidate(scope, path.resolve(process.env[environmentName]!), 'standard', 'json', true),
  ];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function commandText(value: unknown): string {
  return Array.isArray(value)
    ? value.filter((part): part is string => typeof part === 'string').join(' ')
    : typeof value === 'string'
      ? value
      : '';
}

function isCodebaseMemoryCommand(value: unknown): boolean {
  return /(?:^|[\\/\s"'])codebase-memory-mcp(?:\.exe)?(?:$|[\s"'])/iu.test(commandText(value));
}

function isDisabledEntry(entry: Record<string, unknown>): boolean {
  return entry.disabled === true || entry.enabled === false;
}

function inspectServerEntry(entry: unknown): 'registered' | 'conflict' | 'invalid' {
  if (!isRecord(entry)) return 'invalid';
  if (isDisabledEntry(entry)) return 'invalid';
  return isCodebaseMemoryCommand(entry.command) || isCodebaseMemoryCommand(entry.args)
    ? 'registered'
    : 'conflict';
}

function serverEntries(value: unknown, key: string): Record<string, unknown> {
  if (!isRecord(value)) return {};
  const servers = value[key];
  return isRecord(servers) ? servers : {};
}

function inspectJsonSource(source: string, style: ConfigStyle): ConfigInspection {
  try {
    const value = parseJsonc(source) as Record<string, unknown>;
    const key = style === 'opencode' ? 'mcp' : 'mcpServers';
    const servers = serverEntries(value, key);
    const named = servers[CODEBASE_MEMORY_SERVICE];
    if (named !== undefined) {
      const status = inspectServerEntry(named);
      return {
        status,
        configPath: null,
        detail:
          status === 'registered'
            ? 'codebase-memory-mcp is registered'
            : `MCP entry "${CODEBASE_MEMORY_SERVICE}" is not a valid codebase-memory-mcp server`,
      };
    }
    const equivalent = Object.values(servers).find((entry) => isCodebaseMemoryCommand(entry));
    if (equivalent !== undefined) {
      return {
        status: 'registered',
        configPath: null,
        detail: 'an existing MCP entry already points to codebase-memory-mcp',
      };
    }
    return { status: 'missing', configPath: null, detail: 'codebase-memory-mcp is not registered' };
  } catch (error) {
    return {
      status: 'invalid',
      configPath: null,
      detail: `unable to parse MCP configuration: ${(error as Error).message}`,
    };
  }
}

function inspectTomlSource(source: string): ConfigInspection {
  try {
    const value = parseToml(source) as Record<string, unknown>;
    const servers = serverEntries(value, 'mcp_servers');
    const named = servers[CODEBASE_MEMORY_SERVICE];
    if (named !== undefined) {
      const status = inspectServerEntry(named);
      return {
        status,
        configPath: null,
        detail:
          status === 'registered'
            ? 'codebase-memory-mcp is registered'
            : `MCP entry "${CODEBASE_MEMORY_SERVICE}" is not a valid codebase-memory-mcp server`,
      };
    }
    const equivalent = Object.values(servers).find((entry) => isCodebaseMemoryCommand(entry));
    return equivalent !== undefined
      ? {
          status: 'registered',
          configPath: null,
          detail: 'an existing MCP entry already points to codebase-memory-mcp',
        }
      : { status: 'missing', configPath: null, detail: 'codebase-memory-mcp is not registered' };
  } catch (error) {
    return {
      status: 'invalid',
      configPath: null,
      detail: `unable to parse MCP TOML configuration: ${(error as Error).message}`,
    };
  }
}

function inspectYamlSource(source: string): ConfigInspection {
  try {
    const value = parseYaml(source) as Record<string, unknown>;
    const servers = serverEntries(value, 'mcp_servers');
    const named = servers[CODEBASE_MEMORY_SERVICE];
    if (named !== undefined) {
      const status = inspectServerEntry(named);
      return {
        status,
        configPath: null,
        detail:
          status === 'registered'
            ? 'codebase-memory-mcp is registered'
            : `MCP entry "${CODEBASE_MEMORY_SERVICE}" is not a valid codebase-memory-mcp server`,
      };
    }
    const equivalent = Object.values(servers).find((entry) => isCodebaseMemoryCommand(entry));
    return equivalent !== undefined
      ? {
          status: 'registered',
          configPath: null,
          detail: 'an existing MCP entry already points to codebase-memory-mcp',
        }
      : { status: 'missing', configPath: null, detail: 'codebase-memory-mcp is not registered' };
  } catch (error) {
    return {
      status: 'invalid',
      configPath: null,
      detail: `unable to parse MCP YAML configuration: ${(error as Error).message}`,
    };
  }
}

function inspectCandidate(candidate: ConfigCandidate): ConfigInspection | null {
  if (!fs.existsSync(candidate.path)) return null;
  try {
    const source = fs.readFileSync(candidate.path, 'utf8');
    const inspection =
      candidate.format === 'toml'
        ? inspectTomlSource(source)
        : candidate.format === 'yaml'
          ? inspectYamlSource(source)
          : inspectJsonSource(source, candidate.style);
    return { ...inspection, configPath: candidate.path };
  } catch (error) {
    return {
      status: 'invalid',
      configPath: candidate.path,
      detail: `unable to read MCP configuration: ${(error as Error).message}`,
    };
  }
}

function inspectTarget(
  target: CodebaseMemoryTarget | undefined,
  scope: InstallScope,
): ConfigInspection {
  if (!target) {
    return {
      status: 'missing',
      configPath: null,
      detail: 'the selected platform has no verified codebase-memory-mcp configuration adapter',
    };
  }
  const candidates = target.candidates.filter((candidate) => candidate.scope === scope);
  const existing = candidates
    .map((candidate) => inspectCandidate(candidate))
    .filter((candidate): candidate is ConfigInspection => candidate !== null);
  if (existing.length === 0) {
    return {
      status: 'missing',
      configPath: null,
      detail:
        candidates.length === 0
          ? `Codebase Memory does not support ${scope} scope for ${target.name}`
          : `no active ${target.name} MCP configuration was found`,
    };
  }
  const registered = existing.find((result) => result.status === 'registered');
  return registered ?? existing[0];
}

function mcpEntry(command: string, style: ConfigStyle): Record<string, unknown> {
  return style === 'opencode'
    ? { type: 'local', command: [command], enabled: true }
    : { command, args: [] };
}

function jsonTextWithEntry(source: string, style: ConfigStyle, command: string): string {
  const key = style === 'opencode' ? 'mcp' : 'mcpServers';
  const edits = modify(source, [key, CODEBASE_MEMORY_SERVICE], mcpEntry(command, style), {
    formattingOptions: { insertSpaces: true, tabSize: 2, eol: '\n' },
  });
  return applyEdits(source, edits);
}

function tomlEntryText(source: string, command: string): string {
  const separator = source.length === 0 || source.endsWith('\n') ? '' : '\n';
  return `${source}${separator}\n[mcp_servers."${CODEBASE_MEMORY_SERVICE}"]\ncommand = ${JSON.stringify(command)}\nargs = []\n`;
}

function yamlTextWithEntry(source: string, command: string): string {
  const document = parseDocument(source || '{}', { uniqueKeys: true });
  document.setIn(['mcp_servers', CODEBASE_MEMORY_SERVICE], { command, args: [] });
  return document.toString();
}

async function acquireConfigLock(lockPath: string): Promise<() => Promise<void>> {
  const started = Date.now();
  while (true) {
    try {
      const handle = await fsp.open(lockPath, 'wx');
      await handle.close();
      return async () => {
        await fsp.rm(lockPath, { force: true });
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (Date.now() - started >= CONFIG_LOCK_TIMEOUT_MS) {
        throw new Error(`timed out waiting for MCP configuration lock: ${lockPath}`, {
          cause: error,
        });
      }
      await new Promise((resolve) => setTimeout(resolve, CONFIG_LOCK_RETRY_MS));
    }
  }
}

async function atomicWriteConfig(filePath: string, content: string): Promise<void> {
  const directory = path.dirname(filePath);
  await fsp.mkdir(directory, { recursive: true });
  let mode = 0o600;
  try {
    mode = (await fsp.stat(filePath)).mode & 0o777;
  } catch {
    // New MCP configuration files should not be world-readable by default.
  }
  const temporary = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`,
  );
  try {
    await fsp.writeFile(temporary, content, { encoding: 'utf8', mode });
    await fsp.rename(temporary, filePath);
  } finally {
    await fsp.rm(temporary, { force: true });
  }
}

async function writeTargetConfig(
  candidate: ConfigCandidate,
  command: string,
): Promise<ConfigWriteResult> {
  const lockPath = `${candidate.path}.comet.lock`;
  const release = await acquireConfigLock(lockPath);
  try {
    let source = '';
    try {
      source = await fsp.readFile(candidate.path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const current = source
      ? candidate.format === 'toml'
        ? inspectTomlSource(source)
        : candidate.format === 'yaml'
          ? inspectYamlSource(source)
          : inspectJsonSource(source, candidate.style)
      : { status: 'missing' as const, configPath: null, detail: 'configuration file is absent' };
    if (current.status === 'registered') {
      return {
        status: 'registered',
        configPath: candidate.path,
        detail: current.detail,
        changed: false,
      };
    }
    if (current.status === 'conflict' || current.status === 'invalid') {
      return { ...current, configPath: candidate.path, changed: false };
    }
    let output: string;
    try {
      output =
        candidate.format === 'toml'
          ? tomlEntryText(source, command)
          : candidate.format === 'yaml'
            ? yamlTextWithEntry(source, command)
            : jsonTextWithEntry(source || '{}\n', candidate.style, command);
      if (candidate.format === 'json' || candidate.format === 'jsonc') {
        if (!isRecord(parseJsonc(output))) throw new Error('result is not a JSON object');
      } else if (candidate.format === 'toml') {
        parseToml(output);
      } else {
        parseYaml(output);
      }
    } catch (error) {
      return {
        status: 'invalid',
        configPath: candidate.path,
        detail: `unable to update MCP configuration: ${(error as Error).message}`,
        changed: false,
      };
    }
    await atomicWriteConfig(candidate.path, output);
    return {
      status: 'registered',
      configPath: candidate.path,
      detail: 'codebase-memory-mcp MCP configuration registered',
      changed: true,
    };
  } finally {
    await release();
  }
}

function parseCliJson(output: string): unknown {
  const trimmed = output.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    const lines = trimmed.split(/\r?\n/u).reverse();
    for (const line of lines) {
      try {
        return JSON.parse(line) as unknown;
      } catch {
        // Keep looking for the JSON payload after progress output.
      }
    }
  }
  return null;
}

function runCli(
  command: string,
  args: string[],
  cwd: string,
  timeout: number,
  quiet: boolean,
): CliResult {
  const output = execFileSync(command, args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', quiet ? 'pipe' : 'inherit'],
    timeout,
    shell: process.platform === 'win32',
  });
  return { output: String(output), command };
}

function canonicalProjectPath(projectPath: string): string {
  try {
    return fs.realpathSync(projectPath);
  } catch {
    return path.resolve(projectPath);
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function projectRecords(payload: unknown): Record<string, unknown>[] {
  if (Array.isArray(payload)) return payload.filter(isRecord);
  const record = asRecord(payload);
  for (const key of ['projects', 'items', 'results']) {
    if (Array.isArray(record[key])) return record[key].filter(isRecord);
  }
  return [];
}

function projectPathOf(record: Record<string, unknown>): string | null {
  for (const key of ['repo_path', 'repoPath', 'project_path', 'projectPath', 'root', 'path']) {
    if (typeof record[key] === 'string' && record[key].trim()) {
      return canonicalProjectPath(record[key]);
    }
  }
  return null;
}

function stringField(record: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    if (typeof record[key] === 'string' && record[key].trim()) return record[key].trim();
  }
  return null;
}

function normalizeIndexState(value: string | null): {
  status: CodebaseMemoryIndexStatus;
  freshness: CodebaseMemoryFreshness;
} {
  const state = value?.toLowerCase() ?? '';
  if (/(indexing|processing|building|pending)/u.test(state)) {
    return { status: 'indexing', freshness: 'unknown' };
  }
  if (/(stale|outdated|dirty|changes|needs.?index)/u.test(state)) {
    return { status: 'stale', freshness: 'stale' };
  }
  if (/(fail|error)/u.test(state)) return { status: 'failed', freshness: 'unknown' };
  if (/(ready|current|complete|completed|ok|healthy)/u.test(state)) {
    return { status: 'ready', freshness: 'current' };
  }
  return { status: 'unknown', freshness: 'unknown' };
}

function indexStateFromRecord(record: Record<string, unknown>): {
  status: CodebaseMemoryIndexStatus;
  freshness: CodebaseMemoryFreshness;
} {
  const freshness = stringField(record, ['freshness', 'index_freshness', 'indexFreshness']);
  if (freshness) {
    const normalizedFreshness = /current|fresh|ready/u.test(freshness.toLowerCase())
      ? 'current'
      : /stale|outdated/u.test(freshness.toLowerCase())
        ? 'stale'
        : 'unknown';
    const state = normalizeIndexState(
      stringField(record, ['status', 'index_status', 'indexStatus', 'state']),
    );
    return {
      status:
        state.status === 'unknown' && normalizedFreshness === 'current' ? 'ready' : state.status,
      freshness: normalizedFreshness,
    };
  }
  return normalizeIndexState(
    stringField(record, ['status', 'index_status', 'indexStatus', 'state', 'phase']),
  );
}

function inspectIndexWithCommand(
  projectPath: string,
  command: string,
  quiet: boolean,
): CodebaseMemoryIndexDiagnostic {
  const canonical = canonicalProjectPath(projectPath);
  let listPayload: unknown;
  try {
    listPayload = parseCliJson(
      runCli(command, ['cli', 'list_projects'], canonical, 30_000, quiet).output,
    );
  } catch (error) {
    return {
      status: 'unknown',
      freshness: 'unknown',
      projectId: null,
      projectPath: canonical,
      detail: `unable to list codebase-memory-mcp projects: ${(error as Error).message}`,
      remediation: 'codebase-memory-mcp cli list_projects',
    };
  }
  const match = projectRecords(listPayload).find((record) => projectPathOf(record) === canonical);
  if (!match) {
    return {
      status: 'missing',
      freshness: 'unknown',
      projectId: null,
      projectPath: canonical,
      detail: 'no codebase-memory-mcp index is registered for this exact project path',
      remediation: 'codebase-memory-mcp cli index_repository',
    };
  }
  const projectId = stringField(match, ['id', 'project_id', 'projectId', 'name']);
  let state = indexStateFromRecord(match);
  if (state.status === 'unknown' && projectId) {
    try {
      const payload = parseCliJson(
        runCli(
          command,
          ['cli', 'index_status', JSON.stringify({ project: projectId })],
          canonical,
          30_000,
          quiet,
        ).output,
      );
      const statusRecord = asRecord(payload);
      state = indexStateFromRecord(statusRecord);
      if (state.status === 'unknown' && isRecord(statusRecord.index)) {
        state = indexStateFromRecord(statusRecord.index);
      }
    } catch {
      // Keep the explicit unknown state. A successful list is not proof of freshness.
    }
  }
  return {
    status: state.status,
    freshness: state.freshness,
    projectId,
    projectPath: canonical,
    detail:
      state.status === 'ready'
        ? 'codebase-memory-mcp index is ready for this exact project path'
        : `codebase-memory-mcp index status is ${state.status}`,
    remediation: state.status === 'ready' ? null : 'codebase-memory-mcp cli index_repository',
  };
}

function notApplicableIndex(projectPath: string): CodebaseMemoryIndexDiagnostic {
  return {
    status: 'not_applicable',
    freshness: 'not_applicable',
    projectId: null,
    projectPath: canonicalProjectPath(projectPath),
    detail: 'global installation does not initialize the calling directory',
    remediation: null,
  };
}

function targetAgentDiagnostic(
  target: CodebaseMemoryTarget | undefined,
  platform: string,
  scope: InstallScope,
): CodebaseMemoryAgentDiagnostic {
  const inspection = inspectTarget(target, scope);
  return {
    platform,
    name: target?.name ?? platform,
    scope,
    status: target ? inspection.status : 'unsupported',
    configPath: inspection.configPath,
    detail: inspection.detail,
  };
}

function configuredFromAgents(agents: CodebaseMemoryAgentDiagnostic[]): boolean {
  return agents.some(
    (agent) =>
      agent.status === 'registered' || agent.status === 'conflict' || agent.status === 'invalid',
  );
}

function diagnosticForSkip(
  projectPath: string,
  scope: InstallScope,
): CodebaseMemorySetupDiagnostic {
  return {
    requested: 'skip',
    status: 'skipped',
    configured: false,
    cliStatus: 'skipped',
    indexStatus: 'skipped',
    freshness: scope === 'global' ? 'not_applicable' : 'unknown',
    agents: [],
    repairable: false,
    remediation: null,
    detail: 'codebase-memory-mcp setup explicitly skipped',
    program: 'skipped',
    configuration: 'skipped',
    index: 'skipped',
    failures: [],
  };
}

export function hasCodebaseMemoryInstallation(
  projectPath: string,
  scope: InstallScope,
  homeDir?: string,
): boolean {
  if (resolveCodebaseMemoryCommand()) return true;
  const targets = codebaseMemoryTargets(projectPath, homeDir);
  return targets.some((target) => inspectTarget(target, scope).status === 'registered');
}

export function inspectCodebaseMemoryIntegration(
  projectPath: string,
  scope: InstallScope = 'project',
  homeDir?: string,
): CodebaseMemorySetupDiagnostic {
  const resolvedCommand = resolveCodebaseMemoryCommand();
  let command = resolvedCommand;
  let cliStatus: CodebaseMemoryCliStatus = resolvedCommand ? 'installed' : 'missing';
  let cliError: string | null = null;
  if (resolvedCommand) {
    try {
      runCli(resolvedCommand, ['--version'], projectPath, 15_000, true);
    } catch (error) {
      command = null;
      cliStatus = 'incompatible';
      cliError = `codebase-memory-mcp CLI failed version validation: ${(error as Error).message}`;
    }
  }
  const targets = codebaseMemoryTargets(projectPath, homeDir);
  const allowedTargets = targets.filter((target) =>
    target.candidates.some(
      (candidate) =>
        candidate.scope === scope && (!candidate.existingOnly || fs.existsSync(candidate.path)),
    ),
  );
  const agents = allowedTargets
    .map((target) => targetAgentDiagnostic(target, target.platform, scope))
    .filter((agent) => agent.status !== 'missing' || agent.configPath !== null);
  const configured = configuredFromAgents(agents);
  const index =
    command && scope === 'project'
      ? inspectIndexWithCommand(projectPath, command, true)
      : scope === 'global'
        ? notApplicableIndex(projectPath)
        : {
            status: 'unknown' as const,
            freshness: 'unknown' as const,
            projectId: null,
            projectPath: canonicalProjectPath(projectPath),
            detail: 'codebase-memory-mcp CLI is not installed and no project index can be checked',
            remediation: 'install codebase-memory-mcp and retry',
          };
  const indexConfigured = index.status !== 'missing' && index.status !== 'not_applicable';
  const effectiveConfigured = configured || indexConfigured;
  const agentConfigurationBlocked = agents.some(
    (agent) => agent.status === 'conflict' || agent.status === 'invalid',
  );
  const detail = cliError
    ? cliError
    : !effectiveConfigured
      ? 'codebase-memory-mcp is not configured'
      : command
        ? 'codebase-memory-mcp installation is partially configured; inspect CLI, Agent MCP, and project index separately'
        : 'codebase-memory-mcp configuration exists but its CLI is not available';
  const repairable =
    command !== null &&
    scope === 'project' &&
    !agentConfigurationBlocked &&
    effectiveConfigured &&
    (index.status === 'missing' || index.status === 'stale' || index.status === 'failed');
  return {
    requested: 'auto',
    status:
      cliStatus === 'installed' &&
      (!configured || agents.every((agent) => agent.status === 'registered')) &&
      (scope === 'global' || index.status === 'ready' || index.status === 'not_applicable')
        ? 'installed'
        : effectiveConfigured
          ? 'failed'
          : 'skipped',
    configured: effectiveConfigured,
    cliStatus,
    indexStatus: index.status,
    freshness: index.freshness,
    agents,
    repairable,
    remediation: repairable ? 'codebase-memory-mcp cli index_repository' : index.remediation,
    detail,
    program: command ? 'installed' : 'skipped',
    configuration: configured ? 'installed' : 'skipped',
    index: index.status === 'ready' ? 'installed' : 'skipped',
    failures: [],
  };
}

async function ensureCodebaseMemoryCli(
  projectPath: string,
  quiet: boolean,
): Promise<{ command: string | null; status: CodebaseMemoryCliStatus; error?: string }> {
  const existing = resolveCodebaseMemoryCommand();
  if (existing) {
    try {
      runCli(existing, ['--version'], projectPath, 15_000, true);
      return { command: existing, status: 'installed' };
    } catch (error) {
      return {
        command: null,
        status: 'incompatible',
        error: `installed codebase-memory-mcp is not executable: ${(error as Error).message}`,
      };
    }
  }
  try {
    if (!quiet) console.log(`    Installing ${CODEBASE_MEMORY_PACKAGE}...`);
    execFileSync(
      getNpmExecutable(),
      ['install', '-g', `${CODEBASE_MEMORY_PACKAGE}@${CODEBASE_MEMORY_VERSION}`],
      {
        cwd: projectPath,
        stdio: quiet ? ['ignore', 'ignore', 'pipe'] : 'inherit',
        timeout: 180_000,
        shell: process.platform === 'win32',
      },
    );
  } catch (error) {
    return {
      command: null,
      status: 'missing',
      error: `failed to install ${CODEBASE_MEMORY_PACKAGE}: ${(error as Error).message}`,
    };
  }
  const installed = resolveCodebaseMemoryCommand();
  if (!installed) {
    return {
      command: null,
      status: 'missing',
      error: `${CODEBASE_MEMORY_PACKAGE} was installed but its executable could not be resolved`,
    };
  }
  try {
    runCli(installed, ['--version'], projectPath, 15_000, true);
    return { command: installed, status: 'installed' };
  } catch (error) {
    return {
      command: null,
      status: 'incompatible',
      error: `installed ${CODEBASE_MEMORY_PACKAGE} failed version validation: ${(error as Error).message}`,
    };
  }
}

function projectIndexNeedsInitialization(index: CodebaseMemoryIndexDiagnostic): boolean {
  return index.status === 'missing' || index.status === 'stale' || index.status === 'failed';
}

function setupStatus(
  program: CodebaseMemoryStepStatus,
  configuration: CodebaseMemoryStepStatus,
  index: CodebaseMemoryStepStatus,
): CodebaseMemoryStepStatus {
  if ([program, configuration, index].includes('failed')) return 'failed';
  if ([program, configuration, index].some((status) => status === 'installed')) return 'installed';
  return 'skipped';
}

export async function setupCodebaseMemory(
  options: CodebaseMemorySetupOptions,
): Promise<CodebaseMemorySetupDiagnostic> {
  const { projectPath, scope, action, platformIds = [], homeDir, quiet = false } = options;
  if (action === 'skip') return diagnosticForSkip(projectPath, scope);

  const commandResult = await ensureCodebaseMemoryCli(projectPath, quiet);
  let program: CodebaseMemoryStepStatus = commandResult.command ? 'installed' : 'failed';
  let configuration: CodebaseMemoryStepStatus = 'skipped';
  let indexStep: CodebaseMemoryStepStatus;
  const failures: string[] = commandResult.error ? [commandResult.error] : [];
  const targets = codebaseMemoryTargets(projectPath, homeDir);
  const agents: CodebaseMemoryAgentDiagnostic[] = [];

  if (commandResult.command && action === 'install') {
    const selectedTargets = [...new Set(platformIds)].map((platform) => ({
      platform,
      target: targets.find((candidate) => candidate.platform === platform),
    }));
    const writes: ConfigWriteResult[] = [];
    for (const { platform, target } of selectedTargets) {
      if (!target) {
        agents.push({
          platform,
          name: platform,
          scope,
          status: 'unsupported',
          configPath: null,
          detail: 'the selected platform has no verified codebase-memory-mcp configuration adapter',
        });
        continue;
      }
      const candidates = target.candidates.filter(
        (candidate) =>
          candidate.scope === scope && (!candidate.existingOnly || fs.existsSync(candidate.path)),
      );
      const existingCandidate = candidates.find((candidate) => fs.existsSync(candidate.path));
      const candidate = existingCandidate ?? candidates[0];
      if (!candidate) {
        const inspection = inspectTarget(target, scope);
        agents.push({
          platform,
          name: target.name,
          scope,
          status: 'unsupported',
          configPath: inspection.configPath,
          detail: inspection.detail,
        });
        continue;
      }
      const result = await writeTargetConfig(candidate, commandResult.command);
      writes.push(result);
      agents.push({
        platform,
        name: target.name,
        scope,
        status: result.status,
        configPath: result.configPath,
        detail: result.detail,
      });
    }
    if (selectedTargets.length === 0) {
      configuration = 'skipped';
    } else if (writes.length === 0 || writes.some((result) => result.status !== 'registered')) {
      configuration = 'failed';
      for (const agent of agents.filter((entry) => entry.status !== 'registered')) {
        failures.push(`${agent.name}: ${agent.detail}`);
      }
    } else {
      configuration = writes.some((result) => result.changed) ? 'installed' : 'skipped';
    }
  }

  let index =
    scope === 'global'
      ? notApplicableIndex(projectPath)
      : commandResult.command
        ? inspectIndexWithCommand(projectPath, commandResult.command, quiet)
        : {
            status: 'unknown' as const,
            freshness: 'unknown' as const,
            projectId: null,
            projectPath: canonicalProjectPath(projectPath),
            detail: 'project index could not be checked because the CLI is unavailable',
            remediation: 'install codebase-memory-mcp and retry',
          };
  if (commandResult.command && scope === 'project' && projectIndexNeedsInitialization(index)) {
    try {
      if (!quiet) console.log('    Running: codebase-memory-mcp cli index_repository');
      runCli(
        commandResult.command,
        [
          'cli',
          'index_repository',
          JSON.stringify({ repo_path: canonicalProjectPath(projectPath) }),
        ],
        canonicalProjectPath(projectPath),
        600_000,
        quiet,
      );
      index = inspectIndexWithCommand(projectPath, commandResult.command, quiet);
    } catch (error) {
      index = {
        ...index,
        status: 'failed',
        freshness: 'unknown',
        detail: `codebase-memory-mcp project indexing failed: ${(error as Error).message}`,
        remediation: 'codebase-memory-mcp cli index_repository',
      };
    }
  }
  if (scope === 'global') {
    indexStep = 'skipped';
  } else if (index.status === 'ready') {
    indexStep = index.projectId ? 'installed' : 'skipped';
  } else {
    indexStep = 'failed';
    failures.push(index.detail);
  }
  if (!commandResult.command) {
    program = 'failed';
    indexStep = scope === 'global' ? 'skipped' : 'failed';
  }
  const status = setupStatus(program, configuration, indexStep);
  const configured = agents.some((agent) => agent.status === 'registered');
  const cliStatus = commandResult.status;
  return {
    requested: action,
    status,
    configured,
    cliStatus,
    indexStatus: index.status,
    freshness: index.freshness,
    agents,
    repairable:
      commandResult.command !== null &&
      scope === 'project' &&
      (index.status === 'missing' || index.status === 'stale' || index.status === 'failed'),
    remediation: failures[0] ?? index.remediation,
    detail: status === 'failed' ? failures.join('; ') : 'codebase-memory-mcp setup completed',
    program,
    configuration,
    index: indexStep,
    failures,
  };
}

export async function repairCodebaseMemoryIndex(
  projectPath: string,
  quiet = false,
): Promise<CodebaseMemoryRepairResult> {
  const before = inspectCodebaseMemoryIntegration(projectPath, 'project');
  if (!before.configured || !before.repairable) return { repaired: false, diagnostic: before };
  const command = resolveCodebaseMemoryCommand();
  if (!command) return { repaired: false, diagnostic: before };
  try {
    runCli(
      command,
      ['cli', 'index_repository', JSON.stringify({ repo_path: canonicalProjectPath(projectPath) })],
      canonicalProjectPath(projectPath),
      600_000,
      quiet,
    );
  } catch (error) {
    return {
      repaired: false,
      diagnostic: {
        ...before,
        status: 'failed',
        indexStatus: 'failed',
        detail: `codebase-memory-mcp index repair failed: ${(error as Error).message}`,
        failures: [(error as Error).message],
      },
    };
  }
  return { repaired: true, diagnostic: inspectCodebaseMemoryIntegration(projectPath, 'project') };
}

export function codebaseMemoryCheckResults(
  diagnostic: CodebaseMemorySetupDiagnostic,
): Array<{ check: string; status: 'pass' | 'warn' | 'fail'; message: string }> {
  const notConfigured = !diagnostic.configured && diagnostic.status === 'skipped';
  const cliStatus = diagnostic.cliStatus === 'installed' ? 'pass' : notConfigured ? 'pass' : 'warn';
  const indexHealthy =
    diagnostic.indexStatus === 'ready' || diagnostic.indexStatus === 'not_applicable';
  const indexStatus = indexHealthy || notConfigured ? 'pass' : 'warn';
  const agentStatus = diagnostic.agents.every((agent) => agent.status === 'registered')
    ? 'pass'
    : notConfigured
      ? 'pass'
      : 'warn';
  const agents =
    diagnostic.agents.length === 0
      ? 'not configured'
      : diagnostic.agents.map((agent) => `${agent.name}: ${agent.status}`).join('; ');
  return [
    {
      check: 'Codebase Memory CLI',
      status: cliStatus,
      message: notConfigured
        ? 'not configured'
        : diagnostic.cliStatus === 'installed'
          ? 'codebase-memory-mcp CLI is installed'
          : diagnostic.detail,
    },
    {
      check: 'Codebase Memory MCP registration',
      status: agentStatus,
      message: agents,
    },
    {
      check: 'Codebase Memory project index',
      status: indexStatus,
      message:
        diagnostic.indexStatus === 'not_applicable'
          ? 'project index is not part of global scope'
          : notConfigured
            ? 'not configured'
            : diagnostic.detail,
    },
  ];
}

export type {
  CodebaseMemoryAction,
  CodebaseMemoryAgentDiagnostic,
  CodebaseMemoryCliStatus,
  CodebaseMemoryFreshness,
  CodebaseMemoryIndexDiagnostic,
  CodebaseMemoryIndexStatus,
  CodebaseMemoryRepairResult,
  CodebaseMemorySetupDiagnostic,
  CodebaseMemorySetupOptions,
};
