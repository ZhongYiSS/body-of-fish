import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 用户数据目录名。
 *
 * 0.4.0 起产品英文名从 dsh-pet 改成 Body of Fish（中文显示名仍是「本鱼陪伴」），
 * 数据目录跟着改名 `$DSH_HOME/dsh-pet` → `$DSH_HOME/body-of-fish`。
 * 老用户升级时由 {@link dataDirIn} 在第一次启动把它整体迁过来（配置、表情包、语音缓存一起走），
 * 迁移失败就继续用老目录，绝不让「改个名」把攒下的东西弄丢。
 */
export const DATA_DIR_NAME = 'body-of-fish';

/** 0.3.x 及以前的数据目录名（只用于一次性迁移） */
const LEGACY_DATA_DIR_NAME = 'dsh-pet';

/** 递归复制目录（renameSync 跨盘/被占用时兜底；不覆盖已存在的目标文件） */
function copyDir(from: string, to: string): void {
  mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(from)) {
    const src = join(from, entry);
    const dst = join(to, entry);
    if (statSync(src).isDirectory()) {
      copyDir(src, dst);
    } else if (!existsSync(dst)) {
      copyFileSync(src, dst);
    }
  }
}

/**
 * 用户数据根目录（绝对路径），并顺带做一次老目录迁移。
 *
 * - 新目录已存在：直接用新的（说明早就迁过了，或本来就是新装）。
 * - 新目录不存在、老目录存在：先 `renameSync`（同盘瞬间完成），跨盘失败再递归复制。
 * - 两者都没有：返回新目录路径，调用方自己 `mkdirSync`（首次启动）。
 */
export function dataDirIn(home: string): string {
  const next = join(home, DATA_DIR_NAME);
  const legacy = join(home, LEGACY_DATA_DIR_NAME);
  if (existsSync(next) || !existsSync(legacy)) return next;
  try {
    renameSync(legacy, next);
  } catch {
    try {
      copyDir(legacy, next);
    } catch {
      // 迁移失败（权限/占用）：退回老目录，宁可继续用旧名字也不能让用户丢数据
      return legacy;
    }
  }
  return next;
}

/** 独立模式运行时文件的目录（与数据根一致，单独导出方便调用点读起来直观） */
export function runtimeDirIn(home: string): string {
  return dataDirIn(home);
}
