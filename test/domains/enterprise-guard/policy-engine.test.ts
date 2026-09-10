import { describe, expect, it } from 'vitest';

import { parseClaudeEnterpriseHookInput } from '../../../domains/enterprise-guard/input-codecs/claude.js';
import { evaluateEnterpriseHookInput } from '../../../domains/enterprise-guard/policy-engine.js';

describe('enterprise guard policy engine', () => {
  it('maps Claude Write, Edit, and Bash input to the EnterpriseHookInput v1 contract', () => {
    expect(
      parseClaudeEnterpriseHookInput(
        JSON.stringify({
          hook_event_name: 'PreToolUse',
          cwd: '/workspace/project',
          tool_name: 'Write',
          tool_input: { file_path: 'src/config.ts', content: 'export const port = 3000;' },
        }),
      ),
    ).toMatchObject({
      schemaVersion: 'comet.enterprise-hook-input.v1',
      platform: { id: 'claude', surface: 'project' },
      event: { name: 'PreToolUse', preAction: true, blockingCapable: true },
      workingDirectory: { value: '/workspace/project', truncated: false },
      tool: { name: { value: 'Write' } },
      command: { value: null },
      writes: [
        {
          operation: 'create',
          path: { value: 'src/config.ts', truncated: false },
          fragment: { value: 'export const port = 3000;', truncated: false },
        },
      ],
      parse: { status: 'complete', errors: [] },
    });

    expect(
      parseClaudeEnterpriseHookInput(
        JSON.stringify({
          hook_event_name: 'PreToolUse',
          cwd: '/workspace/project',
          tool_name: 'Edit',
          tool_input: { file_path: 'src/config.ts', new_string: 'export const port = 4000;' },
        }),
      ).writes,
    ).toEqual([
      expect.objectContaining({
        operation: 'edit',
        fragment: expect.objectContaining({ value: 'export const port = 4000;' }),
      }),
    ]);

    expect(
      parseClaudeEnterpriseHookInput(
        JSON.stringify({
          hook_event_name: 'PreToolUse',
          cwd: '/workspace/project',
          tool_name: 'Bash',
          tool_input: { command: 'git status --short' },
        }),
      ),
    ).toMatchObject({
      tool: { name: { value: 'Bash' } },
      command: { value: 'git status --short', truncated: false },
      writes: [],
    });
  });

  it('fails closed when a Claude input cannot be parsed', () => {
    const input = parseClaudeEnterpriseHookInput('{not-json');

    expect(input.parse).toMatchObject({ status: 'failed' });
    expect(evaluateEnterpriseHookInput(input)).toMatchObject({
      allowed: false,
      ruleId: 'EG-HARD-INPUT-001',
    });
  });

  it('blocks the approved HARD rule set without echoing secret material', () => {
    const fixtures = [
      {
        source: { tool_name: 'Write', tool_input: { file_path: '.env', content: 'TOKEN=value' } },
        ruleId: 'EG-HARD-ENV-001',
      },
      {
        source: {
          tool_name: 'Write',
          tool_input: { file_path: 'src/config.ts', content: `key=${'AKIA' + '0'.repeat(16)}` },
        },
        ruleId: 'EG-HARD-SECRET-001',
      },
      {
        source: {
          tool_name: 'Edit',
          tool_input: { file_path: 'src/tls.ts', new_string: '-----BEGIN PRIVATE KEY-----' },
        },
        ruleId: 'EG-HARD-SECRET-001',
      },
      {
        source: { tool_name: 'Bash', tool_input: { command: 'rm -rf /' } },
        ruleId: 'EG-HARD-RM-001',
      },
      {
        source: { tool_name: 'Bash', tool_input: { command: 'git push --force origin main' } },
        ruleId: 'EG-HARD-GIT-001',
      },
      {
        source: { tool_name: 'Bash', tool_input: { command: 'sudo rm -rf -- /' } },
        ruleId: 'EG-HARD-RM-001',
      },
      {
        source: { tool_name: 'Bash', tool_input: { command: '/bin/rm -rf /' } },
        ruleId: 'EG-HARD-RM-001',
      },
      {
        source: {
          tool_name: 'Bash',
          tool_input: { command: 'git -c core.sshCommand=ssh push --force origin main' },
        },
        ruleId: 'EG-HARD-GIT-001',
      },
    ];

    for (const fixture of fixtures) {
      const decision = evaluateEnterpriseHookInput(
        parseClaudeEnterpriseHookInput(JSON.stringify(fixture.source)),
      );
      expect(decision).toMatchObject({ allowed: false, ruleId: fixture.ruleId });
      expect(decision.reason).not.toContain('AKIA');
      expect(decision.reason).not.toContain('TOKEN=value');
    }
  });

  it('keeps secret detection active for templates and Bash arguments', () => {
    const template = parseClaudeEnterpriseHookInput(
      JSON.stringify({
        tool_name: 'Write',
        tool_input: {
          file_path: '.env.example',
          content: `AWS_ACCESS_KEY_ID=${'AKIA' + '0'.repeat(16)}`,
        },
      }),
    );
    const bash = parseClaudeEnterpriseHookInput(
      JSON.stringify({
        tool_name: 'Bash',
        tool_input: { command: `export AWS_ACCESS_KEY_ID=${'AKIA' + '0'.repeat(16)}` },
      }),
    );
    const patch = parseClaudeEnterpriseHookInput(
      JSON.stringify({
        tool_name: 'Edit',
        tool_input: {
          file_path: 'src/config.ts',
          patch: `AWS_ACCESS_KEY_ID=${'AKIA' + '0'.repeat(16)}`,
        },
      }),
    );
    const heredoc = parseClaudeEnterpriseHookInput(
      JSON.stringify({
        tool_name: 'Bash',
        tool_input: {
          command: `cat <<'EOF'\nAWS_ACCESS_KEY_ID=${'AKIA' + '0'.repeat(16)}\nEOF`,
        },
      }),
    );

    for (const input of [template, bash, patch, heredoc]) {
      expect(evaluateEnterpriseHookInput(input)).toMatchObject({
        allowed: false,
        ruleId: 'EG-HARD-SECRET-001',
      });
    }
  });

  it('blocks protected destructive operations inside command substitutions and warns for non-protected force pushes', () => {
    const dangerous = parseClaudeEnterpriseHookInput(
      JSON.stringify({
        cwd: '/workspace/project',
        tool_name: 'Bash',
        tool_input: { command: 'printf "%s" "$(rm -rf .)"' },
      }),
    );
    const nonProtectedPush = parseClaudeEnterpriseHookInput(
      JSON.stringify({
        tool_name: 'Bash',
        tool_input: { command: 'git push --force origin feature/isolated-guard' },
      }),
    );

    expect(evaluateEnterpriseHookInput(dangerous)).toMatchObject({
      allowed: false,
      ruleId: 'EG-HARD-RM-001',
    });
    expect(evaluateEnterpriseHookInput(nonProtectedPush)).toMatchObject({
      allowed: true,
      ruleId: null,
      warningRuleIds: ['EG-SOFT-GIT-002'],
    });
  });

  it('downgrades only a valid, unexpired, approved exception to a review warning', () => {
    const input = parseClaudeEnterpriseHookInput(
      JSON.stringify({
        tool_name: 'Write',
        tool_input: { file_path: 'config/.env', content: 'TOKEN=value' },
      }),
    );
    const exception = {
      schemaVersion: 'comet.enterprise-exception.v1' as const,
      exceptionId: 'EGE-ENV-REVIEW',
      ruleId: 'EG-HARD-ENV-001',
      scope: { kind: 'path' as const, value: 'config/.env' },
      reason: 'The generated template is reviewed by the protected release process.',
      owner: 'security@example.test',
      expiresAt: '2026-12-31T00:00:00.000Z',
      approval: {
        changeId: 'CHG-123',
        approvedBy: 'security@example.test',
        approvedAt: '2026-08-31T00:00:00.000Z',
        protectedRef: 'refs/heads/main',
      },
      ci: {
        provider: 'github-actions',
        runId: '456',
        conclusion: 'passed' as const,
        protectedRef: 'refs/heads/main',
      },
      status: 'active' as const,
    };

    expect(
      evaluateEnterpriseHookInput(input, {
        exceptions: [exception],
        now: new Date('2026-08-31T00:00:00.000Z'),
      }),
    ).toMatchObject({
      allowed: true,
      warningRuleIds: ['EG-HARD-ENV-001'],
      results: expect.arrayContaining([
        expect.objectContaining({ exceptionId: 'EGE-ENV-REVIEW', decision: 'warn' }),
      ]),
    });
    expect(
      evaluateEnterpriseHookInput(input, {
        exceptions: [{ ...exception, expiresAt: '2026-01-01T00:00:00.000Z' }],
        now: new Date('2026-08-31T00:00:00.000Z'),
      }),
    ).toMatchObject({ allowed: false, ruleId: 'EG-HARD-ENV-001' });
    expect(
      evaluateEnterpriseHookInput(input, {
        exceptions: [
          {
            ...exception,
            ci: { ...exception.ci, protectedRef: 'refs/heads/release' },
          },
        ],
        now: new Date('2026-08-31T00:00:00.000Z'),
      }),
    ).toMatchObject({ allowed: false, ruleId: 'EG-HARD-ENV-001' });
    expect(
      evaluateEnterpriseHookInput(input, {
        exceptions: [{ ...exception, exceptionId: 'not-an-exception-id' }],
        now: new Date('2026-08-31T00:00:00.000Z'),
      }),
    ).toMatchObject({ allowed: false, ruleId: 'EG-HARD-ENV-001' });
  });

  it('fails closed when the Hook input exceeds its supported size', () => {
    const input = parseClaudeEnterpriseHookInput(
      JSON.stringify({
        tool_name: 'Write',
        tool_input: { file_path: '.env', content: 'x'.repeat(300 * 1024) },
      }),
    );

    expect(input.truncation.fields.some((field) => field.truncated)).toBe(true);
    expect(evaluateEnterpriseHookInput(input)).toMatchObject({
      allowed: false,
      ruleId: 'EG-HARD-INPUT-001',
    });
  });

  it('keeps regex-based scans bounded for adversarial but supported Hook input', () => {
    const input = parseClaudeEnterpriseHookInput(
      JSON.stringify({
        tool_name: 'Bash',
        tool_input: { command: `printf '%s' '${'('.repeat(60 * 1024)}'` },
      }),
    );
    const startedAt = performance.now();
    const decision = evaluateEnterpriseHookInput(input);

    expect(performance.now() - startedAt).toBeLessThan(500);
    expect(decision).toMatchObject({ allowed: true, ruleId: null });
  });
});
