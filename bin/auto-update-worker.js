#!/usr/bin/env node

import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 5 分钟超时看门狗
const WATCHDOG_TIMEOUT_MS = 5 * 60 * 1000;
const watchdog = setTimeout(() => {
  try {
    if (process.platform === 'win32') {
      import('node:child_process').then(({ spawn }) => {
        spawn('taskkill', ['/pid', String(process.pid), '/T', '/F']);
      });
    } else {
      process.kill(-process.pid, 'SIGTERM');
      setTimeout(() => {
        try {
          process.kill(-process.pid, 'SIGKILL');
        } catch {
          // ignore
        }
      }, 5000).unref?.();
    }
  } catch {
    process.exit(124);
  }
}, WATCHDOG_TIMEOUT_MS);
watchdog.unref?.();

async function main() {
  try {
    const { runAutoUpdateWorker } = await import('../dist/domains/auto-update/index.js');
    const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    await runAutoUpdateWorker({ packageRoot: pkgRoot });
  } catch {
    process.exit(1);
  } finally {
    clearTimeout(watchdog);
  }
}

await main();
