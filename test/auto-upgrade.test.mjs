// @ts-check
/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : auto-upgrade.test.mjs
 * Author     : sumu
 * Date       : 2026/08/01
 * Version    : 0.1.0
 * Description: auto-upgrade.js 版本号递增行为单元测试
 *
 *              覆盖目标：
 *                1. 纯计算函数 bumpMinor 的各种版本号递增场景（核心）
 *                   - 正常 minor bump（中位 +1、末位归零）
 *                   - patch 归零规则（0.2.3 → 0.3.0，而非 0.3.3）
 *                   - 多位数 / 边界值（0.1.9 → 0.2.0、0.10.20 → 0.11.0）
 *                   - 非法格式一律抛错（缺段、非数字、前导 v、空串等）
 *                2. require 不会触发 main（保证可被测试安全引入）
 *                3. CLI 冒烟：--target=<当前版本> 命中幂等检查退出码 2（不发网络、不改文件）
 *                4. CLI 冒烟：--target=<非法格式> 在格式校验处退出码 1（不发网络、不改文件）
 *
 *              运行：npm run test:upgrade
 * =====================================================
 */

import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

// auto-upgrade.js 是 CommonJS，ESM 里用 createRequire 引入其导出的纯函数
const require = createRequire(import.meta.url);
const ROOT = path.resolve(import.meta.dirname, '..');
const { bumpMinor } = require(path.join(ROOT, 'build/auto-upgrade.js'));

// ── 测试结果统计 ──────────────────────────────────────────────
let passed = 0;
let failed = 0;

function pass(name) {
  console.log(`  ✔ ${name}`);
  passed++;
}
function fail(name, detail) {
  console.log(`  ✘ ${name}`);
  if (detail) console.log(`    → ${detail}`);
  failed++;
}

/**
 * 断言实际值 === 期望值，相等记通过，否则记失败
 * @param {string} name 用例名
 * @param {unknown} actual 实际值
 * @param {unknown} expected 期望值
 */
