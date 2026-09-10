import { realpathSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { executeEnterpriseGateway } from './enterprise-gateway.js';
import { MAX_ENTERPRISE_HOOK_INPUT_BYTES } from './normalized-event.js';

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
  void readStdin().then(async (source) => {
    const output = await executeEnterpriseGateway(process.argv.slice(2), source);
    if (output.stdout) process.stdout.write(output.stdout);
    if (output.stderr) process.stderr.write(output.stderr);
    process.exitCode = output.exitCode;
  });
}
