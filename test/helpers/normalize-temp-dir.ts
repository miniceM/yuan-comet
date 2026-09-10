import { realpathSync } from 'node:fs';

for (const variable of ['TMPDIR', 'TMP', 'TEMP']) {
  const value = process.env[variable];
  if (!value) continue;
  try {
    process.env[variable] = realpathSync(value);
  } catch {
    // A missing caller-provided temporary directory should retain Node's default behavior.
  }
}
