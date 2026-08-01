// @ts-check
'use strict';

/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : auto-upgrade.js
 * Author     : sumu
 * Date       : 2026/08/01
 * Version    : 0.1.0
 * Description: 上游 cmdsift 二进制版本自动升级脚本
 *
 *              【职责边界】
 *              上游 cmdsift 发新版时，本脚本一次性完成两件事：
 *                1. 更新上游二进制版本（platforms.js 的 VERSION + binaries.lock.json 的 SHA256）
 *                2. 自动 minor bump npm 包版本号（package.json 的 version 中位 +1、末位归零）
 *                   并同步子包
 *              遵循「上游发新版 → 下游必发新版」的约定：二进制行为已变，npm 包必须
 *              跟着发新版，否则用户无法拿到新二进制。
 *
 *              【版本号语义约定】
 *              npm 版本号用 semver 三段式区分变化来源（详见 VERSION-BUMP.md 第一章）：
 *                - patch（末位）：仅入口包 JS 代码改动，二进制不变（人工手动 bump）
 *                - minor（中位）：上游二进制更新（本脚本自动 bump，故二进制一升就 minor）
 *                - major（首位）：破坏性变更（人工手动 bump）
 *              这样用户从版本号即可判断变化性质：patch=纯代码调整，minor=含新二进制。
 *
 *              【与下游脚本的关系】
 *              本脚本内部调用：
 *                - npm run update-lock（即 prepare-binaries.js --update-lock）
 *                  重新下载各平台 archive 并写入新 SHA256 到 binaries.lock.json
 *                - npm run sync-packages
 *                  把 patch bump 后的 npm 版本号同步到所有子包 package.json 及
 *                  入口包的 optionalDependencies
 *
 *              【用法】
 *                node build/auto-upgrade.js                     # 自动取上游最新 release
 *                node build/auto-upgrade.js --target=v0.2.0     # 指定目标版本（带 v 前缀）
 *                GITHUB_TOKEN=xxx node build/auto-upgrade.js    # 带 token 避免 API 限流
 *
 *              【退出码】
 *                0  成功（二进制版本已更新，待人工决定是否发版）
 *                1  失败（上游无 release、网络错误、刷锁失败等）
 *                2  跳过（platforms.js 已是该版本，无需重复升级）
 * =====================================================
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { execSync } = require('child_process');

// 仓库根目录（本文件位于 build/，故上一级即根）
const ROOT = path.join(__dirname, '..');
// 上游二进制版本的唯一真相源：VERSION 常量定义在此
const PLATFORMS_PATH = path.join(ROOT, 'build/platforms.js');
// npm 包版本号的真相源：version 字段定义在此（patch bump 时读写）
const ROOT_PKG_PATH = path.join(ROOT, 'package.json');
// 上游 cmdsift 的 GitHub 仓库（owner/repo），用于拼接 Release API 和下载 URL
const REPO = 'smk-h/cmdsift';

// ── 命令行参数解析 ────────────────────────────────────────────
// 支持 --target vX.Y.Z（空格分隔）和 --target=vX.Y.Z（等号分隔）两种写法，
// 兼容 npm run auto-upgrade -- --target=v0.2.0 与直接 node 调用两种场景。
const argv = process.argv.slice(2);
const targetIdx = argv.findIndex(a => a.startsWith('--target'));
let TARGET;
if (targetIdx !== -1) {
  const arg = argv[targetIdx];
  if (arg.includes('=')) {
    // 等号形式：取 = 之后的值
    TARGET = arg.split('=')[1];
  } else {
    // 空格形式：取下一个 argv 元素；若缺失则为 undefined，后续格式校验会报错
    TARGET = argv[targetIdx + 1];
  }
}

/**
 * 通过 HTTPS GET 请求 GitHub API，返回解析后的 JSON
 *
 * 封装了对 301/302 重定向的处理（GitHub Release 资源常会重定向到 CDN），
 * 并在非 200 响应时主动消费并丢弃响应体（res.resume），避免连接泄漏。
 *
 * @param {string} url - 完整的 GitHub API URL
 * @param {Record<string, string>} headers - 附加请求头（如 authorization）
 * @returns {Promise<unknown>} 解析后的 JSON 对象
 */
function githubApiGet(url, headers) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'user-agent': 'cmdsift-monorepo', ...headers } }, res => {
      const { statusCode, headers: resHeaders } = res;
      const location = /** @type {string | undefined} */ (resHeaders.location);
      // 处理重定向：GitHub 的 release 资源 URL 常返回 302 跳转到 CDN
      if ((statusCode === 301 || statusCode === 302) && location) {
        res.resume(); // 丢弃当前响应体，避免底层连接挂起
        return githubApiGet(location, headers).then(resolve, reject);
      }
      if (statusCode !== 200) {
        res.resume(); // 非 200 也需消费响应体，防止 socket 泄漏
        return reject(new Error(`GitHub API HTTP ${statusCode} for ${url}`));
      }
      let body = '';
      res.on('data', chunk => (body += chunk));
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (err) {
          reject(err);
        }
      });
    }).on('error', reject);
  });
}

