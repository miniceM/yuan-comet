import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { GlobalUpdateLockData } from './auto-update-types.js';

export interface LockAcquireOptions {
  installationId: string;
  homeDir?: string;
  heartbeatIntervalMs?: number;
}

export class AutoUpdateLock {
  private heartbeatTimer?: NodeJS.Timeout;

  constructor(
    public readonly lockFilePath: string,
    public readonly token: string,
    public readonly installationId: string,
    public readonly supervisorPid: number,
  ) {}

  /**
   * 获取全局更新互斥锁。
   * 采用原子写、双活进程检测及安全的 reclaim.lock 孤儿回收协议。
   */
  static async acquire(options: LockAcquireOptions): Promise<AutoUpdateLock | null> {
    const homeDir = options.homeDir ?? os.homedir();
    const cometDir = path.join(homeDir, '.comet');
    if (!fs.existsSync(cometDir)) {
      try {
        fs.mkdirSync(cometDir, { recursive: true });
      } catch {
        return null;
      }
    }

    const lockPath = path.join(cometDir, 'auto-update.lock');
    const reclaimPath = path.join(cometDir, 'auto-update.reclaim.lock');
    const supervisorPid = process.pid;
    const token = randomUUID();
    const hostname = os.hostname();
    const now = new Date().toISOString();

    const lockData: GlobalUpdateLockData = {
      supervisorPid,
      hostname,
      token,
      installationId: options.installationId,
      startedAt: now,
      heartbeatAt: now,
    };

    // 1. 尝试直接排他创建锁文件
    if (tryCreateLockFile(lockPath, lockData)) {
      const lock = new AutoUpdateLock(lockPath, token, options.installationId, supervisorPid);
      lock.startHeartbeat(options.heartbeatIntervalMs);
      return lock;
    }

    // 2. 锁已存在，检查锁内容
    const existing = readLockFile(lockPath);
    if (!existing) {
      // 损坏的空锁或读取异常，尝试安全回收
      if (tryReclaimStaleLock(lockPath, reclaimPath, lockData)) {
        const lock = new AutoUpdateLock(lockPath, token, options.installationId, supervisorPid);
        lock.startHeartbeat(options.heartbeatIntervalMs);
        return lock;
      }
      return null;
    }

    // 3. 严格活体检测：只要 supervisorPid 或 activeWorkerPid 任一存活，绝对不接管！
    if (
      isPidAlive(existing.supervisorPid, existing.hostname) ||
      (existing.activeWorkerPid && isPidAlive(existing.activeWorkerPid, existing.hostname))
    ) {
      return null;
    }

    // 若标记了未干净退出 (uncleanTermination)，保守保护，不自动清理
    if (existing.uncleanTermination) {
      return null;
    }

    // 4. 确认所有者均已死亡，通过原子回收锁进行安全接管
    if (tryReclaimStaleLock(lockPath, reclaimPath, lockData, existing.token)) {
      const lock = new AutoUpdateLock(lockPath, token, options.installationId, supervisorPid);
      lock.startHeartbeat(options.heartbeatIntervalMs);
      return lock;
    }

    return null;
  }

