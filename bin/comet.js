#!/usr/bin/env node

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tryRunFastRuntime } from './fast-runtime-router.js';

// 1. 深拷贝原始参数，防止 fast-runtime-router 原地修改 process.argv 导致后续判断失真
const rawArgv = [...process.argv];

try {
  if (!(await tryRunFastRuntime())) {
    await import('../dist/app/cli/index.js');
  }
} finally {
  // 2. 统一出口调度接线 (Exit Tap)
  tryScheduleAutoUpdate(rawArgv);
}

function tryScheduleAutoUpdate(argv) {
  try {
    // 业务执行失败、帮助、版本查询或显式禁用时，绝不触发
    if (process.exitCode !== undefined && process.exitCode !== 0) return;
    if (process.env.COMET_NO_AUTO_UPDATE === '1' || process.env.CI === 'true') return;

    const args = argv.slice(2);
    const isWorkflowResolve = args[0] === 'workflow' && args[1] === 'resolve';
    if (!isWorkflowResolve) return;

    if (args.includes('--help') || args.includes('-h') || args.includes('--version') || args.includes('-v')) {
      return;
    }

    const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const workerScript = path.join(pkgRoot, 'bin', 'auto-update-worker.js');

    const child = spawn(process.execPath, [workerScript], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, COMET_BACKGROUND_WORKER: '1' },
    });

    child.on('error', () => {
      // 忽略启动异常，严禁篡改业务退出码
    });
    child.unref?.();
  } catch {
    // 隔离所有调度异常
  }
}
