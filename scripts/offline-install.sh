#!/usr/bin/env bash
# * =====================================================
# * Copyright © sumu. 2022-present. All rights reserved.
# * File name  : offline-install.sh
# * Author     : sumu
# * Date       : 2026/08/02
# * Description: 把 cmdsift 离线包直接装到全局 npm 目录。
# *              复刻 `npm install -g` 的两步（复制包到 node_modules + 建 bin 软链接），
# *              但不触发任何 npm 生命周期脚本、不依赖网络，绕开离线/内网环境的安装问题。
# *
# *              cmdsift 是 monorepo 架构：入口包 @smai-kit/cmdsift（纯 JS）
# *              + 平台子包 @smai-kit/cmdsift-<os>-<cpu>（含二进制）。
# *              本脚本同时安装这两个包到全局 node_modules/@smai-kit/ 下，
# *              并在全局 bin 目录创建 cmdsift 软链接指向入口包的 lib/cli.js。
# *
# *              离线包目录结构：
# *              cmdsift-offline-<version>-<os>-<cpu>/
# *              ├── offline-install.sh        ← 本脚本
# *              ├── cmdsift/                   ← 入口包（lib/ + package.json + ...）
# *              └── cmdsift-<os>-<cpu>/        ← 平台子包（bin/ + package.json + ...）
# *
# * Usage      :
# *              bash offline-install.sh
# *              bash offline-install.sh /path/to/cmdsift-offline-<version>-<os>-<cpu>
# *              bash offline-install.sh uninstall
# * ======================================================

set -euo pipefail

# 脚本路径
# ========================================================
SCRIPT_ABSOLUTE_PATH=$(cd "$(dirname "${0}")" && pwd)

# 颜色和日志标识
# ========================================================
step() {
    echo -e "\e[96m➤  $@\e[0m"
}

warning() {
    echo -n "⚠️  "
    echo -e "\e[33m$@\e[0m"
}

error() {
    echo -n "❌ "
    echo -e "\e[31m$@\e[0m"
}

success() {
    echo -n "✅ "
    echo -e "\e[32m$@\e[0m"
}

info() {
    echo -ne "\e[32mℹ️ [INFO]\e[0m"
    echo -e "\e[0m$@\e[0m"
}

# sudo 密码配置（与 file-utils-mcp-toolkit 保持一致）
SUDO_PASSWORD="000000"

# 带命令回显的执行函数
execute() {
    printf '\e[95m[CMD] %s\e[0m\n' "$*" >&2

    if [ "$1" = "sudo" ]; then
        shift
        if [ "$(id -u)" -eq 0 ]; then
            printf '\e[33m[SUDO] Already root, skip sudo\e[0m\n' >&2
            "$@"
        else
            printf '\e[33m[SUDO] Auto elevating privileges\e[0m\n' >&2
            echo "$SUDO_PASSWORD" | sudo -S "$@" 2>&1
        fi
    else
        "$@"
    fi
    local ret=$?
    if [ $ret -ne 0 ]; then
        printf '\e[31m❌ Command failed (exit code: %d): %s\e[0m\n' "$ret" "$*" >&2
        return $ret
    fi
    return 0
}

# ========================================================
# 常量
# ========================================================

# 入口包名与 bin 命令名（与 package.json 一致）
ENTRY_PKG_NAME="@smai-kit/cmdsift"
ENTRY_BIN="cmdsift"
# 入口包 bin 入口（相对包根）
ENTRY_BIN_REL="lib/cli.js"

# 卸载模式用到的平台子包短名列表（用于清理）
PLATFORM_SHORT_NAMES="cmdsift-linux-x64 cmdsift-win32-x64"

# ========================================================
# 参数解析
# ========================================================

SRC_DIR=""
ACTION=""

if [ "${1:-}" = "uninstall" ]; then
    ACTION="uninstall"
elif [ -n "${1:-}" ]; then
    ACTION="install"
    SRC_DIR="$(cd "$1" && pwd)"
else
    ACTION="install"
    SRC_DIR="$SCRIPT_ABSOLUTE_PATH"
fi

# ========================================================
# 检查依赖（node / npm）
# ========================================================
check_dependencies() {
    step "checking dependencies..."

    if ! command -v node &>/dev/null; then
        error "node is not installed!"
        info "please install Node.js first"
        return 1
    fi
    success "node $(node --version) found"

    if ! command -v npm &>/dev/null; then
        error "npm is not installed!"
        return 1
    fi
    success "npm $(npm --version) found"

    return 0
}

