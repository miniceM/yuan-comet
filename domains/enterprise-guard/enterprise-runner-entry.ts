import { realpathSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  failedOpenCodeRunnerDecision,
  renderOpenCodeRunnerDecision,
} from './decision-codecs/opencode.js';
import { evaluateEnterpriseGuardSource } from './guard-service.js';
import { MAX_ENTERPRISE_HOOK_INPUT_BYTES } from './normalized-event.js';

type RunnerArgs = {
  platformId: string;
  projectRoot?: string;
};

function parseRunnerArgs(args: readonly string[]): RunnerArgs {
  let platformId: string | undefined;
  let projectRoot: string | undefined;
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === '--platform') {
      platformId = args[++index];
      continue;
    }
    if (argument === '--project-root') {
      projectRoot = args[++index];
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }
  if (!platformId || platformId.startsWith('--')) throw new Error('--platform is required');
  if (projectRoot?.startsWith('--')) throw new Error('--project-root requires a value');
  return { platformId, ...(projectRoot ? { projectRoot } : {}) };
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  try {
    const chunks: Buffer[] = [];
    const maxCapturedBytes = MAX_ENTERPRISE_HOOK_INPUT_BYTES + 1;
    let capturedBytes = 0;

    for await (const chunk of process.stdin) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const bytesToCapture = Math.min(bytes.length, maxCapturedBytes - capturedBytes);
      if (bytesToCapture > 0) {
        chunks.push(Buffer.from(bytes.subarray(0, bytesToCapture)));
        capturedBytes += bytesToCapture;
      }
    }

    return Buffer.concat(chunks).toString('utf8');
  } catch {
    return '';
  }
}

export async function executeEnterpriseRunner(
  args: readonly string[],
  source: string,
): Promise<string> {
  let parsed: RunnerArgs;
  try {
    parsed = parseRunnerArgs(args);
  } catch (error) {
    return failedOpenCodeRunnerDecision(
      `Enterprise Guard failed closed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  try {
    const evaluation = await evaluateEnterpriseGuardSource({
      platformId: parsed.platformId,
      source,
      projectRoot: parsed.projectRoot ?? null,
    });
    return renderOpenCodeRunnerDecision(evaluation);
  } catch {
    return failedOpenCodeRunnerDecision(
      'Enterprise Guard failed closed: internal evaluation unavailable',
    );
  }
}

function isDirectEntry(entry: string | undefined, moduleUrl: string = import.meta.url): boolean {
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return moduleUrl === pathToFileURL(entry).href;
  }
}

if (isDirectEntry(process.argv[1])) {
  void readStdin().then(async (source) => {
    process.stdout.write(`${await executeEnterpriseRunner(process.argv.slice(2), source)}\n`);
  });
}
