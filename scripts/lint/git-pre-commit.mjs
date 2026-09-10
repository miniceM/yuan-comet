#!/usr/bin/env node

import { runGitBoundaryCli } from '../../assets/skills/comet/scripts/comet-git-boundary.mjs';

const exitCode = await runGitBoundaryCli(['pre-commit', ...process.argv.slice(2)]);
process.exit(exitCode);