  /**
   * 在启动子进程后登记 activeWorkerPid
   */
  registerActiveWorkerPid(activeWorkerPid: number): boolean {
    try {
      const current = readLockFile(this.lockFilePath);
      if (!current || current.token !== this.token) return false;

      current.activeWorkerPid = activeWorkerPid;
      current.heartbeatAt = new Date().toISOString();
      fs.writeFileSync(this.lockFilePath, JSON.stringify(current, null, 2), 'utf8');
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 标记终止异常（防止孤儿锁被自动删除）
   */
  markUncleanTermination(): void {
    try {
      const current = readLockFile(this.lockFilePath);
      if (current && current.token === this.token) {
        current.uncleanTermination = true;
        fs.writeFileSync(this.lockFilePath, JSON.stringify(current, null, 2), 'utf8');
      }
    } catch {
      // ignore
    }
  }

  /**
   * 释放锁，必须校验 token
   */
  async release(): Promise<boolean> {
    this.stopHeartbeat();
    try {
      const current = readLockFile(this.lockFilePath);
      if (!current || current.token !== this.token) {
        return false;
      }
      fs.unlinkSync(this.lockFilePath);
      return true;
    } catch {
      return false;
    }
  }

  private startHeartbeat(intervalMs = 30_000): void {
    this.heartbeatTimer = setInterval(() => {
      try {
        const current = readLockFile(this.lockFilePath);
        if (current && current.token === this.token) {
          current.heartbeatAt = new Date().toISOString();
          fs.writeFileSync(this.lockFilePath, JSON.stringify(current, null, 2), 'utf8');
        }
      } catch {
        // ignore
      }
    }, intervalMs);
    this.heartbeatTimer.unref?.();
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
  }
}

function tryCreateLockFile(lockPath: string, data: GlobalUpdateLockData): boolean {
  try {
    const fd = fs.openSync(lockPath, 'wx');
    try {
      fs.writeFileSync(fd, JSON.stringify(data, null, 2), 'utf8');
      return true;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
}

function readLockFile(lockPath: string): GlobalUpdateLockData | null {
  try {
    const content = fs.readFileSync(lockPath, 'utf8');
    const parsed = JSON.parse(content) as GlobalUpdateLockData;
    if (typeof parsed.supervisorPid === 'number' && typeof parsed.token === 'string') {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

export function isPidAlive(pid: number, expectedHostname?: string): boolean {
  if (expectedHostname && expectedHostname !== os.hostname()) {
    // 跨主机无法通过本地 signal 探测，保守认为存活
    return true;
  }
  try {
    process.kill(pid, 0);
    return true; // 信号发送成功，进程肯定存活
  } catch (err: unknown) {
    const error = err as NodeJS.ErrnoException;
    if (error.code === 'EPERM') {
      // 权限不足但说明进程确实存在并存活
      return true;
    }
    if (error.code === 'ESRCH') {
      // 进程绝对不存在
      return false;
    }
    // 其他未知异常保守认定存活
    return true;
  }
}

function tryAcquireReclaimLock(reclaimPath: string): boolean {
  try {
    const fd = fs.openSync(reclaimPath, 'wx');
    try {
      fs.writeFileSync(
        fd,
        JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
        'utf8',
      );
      return true;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    try {
      const existingReclaim = JSON.parse(fs.readFileSync(reclaimPath, 'utf8')) as { pid?: number };
      if (existingReclaim.pid && !isPidAlive(existingReclaim.pid)) {
        try {
          fs.unlinkSync(reclaimPath);
          const fd = fs.openSync(reclaimPath, 'wx');
          fs.closeSync(fd);
          return true;
        } catch {
          return false;
        }
      }
    } catch {
      return false;
    }
    return false;
  }
}

/**
 * 带有独立原子回收锁的安全清理机制
 */
function tryReclaimStaleLock(
  lockPath: string,
  reclaimPath: string,
  newLockData: GlobalUpdateLockData,
  expectedOldToken?: string,
): boolean {
  if (!tryAcquireReclaimLock(reclaimPath)) {
    return false;
  }

  try {
    // 2. 拿到 reclaim 权限后，再次原子重新核对正式锁的当前状态！
    const current = readLockFile(lockPath);
    if (current) {
      if (expectedOldToken && current.token !== expectedOldToken) {
        // 锁已经被其他有效进程替换，放弃清理
        return false;
      }
      if (
        isPidAlive(current.supervisorPid, current.hostname) ||
        (current.activeWorkerPid && isPidAlive(current.activeWorkerPid, current.hostname))
      ) {
        return false;
      }
      try {
        fs.unlinkSync(lockPath);
      } catch {
        return false;
      }
    }

    // 3. 创建新锁
    return tryCreateLockFile(lockPath, newLockData);
  } finally {
    try {
      fs.unlinkSync(reclaimPath);
    } catch {
      // ignore
    }
  }
}
