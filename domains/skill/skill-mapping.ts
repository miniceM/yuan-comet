/**
 * Enterprise Skill Name Mapping and Projection
 *
 * Defines the canonical mapping between upstream Comet skill identifiers
 * and enterprise SDD skill identifiers, enabling the project to present
 * a distinct `/sdd-*` user-facing product surface while preserving upstream
 * codebase layout and minimizing upstream merge conflicts.
 */

export const CANONICAL_TO_PROJECTED_SKILL_NAMES: Readonly<Record<string, string>> = Object.freeze({
  comet: 'sdd',
  'comet-native': 'sdd-native',
  'comet-classic': 'sdd-classic',
  'comet-review': 'sdd-review',
  'comet-open': 'sdd-open',
  'comet-design': 'sdd-design',
  'comet-build': 'sdd-build',
  'comet-verify': 'sdd-verify',
  'comet-archive': 'sdd-archive',
  'comet-hotfix': 'sdd-hotfix',
  'comet-tweak': 'sdd-tweak',
  'comet-any': 'sdd-any',
  'comet-memory': 'sdd-memory',
});

export const PROJECTED_TO_CANONICAL_SKILL_NAMES: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(
    Object.entries(CANONICAL_TO_PROJECTED_SKILL_NAMES).map(([canonical, projected]) => [
      projected,
      canonical,
    ]),
  ),
);

/**
 * Convert a canonical skill name (e.g. 'comet-open' or 'comet')
 * to its projected enterprise name (e.g. 'sdd-open' or 'sdd').
 */
export function toProjectedSkillName(name: string): string {
  return CANONICAL_TO_PROJECTED_SKILL_NAMES[name] ?? name;
}

/**
 * Convert a projected enterprise skill name (e.g. 'sdd-open' or 'sdd')
 * back to its canonical upstream name (e.g. 'comet-open' or 'comet').
 */
export function toCanonicalSkillName(name: string): string {
  return PROJECTED_TO_CANONICAL_SKILL_NAMES[name] ?? name;
}

/**
 * Map a relative skill path (e.g. 'comet-open/SKILL.md' or 'comet/SKILL.md')
 * to its projected path (e.g. 'sdd-open/SKILL.md' or 'sdd/SKILL.md').
 */
export function projectSkillPath(skillRelPath: string): string {
  const parts = skillRelPath.split('/');
  if (parts.length === 0) return skillRelPath;

  const topLevel = parts[0];
  const projectedTop = CANONICAL_TO_PROJECTED_SKILL_NAMES[topLevel];
  if (!projectedTop) {
    return skillRelPath;
  }

  return [projectedTop, ...parts.slice(1)].join('/');
}

// Regex matching frontmatter `name: <value>` line
const FRONTMATTER_NAME_REGEX = /^(\s*name:\s*)([a-zA-Z0-9_-]+)(\s*)$/m;

// Ordered keys sorted by length descending so longer patterns (e.g. /comet-open)
// match before shorter ones (e.g. /comet)
const ORDERED_COMMAND_REPLACEMENTS: Array<{ regex: RegExp; replacement: string }> = Object.entries(
  CANONICAL_TO_PROJECTED_SKILL_NAMES,
)
  .sort((a, b) => b[0].length - a[0].length)
  .map(([canonical, projected]) => ({
    // Match /comet-* command references with word/boundary check
    regex: new RegExp(`\\/${canonical}(?=[^a-zA-Z0-9_-]|$)`, 'g'),
    replacement: `/${projected}`,
  }));

const ORDERED_SKILL_NAME_REPLACEMENTS: Array<{ regex: RegExp; replacement: string }> =
  Object.entries(CANONICAL_TO_PROJECTED_SKILL_NAMES)
    .sort((a, b) => b[0].length - a[0].length)
    .map(([canonical, projected]) => ({
      // Match `load the comet-native skill` or `comet-native` skill references
      regex: new RegExp(`\\b${canonical}(?=\\s+skill|\\s+Skill|\\s+技能)`, 'g'),
      replacement: projected,
    }));

/**
 * Transform skill file content (SKILL.md, prompts, openCode commands)
 * to reflect projected skill names and slash commands.
 */
export function projectSkillContent(content: string, targetSkillName?: string): string {
  let result = content;

  // 1. Replace frontmatter `name: <value>` if present
  if (FRONTMATTER_NAME_REGEX.test(result)) {
    result = result.replace(FRONTMATTER_NAME_REGEX, (match, prefix, currentName, suffix) => {
      const newName = targetSkillName ?? toProjectedSkillName(currentName);
      return `${prefix}${newName}${suffix}`;
    });
  }

  // 2. Replace slash command references: /comet-open -> /sdd-open, /comet -> /sdd
  for (const { regex, replacement } of ORDERED_COMMAND_REPLACEMENTS) {
    result = result.replace(regex, replacement);
  }

  // 3. Replace text references like `load the comet-native skill` -> `load the sdd-native skill`
  for (const { regex, replacement } of ORDERED_SKILL_NAME_REPLACEMENTS) {
    result = result.replace(regex, replacement);
  }

  return result;
}
