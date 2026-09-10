import { describe, expect, it } from 'vitest';
import {
  CANONICAL_TO_PROJECTED_SKILL_NAMES,
  PROJECTED_TO_CANONICAL_SKILL_NAMES,
  projectSkillContent,
  projectSkillPath,
  toCanonicalSkillName,
  toProjectedSkillName,
} from '../../../domains/skill/skill-mapping.js';

describe('skill-mapping', () => {
  it('maps all 12 core skills and memory correctly', () => {
    expect(toProjectedSkillName('comet')).toBe('sdd');
    expect(toProjectedSkillName('comet-native')).toBe('sdd-native');
    expect(toProjectedSkillName('comet-classic')).toBe('sdd-classic');
    expect(toProjectedSkillName('comet-review')).toBe('sdd-review');
    expect(toProjectedSkillName('comet-open')).toBe('sdd-open');
    expect(toProjectedSkillName('comet-design')).toBe('sdd-design');
    expect(toProjectedSkillName('comet-build')).toBe('sdd-build');
    expect(toProjectedSkillName('comet-verify')).toBe('sdd-verify');
    expect(toProjectedSkillName('comet-archive')).toBe('sdd-archive');
    expect(toProjectedSkillName('comet-hotfix')).toBe('sdd-hotfix');
    expect(toProjectedSkillName('comet-tweak')).toBe('sdd-tweak');
    expect(toProjectedSkillName('comet-any')).toBe('sdd-any');
    expect(toProjectedSkillName('comet-memory')).toBe('sdd-memory');
  });

  it('preserves unknown skill names', () => {
    expect(toProjectedSkillName('custom-skill')).toBe('custom-skill');
    expect(toCanonicalSkillName('custom-skill')).toBe('custom-skill');
  });

  it('performs reverse canonical lookup correctly', () => {
    expect(toCanonicalSkillName('sdd')).toBe('comet');
    expect(toCanonicalSkillName('sdd-open')).toBe('comet-open');
    expect(toCanonicalSkillName('sdd-native')).toBe('comet-native');
    expect(toCanonicalSkillName('sdd-classic')).toBe('comet-classic');
  });

  it('projects relative skill paths', () => {
    expect(projectSkillPath('comet-open/SKILL.md')).toBe('sdd-open/SKILL.md');
    expect(projectSkillPath('comet/SKILL.md')).toBe('sdd/SKILL.md');
    expect(projectSkillPath('comet-native/reference/workspace.md')).toBe(
      'sdd-native/reference/workspace.md',
    );
    expect(projectSkillPath('other-skill/file.txt')).toBe('other-skill/file.txt');
  });

  it('projects frontmatter name and slash commands in skill content', () => {
    const input = [
      '---',
      'name: comet-open',
      'description: Phase 1 of Comet Classic',
      '---',
      '',
      '# Comet Phase 1: Open',
      '',
      'Run /comet-open to start. After open completes, proceed to /comet-design.',
      'Or invoke /comet for shared entry.',
      'Use the Skill tool to load the comet-native skill.',
    ].join('\n');

    const output = projectSkillContent(input);

    expect(output).toContain('name: sdd-open');
    expect(output).toContain('Run /sdd-open to start.');
    expect(output).toContain('proceed to /sdd-design.');
    expect(output).toContain('invoke /sdd for shared entry.');
    expect(output).toContain('load the sdd-native skill.');
    expect(output).not.toContain('/comet-open');
    expect(output).not.toContain('/comet-design');
    expect(output).not.toContain('/comet ');
  });

  it('handles custom targetSkillName override in frontmatter', () => {
    const input = '---\nname: comet\n---\nHello /comet';
    const output = projectSkillContent(input, 'sdd');
    expect(output).toBe('---\nname: sdd\n---\nHello /sdd');
  });
});