# ========================================================
# 读取入口包 package.json，计算安装路径
# ========================================================
read_package_info() {
    step "reading package info..."

    local entry_json="$SRC_DIR/cmdsift/package.json"
    if [ ! -f "$entry_json" ]; then
        error "$entry_json does not exist"
        info "请确保离线包目录下有 cmdsift/ 子目录（入口包）"
        info "或通过参数指定离线包目录: bash offline-install.sh <offline-dir>"
        return 1
    fi

    # 从入口包 package.json 读取 name / bin（容错：bin 可能是对象或字符串）
    ENTRY_NAME="$(node -p "require('$entry_json').name")"
    local bin_field
    bin_field="$(node -p "const b=require('$entry_json').bin; typeof b==='string'?b:Object.keys(b).reduce((a,k)=>a||b[k],'')")"
    ENTRY_BIN_REL="${bin_field#./}"

    # 全局目录
    PREFIX="$(npm prefix -g 2>/dev/null)"
    ROOT_G="$(npm root -g 2>/dev/null)"
    SCOPE="$(dirname "$ENTRY_NAME")"          # @smai-kit
    ENTRY_BASE="$(basename "$ENTRY_NAME")"     # cmdsift
    DEST_ENTRY="$ROOT_G/$SCOPE/$ENTRY_BASE"    # 全局 node_modules 下的入口包路径
    BIN_DIR="$PREFIX/bin"                       # 全局 bin

    # 平台子包目录：遍历 SRC_DIR 下的 cmdsift-<os>-<cpu> 目录
    PLATFORM_PKGS=()
    for dir in "$SRC_DIR"/cmdsift-*-x64; do
        [ -d "$dir" ] || continue
        local name
        name="$(node -p "require('$dir/package.json').name")"
        local base
        base="$(basename "$name")"
        PLATFORM_PKGS+=("$name:$base:$dir")
    done

    if [ "${#PLATFORM_PKGS[@]}" -eq 0 ]; then
        error "未在 $SRC_DIR 下找到平台子包目录（cmdsift-<os>-<cpu>）"
        info "离线包应同时包含入口包 cmdsift/ 和至少一个平台子包目录"
        return 1
    fi

    info "源目录      : $SRC_DIR"
    info "入口包      : $ENTRY_NAME"
    info "全局 prefix : $PREFIX"
    info "安装入口到  : $DEST_ENTRY"
    info "bin symlink : $BIN_DIR/$ENTRY_BIN -> $DEST_ENTRY/$ENTRY_BIN_REL"
    info "平台子包    : ${#PLATFORM_PKGS[@]} 个"
    for pkg in "${PLATFORM_PKGS[@]}"; do
        info "  - ${pkg%%:*}"
    done

    return 0
}

# ========================================================
# 权限检查
# ========================================================
check_permission() {
    step "checking write permission on $PREFIX ..."

    if [ ! -w "$PREFIX" ]; then
        error "$PREFIX is not writable"
        info "using nvm: reopen terminal or source nvm then retry"
        info "system npm: run with sudo bash offline-install.sh"
        return 1
    fi

    success "permission OK"
    return 0
}

# ========================================================
# 清理旧版（入口包 + 所有平台子包）
# ========================================================
clean_old_version() {
    step "cleaning previous install..."

    # 清理入口包
    if [ -e "$DEST_ENTRY" ]; then
        execute rm -rf "$DEST_ENTRY" || return 1
        info "removed $DEST_ENTRY"
    fi

    # 清理所有平台子包
    for pkg in "${PLATFORM_PKGS[@]}"; do
        local base
        base="$(echo "$pkg" | cut -d: -f2)"
        local dest="$ROOT_G/$SCOPE/$base"
        if [ -e "$dest" ]; then
            execute rm -rf "$dest" || return 1
            info "removed $dest"
        fi
    done

    success "previous install cleaned"
    return 0
}

# ========================================================
# 复制入口包与平台子包到全局 node_modules
# ========================================================
copy_files() {
    step "copying entry package and platform packages..."

    execute mkdir -p "$DEST_ENTRY" || return 1

    # 复制入口包：lib/ package.json LICENSE README.md（按 files 字段，只复制存在的）
    local item
    for item in lib package.json LICENSE README.md; do
        if [ -e "$SRC_DIR/cmdsift/$item" ]; then
            execute cp -a "$SRC_DIR/cmdsift/$item" "$DEST_ENTRY/" || return 1
        fi
    done

    # 复制各平台子包：bin/ package.json LICENSE README.md
    for pkg in "${PLATFORM_PKGS[@]}"; do
        local base src_dir
        base="$(echo "$pkg" | cut -d: -f2)"
        src_dir="$(echo "$pkg" | cut -d: -f3)"
        local dest="$ROOT_G/$SCOPE/$base"
        execute mkdir -p "$dest" || return 1
        for item in bin package.json LICENSE README.md; do
            if [ -e "$src_dir/$item" ]; then
                execute cp -a "$src_dir/$item" "$dest/" || return 1
            fi
        done

        # Linux 平台：确保二进制有可执行权限
        local binary="$dest/bin/cmdsift"
        if [ -f "$binary" ]; then
            execute chmod +x "$binary" 2>/dev/null || true
        fi
    done

    # 入口包 cli.js 也加可执行权限（虽然通过 node 调起，保持一致性）
    if [ -f "$DEST_ENTRY/$ENTRY_BIN_REL" ]; then
        execute chmod +x "$DEST_ENTRY/$ENTRY_BIN_REL" 2>/dev/null || true
    fi

    success "files copied"
    return 0
}

