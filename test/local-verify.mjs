// @ts-check
/**
 * =====================================================
 * Copyright © sumu. 2022-present. Tech. Co., Ltd. All rights reserved.
 * File name  : local-verify.mjs
 * Author     : sumu
 * Date       : 2026/08/01
 * Version    : 0.1.0
 * Description: 本地修改后验证脚本（无需发布、不依赖 npm registry）
 *
 *              模拟「其他项目安装 @smai-kit/cmdsift」的完整链路，但全部基于
 *              本地 npm pack 出的 tarball，因此每次修改 packages/cmdsift/lib/
 *              后即可立即验证，不需要发布到 npm。
 *
 *              验证链路：
 *                1. 入口包、当前平台子包各自 npm pack 成 tarball（含最新代码）
 *                2. 在隔离临时目录用 npm install <tarball> 安装（真实安装行为）
 *                3. 断言安装结果、平台分发、路径解析、二进制可执行、双模导入
 *
 *              前提：当前平台子包的 bin/ 已由 prepare-binaries 填充。
 *              未填充时本脚本会提示并退出，不会误报失败。
 *
 *              运行：npm run verify
 * =====================================================
 */

import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, access, readFile, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

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
 * 同步执行 shell 命令
 * @param {string} cmd
 * @param {string[]} args
 * @param {object} [opts]
 * @returns {string} stdout
 */
function run(cmd, args, opts) {
  return execFileSync(cmd, args, {
    cwd: opts?.cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: opts?.timeout ?? 120000,
  });
}

/**
 * 判断路径是否存在
 * @param {string} p
 */
async function exists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * 当前宿主平台对应的子包名、二进制文件名、子包目录名
 */
function hostPlatformInfo() {
  const arch = process.arch;
  const pkg = `@smai-kit/cmdsift-${process.platform}-${arch}`;
  const binary = process.platform === 'win32' ? 'cmdsift.exe' : 'cmdsift';
  const shortName = `cmdsift-${process.platform}-${arch}`;
  return { pkg, binary, shortName };
}

/**
 * 对指定子包执行 npm pack，返回生成的 tarball 绝对路径
 * @param {string} pkgDir 子包目录（如 packages/cmdsift）
 * @param {string} destDir tarball 输出目录
 * @returns {string} tarball 绝对路径
 */
function packPackage(pkgDir, destDir) {
  // --pack-destination 控制输出位置，stdout 输出文件名
  const out = run('npm', ['pack', '--pack-destination', destDir], { cwd: pkgDir });
  const filename = out.trim().split('\n').pop()?.trim();
  if (!filename) throw new Error(`npm pack ${pkgDir} 未输出文件名`);
  return path.join(destDir, filename);
}

// ─────────────────────────────────────────────────────────────
// 主流程
// ─────────────────────────────────────────────────────────────