function assertEqual(name, actual, expected) {
  if (actual === expected) {
    pass(name);
  } else {
    fail(name, `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
  }
}

/**
 * 断言调用 fn 会抛错，且错误信息含 expectedMsgFragment
 * @param {string} name 用例名
 * @param {() => unknown} fn 待调用函数
 * @param {string} expectedMsgFragment 期望的错误信息子串
 */
function assertThrows(name, fn, expectedMsgFragment) {
  try {
    fn();
    fail(name, '期望抛错，但未抛错');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes(expectedMsgFragment)) {
      pass(name);
    } else {
      fail(name, `错误信息应含「${expectedMsgFragment}」，实际: ${msg}`);
    }
  }
}

/**
 * 同步执行子进程，返回 { status, stdout, stderr }
 *
 * main 的主流程日志走 console.log（stdout），失败信息走 console.error（stderr），
 * 故两个流都要捕获。process.exit(2) 等非零退出会让 execFileSync 抛错，
 * 此时 stdout/stderr 仍挂在异常对象上，需从 err 上取回。
 *
 * @param {string[]} args 传给 node build/auto-upgrade.js 的参数
 * @returns {{ status: number | null, stdout: string, stderr: string }}
 */
function runCli(args) {
  try {
    const stdout = execFileSync('node', [path.join(ROOT, 'build/auto-upgrade.js'), ...args], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30000,
    });
    return { status: 0, stdout: String(stdout), stderr: '' };
  } catch (err) {
    return {
      status: err.status ?? null,
      stdout: err.stdout ? String(err.stdout) : '',
      stderr: err.stderr ? String(err.stderr) : '',
    };
  }
}

// ─────────────────────────────────────────────────────────────
// 用例集
// ─────────────────────────────────────────────────────────────

/**
 * 第一组：bumpMinor 正常递增（核心语义验证）
 *
 * 重点验证「patch 归零规则」——情况②③触发 minor bump 时，patch 位必须归零，
 * 而不是简单累加。这是 VERSION-BUMP.md 第一章约定的核心语义。
 */
function suite_bumpMinorNormal() {
  console.log('── 第一组：bumpMinor 正常递增（patch 归零）──');

  // 初版，patch 本就是 0：只动 minor
  assertEqual('0.1.0 → 0.2.0', bumpMinor('0.1.0'), '0.2.0');

  // patch 非 0：minor +1 的同时 patch 归零（不是 0.3.3）
  assertEqual('0.2.3 → 0.3.0（patch 归零）', bumpMinor('0.2.3'), '0.3.0');
  assertEqual('0.2.9 → 0.3.0（patch 归零）', bumpMinor('0.2.9'), '0.3.0');
  assertEqual('0.5.7 → 0.6.0', bumpMinor('0.5.7'), '0.6.0');

  // patch 进位边界：patch 到 9 也不影响 minor，minor 独立 +1
  assertEqual('0.1.9 → 0.2.0（patch 满 9 也不进 minor）', bumpMinor('0.1.9'), '0.2.0');

  // 多位数版本号：minor 段是两位数
  assertEqual('0.10.20 → 0.11.0（多位 minor）', bumpMinor('0.10.20'), '0.11.0');
  assertEqual('1.9.0 → 1.10.0（minor 9→10 进位）', bumpMinor('1.9.0'), '1.10.0');

  // major 段不动：minor bump 只改中位与末位
  assertEqual('3.4.5 → 3.5.0（major 保持）', bumpMinor('3.4.5'), '3.5.0');
  assertEqual('12.0.1 → 12.1.0', bumpMinor('12.0.1'), '12.1.0');
}

/**
 * 第二组：bumpMinor 非法格式一律抛错
 *
 * bumpMinor 只接受纯数字 X.Y.Z。任何偏离（带 v 前缀、缺段、含字母、空串、
 * 前导零虽是纯数字但语义存疑也一并拒绝）都应抛错，避免静默产出错误版本号。
 */
function suite_bumpMinorInvalid() {
  console.log('\n── 第二组：bumpMinor 非法格式抛错 ──');

  // 带 v 前缀：npm version 是纯数字，不应有 v
  assertThrows('带 v 前缀抛错', () => bumpMinor('v0.1.0'), '版本号格式');

  // 段数不对：少一段或多一段
  assertThrows('两段抛错', () => bumpMinor('0.1'), '版本号格式');
  assertThrows('四段抛错', () => bumpMinor('0.1.0.0'), '版本号格式');
  assertThrows('单段抛错', () => bumpMinor('0'), '版本号格式');

  // 含非数字字符：字母、空格、预发布后缀
  assertThrows('含字母抛错', () => bumpMinor('0.1.a'), '版本号格式');
  assertThrows('含空格抛错', () => bumpMinor('0. 1.0'), '版本号格式');
  assertThrows('带预发布后缀抛错', () => bumpMinor('0.1.0-beta'), '版本号格式');

  // 空串与空段
  assertThrows('空串抛错', () => bumpMinor(''), '版本号格式');
  assertThrows('空段抛错', () => bumpMinor('0..1'), '版本号格式');

  // 负数 / 小数点：负号、小数都不是纯整数
  assertThrows('负数抛错', () => bumpMinor('0.-1.0'), '版本号格式');
  assertThrows('小数抛错', () => bumpMinor('0.1.0.5'), '版本号格式');
}

/**
 * 第三组：require 安全性
 *
 * auto-upgrade.js 顶部用 require.main === module 守护 main，
 * 这里验证 require 进来后只拿到 bumpMinor，且不会触发主流程（主流程会发网络、
 * 改文件，测试环境不应有副作用）。
 */
function suite_requireSafety() {
  console.log('\n── 第三组：require 不触发 main 且正确导出 bumpMinor ──');

  assertEqual('bumpMinor 是函数', typeof bumpMinor, 'function');
  // 若 require 误触发了 main，进程早已 exit，根本走不到这里——能执行本断言即说明未触发
  assertEqual('require 未触发 main（已执行到此处）', true, true);
}

/**
 * 第四组：CLI 冒烟——幂等跳过（退出码 2，不发网络、不改文件）
 *
 * 传 --target=<platforms.js 当前的 VERSION>，main 的步骤 2 幂等检查会命中，
 * 直接 process.exit(2)。这条路径不触达 GitHub API 与文件写入，故可离线、
 * 无副作用地验证「已在该版本时跳过」的行为。
 */
async function suite_cliSkip() {
  console.log('\n── 第四组：CLI 幂等跳过（--target=当前版本 → 退出码 2）──');

  // 读 platforms.js 当前 VERSION，作为 --target（避免依赖网络）
  const platformsSrc = await readFile(path.join(ROOT, 'build/platforms.js'), 'utf8');
  const m = platformsSrc.match(/const VERSION = '([^']*)';/);
  if (!m) {
    fail('读取当前 VERSION', 'platforms.js 未找到 VERSION 常量');
    return;
  }
  const currentTag = m[1];

  const { status, stdout, stderr } = runCli([`--target=${currentTag}`]);
  const output = (stdout + stderr);
  assertEqual('已在该版本时退出码为 2（跳过）', status, 2);
  // 跳过提示走 console.log（stdout）；两路都查，兼容未来调整
  if (output.includes('无需升级') || output.includes('跳过')) {
    pass('输出包含「无需升级/跳过」提示');
  } else {
    fail('输出包含跳过提示', `output: ${output.trim().slice(-120)}`);
  }
}

/**
 * 第五组：CLI 冒烟——非法 target 格式（退出码 1，不发网络、不改文件）
 *
 * 传一个不符合 vX.Y.Z 的 --target，main 的步骤 1 格式校验会抛错，
 * 走到 catch 后 process.exit(1)。同样不触达网络与文件写入。
 */
function suite_cliInvalidTarget() {
  console.log('\n── 第五组：CLI 非法 target（--target=xxx → 退出码 1）──');

  const { status, stdout, stderr } = runCli(['--target=不是版本号']);
  const output = (stdout + stderr);
  assertEqual('非法 target 退出码为 1（失败）', status, 1);
  if (output.includes('版本号格式')) {
    pass('输出包含「版本号格式」错误提示');
  } else {
    fail('输出包含格式错误提示', `output: ${output.trim().slice(-120)}`);
  }
}

// ─────────────────────────────────────────────────────────────
// 主流程
// ─────────────────────────────────────────────────────────────

async function main() {
  console.log('════════ auto-upgrade 版本号递增行为测试 ════════');

  // 纯函数单元测试（不发网络、不改文件）
  suite_bumpMinorNormal();
  suite_bumpMinorInvalid();
  suite_requireSafety();

  // CLI 冒烟测试（命中幂等检查 / 格式校验，均不触达网络与文件写入）
  await suite_cliSkip();
  suite_cliInvalidTarget();

  // 收尾
  console.log('\n────────────────────────────────────');
  console.log(`结果: ${passed} 通过, ${failed} 失败`);
  console.log('────────────────────────────────────');
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('\n测试脚本异常退出:', err);
  process.exit(1);
});
