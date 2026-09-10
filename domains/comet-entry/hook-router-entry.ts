import path from 'path';
import { realpathSync } from 'fs';
import { fileURLToPath, pathToFileURL } from 'url';

import {
  COMET_HOOK_PLATFORM_IDS,
  readCometHookRequest,
  renderCometHookDecision,
} from './hook-adapter.js';
import { runWithHookReadCache } from '../../platform/process/hook-read-cache.js';
import { inspectCometHook } from './hook-router.js';
import type { CometHookDecision } from './hook-types.js';
import { projectRootFrom } from './hook-project-root.js';

const USAGE = 'Usage: comet-hook-router --platform <platform-id> [--project-root <project-root>]';

interface ParsedArgs {
  platformId: string;
  projectRoot?: string;
}

function parseArgs(args: readonly string[]): ParsedArgs {
  let platformId: string | undefined;
  let projectRoot: string | undefined;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--platform') {
      platformId = args[++index];
      continue;
    }
    if (arg === '--project-root') {
      projectRoot = args[++index];
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  if (!platformId || platformId.startsWith('--')) throw new Error('--platform is required');
  if (!COMET_HOOK_PLATFORM_IDS.has(platformId)) {
    throw new Error(`unsupported Hook platform: ${platformId}`);
  }
  if (projectRoot?.startsWith('--')) throw new Error('--project-root requires a value');
  return { platformId, ...(projectRoot ? { projectRoot: path.resolve(projectRoot) } : {}) };
}

export async function runCometHookRouter(args: readonly string[]): Promise<number> {
  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(args);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n${USAGE}\n`);
    return 64;
  }

  let decision: CometHookDecision;
  try {
    const request = readCometHookRequest();
    const projectRoot = await projectRootFrom(parsed, request);
    decision = projectRoot
      ? await runWithHookReadCache(() => inspectCometHook(projectRoot, request))
      : { allowed: true, reason: 'No Comet project discovered' };
  } catch (error) {
    decision = {
      allowed: false,
      reason: `Comet Hook Router failed closed during project discovery: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const output = renderCometHookDecision(parsed.platformId, decision);
  if (output.stdout) process.stdout.write(output.stdout);
  if (output.stderr) process.stderr.write(output.stderr);
  return output.exitCode;
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  return runCometHookRouter(argv);
}

export function isDirectEntry(
  entry: string | undefined,
  moduleUrl: string = import.meta.url,
): boolean {
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return moduleUrl === pathToFileURL(entry).href;
  }
}

const entry = process.argv[1];
if (isDirectEntry(entry)) {
  void main().then((exitCode) => {
    process.exitCode = exitCode;
  });
}
