import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  constants,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { dataDirIn } from '../host/data-dir';
import { randomUUID } from 'node:crypto';

const MAX_CONFIG_BYTES = 32_768;

/** Never pass a shell command, account name, or an unvalidated SID to icacls. */
function restrictFile(path: string): void {
  if (process.platform !== 'win32') {
    chmodSync(path, 0o600);
    return;
  }
  const identity = execFileSync(
    join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'whoami.exe'),
    ['/user', '/fo', 'csv', '/nh'],
    { encoding: 'utf8', windowsHide: true },
  );
  const sid = identity.match(/\bS-1-\d+(?:-\d+)+\b/)?.[0];
  if (!sid) throw new Error('Cannot identify file owner');
  execFileSync(
    join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'icacls.exe'),
    [path, '/inheritance:r', '/grant:r', `*${sid}:F`],
    { stdio: 'pipe', windowsHide: true },
  );
}

function configPath(home: string): string {
  const directory = dataDirIn(home);
  if (!existsSync(directory)) mkdirSync(directory, { recursive: true, mode: 0o700 });
  // 目录本身允许是 junction/符号链接：用户把 $DSH_HOME 挪到别的盘再留个 junction 是常见做法
  // （本机 C:\Users\hb109\.dsh\dsh-pet 就是 junction → D:\AI\...），一律拒绝会让独立模式
  // 在启动第一步就失败（Cannot securely load standalone AI settings.）且看不到任何窗口。
  // 安全边界改成：解析到真实路径后必须是目录；文件本身仍然不许是链接（见 readAiSettings）。
  const info = statSync(directory);
  if (!info.isDirectory()) throw new Error('Unsafe settings directory');
  return join(realpathSync(directory), 'standalone-ai.json');
}

export function readAiSettings(home: string): unknown | undefined {
  const path = configPath(home);
  if (!existsSync(path)) return undefined;
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_CONFIG_BYTES) throw new Error('Unsafe settings file');
  // Refuse broad explicit Windows grants rather than reading a potentially public secret.
  // Files created here have no explicit grants except the current SID.
  if (process.platform === 'win32') {
    const acl = execFileSync(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'icacls.exe'), [path], {
      encoding: 'utf8',
      windowsHide: true,
    });
    if (/\b(?:Everyone|BUILTIN\\Users|Authenticated Users)\s*:/i.test(acl))
      throw new Error('Unsafe settings permissions');
  }
  restrictFile(path);
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    if (fstatSync(fd).size > MAX_CONFIG_BYTES) throw new Error('Settings file too large');
    return JSON.parse(readFileSync(fd, 'utf8')) as unknown;
  } finally {
    closeSync(fd);
  }
}

/** Set permissions on an empty exclusive temporary file BEFORE writing any secret. */
export function writeAiSettings(home: string, settings: unknown): void {
  writePrivateJson(configPath(home), settings);
}

/** Internal server utility; caller supplies an existing, trusted parent directory. */
export function writePrivateJson(path: string, settings: unknown): void {
  // 目录允许是 junction（$DSH_HOME 挪盘后留链接是常见做法），解析真实路径后仍必须是目录；
  // 被写入的文件本身依旧不许是链接（下面 existsSync 分支只放行普通文件）。
  const realDirectory = realpathSync(dirname(path));
  if (!statSync(realDirectory).isDirectory()) throw new Error('Unsafe private file directory');
  if (existsSync(path) && (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()))
    throw new Error('Unsafe settings file');
  const target = join(realDirectory, basename(path));
  const temporary = `${target}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  try {
    restrictFile(temporary);
    writeFileSync(fd, JSON.stringify(settings), { encoding: 'utf8' });
    fsyncSync(fd);
    closeSync(fd);
  } catch (error) {
    closeSync(fd);
    unlinkSync(temporary);
    throw error;
  }
  try {
    renameSync(temporary, target);
  } catch (error) {
    unlinkSync(temporary);
    throw error;
  }
}
