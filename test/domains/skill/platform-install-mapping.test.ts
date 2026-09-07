import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  copyCometSkillsForPlatform,
  detectInstalledWorkflowSelection,
} from '../../../domains/skill/platform-install.js';
import { removeCometSkillsForPlatform } from '../../../domains/skill/uninstall.js';
import type { Platform } from '../../../platform/install/platforms.js';
import { fileExists } from '../../../platform/fs/file-system.js';

describe('platform-install SDD projection', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = path.join(
      os.tmpdir(),
      `sdd-install-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    await fs.mkdir(tmpDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  const claudePlatform: Platform = {
    id: 'claude',
    name: 'Claude Code',
    skillsDir: '.claude',
    openspecToolId: 'claude',
  };

  const opencodePlatform: Platform = {
    id: 'opencode',
    name: 'OpenCode',
    skillsDir: '.opencode',
    openspecToolId: 'opencode',
  };

  it('installs projected sdd-* skills with converted frontmatter and commands', async () => {
    const result = await copyCometSkillsForPlatform(tmpDir, claudePlatform, false, 'skills');
    expect(result.copied).toBeGreaterThan(0);

    // Verify projected enterprise SDD skills exist
    const sddOpenSkillPath = path.join(tmpDir, '.claude', 'skills', 'sdd-open', 'SKILL.md');
    expect(await fileExists(sddOpenSkillPath)).toBe(true);

    const sddOpenContent = await fs.readFile(sddOpenSkillPath, 'utf-8');
    expect(sddOpenContent).toContain('name: sdd-open');
    expect(sddOpenContent).toContain('/sdd-open');
    expect(sddOpenContent).toContain('/sdd-design');
    expect(sddOpenContent).not.toContain('name: comet-open');

    // Verify canonical path also exists for backward compatibility
    const cometOpenSkillPath = path.join(tmpDir, '.claude', 'skills', 'comet-open', 'SKILL.md');
    expect(await fileExists(cometOpenSkillPath)).toBe(true);
  });

  it('generates projected /sdd-* OpenCode slash commands', async () => {
    await copyCometSkillsForPlatform(tmpDir, opencodePlatform, false, 'skills');

    const sddOpenCommandPath = path.join(tmpDir, '.opencode', 'commands', 'sdd-open.md');
    expect(await fileExists(sddOpenCommandPath)).toBe(true);

    const commandContent = await fs.readFile(sddOpenCommandPath, 'utf-8');
    expect(commandContent).toContain('Command name: `/sdd-open`');
    expect(commandContent).toContain('Equivalent Comet skill: `sdd-open`');
    expect(commandContent).toContain('/sdd-design');
  });

  it('detects workflow selection from projected sdd markers', async () => {
    const skillsRoot = path.join(tmpDir, 'skills');
    await fs.mkdir(path.join(skillsRoot, 'sdd-native'), { recursive: true });
    await fs.writeFile(path.join(skillsRoot, 'sdd-native', 'SKILL.md'), '# SDD Native');

    const selection = await detectInstalledWorkflowSelection(skillsRoot);
    expect(selection).toBe('native');
  });

  it('uninstalls projected sdd-* skills and commands cleanly', async () => {
    await copyCometSkillsForPlatform(tmpDir, opencodePlatform, false, 'skills');

    const sddOpenPath = path.join(tmpDir, '.opencode', 'skills', 'sdd-open', 'SKILL.md');
    const sddOpenCommand = path.join(tmpDir, '.opencode', 'commands', 'sdd-open.md');
    expect(await fileExists(sddOpenPath)).toBe(true);
    expect(await fileExists(sddOpenCommand)).toBe(true);

    await removeCometSkillsForPlatform(tmpDir, opencodePlatform, 'project');

    expect(await fileExists(sddOpenPath)).toBe(false);
    expect(await fileExists(sddOpenCommand)).toBe(false);
  });
});
