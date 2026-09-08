import { promises as fs } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { withMockEnterpriseCli } from '../../helpers/mock-enterprise-cli.js';

const execFileAsync = promisify(execFile);
const zhSkillRoot = path.resolve('assets', 'skills-zh');
const enSkillRoot = path.resolve('assets', 'skills');

async function readSkill(root: string, name: string): Promise<string> {
  return fs.readFile(path.join(root, name, 'SKILL.md'), 'utf8');
}

describe('Classic SDD IAM & DOP Contract (Bilingual Skills)', () => {
  describe.each([
    ['中文', zhSkillRoot, '立即停止流程', '纯自然语言交互模式'],
    ['English', enSkillRoot, 'stop the flow immediately', 'pure natural language interaction mode'],
  ])('%s comet-open static skill contract', (_lang, root, stopMarker, fallbackMarker) => {
    it('defines IAM authentication check with iam auth login prompt and hard-stop', async () => {
      const content = await readSkill(root, 'comet-open');
      expect(content).toContain('iam auth status --json');
      expect(content).toContain('iam auth login');
      expect(content).not.toContain('oms-login');
      expect(content).toContain(stopMarker);
      expect(content).toContain('credentials');
      expect(content).toContain('logged');
    });

    it('defines DOP availability and pending task checks', async () => {
      const content = await readSkill(root, 'comet-open');
      expect(content).toContain('dop change list');
      expect(content).toContain('dop_completion.status: pending');
      expect(content).toContain(fallbackMarker);
    });

    it('defines DOP requirement fetch with --json and regex pattern, strictly excluding -j shorthand', async () => {
      const content = await readSkill(root, 'comet-open');
      expect(content).toContain('dop change view <change-id> --json');
      expect(content).not.toContain('dop change view <change-id> -j');
      expect(content).not.toContain('dop change view <slug> -j');
      expect(content).toMatch(/\^\[A-Z\]\{2,6\}\\d\+\$/);
      expect(content).toContain('summary');
      expect(content).toContain('description');
      expect(content).toContain('storyAC');
      expect(content).toContain('subSystems');
      expect(content).toContain('userStory');
      expect(content).toContain('dop_status: "spec-in-progress"');
    });
  });

  describe.each([
    ['中文', zhSkillRoot, '立即停止流程', '绝不撤销已创建的 PR'],
    ['English', enSkillRoot, 'stop the flow immediately', 'Never revoke the created PR'],
  ])('%s comet-archive static skill contract', (_lang, root, stopMarker, nonRollbackMarker) => {
    it('defines IAM authentication check prior to confirmation', async () => {
      const content = await readSkill(root, 'comet-archive');
      expect(content).toContain('iam auth status --json');
      expect(content).toContain('iam auth login');
      expect(content).not.toContain('oms-login');
      expect(content).toContain(stopMarker);
    });

    it('defines DOP completion flow in step 5 with atomic PR non-rollback guarantee', async () => {
      const content = await readSkill(root, 'comet-archive');
      expect(content).toContain('dop change done <change-id>');
      expect(content).toContain(nonRollbackMarker);
      expect(content).toContain("dop_completion: { status: 'pending'");
      expect(content).toContain('dop_completion.status: pending');
    });
  });

  describe.each([
    ['中文', zhSkillRoot],
    ['English', enSkillRoot],
  ])('%s comet-classic static skill contract', (_lang, root) => {
    it('defines slots.change_id extraction and enterprise lifecycle notes', async () => {
      const content = await readSkill(root, 'comet-classic');
      expect(content).toMatch(/slots\.change_id/);
      expect(content).toMatch(/\^\[A-Z\]\{2,6\}\\d\+\$/);
      expect(content).toContain('iam auth status --json');
      expect(content).toContain('dop change view <change-id> --json');
      expect(content).toContain('dop change done <change-id>');
    });
  });

  describe('Mock Enterprise CLI Execution (Offline/CI verification)', () => {
    it('simulates authenticated iam session with production JSON format', async () => {
      await withMockEnterpriseCli({ iamStatus: 'logged_in' }, async () => {
        const { stdout } = await execFileAsync('iam', ['auth', 'status', '--json']);
        const parsed = JSON.parse(stdout);
        expect(parsed.total).toBe(2);
        expect(parsed.credentials).toHaveLength(2);
        expect(parsed.credentials[0]).toMatchObject({
          system: 'devops',
          status: 'logged',
          has_api_key: true,
        });
      });
    });

    it('simulates logged out iam session with total: 0', async () => {
      await withMockEnterpriseCli({ iamStatus: 'logged_out' }, async () => {
        const { stdout } = await execFileAsync('iam', ['auth', 'status', '--json']);
        const parsed = JSON.parse(stdout);
        expect(parsed.total).toBe(0);
        expect(parsed.credentials).toEqual([]);
      });
    });

    it('simulates iam failure with non-zero exit code', async () => {
      await withMockEnterpriseCli({ iamStatus: 'error' }, async () => {
        await expect(execFileAsync('iam', ['auth', 'status', '--json'])).rejects.toThrow();
      });
    });

    it('simulates dop change list, view with --json, and done commands', async () => {
      await withMockEnterpriseCli({}, async () => {
        // dop change list
        const { stdout: listOut } = await execFileAsync('dop', ['change', 'list', '--json']);
        const listJson = JSON.parse(listOut);
        expect(listJson.changes.length).toBeGreaterThan(0);

        // dop change view <id> --json
        const { stdout: viewOut } = await execFileAsync('dop', [
          'change',
          'view',
          'ARD123456',
          '--json',
        ]);
        const viewJson = JSON.parse(viewOut);
        expect(viewJson.id).toBe('ARD123456');
        expect(viewJson.summary).toBeDefined();
        expect(viewJson.description).toBeDefined();
        expect(viewJson.storyAC).toBeInstanceOf(Array);
        expect(viewJson.subSystems).toBeInstanceOf(Array);
        expect(viewJson.userStory.release_info).toBeDefined();

        // dop change done <id>
        const { stdout: doneOut } = await execFileAsync('dop', ['change', 'done', 'ARD123456']);
        const doneJson = JSON.parse(doneOut);
        expect(doneJson).toEqual({ id: 'ARD123456', status: 'done' });
      });
    });

    it('rejects forbidden -j flag on dop change view according to production CLI design', async () => {
      await withMockEnterpriseCli({}, async () => {
        await expect(execFileAsync('dop', ['change', 'view', 'ARD123456', '-j'])).rejects.toThrow();
      });
    });

    it('handles dop change view not found failure', async () => {
      await withMockEnterpriseCli({ dopViewStatus: 'not_found' }, async () => {
        await expect(
          execFileAsync('dop', ['change', 'view', 'ARD999999', '--json']),
        ).rejects.toThrow();
      });
    });

    it('handles dop change done failure without crashing test runner', async () => {
      await withMockEnterpriseCli({ dopDoneStatus: 'error' }, async () => {
        await expect(execFileAsync('dop', ['change', 'done', 'ARD123456'])).rejects.toThrow();
      });
    });
  });
});
