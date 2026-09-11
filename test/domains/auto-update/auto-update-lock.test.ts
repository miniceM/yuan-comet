import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { AutoUpdateLock } from '../../../domains/auto-update/auto-update-lock.js';

describe('auto-update-lock', () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = path.join(
      os.tmpdir(),
      `lock-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    fs.mkdirSync(tmpHome, { recursive: true });
  });

  it('acquires and releases global lock successfully', async () => {
    const lock = await AutoUpdateLock.acquire({
      installationId: 'inst-1',
      homeDir: tmpHome,
    });
    expect(lock).not.toBeNull();
    expect(fs.existsSync(lock!.lockFilePath)).toBe(true);

    const released = await lock!.release();
    expect(released).toBe(true);
    expect(fs.existsSync(lock!.lockFilePath)).toBe(false);
  });

  it('prevents concurrent acquire while lock is held', async () => {
    const lock1 = await AutoUpdateLock.acquire({
      installationId: 'inst-1',
      homeDir: tmpHome,
    });
    expect(lock1).not.toBeNull();

    // 第二个进程尝试获取同一个全局锁
    const lock2 = await AutoUpdateLock.acquire({
      installationId: 'inst-2',
      homeDir: tmpHome,
    });
    expect(lock2).toBeNull();

    await lock1!.release();

    // 释放后可以获取
    const lock3 = await AutoUpdateLock.acquire({
      installationId: 'inst-2',
      homeDir: tmpHome,
    });
    expect(lock3).not.toBeNull();
    await lock3!.release();
  });

  it('respects activeWorkerPid: refuses to reclaim lock if worker child is alive', async () => {
    const lockFile = path.join(tmpHome, '.comet', 'auto-update.lock');
    fs.mkdirSync(path.join(tmpHome, '.comet'), { recursive: true });

    // 构造一个模拟锁：supervisorPid 是一个绝对死掉的伪造 PID (比如 99999999)，但 activeWorkerPid 是当前存活的 process.pid
    fs.writeFileSync(
      lockFile,
      JSON.stringify({
        supervisorPid: 99999999,
        activeWorkerPid: process.pid, // 存活！
        hostname: os.hostname(),
        token: 'active-worker-token',
        installationId: 'inst-test',
        startedAt: new Date().toISOString(),
        heartbeatAt: new Date().toISOString(),
      }),
      'utf8',
    );

    const lock = await AutoUpdateLock.acquire({
      installationId: 'inst-new',
      homeDir: tmpHome,
    });

    // 绝不能接管！
    expect(lock).toBeNull();
  });

  it('reclaims stale lock when all owners are dead', async () => {
    const lockFile = path.join(tmpHome, '.comet', 'auto-update.lock');
    fs.mkdirSync(path.join(tmpHome, '.comet'), { recursive: true });

    // 构造一个所有者均已死亡的孤儿锁
    fs.writeFileSync(
      lockFile,
      JSON.stringify({
        supervisorPid: 99999999,
        activeWorkerPid: 99999998,
        hostname: os.hostname(),
        token: 'dead-token',
        installationId: 'inst-old',
        startedAt: new Date().toISOString(),
        heartbeatAt: new Date().toISOString(),
      }),
      'utf8',
    );

    const lock = await AutoUpdateLock.acquire({
      installationId: 'inst-reclaimer',
      homeDir: tmpHome,
    });

    expect(lock).not.toBeNull();
    expect(lock!.installationId).toBe('inst-reclaimer');
    await lock!.release();
  });

  it('refuses to reclaim lock if marked with uncleanTermination', async () => {
    const lockFile = path.join(tmpHome, '.comet', 'auto-update.lock');
    fs.mkdirSync(path.join(tmpHome, '.comet'), { recursive: true });

    fs.writeFileSync(
      lockFile,
      JSON.stringify({
        supervisorPid: 99999999,
        hostname: os.hostname(),
        token: 'unclean-token',
        installationId: 'inst-old',
        startedAt: new Date().toISOString(),
        heartbeatAt: new Date().toISOString(),
        uncleanTermination: true,
      }),
      'utf8',
    );

    const lock = await AutoUpdateLock.acquire({
      installationId: 'inst-new',
      homeDir: tmpHome,
    });

    expect(lock).toBeNull();
  });

  it('interleaved reclaim: does not remove new lock if token was changed by another process', async () => {
    const cometDir = path.join(tmpHome, '.comet');
    const lockFile = path.join(cometDir, 'auto-update.lock');
    fs.mkdirSync(cometDir, { recursive: true });

    // 先创建一个假锁
    fs.writeFileSync(
      lockFile,
      JSON.stringify({
        supervisorPid: 99999999,
        hostname: os.hostname(),
        token: 'token-old',
        installationId: 'inst-old',
        startedAt: new Date().toISOString(),
        heartbeatAt: new Date().toISOString(),
      }),
      'utf8',
    );

    // 模拟正常进程 A 接管成功并写入了自己的新锁（包含当前存活的 process.pid 和新 token）
    const lockA = await AutoUpdateLock.acquire({
      installationId: 'inst-A',
      homeDir: tmpHome,
    });
    expect(lockA).not.toBeNull();
    expect(lockA!.token).not.toBe('token-old');

    // 进程 B 再次尝试回收，但现在的锁已经是进程 A 持有且存活
    const lockB = await AutoUpdateLock.acquire({
      installationId: 'inst-B',
      homeDir: tmpHome,
    });
    expect(lockB).toBeNull();

    // 验证进程 A 的新锁完好无损，没有被移走
    const content = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
    expect(content.token).toBe(lockA!.token);
    expect(content.installationId).toBe('inst-A');

    await lockA!.release();
  });

  it('blocks manual updateCommand when background update lock is active', async () => {
    const cometDir = path.join(tmpHome, '.comet');
    const lockFile = path.join(cometDir, 'auto-update.lock');
    fs.mkdirSync(cometDir, { recursive: true });

    // 写入活跃锁（PID 为当前存活进程）
    fs.writeFileSync(
      lockFile,
      JSON.stringify({
        supervisorPid: process.pid,
        hostname: os.hostname(),
        token: 'active-token',
        installationId: 'inst-active',
        startedAt: new Date().toISOString(),
        heartbeatAt: new Date().toISOString(),
      }),
      'utf8',
    );

    const { updateCommand } = await import('../../../app/commands/update.js');
    const result = await updateCommand(tmpHome, {
      json: true,
      allProjects: false,
      homeDir: tmpHome,
    });
    expect(result.status).toBe('incomplete');
  });
});
