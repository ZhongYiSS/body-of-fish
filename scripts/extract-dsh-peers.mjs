#!/usr/bin/env node
/**
 * extract-dsh-peers.mjs —— 从正在运行的 DSH 安装里，把宿主的 @deepseek-ai/* 包
 * 抽到本工程的 node_modules，供**单测**解析用。
 *
 * 为什么需要：这些包是 peerDependencies，真实运行时由 DSH 提供，不会随插件安装。
 * 但单测（routes / whisper / chat / work-status …）要 import 它们的值，裸 node --test
 * 时解析不到 → ERR_MODULE_NOT_FOUND。开发机上从 app.asar 抽一份只读副本最省事。
 *
 * 只抽不建链接：抽出来的是可读副本，改不了安装里的东西，也不影响真机运行。
 * 用法：
 *   node scripts/extract-dsh-peers.mjs                # 默认抽 @deepseek-ai/*
 *   node scripts/extract-dsh-peers.mjs cordis cosmokit
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ASAR = process.env.DSH_ASAR || 'D:\\DSH harness\\resources\\app.asar';
const UNPACKED = ASAR.replace(/app\.asar$/, 'app.asar.unpacked');
const wanted = process.argv.slice(2);
if (wanted.length === 0) wanted.push('@deepseek-ai');

if (!existsSync(ASAR)) {
  console.error(`[peers] 找不到 ${ASAR}，用 DSH_ASAR 环境变量指一下`);
  process.exit(1);
}

const buf = readFileSync(ASAR);
const headerSize = buf.readUInt32LE(12);
const header = JSON.parse(buf.subarray(16, 16 + headerSize).toString('utf8').replace(/\u0000+$/, ''));
const DATA_START = 16 + headerSize;

/** 取 /dsh/node_modules 下的子树 */
const nodeModules = header.files?.dsh?.files?.node_modules;
if (!nodeModules) {
  console.error('[peers] asar 里没有 /dsh/node_modules');
  process.exit(1);
}

function matchScope(name, prefix) {
  if (name === prefix) return 'whole';
  if (prefix.startsWith('@') && !prefix.includes('/') && name.startsWith(prefix + '/')) return 'sub';
  if (name.startsWith(prefix + '/')) return 'sub';
  return null;
}

let written = 0;
const notFound = [];

function writeEntry(rel, entry) {
  const dest = join(ROOT, 'node_modules', rel);
  mkdirSync(dirname(dest), { recursive: true });
  if (entry.unpacked) {
    const from = join(UNPACKED, rel);
    if (!existsSync(from)) return false;
    writeFileSync(dest, readFileSync(from));
  } else {
    const start = DATA_START + Number(entry.offset);
    writeFileSync(dest, buf.subarray(start, start + Number(entry.size)));
  }
  written += 1;
  return true;
}

function walk(node, rel) {
  for (const [name, child] of Object.entries(node.files ?? {})) {
    const childRel = rel ? `${rel}/${name}` : name;
    if (child.files) walk(child, childRel);
    else writeEntry(childRel, child);
  }
}

for (const entryName of Object.keys(nodeModules.files)) {
  if (!wanted.some((w) => matchScope(entryName, w))) continue;
  const node = nodeModules.files[entryName];
  if (node.files) walk(node, entryName);
  else writeEntry(entryName, node);
}

console.log(`[peers] 抽出 ${written} 个文件 → node_modules/`);
console.log(`[peers] 目标: ${wanted.join(' ')}`);
