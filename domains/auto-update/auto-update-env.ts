import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export interface InstallationIdentity {
  installationId: string;
  canonicalPackageRoot: string;
  canonicalNodeExec: string;
  isGlobal: boolean;
  isDevWorktree: boolean;
}

export function resolveInstallationId(
  packageRoot: string,
  nodeExec: string = process.execPath,
): string {
  const canonicalPkgRoot = getSafeRealPath(packageRoot);
  const canonicalNodeExec = getSafeRealPath(nodeExec);
  return createHash('sha256')
    .update(`${canonicalPkgRoot}:${canonicalNodeExec}`)
    .digest('hex')
    .slice(0, 16);
}

function getSafeRealPath(filePath: string): string {
  try {
    return fs.realpathSync(filePath);
  } catch {
    return path.resolve(filePath);
  }
}

/**
 * 严格判定包自身的物理根路径是否为源码仓库开发环境：
 * 必须包本身目录下同时满足：
 * 1. package.json 的 name 是 @cli-tools/yuan-comet 或 @rpamis/comet
 * 2. 存在 build.js 与 domains/ 或 app/ 源码目录
 * 3. 存在 .git 文件或目录（包括 git worktree 的 .git 文件）
 */
export function isDevSourceWorktree(packageRoot: string): boolean {
  try {
    const realRoot = getSafeRealPath(packageRoot);
    const pkgJsonPath = path.join(realRoot, 'package.json');
    if (!fs.existsSync(pkgJsonPath)) return false;

    const raw = fs.readFileSync(pkgJsonPath, 'utf8');
    const pkg = JSON.parse(raw) as { name?: string };
    if (pkg.name !== '@cli-tools/yuan-comet' && pkg.name !== '@rpamis/comet') {
      return false;
    }

    const hasBuildJs = fs.existsSync(path.join(realRoot, 'build.js'));
    const hasDomainsOrApp =
      fs.existsSync(path.join(realRoot, 'domains')) || fs.existsSync(path.join(realRoot, 'app'));
    const hasGit = fs.existsSync(path.join(realRoot, '.git'));

    return hasBuildJs && hasDomainsOrApp && hasGit;
  } catch {
    return false;
  }
}

/**
 * 判定当前包是否属于全局安装包。
 * 若物理路径位于某个非全局项目的 node_modules 下（即其上层包含非全局 node_modules），则不视为受支持的全局安装。
 */
export function isGlobalPackageRoot(packageRoot: string): boolean {
  const realRoot = getSafeRealPath(packageRoot);
  if (isDevSourceWorktree(realRoot)) return false;

  // 典型全局包路径特征：
  // macOS/Linux: /usr/local/lib/node_modules/..., ~/.nvm/versions/node/.../lib/node_modules/...
  // Windows: %AppData%\npm\node_modules\...
  // 如果路径内没有 node_modules，或作为顶层包安装，属于非全局依赖
  const parentDir = path.dirname(realRoot);
  // 对于 scoped package (@cli-tools/yuan-comet)，parentDir 是 @cli-tools，grandparentDir 才是 node_modules
  const isScoped = path.basename(parentDir).startsWith('@');
  const nodeModulesDir = isScoped ? path.dirname(parentDir) : parentDir;

  if (path.basename(nodeModulesDir).toLowerCase() !== 'node_modules') {
    return false;
  }

  // 检查 node_modules 的父级目录：若父级目录本身还有 package.json 且该 package.json 定义了 dependencies/devDependencies 包含本包，
  // 说明是项目局部依赖，非全局安装
  const projectCandidate = path.dirname(nodeModulesDir);
  const candidatePkgJson = path.join(projectCandidate, 'package.json');
  if (fs.existsSync(candidatePkgJson)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(candidatePkgJson, 'utf8')) as {
        name?: string;
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      // 如果不是系统库（例如父项目有自己的 name 且将本包声明为依赖）
      if (
        parsed.dependencies?.['@cli-tools/yuan-comet'] ||
        parsed.devDependencies?.['@cli-tools/yuan-comet'] ||
        parsed.dependencies?.['@rpamis/comet'] ||
        parsed.devDependencies?.['@rpamis/comet']
      ) {
        return false;
      }
    } catch {
      // ignore
    }
  }

  return true;
}

export function inspectInstallationIdentity(
  packageRoot: string,
  nodeExec: string = process.execPath,
): InstallationIdentity {
  const canonicalPackageRoot = getSafeRealPath(packageRoot);
  const canonicalNodeExec = getSafeRealPath(nodeExec);
  const installationId = resolveInstallationId(canonicalPackageRoot, canonicalNodeExec);
  const isDevWorktree = isDevSourceWorktree(canonicalPackageRoot);
  const isGlobal = isGlobalPackageRoot(canonicalPackageRoot);

  return {
    installationId,
    canonicalPackageRoot,
    canonicalNodeExec,
    isGlobal,
    isDevWorktree,
  };
}
