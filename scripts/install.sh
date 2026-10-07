#!/bin/sh
# One-line install: find a Node, fetch `install.mjs`, hand over to it.
#
# This is the part that has to work *before* anything is installed, so it stays
# POSIX sh with no dependency beyond curl (wget as a fallback) and no bashisms:
# the documented form pipes this file into a shell
#
#   curl -fsSL …/releases/latest/download/install.sh | sh
#
# where `$0` is just "sh" and stdin is the script itself — nothing may be read
# from stdin, and the file cannot be located on disk. Everything past "is there a
# Node?" lives in install.mjs, which can parse JSON and gunzip without this file
# needing jq or tar.
#
# The URL below is a **fixed asset name** on `releases/latest/download`, re-uploaded
# by every release, so publishing a version never edits this file or the docs that
# call it.
set -eu

BASE=${AGENT_USAGES_BASE_URL:-https://github.com/liruohrh/agent-usages/releases/latest/download}
MIN_NODE=22.18

usage() {
  cat <<'EOF'
agent-usages 安装器（POSIX sh）

用法：
  curl -fsSL https://github.com/liruohrh/agent-usages/releases/latest/download/install.sh | sh

  # 装指定版本（管道里要给 sh 传参，得用 sh -s --）
  curl -fsSL https://github.com/liruohrh/agent-usages/releases/latest/download/install.sh | sh -s -- --version 0.0.3

  # 已经下载了脚本，或者想装本地 tarball
  sh install.sh [install.mjs 的选项…]

这个脚本只做两件事：找一个 Node ≥ 22.18（找不到或太旧就告诉你怎么装，不代装）、
下载 install.mjs，然后把它剩下的活交给 install.mjs。

  --base <url>   安装器与发布包的基址（默认 releases/latest/download）
  -h, --help     显示这段帮助

其余选项原样转给 install.mjs（--version / --tarball / --prefix / --dry-run），
`-s -- --help` 可看它的完整帮助。

环境变量：
  AGENT_USAGES_NODE       用哪个 node（默认 PATH 里的 node）
  AGENT_USAGES_BASE_URL   同 --base，命令行优先
EOF
}

node_error() {
  printf '%s\n' \
    "install.sh: $1" \
    "装一个 Node ≥ $MIN_NODE（任选一种，装完重开终端）：" \
    "  - 官网安装包：https://nodejs.org/" \
    "  - mise：mise use -g node@22" \
    "  - nvm：nvm install 22 && nvm use 22" \
    "  - Homebrew：brew install node" \
    "  - 或指定已经装好的 node：AGENT_USAGES_NODE=/path/to/node sh install.sh …" >&2
  exit 1
}

# 把 --base 摘出来，其余参数原样留在位置参数里。POSIX sh 没有数组，所以用
# 「搬到最后」的写法：每轮处理一个参数，不要的丢掉，要的接到队尾。
remaining=$#
while [ "$remaining" -gt 0 ]; do
  argument=$1
  shift
  remaining=$((remaining - 1))
  case $argument in
    --base)
      if [ "$remaining" -eq 0 ]; then
        printf '%s\n' 'install.sh: --base 缺少值' >&2
        exit 2
      fi
      BASE=$1
      shift
      remaining=$((remaining - 1))
      ;;
    --base=*) BASE=${argument#--base=} ;;
    -h | --help)
      usage
      exit 0
      ;;
    *) set -- "$@" "$argument" ;;
  esac
done

BASE=${BASE%/}
if [ -z "$BASE" ]; then
  printf '%s\n' 'install.sh: --base 不能为空' >&2
  exit 2
fi

if [ -n "${AGENT_USAGES_NODE:-}" ]; then
  NODE=$AGENT_USAGES_NODE
  command -v "$NODE" >/dev/null 2>&1 ||
    node_error "AGENT_USAGES_NODE=$NODE 不是一个可执行的命令或文件"
else
  NODE=$(command -v node 2>/dev/null || true)
  [ -n "$NODE" ] || node_error "PATH 里没有 node"
fi

NODE_VERSION=$("$NODE" -p 'process.versions.node' 2>/dev/null) ||
  node_error "跑不动 $NODE（它看起来不是一个可用的 node）"

case $NODE_VERSION in
  '' | *[!0-9.]*) node_error "读不出 $NODE 的版本号：$NODE_VERSION" ;;
esac

NODE_MAJOR=${NODE_VERSION%%.*}
NODE_REST=${NODE_VERSION#*.}
NODE_MINOR=${NODE_REST%%.*}
if [ "$NODE_MAJOR" -gt 22 ] || { [ "$NODE_MAJOR" -eq 22 ] && [ "$NODE_MINOR" -ge 18 ]; }; then
  :
else
  node_error "需要 Node ≥ $MIN_NODE，当前是 $NODE_VERSION"
fi

tmp_base=${TMPDIR:-/tmp}
tmp=$(mktemp -d "$tmp_base/agent-usages-install.XXXXXX" 2>/dev/null) || tmp=
if [ -z "$tmp" ]; then
  tmp=$tmp_base/agent-usages-install.$$
  mkdir -p "$tmp" || {
    printf '%s\n' "install.sh: 建不了临时目录 $tmp" >&2
    exit 1
  }
fi
cleanup() { rm -rf "$tmp"; }
trap cleanup EXIT
trap 'exit 130' INT TERM HUP

url=$BASE/install.mjs
installer=$tmp/install.mjs
if command -v curl >/dev/null 2>&1; then
  curl -fsSL "$url" -o "$installer" || {
    printf '%s\n' "install.sh: 下载失败：$url" \
      "  （网络不通，或基址不对？可以用 --base <url> 或 AGENT_USAGES_BASE_URL 换一个）" >&2
    exit 1
  }
elif command -v wget >/dev/null 2>&1; then
  wget -q -O "$installer" "$url" || {
    printf '%s\n' "install.sh: 下载失败：$url" \
      "  （网络不通，或基址不对？可以用 --base <url> 或 AGENT_USAGES_BASE_URL 换一个）" >&2
    exit 1
  }
else
  printf '%s\n' 'install.sh: 需要 curl 或 wget 来下载安装器' >&2
  exit 1
fi

if [ ! -s "$installer" ]; then
  printf '%s\n' "install.sh: $url 下载下来是空的" >&2
  exit 1
fi

printf '%s\n' "使用 $NODE（Node $NODE_VERSION），基址 $BASE"

# 这里**不用 exec**：exec 会替换掉这个 shell，EXIT trap 不再执行，临时目录每次成功
# 安装都会留下。前台跑 + 转发退出码对外完全一样（同一个退出码、同一个前台进程、
# Ctrl-C 同样直接送到 node），而且能清理。
status=0
"$NODE" "$installer" --base "$BASE" "$@" || status=$?
exit "$status"
