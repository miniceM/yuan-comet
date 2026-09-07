#!/usr/bin/env node

import { build } from 'esbuild';
import { promises as fs } from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { readRepositoryLayout, resolveRepositoryPath } from '../lib/repository-layout.mjs';

const layout = readRepositoryLayout();
const repoRoot = resolveRepositoryPath('.');
const entries = layout.enterpriseGuardRuntime?.entries;
const outputs = layout.enterpriseGuardRuntime?.outputs;
const manifestPath = layout.enterpriseGuardRuntime?.manifest;

if (!entries || !outputs) {
  throw new Error('Enterprise Guard runtime requires entries and outputs in repository layout');
}

const entryNames = Object.keys(entries).sort();
const outputNames = Object.keys(outputs).sort();
if (
  entryNames.length !== outputNames.length ||
  entryNames.some((name, index) => name !== outputNames[index])
) {
  throw new Error('Enterprise Guard runtime entries and outputs must use the same keys');
}

const executableOutputs = new Set(['gateway', 'runner', 'gitBoundary']);

function computeSha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

async function bundledRuntime(entry) {
  const result = await build({
    absWorkingDir: repoRoot,
    entryPoints: [entry],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'esm',
    target: ['node20'],
    packages: 'bundle',
    preserveSymlinks: true,
    sourcemap: false,
    legalComments: 'none',
    charset: 'utf8',
    treeShaking: true,
    minify: true,
  });
  if (result.outputFiles.length !== 1) {
    throw new Error(
      `Expected one Enterprise Guard runtime output, got ${result.outputFiles.length}`,
    );
  }
  return Buffer.from(result.outputFiles[0].contents);
}

async function bundledRuntimeArtifacts() {
  const artifacts = new Map();
  for (const [name, entry] of Object.entries(entries)) {
    const output = outputs[name];
    let expected = await bundledRuntime(entry);
    if (executableOutputs.has(name)) {
      expected = Buffer.concat([
        Buffer.from(
          [
            '#!/usr/bin/env node',
            "import { createRequire as __cometCreateRequire } from 'module';",
            'const require = __cometCreateRequire(import.meta.url);',
            '',
          ].join('\n'),
          'utf8',
        ),
        expected,
      ]);
    }
    artifacts.set(name, { output, expected });
  }
  return artifacts;
}

const artifacts = await bundledRuntimeArtifacts();

async function buildManifest(artifactsMap) {
  const packageJson = JSON.parse(await fs.readFile(resolveRepositoryPath('package.json'), 'utf8'));
  const version = packageJson.version;
  const files = {};
  for (const [name, { output, expected }] of artifactsMap.entries()) {
    files[name] = {
      fileName: path.basename(output),
      sha256: computeSha256(expected),
      executable: executableOutputs.has(name),
    };
  }
  return {
    schemaVersion: 1,
    version,
    compatibleCliRange: `>=${version}`,
    rules: [
      'EG-HARD-INPUT-001',
      'EG-HARD-ENV-001',
      'EG-HARD-SECRET-001',
      'EG-HARD-RM-001',
      'EG-HARD-GIT-001',
      'EG-HARD-AUDIT-001',
      'EG-HARD-INTEGRITY-001',
    ],
    files,
  };
}

const expectedManifest = manifestPath ? await buildManifest(artifacts) : null;
const expectedManifestContent = expectedManifest
  ? JSON.stringify(expectedManifest, null, 2) + '\n'
  : null;

if (process.argv.includes('--check')) {
  for (const { output, expected } of artifacts.values()) {
    const outputFile = resolveRepositoryPath(output);
    let actual;
    try {
      actual = await fs.readFile(outputFile);
    } catch (error) {
      if (error.code === 'ENOENT') {
        console.error(`Enterprise Guard runtime script is missing: ${output}`);
        process.exitCode = 1;
        continue;
      } else {
        throw error;
      }
    }
    if (actual && !actual.equals(expected)) {
      console.error(
        `Enterprise Guard runtime script is stale: ${output}; run node scripts/build/build-enterprise-guard-runtime.mjs`,
      );
      process.exitCode = 1;
    }
  }

  const manifestPaths = manifestPath
    ? [manifestPath, manifestPath.replace('assets/skills/', 'assets/skills-zh/')]
    : [];

  for (const mPath of manifestPaths) {
    if (expectedManifestContent) {
      const manifestFile = resolveRepositoryPath(mPath);
      let actualManifest;
      try {
        actualManifest = await fs.readFile(manifestFile, 'utf8');
      } catch (error) {
        if (error.code === 'ENOENT') {
          console.error(`Enterprise Guard manifest is missing: ${mPath}`);
          process.exitCode = 1;
        } else {
          throw error;
        }
      }
      if (actualManifest && actualManifest !== expectedManifestContent) {
        console.error(
          `Enterprise Guard manifest is stale: ${mPath}; run node scripts/build/build-enterprise-guard-runtime.mjs`,
        );
        process.exitCode = 1;
      }
    }
  }
} else {
  for (const [name, { output, expected }] of artifacts.entries()) {
    const outputFile = resolveRepositoryPath(output);
    await fs.mkdir(path.dirname(outputFile), { recursive: true });
    await fs.writeFile(outputFile, expected);
    if (executableOutputs.has(name) && process.platform !== 'win32') {
      await fs.chmod(outputFile, 0o755);
    }
  }

  const manifestPaths = manifestPath
    ? [manifestPath, manifestPath.replace('assets/skills/', 'assets/skills-zh/')]
    : [];
  for (const mPath of manifestPaths) {
    if (expectedManifestContent) {
      const manifestFile = resolveRepositoryPath(mPath);
      await fs.mkdir(path.dirname(manifestFile), { recursive: true });
      await fs.writeFile(manifestFile, expectedManifestContent, 'utf8');
    }
  }
}
