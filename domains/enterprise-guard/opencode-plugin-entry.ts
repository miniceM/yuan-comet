import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseOpenCodeRunnerDecision } from './decision-codecs/opencode.js';
import { OPENCODE_PLUGIN_MARKER } from './hook-lifecycle.js';
import { isAuditedOpenCodeTool } from './input-codecs/opencode.js';

const RUNNER_TIMEOUT_MS = 10_000;
const INSTALLED_RUNNER_RELATIVE_PATH = '../skills/comet/scripts/comet-enterprise-runner.mjs';
const PUBLISHED_RUNNER_RELATIVE_PATH = '../scripts/comet-enterprise-runner.mjs';
const PLATFORM = 'opencode';

type OpenCodePluginContext = {
  directory?: unknown;
  worktree?: unknown;
};

type OpenCodeHookInput = {
  tool?: unknown;
};

type OpenCodeHookOutput = {
  args?: unknown;
};

function runnerPath(): string {
  if (
    process.env.COMET_ENTERPRISE_GUARD_RUNNER &&
    existsSync(process.env.COMET_ENTERPRISE_GUARD_RUNNER)
  ) {
    return process.env.COMET_ENTERPRISE_GUARD_RUNNER;
  }
  try {
    const storageRoot =
      process.env.COMET_ENTERPRISE_GUARD_RUNTIME_ROOT ||
      path.join(os.homedir(), '.comet', 'enterprise-guard');
    const pointerFile = path.join(storageRoot, 'current.json');
    if (existsSync(pointerFile)) {
      const pointer = JSON.parse(readFileSync(pointerFile, 'utf8')) as { activePath?: string };
      if (typeof pointer?.activePath === 'string') {
        const candidate = path.join(pointer.activePath, 'comet-enterprise-runner.mjs');
        if (existsSync(candidate)) return candidate;
      }
    }
  } catch {
    // Ignore and fallback
  }
  const currentPath = fileURLToPath(import.meta.url);
  const currentDir = path.dirname(currentPath);
  for (const relativePath of [INSTALLED_RUNNER_RELATIVE_PATH, PUBLISHED_RUNNER_RELATIVE_PATH]) {
    const candidate = path.resolve(currentDir, relativePath);
    if (existsSync(candidate)) return candidate;
  }
  return path.resolve(currentDir, INSTALLED_RUNNER_RELATIVE_PATH);
}

function nodeExecutablePath(): string {
  const executableName = path.basename(process.execPath).replace(/\.exe$/iu, '');
  // OpenCode plugins may run under the OpenCode binary (Bun), not Node.
  return executableName === 'node' ? process.execPath : 'node';
}

function workingDirectory(context: OpenCodePluginContext | undefined): string | null {
  for (const value of [context?.directory, context?.worktree]) {
    if (typeof value === 'string' && value.trim()) return value;
  }
  return null;
}

function runRunner(payload: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    let settled = false;
    let stdout = '';
    let stderr = '';
    const child = spawn(nodeExecutablePath(), [runnerPath(), '--platform', PLATFORM], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
    }, RUNNER_TIMEOUT_MS);
    const finish = (code: number, reason = stderr) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr: reason });
    };

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (stdout.length < 1_048_576) stdout += chunk;
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      if (stderr.length < 65_536) stderr += chunk;
    });
    child.on('error', (error) => finish(1, error.message));
    child.on('close', (code) => finish(code ?? 1));
    child.stdin.end(payload);
  });
}

function failClosed(reason: string): never {
  throw new Error(`Enterprise Guard failed closed: ${reason}`);
}

/** Thin host bridge: normalize, invoke the managed Runner, and deny by throwing. */
export const CometEnterpriseGuardPlugin = async (context?: OpenCodePluginContext) => ({
  [OPENCODE_PLUGIN_MARKER]: true,
  'tool.execute.before': async (input: OpenCodeHookInput, output: OpenCodeHookOutput) => {
    const toolName = typeof input?.tool === 'string' ? input.tool.trim() : null;
    if (toolName !== null && !isAuditedOpenCodeTool(toolName)) {
      return;
    }
    const payload = JSON.stringify({
      hook_event_name: 'tool.execute.before',
      tool: input?.tool ?? null,
      tool_input: output?.args ?? {},
      ...(workingDirectory(context) ? { cwd: workingDirectory(context) } : {}),
    });
    const result = await runRunner(payload);
    if (result.code !== 0) failClosed(result.stderr.trim() || `Runner exited ${result.code}`);
    const decision = parseOpenCodeRunnerDecision(result.stdout);
    if (!decision.allowed) {
      throw new Error(
        `Enterprise Guard blocked${decision.ruleId ? ` ${decision.ruleId}` : ''}: ${decision.reason}`,
      );
    }
  },
});

export default CometEnterpriseGuardPlugin;