# ========================================================
# 创建 bin 软链接（相对路径，对齐 npm i -g 行为）
# ========================================================
create_bin_symlink() {
    step "creating bin symlink..."

    local target="$DEST_ENTRY/$ENTRY_BIN_REL"
    local link="$BIN_DIR/$ENTRY_BIN"
    local rel_target

    # 优先用 realpath --relative-to，失败则手工拼
    if command -v realpath &>/dev/null; then
        rel_target="$(realpath --relative-to="$BIN_DIR" "$target" 2>/dev/null || true)"
    fi
    if [ -z "${rel_target:-}" ]; then
        rel_target="../lib/node_modules/$SCOPE/$ENTRY_BASE/$ENTRY_BIN_REL"
    fi

    execute mkdir -p "$BIN_DIR" || return 1

    # 清理旧链接
    if [ -e "$link" ] || [ -L "$link" ]; then
        execute rm -f "$link" || return 1
    fi

    execute ln -s "$rel_target" "$link" || return 1

    success "symlink created: $link -> $rel_target"
    return 0
}

# ========================================================
# 安装
# ========================================================
do_install() {
    check_dependencies || return 1
    read_package_info || return 1
    check_permission || return 1
    clean_old_version || return 1
    copy_files || return 1
    create_bin_symlink || return 1

    # 刷新命令哈希表
    hash -r 2>/dev/null || true

    success "install completed"
    return 0
}

# ========================================================
# 卸载（不依赖源目录，用常量算路径）
# ========================================================
do_uninstall() {
    step "uninstalling $ENTRY_PKG_NAME ..."

    PREFIX="$(npm prefix -g 2>/dev/null)"
    ROOT_G="$(npm root -g 2>/dev/null)"
    SCOPE="$(dirname "$ENTRY_PKG_NAME")"
    ENTRY_BASE="$(basename "$ENTRY_PKG_NAME")"
    DEST_ENTRY="$ROOT_G/$SCOPE/$ENTRY_BASE"
    BIN_DIR="$PREFIX/bin"

    # 1. 删除入口包
    if [ -e "$DEST_ENTRY" ]; then
        step "removing $DEST_ENTRY ..."
        execute rm -rf "$DEST_ENTRY" || warning "failed to remove $DEST_ENTRY"
    else
        info "entry package not found: $DEST_ENTRY"
    fi

    # 2. 删除所有平台子包
    for short_name in $PLATFORM_SHORT_NAMES; do
        local dest="$ROOT_G/$SCOPE/$short_name"
        if [ -e "$dest" ]; then
            step "removing $dest ..."
            execute rm -rf "$dest" || warning "failed to remove $dest"
        fi
    done

    # 3. 删除 bin 软链接
    local link="$BIN_DIR/$ENTRY_BIN"
    if [ -e "$link" ] || [ -L "$link" ]; then
        step "removing symlink $link ..."
        execute rm -f "$link" || warning "failed to remove $link"
    else
        info "symlink not found: $link"
    fi

    hash -r 2>/dev/null || true
    success "uninstall done."
    return 0
}

# ========================================================
# 显示版本信息
# ========================================================
show_version() {
    echo ""
    echo -e "cmdsift:"
    if command -v "$ENTRY_BIN" &>/dev/null; then
        info "found at: $(command -v "$ENTRY_BIN")"
        # 尝试执行 --help 验证二进制可用
        if "$ENTRY_BIN" --help >/dev/null 2>&1; then
            success "cmdsift --help 执行成功"
        else
            warning "cmdsift --help 退出码非 0（可能是正常行为，取决于 cmdsift 实现）"
        fi
    else
        warning "$ENTRY_BIN not found in PATH"
    fi
    echo ""
    echo -e "运行 $ENTRY_BIN --help 查看用法"
}

# ========================================================
# 打印菜单
# ========================================================
do_echo_menu() {
    echo "================================================="
    echo -e "    cmdsift offline installer"
    echo "================================================="
    echo -e "ACTION              : ${ACTION}"
    echo -e "ENTRY_PKG_NAME      : ${ENTRY_PKG_NAME}"
    echo -e "ENTRY_BIN           : ${ENTRY_BIN}"
    echo -e "SRC_DIR             : ${SRC_DIR:-<none>}"
    echo -e "SCRIPT_ABSOLUTE_PATH: ${SCRIPT_ABSOLUTE_PATH}"
    echo ""
    echo "================================================="
}

# ========================================================
# 主流程
# ========================================================
do_echo_menu "$@"

if [ "$ACTION" = "uninstall" ]; then
    do_uninstall
else
    do_install || exit 1
    show_version
fi

exit $?
