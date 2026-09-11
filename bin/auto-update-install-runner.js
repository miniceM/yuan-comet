#!/usr/bin/env node

import { spawn } from 'node:child_process';

// 等待 stdin 授权信号
const timer = setTimeout(() => {
  process.exit(1);
}, 10_000);
timer.unref?.();

process.stdin.setEncoding('utf8');
process.stdin.once('data', (chunk) => {
  clearTimeout(timer);
  if (!String(chunk).includes('START')) {
    process.exit(1);
  }

  const version = process.argv[2];
  if (!version) {
    process.exit(1);
  }

  const installArgs = ['install', '-g', `@cli-tools/yuan-comet@${version}`];
  const customRegistry = process.env.COMET_ENTERPRISE_NPM_REGISTRY?.trim();
  if (customRegistry) {
    installArgs.push('--registry', customRegistry);
  }

  const child = spawn(
    'npm',
    installArgs,
    {
      stdio: 'inherit',
      shell: process.platform === 'win32',
    },
  );

  child.on('error', () => process.exit(1));
  child.on('close', (code) => {
    process.exit(code ?? 1);
  });
});