/**
 * 查询上游 cmdsift 最新正式 release 的 tag（如 v0.2.0）
 *
 * GitHub API /releases 默认按创建时间倒序返回，首个非 draft、非 prerelease
 * 的即为最新正式版本。若全部是草稿/预发布，则退而取列表第一个（容错）。
 *
 * @param {string} token - GITHUB_TOKEN，避免匿名 API 限流（未认证 60 次/小时）
 * @returns {Promise<string>} 最新正式 release 的 tag_name（带 v 前缀）
 */
async function fetchLatestReleaseTag(token) {
  // 匿名调用 GitHub API 限流 60 次/小时，带 token 可提升至 5000 次/小时
  /** @type {Record<string, string>} */
  const headers = token ? { authorization: `token ${token}` } : {};
  const releases = /** @type {Array<{ tag_name: string; draft: boolean; prerelease: boolean }>} */ (
    await githubApiGet(`https://api.github.com/repos/${REPO}/releases`, headers)
  );
  // 跳过 draft（草稿）和 prerelease（预发布），取第一个正式 release
  // 若全是非正式版，退而取列表第一项（API 已按时间倒序），保证总能拿到一个
  const latest = releases.find(r => !r.draft && !r.prerelease) || releases[0];
  if (!latest) {
    throw new Error(`上游 ${REPO} 无任何 release，无法自动升级`);
  }
  return latest.tag_name;
}

/**
 * 读取 platforms.js 当前的 VERSION 常量值（用于跳过判断）
 *
 * 通过正则匹配 `const VERSION = '...';` 提取引号内的字符串，
 * 避免引入 platforms.js 模块（其内部逻辑会触发二进制下载等副作用）。
 *
 * @returns {string} 当前二进制版本 tag，形如 v0.1.0
 */
function currentPlatformsVersion() {
  const content = fs.readFileSync(PLATFORMS_PATH, 'utf8');
  const match = content.match(/const VERSION = '([^']*)';/);
  if (!match) {
    throw new Error(`未在 ${PLATFORMS_PATH} 找到 VERSION 常量`);
  }
  return match[1];
}

/**
 * 把 platforms.js 的 VERSION 常量改为新值（原地文本替换）
 *
 * 采用正则替换而非 require 模块，保证只改版本字符串、不动文件其余部分。
 * 替换前后内容相同则说明未匹配到常量，抛错避免静默失败。
 *
 * @param {string} tag - 新版本 tag，形如 v0.2.0（带 v 前缀）
 */
function updatePlatformsVersion(tag) {
  const original = fs.readFileSync(PLATFORMS_PATH, 'utf8');
  const updated = original.replace(
    /const VERSION = '[^']*';/,
    `const VERSION = '${tag}';`,
  );
  if (updated === original) {
    throw new Error(`未在 ${PLATFORMS_PATH} 找到 VERSION 常量`);
  }
  fs.writeFileSync(PLATFORMS_PATH, updated);
}

/**
 * 对 semver 版本号做 minor bump 的纯计算（无 I/O，便于单元测试）
 *
 * 规则：中位 minor +1，末位 patch 归零。例如 0.2.3 → 0.3.0（不是 0.3.3）。
 * 这样 minor 版本永远是「该二进制版本的第一个发布」，patch 位干净地记录
 * 「这个二进制版本下又改了几次入口包」。
 *
 * @param {string} version - 形如 X.Y.Z 的纯数字版本号
 * @returns {string} bump 后的版本号
 * @throws {Error} 格式非 X.Y.Z 或含非数字时抛错
 */
function bumpMinor(version) {
  const parts = version.split('.');
  if (parts.length !== 3 || parts.some(p => !/^\d+$/.test(p))) {
    throw new Error(`版本号格式应为 X.Y.Z（纯数字），实际: ${version}`);
  }
  parts[1] = String(Number(parts[1]) + 1);
  parts[2] = '0';
  return parts.join('.');
}

/**
 * 对根 package.json 的 version 做 minor bump（中位 +1、末位归零）并写回
 *
 * 用于上游二进制升级时连带发 npm 新版。按 semver 约定，二进制功能更新属于
 * 「向后兼容的功能变化」，对应 minor 升级；这样用户从版本号即可判断是否包含
 * 新二进制（patch 表示仅入口包代码改动，minor 表示二进制更新）。
 *
 * @param {string} currentVersion - 当前 npm 版本号，形如 0.1.0
 * @returns {string} bump 后的新版本号，形如 0.2.0
 */
