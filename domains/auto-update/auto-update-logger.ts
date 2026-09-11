import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function getAutoUpdateLogPath(homeDir = os.homedir()): string {
  return path.join(homeDir, '.comet', 'logs', 'auto-update.log');
}

export function logAutoUpdate(message: string, homeDir = os.homedir()): void {
  try {
    const logPath = getAutoUpdateLogPath(homeDir);
    const dir = path.dirname(logPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const timestamp = new Date().toISOString();
    const line = `[${timestamp}] [PID:${process.pid}] ${message}\n`;

    // 简单滚动保护（超过 200KB 时截断保留后半部分）
    try {
      if (fs.existsSync(logPath)) {
        const stat = fs.statSync(logPath);
        if (stat.size > 200 * 1024) {
          const content = fs.readFileSync(logPath, 'utf8');
          const trimmed = content.slice(-100 * 1024);
          fs.writeFileSync(logPath, trimmed, 'utf8');
        }
      }
    } catch {
      // ignore
    }

    fs.appendFileSync(logPath, line, 'utf8');
  } catch {
    // 写入日志绝不能抛出异常
  }
}
