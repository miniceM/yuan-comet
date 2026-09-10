import { describe, expect, it } from 'vitest';
import { existsSync, promises as fs } from 'fs';
import path from 'path';
import { parse as parseYaml } from 'yaml';
import { readManifest } from '../../domains/skill/platform-install.js';

type OpenAiYaml = {
  interface?: {
    display_name?: string;
    short_description?: string;
    default_prompt?: string;
  };
  policy?: {
    allow_implicit_invocation?: boolean;
  };
};

type SkillFrontmatter = {
  name?: string;
  description?: string;
  'disable-model-invocation'?: boolean;
};

const maintainerRoot = 'assets/skills-maintainer';

async function parseFrontmatter(filePath: string): Promise<SkillFrontmatter> {
  const content = await fs.readFile(filePath, 'utf8');
  const match = content.match(/^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u);
  if (!match) return {};
  return (parseYaml(match[1]) as SkillFrontmatter) ?? {};
}

describe('Maintainer skills registry and isolation contract', () => {
  it('ensures all maintainer skills have valid SKILL.md and agents/openai.yaml', async () => {
    const entries = await fs.readdir(maintainerRoot, { withFileTypes: true });
    const skillDirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);

    expect(skillDirs).toContain('comet-upstream-sync');

    for (const dirName of skillDirs) {
      const skillMdPath = path.resolve(maintainerRoot, dirName, 'SKILL.md');
      const openaiYamlPath = path.resolve(maintainerRoot, dirName, 'agents', 'openai.yaml');

      expect(existsSync(skillMdPath), `${dirName}/SKILL.md must exist`).toBe(true);
      expect(existsSync(openaiYamlPath), `${dirName}/agents/openai.yaml must exist`).toBe(true);

      const frontmatter = await parseFrontmatter(skillMdPath);
      expect(frontmatter.name, `${dirName} frontmatter name`).toBe(dirName);
      expect(
        typeof frontmatter.description === 'string' && frontmatter.description.length > 0,
        `${dirName} frontmatter description must be non-empty string`,
      ).toBe(true);
      expect(
        frontmatter['disable-model-invocation'],
        `${dirName} must set disable-model-invocation to true`,
      ).toBe(true);

      const yamlContent = await fs.readFile(openaiYamlPath, 'utf8');
      const doc = parseYaml(yamlContent) as OpenAiYaml;

      expect(
        typeof doc.interface?.display_name === 'string' && doc.interface.display_name.length > 0,
        `${dirName} openai.yaml display_name`,
      ).toBe(true);
      expect(
        typeof doc.interface?.short_description === 'string' &&
          doc.interface.short_description.length > 0,
        `${dirName} openai.yaml short_description`,
      ).toBe(true);
      expect(
        doc.policy?.allow_implicit_invocation,
        `${dirName} openai.yaml policy.allow_implicit_invocation must be false`,
      ).toBe(false);
    }
  });

  it('verifies comet-upstream-sync specifies the dual-track topology and conflict rules', async () => {
    const skillMd = await fs.readFile(
      path.resolve(maintainerRoot, 'comet-upstream-sync', 'SKILL.md'),
      'utf8',
    );

    expect(skillMd).toContain('upstream/master');
    expect(skillMd).toContain('enterprise/main');
    expect(skillMd).toContain('git merge --ff-only');
    expect(skillMd).toContain('sync/upstream-');
    expect(skillMd).toContain('maintainer-contract.md');
    expect(skillMd).toContain('pnpm build:classic-runtime');
    expect(skillMd).toContain('pnpm build:native-runtime');
    expect(skillMd).toContain('pnpm build:entry-runtime');
  });

  it('keeps maintainer skills isolated from public manifest and npm packaging', async () => {
    const manifest = await readManifest();

    for (const skill of manifest.skills) {
      expect(skill).not.toContain('skills-maintainer');
      expect(skill).not.toContain('comet-upstream-sync');
    }

    const packageJsonRaw = await fs.readFile('package.json', 'utf8');
    const packageJson = JSON.parse(packageJsonRaw) as { files?: string[] };
    expect(packageJson.files).toContain('!assets/skills-maintainer');
    expect(packageJson.files).toContain('!assets/skills-maintainer/**');

    const npmIgnore = await fs.readFile('.npmignore', 'utf8');
    expect(npmIgnore).toContain('assets/skills-maintainer');
  });
});