function minorBumpNpmVersion(currentVersion) {
  const newVersion = bumpMinor(currentVersion);
  const pkg = JSON.parse(fs.readFileSync(ROOT_PKG_PATH, 'utf8'));
  pkg.version = newVersion;
  fs.writeFileSync(ROOT_PKG_PATH, JSON.stringify(pkg, null, 2) + '\n');
  return newVersion;
}

/**
 * 同步执行 npm script，继承 stdio（便于实时观察子进程输出）
 *
 * @param {string} script - package.json scripts 中的键名，如 update-lock
 * @param {string[]} extraArgs - 透传给脚本的额外参数，会拼接到 -- 之后
 */
function runScript(script, extraArgs = []) {
  const cmd = `npm run ${script}${extraArgs.length ? ' -- ' + extraArgs.join(' ') : ''}`;
  console.log(`  $ ${cmd}`);
  execSync(cmd, { cwd: ROOT, stdio: 'inherit' });
}

async function main() {
  // ── 步骤 1：确定目标版本 ──────────────────────────────────
  // 优先用 --target 指定的版本；未指定则查询上游最新正式 release
  let tag = TARGET;
  if (!tag) {
    console.log('[1/5] 未指定 --target，查询上游最新 release...');
    tag = await fetchLatestReleaseTag(process.env.GITHUB_TOKEN || '');
    console.log(`      上游最新 release: ${tag}`);
  } else {
    console.log(`[1/5] 使用指定版本: ${tag}`);
    // 校验版本号格式，避免拼出错误的下载 URL
    if (!/^v\d+\.\d+\.\d+/.test(tag)) {
      throw new Error(`版本号格式应为 vX.Y.Z，实际: ${tag}`);
    }
  }

  // ── 步骤 2：幂等检查 ──────────────────────────────────────
  // 若 platforms.js 已是该版本，说明二进制已是最新，无需重复升级（避免无谓下载）
  const current = currentPlatformsVersion();
  console.log(`[2/5] 检查当前二进制版本（platforms.js VERSION = '${current}'）...`);
  if (current === tag) {
    console.log(`      ⏭️  二进制已是 ${tag}，无需升级`);
    process.exit(2); // 退出码 2 表示跳过，区别于成功(0)与失败(1)
  }
  console.log(`      ${current} → ${tag}，继续升级`);

  // ── 步骤 3：更新二进制版本常量 ────────────────────────────
  // 改 platforms.js 的 VERSION，作为下载新二进制的 release tag 来源
  console.log('[3/5] 更新上游二进制版本号...');
  updatePlatformsVersion(tag);
  console.log(`      platforms.js VERSION = '${tag}'`);

  // ── 步骤 4：刷新 SHA256 锁 ────────────────────────────────
  // update-lock 会重新下载各平台 archive 并写入新哈希到 binaries.lock.json
  // 这一步是发布前的完整性保障：CI 发布时会用锁文件校验下载的二进制
  console.log('[4/5] 刷新 binaries.lock.json（下载二进制并计算 SHA256）...');
  runScript('update-lock');

  // ── 步骤 5：minor bump npm 版本并同步子包 ─────────────────
  // 上游发新版 → 下游必发新版：二进制行为已变，npm 包必须跟着发新版，
  // 否则用户无法拿到新二进制。按 semver 约定，二进制功能更新对应 minor 升级，
  // 用户从版本号即可判断是否含新二进制（patch=仅入口包改动，minor=二进制更新）。
  const oldNpmVersion = JSON.parse(fs.readFileSync(ROOT_PKG_PATH, 'utf8')).version;
  const newNpmVersion = minorBumpNpmVersion(oldNpmVersion);
  console.log(`[5/5] npm 版本 minor bump: ${oldNpmVersion} → ${newNpmVersion}`);
  runScript('sync-packages');

  // ── 完成：提示后续操作 ────────────────────────────────────
  console.log(`\n✅ 升级完成:`);
  console.log(`   上游二进制版本: ${current} → ${tag}`);
  console.log(`   npm 包版本:     ${oldNpmVersion} → ${newNpmVersion}`);
  console.log('');
  console.log('   下一步：检查改动并提交带 [publish] 的 commit 触发发布：');
  console.log('     git add -A');
  console.log(`     git commit -m "chore(release): ${newNpmVersion} [publish]"`);
  console.log('     git push');
}

// 导出纯计算函数供单元测试使用（require 时不触发 main，见下方判断）
module.exports = { bumpMinor };

// 仅在直接运行本文件时执行主流程（require 时不执行）
if (require.main === module) {
  main().catch(err => {
    console.error('\n❌ 自动升级失败:', err.message);
    process.exit(1);
  });
}