async function main() {
  console.log('════════ 本地修改后验证（无需发布）════════');
  console.log(`宿主平台: ${process.platform}-${process.arch}`);

  const { pkg: platformPkg, binary: binaryName, shortName } = hostPlatformInfo();
  const ROOT = path.resolve(import.meta.dirname, '..');
  const ENTRY_DIR = path.join(ROOT, 'packages/cmdsift');
  const PLATFORM_DIR = path.join(ROOT, 'packages', shortName);

  // ── 前置检查 1：入口包源码存在 ──
  if (!(await exists(path.join(ENTRY_DIR, 'lib/index.js')))) {
    fail('入口包源码缺失', `找不到 ${path.relative(ROOT, ENTRY_DIR)}/lib/index.js`);
    return finish();
  }

  // ── 前置检查 2：当前平台子包的二进制已填充 ──
  const binPath = path.join(PLATFORM_DIR, 'bin', binaryName);
  if (!(await exists(binPath))) {
    console.log(`\n⚠ 当前平台子包的二进制未填充: ${path.relative(ROOT, binPath)}`);
    console.log('  请先执行以下命令生成二进制，再运行本验证：');
    console.log(`    npm run prepare-binaries:${shortName.replace('cmdsift-', '')}`);
    return finish();
  }

  // 工作目录：建在仓库内的 tmp/ 下（已加入 .gitignore），保留以便事后排查
  // 每次运行用时间戳唯一命名，多次运行的产物互不覆盖
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const tmpRoot = path.join(ROOT, 'test', 'tmp', `verify-${stamp}`);
  // mkdtemp 只创建最后一级目录，需先递归创建父目录
  await mkdir(tmpRoot, { recursive: true });
  const packDir = await mkdtemp(path.join(tmpRoot, 'pack-'));
  const consumerDir = await mkdtemp(path.join(tmpRoot, 'consumer-'));
  console.log(`tarball 目录: ${packDir}`);
  console.log(`消费项目目录: ${consumerDir}\n`);

  try {
    // ── 用例 1：打包入口包 tarball ─────────────────────────
    console.log('── 用例 1：入口包 npm pack 成 tarball ──');
    let entryTgz;
    try {
      entryTgz = packPackage(ENTRY_DIR, packDir);
      const pkgJson = JSON.parse(await readFile(path.join(ENTRY_DIR, 'package.json'), 'utf8'));
      pass(`入口包打包成功: ${path.basename(entryTgz)}（版本 ${pkgJson.version}）`);
    } catch (err) {
      fail('入口包 npm pack 应成功', err.message);
      return finish();
    }

    // ── 用例 2：打包当前平台子包 tarball ───────────────────
    console.log('\n── 用例 2：当前平台子包 npm pack 成 tarball ──');
    let platformTgz;
    try {
      platformTgz = packPackage(PLATFORM_DIR, packDir);
      pass(`平台子包打包成功: ${path.basename(platformTgz)}`);
    } catch (err) {
      fail(`平台子包 ${platformPkg} npm pack 应成功`, err.message);
      return finish();
    }

    // ── 用例 3：tarball 内容包含必要文件 ───────────────────
    console.log('\n── 用例 3：tarball 内容包含 lib/ 与 bin/ ──');
    try {
      const entryContents = run('tar', ['-tzf', entryTgz]).split('\n');
      const platformContents = run('tar', ['-tzf', platformTgz]).split('\n');
      const entryHasLib = entryContents.some((f) => f.includes('lib/index.js'));
      const platformHasBin = platformContents.some((f) => f.includes(`bin/${binaryName}`));
      if (entryHasLib && platformHasBin) {
        pass('入口包含 lib/index.js，平台子包含 bin/' + binaryName);
      } else {
        fail('tarball 内容缺失', `入口含lib=${entryHasLib}, 平台含bin=${platformHasBin}`);
      }
    } catch (err) {
      fail('检查 tarball 内容失败', err.message);
    }

    // ── 用例 4：在消费项目安装两个本地 tarball ──────────────
    console.log('\n── 用例 4：消费项目 npm install 本地 tarball ──');
    try {
      await writeFile(
        path.join(consumerDir, 'package.json'),
        JSON.stringify({ name: 'local-consumer', version: '0.0.0', private: true }, null, 2),
      );
      run('npm', ['install', entryTgz, platformTgz, '--force', '--no-audit', '--no-fund'], {
        cwd: consumerDir,
        timeout: 120000,
      });
      pass('安装本地 tarball 成功');
    } catch (err) {
      fail('消费项目安装 tarball 应成功', err.message);
      return finish();
    }

    // ── 用例 5：入口包与平台子包均已进入 node_modules ──────
    console.log('\n── 用例 5：入口包与平台子包均安装到位 ──');
    const entryInstalled = await exists(path.join(consumerDir, 'node_modules/@smai-kit/cmdsift/package.json'));
    const platformInstalled = await exists(path.join(consumerDir, `node_modules/${platformPkg}/package.json`));
    if (entryInstalled && platformInstalled) {
      pass(`@smai-kit/cmdsift 与 ${platformPkg} 均已安装`);
    } else {
      fail('两个包应均存在于 node_modules', `入口=${entryInstalled}, 平台=${platformInstalled}`);
    }

    // ── 用例 6：平台子包 bin/ 二进制存在 ───────────────────
    console.log(`\n── 用例 6：平台子包 bin/${binaryName} 二进制存在 ──`);
    const installedBin = path.join(consumerDir, `node_modules/${platformPkg}/bin/${binaryName}`);
    if (await exists(installedBin)) {
      const st = await stat(installedBin);
      if (st.size > 0) {
        pass(`二进制存在且非空（${Math.round(st.size / 1024)} KB）`);
      } else {
        fail('二进制应为非空文件', `大小: ${st.size}`);
      }
    } else {
      fail(`二进制 bin/${binaryName} 应存在`, installedBin);
    }

    // ── 用例 7：入口包 cmdsiftPath 解析到正确路径 ──────────
    console.log('\n── 用例 7：cmdsiftPath 解析到平台子包的二进制 ──');
    let cmdsiftPath = '';
    try {
      cmdsiftPath = run(
        'node',
        ['-e', `import('@smai-kit/cmdsift').then(m=>process.stdout.write(m.cmdsiftPath))`],
        { cwd: consumerDir },
      ).trim();
      const normalized = cmdsiftPath.replace(/\\/g, '/');
      const expectedSubstr = `node_modules/${platformPkg}/bin/${binaryName}`;
      if (normalized.includes(expectedSubstr)) {
        pass(`cmdsiftPath 解析正确: ${path.relative(consumerDir, cmdsiftPath) || cmdsiftPath}`);
      } else {
        fail(`路径应包含 ${expectedSubstr}`, `实际: ${cmdsiftPath}`);
      }
    } catch (err) {
      fail('cmdsiftPath 解析应成功', err.message);
    }

    // ── 用例 8：执行二进制 --help，正常退出有输出 ─────────────
    // 注意：cmdsift 不带子命令时以非零码退出（missing command），故用 --help 验证可执行性
    console.log('\n── 用例 8：通过 child_process 执行二进制（--help）──');
    if (cmdsiftPath) {
      try {
        const stdout = run(
          'node',
          [
            '-e',
            [
              `import('@smai-kit/cmdsift').then(async m=>{`,
              `  const {execFile}=await import('node:child_process');`,
              `  const {promisify}=await import('node:util');`,
              `  const x=promisify(execFile);`,
              `  try{const{stdout}=await x(m.cmdsiftPath,['--help'],{timeout:5000});process.stdout.write(stdout);}`,
              `  catch(e){process.stderr.write(String(e.message));process.exit(1);}`,
              `})`,
            ].join('\n'),
          ],
          { cwd: consumerDir, timeout: 15000 },
        ).trim();
        if (stdout.length > 0) {
          pass(`二进制执行成功，stdout 有输出（${JSON.stringify(stdout)}）`);
        } else {
          fail('二进制执行应有 stdout 输出', 'stdout 为空');
        }
      } catch (err) {
        fail('二进制执行应退出码 0', err.message);
      }
    } else {
      fail('执行二进制', '前置 cmdsiftPath 解析失败');
    }

    // ── 用例 9：ESM 与 CJS 双模导入均可用 ──────────────────
    console.log('\n── 用例 9：ESM 与 CJS 双模导入均返回 cmdsiftPath ──');
    try {
      const esmType = run(
        'node',
        ['-e', `import('@smai-kit/cmdsift').then(m=>process.stdout.write(typeof m.cmdsiftPath))`],
        { cwd: consumerDir },
      ).trim();
      const cjsType = run(
        'node',
        ['-e', `const m=require('@smai-kit/cmdsift');process.stdout.write(typeof m.cmdsiftPath)`],
        { cwd: consumerDir },
      ).trim();
      if (esmType === 'string' && cjsType === 'string') {
        pass('ESM 与 CJS 导入均返回 string 类型的 cmdsiftPath');
      } else {
        fail('两种导入都应返回 string', `ESM=${esmType}, CJS=${cjsType}`);
      }
    } catch (err) {
      fail('双模导入应可用', err.message);
    }
  } catch (err) {
    // 外层兜底：任意步骤抛错都不应让脚本静默退出
    fail('验证流程异常', err.message);
  }

  // 临时目录保留在 tmp/ 下（已加入 .gitignore），便于事后排查
  console.log(`\n（临时产物保留于: ${path.relative(ROOT, packDir)}）`);
  return finish();
}

function finish() {
  console.log('\n────────────────────────────────────');
  console.log(`结果: ${passed} 通过, ${failed} 失败`);
  console.log('────────────────────────────────────');
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('\n验证脚本异常退出:', err);
  process.exit(1);
});
