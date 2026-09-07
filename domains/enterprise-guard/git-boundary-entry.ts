import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { evaluatePreCommit, evaluatePrePush, type GitPushRef } from './git-boundary.js';

export * from './git-boundary.js';

const ZERO_OID = '0000000000000000000000000000000000000000';

export async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  return new Promise((res) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => res(data));
    process.stdin.on('error', () => res(''));
  });
}

export function isNonFastForward(
  projectRoot: string,
  localOid: string,
  remoteOid: string,
): boolean {
  if (!remoteOid || remoteOid === ZERO_OID) return false;
  if (!localOid || localOid === ZERO_OID) return false;
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', remoteOid, localOid], {
      cwd: projectRoot,
      stdio: 'ignore',
    });
    return false;
  } catch {
    return true;
  }
}

export function getStagedFiles(projectRoot: string): string[] {
  try {
    const output = execFileSync('git', ['diff', '--cached', '--name-only', '--diff-filter=ACMR'], {
      cwd: projectRoot,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    return output
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

export function getStagedDiffs(
  projectRoot: string,
  files: readonly string[],
): { file: string; patch: string }[] {
  const diffs: { file: string; patch: string }[] = [];
  for (const file of files) {
    try {
      const patch = execFileSync('git', ['diff', '--cached', '-U0', '--', file], {
        cwd: projectRoot,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'ignore'],
      });
      diffs.push({ file, patch });
    } catch {
      // Ignore files that cannot produce diff
    }
  }
  return diffs;
}

export interface GitBoundaryCliOptions {
  command?: 'pre-push' | 'pre-commit' | 'help';
  projectRoot?: string;
  skipFindings?: boolean;
}

export function parseGitBoundaryArgs(args: readonly string[]): GitBoundaryCliOptions {
  let command: 'pre-push' | 'pre-commit' | 'help' | undefined;
  let projectRoot: string | undefined;
  let skipFindings = false;

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--help' || arg === '-h' || arg === 'help') {
      command = 'help';
      continue;
    }
    if (arg === 'pre-push' || arg === 'pre-commit') {
      command = arg;
      continue;
    }
    if (arg === '--project-root') {
      projectRoot = args[++index];
      continue;
    }
    if (arg === '--skip-findings') {
      skipFindings = true;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return { command, projectRoot, skipFindings };
}

export async function runGitBoundaryCli(
  args: readonly string[],
  stdinOverride?: string,
): Promise<number> {
  let parsed: GitBoundaryCliOptions;
  try {
    parsed = parseGitBoundaryArgs(args);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error('Usage: comet-git-boundary <pre-push|pre-commit> [--project-root <path>]');
    return 1;
  }

  if (parsed.command === 'help') {
    console.log('Usage: comet-git-boundary <pre-push|pre-commit> [--project-root <path>]');
    return 0;
  }

  const projectRoot = resolve(parsed.projectRoot ?? '.');

  if (parsed.command === 'pre-push') {
    const rawStdin = stdinOverride !== undefined ? stdinOverride : await readStdin();
    if (!rawStdin.trim()) {
      return 0;
    }

    const pushRefs: GitPushRef[] = [];
    let hasForcePush = false;

    for (const line of rawStdin.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const parts = trimmed.split(/\s+/u);
      if (parts.length >= 4) {
        const [localRef, localOid, remoteRef, remoteOid] = parts;
        pushRefs.push({ localRef, localOid, remoteRef, remoteOid });
        if (isNonFastForward(projectRoot, localOid, remoteOid)) {
          hasForcePush = true;
        }
      }
    }

    if (pushRefs.length === 0) {
      return 0;
    }

    const evaluation = await evaluatePrePush(projectRoot, pushRefs, {
      isForcePush: hasForcePush,
      skipFindingsCheck: parsed.skipFindings,
    });

    if (!evaluation.allowed) {
      console.error('\n❌ Enterprise Guard pre-push blocked:');
      for (const v of evaluation.violations) {
        console.error(`- [${v.ruleId}] ${v.target}: ${v.detail}`);
      }
      console.error('\nPlease resolve the violations above before pushing.\n');
      return 1;
    }

    return 0;
  }

  if (parsed.command === 'pre-commit') {
    const stagedFiles = getStagedFiles(projectRoot);
    if (stagedFiles.length === 0) {
      return 0;
    }

    const stagedDiffs = getStagedDiffs(projectRoot, stagedFiles);
    const evaluation = await evaluatePreCommit(projectRoot, stagedFiles, stagedDiffs, {
      skipFindingsCheck: parsed.skipFindings,
    });

    if (!evaluation.allowed) {
      console.error('\n❌ Enterprise Guard pre-commit blocked:');
      for (const v of evaluation.violations) {
        console.error(`- [${v.ruleId}] ${v.target}: ${v.detail}`);
      }
      console.error('\nPlease resolve the violations above before committing.\n');
      return 1;
    }

    return 0;
  }

  console.error(
    'Missing command. Usage: comet-git-boundary <pre-push|pre-commit> [--project-root <path>]',
  );
  return 1;
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

if (isDirectEntry(process.argv[1])) {
  void runGitBoundaryCli(process.argv.slice(2)).then((code) => {
    process.exit(code);
  });
}
