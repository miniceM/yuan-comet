import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

export interface MockCliOptions {
  iamStatus?: 'logged_in' | 'logged_out' | 'error';
  dopStatus?: 'installed' | 'not_installed' | 'error';
  dopViewStatus?: 'success' | 'not_found' | 'error';
  dopDoneStatus?: 'success' | 'error';
}

export interface MockEnterpriseCliEnvironment {
  binDir: string;
  cleanup: () => Promise<void>;
}

export async function createMockEnterpriseCli(
  options: MockCliOptions = {},
): Promise<MockEnterpriseCliEnvironment> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mock-ent-cli-'));
  const isWindows = process.platform === 'win32';

  const mockRunnerPath = path.join(tmpDir, 'mock-runner.cjs');
  const runnerScript = `
const [,, tool, ...args] = process.argv;

const iamStatus = process.env.MOCK_IAM_STATUS || ${JSON.stringify(options.iamStatus || 'logged_in')};
const dopStatus = process.env.MOCK_DOP_STATUS || ${JSON.stringify(options.dopStatus || 'installed')};
const dopViewStatus = process.env.MOCK_DOP_VIEW_STATUS || ${JSON.stringify(options.dopViewStatus || 'success')};
const dopDoneStatus = process.env.MOCK_DOP_DONE_STATUS || ${JSON.stringify(options.dopDoneStatus || 'success')};

if (tool === 'iam') {
  if (iamStatus === 'error') {
    console.error('Error: IAM internal communication failure');
    process.exit(1);
  }
  const [cmd, subcmd, ...rest] = args;
  if (cmd === '--version' || cmd === '-v') {
    console.log('iam version 1.0.0');
    process.exit(0);
  }
  if (cmd === 'auth' && subcmd === 'status') {
    const isJson = rest.includes('--json');
    if (rest.includes('-j')) {
      console.error('Error: unknown shorthand flag: -j in iam auth status');
      process.exit(1);
    }
    if (iamStatus === 'logged_out') {
      if (isJson) {
        console.log(JSON.stringify({ credentials: [], total: 0 }));
      } else {
        console.log('Authentication status:\\n(no credentials)\\nTotal: 0 credential(s)');
      }
      process.exit(0);
    }
    if (isJson) {
      console.log(JSON.stringify({
        credentials: [
          { system: 'devops', username: '001701', status: 'logged', has_api_key: true },
          { system: 'gitee', username: '001701', status: 'logged', has_api_key: true }
        ],
        total: 2
      }));
    } else {
      console.log('Authentication status:\\n\\ndevops: 001701 (logged)\\ngitee: 001701 (logged)\\n\\nTotal: 2 credential(s)');
    }
    process.exit(0);
  }
  if (cmd === 'auth' && subcmd === 'login') {
    console.log('Authentication successful for devops and gitee.');
    process.exit(0);
  }
  console.log('IAM CLI mock ready');
  process.exit(0);
}

if (tool === 'dop') {
  if (dopStatus === 'error') {
    console.error('Error: DOP service unavailable');
    process.exit(1);
  }
  if (args.includes('-j')) {
    console.error('Error: unknown shorthand flag: -j in dop');
    process.exit(1);
  }
  const isJson = args.includes('--json');
  const filteredArgs = args.filter(a => a !== '--json');
  const [cmd, subcmd, changeId] = filteredArgs;

  if (cmd === '--version' || cmd === '-v') {
    console.log('dop version 1.0.0');
    process.exit(0);
  }
  if (cmd === 'change' && subcmd === 'list') {
    if (isJson) {
      console.log(JSON.stringify({
        changes: [
          { id: 'ARD123456', title: '用户测试demo', status: 'open' },
          { id: 'ARD222222', title: '信用卡积分兑换功能', status: 'open' }
        ],
        total: 2
      }));
    } else {
      console.log('Changes:\\n  ARD123456 - 用户测试demo [open]\\n  ARD222222 - 信用卡积分兑换功能 [open]');
    }
    process.exit(0);
  }
  if (cmd === 'change' && subcmd === 'view') {
    if (!changeId) {
      console.error('Error: change-id is required');
      process.exit(1);
    }
    if (dopViewStatus === 'not_found') {
      console.error('Change ' + changeId + ' not found');
      process.exit(1);
    }
    if (dopViewStatus === 'error') {
      console.error('Network timeout while querying DOP');
      process.exit(1);
    }
    const detail = {
      id: changeId,
      summary: changeId === 'ARD222222' ? '信用卡积分兑换功能' : '用户测试demo',
      description: '这是从外部 DOP 系统拉取的业务背景描述。',
      storyAC: [
        '用户在界面上能够看到清晰的凭据状态',
        '流程完成时自动调用 dop change done 闭环'
      ],
      subSystems: [
        { code: 'ARD.ard-sdk', name: '智能研发平台.AI原生框架套件' }
      ],
      userStory: {
        id: 'story-1',
        code: 'US-95376',
        title: '企业身份与状态集成故事',
        release_info: {
          release_num: 'R20260908001',
          release_name: '202609需求排期',
          release_date: '2026-09-30T00:00:00Z',
          release_stage: '投产实施'
        }
      }
    };
    if (isJson) {
      console.log(JSON.stringify(detail));
    } else {
      console.log('Change ' + changeId + ': ' + detail.summary + '\\n' + detail.description);
    }
    process.exit(0);
  }
  if (cmd === 'change' && subcmd === 'done') {
    if (!changeId) {
      console.error('Error: change-id is required for dop change done');
      process.exit(1);
    }
    if (dopDoneStatus === 'error') {
      console.error('Failed to mark change ' + changeId + ' as done: service error');
      process.exit(1);
    }
    console.log(JSON.stringify({ id: changeId, status: 'done' }));
    process.exit(0);
  }
  console.log('dop mock CLI ready');
  process.exit(0);
}

console.error('Unknown tool: ' + tool);
process.exit(1);
`;

  await fs.writeFile(mockRunnerPath, runnerScript.trim(), 'utf8');

  if (isWindows) {
    await fs.writeFile(
      path.join(tmpDir, 'iam.cmd'),
      `@echo off\r\nnode "%~dp0mock-runner.cjs" iam %*\r\n`,
      'utf8',
    );
  } else {
    const iamPath = path.join(tmpDir, 'iam');
    await fs.writeFile(iamPath, `#!/bin/sh\nexec node "${mockRunnerPath}" iam "$@"\n`, 'utf8');
    await fs.chmod(iamPath, 0o755);
  }

  if (options.dopStatus !== 'not_installed') {
    if (isWindows) {
      await fs.writeFile(
        path.join(tmpDir, 'dop.cmd'),
        `@echo off\r\nnode "%~dp0mock-runner.cjs" dop %*\r\n`,
        'utf8',
      );
    } else {
      const dopPath = path.join(tmpDir, 'dop');
      await fs.writeFile(dopPath, `#!/bin/sh\nexec node "${mockRunnerPath}" dop "$@"\n`, 'utf8');
      await fs.chmod(dopPath, 0o755);
    }
  }

  return {
    binDir: tmpDir,
    cleanup: async () => {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    },
  };
}

export async function withMockEnterpriseCli<T>(
  options: MockCliOptions,
  fn: (env: MockEnterpriseCliEnvironment) => Promise<T>,
): Promise<T> {
  const env = await createMockEnterpriseCli(options);
  const originalPath = process.env.PATH;
  process.env.PATH = `${env.binDir}${path.delimiter}${originalPath ?? ''}`;
  try {
    return await fn(env);
  } finally {
    process.env.PATH = originalPath;
    await env.cleanup();
  }
}
