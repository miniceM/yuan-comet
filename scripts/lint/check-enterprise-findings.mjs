#!/usr/bin/env node

import { resolve } from 'node:path';

async function loadFindingsReader() {
  try {
    return await import('../../domains/enterprise-guard/findings.ts');
  } catch {
    const { build } = await import('esbuild');
    const result = await build({
      entryPoints: [resolve('domains/enterprise-guard/findings.ts')],
      bundle: true,
      write: false,
      platform: 'node',
      format: 'esm',
    });
    const code = result.outputFiles[0].text;
    const dataUri = `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`;
    return await import(dataUri);
  }
}

const argv = process.argv.slice(2);
const rootIndex = argv.indexOf('--root');
const projectRoot = resolve(rootIndex >= 0 ? (argv[rootIndex + 1] ?? '.') : '.');

const { readEnterpriseFindings } = await loadFindingsReader();
const report = await readEnterpriseFindings(projectRoot);

if (report.status === 'blocked') {
  console.error('Enterprise Guard review blocked:');
  if (report.integrityErrors.length > 0) {
    for (const error of report.integrityErrors) {
      console.error(`- Integrity Error: ${error}`);
    }
  }
  const hardDenials = report.findings.filter(
    (f) => f.enforcement === 'hard' && f.decision === 'deny',
  );
  for (const finding of hardDenials) {
    console.error(
      `- HARD Denial: [${finding.ruleId}] on ${finding.path ?? finding.tool ?? 'project'} (fingerprint: ${finding.fingerprint})`,
    );
  }
  process.exitCode = 1;
} else if (report.status === 'warn') {
  console.warn(
    `Enterprise Guard review warning: ${report.findings.length} soft finding(s) pending audit.`,
  );
  process.exitCode = 0;
} else {
  console.log('Enterprise Guard review passed: findings clean.');
  process.exitCode = 0;
}
