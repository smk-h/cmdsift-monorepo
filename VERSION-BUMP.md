<!-- more -->

## 一、 概述

本 monorepo 以 lockstep 方式发布 3 个 npm 包，它们共享同一个版本号（取自根 [`package.json`](package.json)）：

- `@smai-kit/cmdsift` —— 入口包（JS 路径解析器，位于 [`packages/cmdsift/`](packages/cmdsift/)）
- `@smai-kit/cmdsift-<os>-<cpu>` —— 各平台二进制子包（位于 [`packages/`](packages/)）

二进制文件不在本仓库内，发布时由 [`build/prepare-binaries.js`](build/prepare-binaries.js) 从上游 [`smk-h/cmdsift`](https://github.com/smk-h/cmdsift) 的 GitHub Release 下载并做 SHA256 校验。

【**注意**】

升级版本时只需手动改两处真相源（二进制版本常量 + npm 包版本号），其余哈希锁与子包清单全部由脚本自动生成，**禁止手填**。

## 二、 升级 cmdsift 二进制版本

当上游 `smk-h/cmdsift` 发布了新的 GitHub Release（如 `v0.2.0`）时使用本流程。

### 1. 修改上游版本常量

编辑 [`build/platforms.js`](build/platforms.js) 的 `VERSION` 常量，指向新的 release tag：

```js
// build/platforms.js
const VERSION = 'v0.2.0';
```

`VERSION` 是上游二进制版本的唯一真相源，`prepare-binaries.js` 和 `sync-packages.js` 都从它读取下载 URL。

### 2. 修改 npm 包版本号

编辑根 [`package.json`](package.json) 的 `version` 字段（如 `0.1.0` → `0.2.0`）。由于二进制发生了变更，应按 semver 语义决定是 major 还是 minor 升级：

- 不兼容改动：升 major
- 向后兼容的新功能：升 minor

### 3. 刷新哈希锁文件

运行下面的脚本，它会下载各平台 archive、计算 SHA256 并重写 [`binaries.lock.json`](binaries.lock.json)：

```sh
npm run update-lock
```

该脚本需要访问 GitHub Releases，建议设置 `GITHUB_TOKEN` 以避免匿名 API 限流：

```sh
GITHUB_TOKEN=<your-token> npm run update-lock
```

如需只更新单个平台，可加 `--target` 参数：

```sh
npm run update-lock:linux-x64
npm run update-lock:win32-x64
```

### 4. 同步子包清单

运行下面的脚本，把根版本号同步到所有子包的 `package.json` 及入口包的 `optionalDependencies`：

```sh
npm run sync-packages
```

该脚本是幂等的，重复运行不会产生多余 diff。

### 5. 提交并发布

需要提交的文件包括：

- [`build/platforms.js`](build/platforms.js)（新版本常量）
- 根 [`package.json`](package.json)（新 npm 版本号）
- [`binaries.lock.json`](binaries.lock.json)（新 SHA256）
- 所有由 `sync-packages` 重新生成的 [`packages/`](packages/) 下的 `package.json`、`README.md`、`LICENSE`

提交信息中带上 `[publish]` 关键字即可触发 CNB 发布流水线：

```sh
git commit -m "release: v0.2.0 [publish]"
```

## 三、 仅发布入口包代码改动

当只改动了 [`packages/cmdsift/lib/`](packages/cmdsift/lib/) 下的 JS 代码（如修复 README、调整路径解析逻辑），不涉及上游二进制升级时使用本流程。

### 1. 修改 npm 包版本号

只需编辑根 [`package.json`](package.json) 的 `version` 字段（通常是 patch 升级，如 `0.1.0` → `0.1.1`）。

【**注意**】

此场景**不需要**修改 [`build/platforms.js`](build/platforms.js)，也**不需要**运行 `update-lock`。

### 2. 同步并提交

```sh
npm run sync-packages
git add -A
git commit -m "release: v0.1.1 [publish]"
```

## 四、 添加新平台

当需要支持新的 OS/CPU 组合时使用本流程。

### 1. 新增平台映射

在 [`build/platforms.js`](build/platforms.js) 的 `platforms` 数组中追加一项：

```js
// build/platforms.js
const platforms = [
  { os: 'win32', cpu: 'x64', target: 'x86_64-pc-windows-msvc', version: VERSION },
  { os: 'linux', cpu: 'x64', target: 'x86_64-unknown-linux-musl', version: VERSION },
  { os: 'darwin', cpu: 'arm64', target: 'aarch64-apple-darwin', version: VERSION }, // 新增
];
```

其中 `target` 为对应的 Rust 编译三元组（triple），必须与上游 release asset 的命名一致。

### 2. 填充哈希锁

```sh
npm run update-lock:<新平台的 short name>
```

或直接运行全量 `npm run update-lock` 为新平台补上 SHA256。

### 3. 生成子包目录

```sh
npm run sync-packages
```

该脚本会自动创建 [`packages/cmdsift-<os>-<cpu>/`](packages/) 目录及其 `package.json`、`README.md`、`LICENSE`。

### 4. 更新发布流水线

在 [`.cnb/workflows/npm-publish.yml`](.cnb/workflows/npm-publish.yml) 中复制一个现有的平台发布阶段，替换其中的包名和 workspace 参数。

### 5. 升级版本并提交

按「升级二进制版本」流程的第 2、4、5 步操作：改根版本号、`sync-packages`、提交带 `[publish]` 的 commit。

## 五、 CI 发布流水线行为

发布流水线定义在 [`.cnb/workflows/npm-publish.yml`](.cnb/workflows/npm-publish.yml)，由提交信息包含 `[publish]` 触发，依次执行以下阶段：

1. `npm ci --force` 安装依赖（`--force` 用于跳过非宿主平台子包的 os/cpu 校验，这是 workspace 模式下的正常现象，无副作用）
2. `npm run sync-packages` 保证发布的清单与提交的根版本一致（即便开发者本地忘了运行也无妨）
3. `npm run prepare-binaries` 下载并 SHA256 校验二进制
4. 依次发布平台子包（`linux-x64`、`win32-x64`），最后发布入口包 `@smai-kit/cmdsift`

【**发布顺序**】

平台子包必须先于入口包发布，因为入口包的 `optionalDependencies` 指向它们——若顺序颠倒，用户在安装入口包时会因找不到平台子包而报错。

每个发布阶段都内置了幂等保护：发布前先用 `npm view` 查询目标版本是否已存在，已存在则跳过该包，避免重试时触发 `EPUBLISHCONFLICT`。

## 六、 发布前本地验证

```sh
# 1. 确保所有子包清单与根版本同步
npm run sync-packages

# 2. 下载当前宿主平台的二进制（以 Windows x64 为例）
node build/prepare-binaries.js --target x86_64-pc-windows-msvc

# 3. 安装 workspace 并验证入口包能解析到同仓的兄弟子包
#    --force 用于跳过非宿主平台包的 os/cpu 校验（无害）
npm install --force

# 4. 验证解析路径
node -e "import('@smai-kit/cmdsift').then(m => console.log(m.cmdsiftPath))"
```

输出的路径应位于 [`packages/cmdsift-<你的os>-<你的cpu>/bin/`](packages/) 下。

---
*本文档由 markdowncli 技能辅助生成*
