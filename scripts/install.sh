#!/bin/sh
# One-line install: find a Node, fetch `install.mjs`, run it with your arguments.
#
#   curl -fsSL https://raw.githubusercontent.com/liruohrh/agent-usages/refs/heads/master/scripts/install.sh | sh
#
# This is the part that has to work *before* anything is installed, so it stays POSIX
# sh with no dependency beyond curl (wget as a fallback) and no bashisms: the
# documented form pipes this file into a shell, where `$0` is just "sh" and stdin is
# the script itself — nothing may be read from stdin, and the file cannot be located
# on disk.
#
# Exactly three steps, and no argument handling at all: find Node (≥ 22.18, and say how
# to get one instead of installing it), download install.mjs, and run it with **your
# arguments passed through untouched** — not even `--help` is intercepted, because
# every option belongs to install.mjs and `"$@"` is enough to hand them over. Which
# also means this file is optional:
#
#   curl -fsSL https://raw.githubusercontent.com/liruohrh/agent-usages/refs/heads/master/scripts/install.mjs -o install.mjs
#   node install.mjs --help
#
# Two different defaults, deliberately: **this script comes from `master`** (an
# installer fix ships as soon as it is pushed, no release needed), while the package it
# installs comes from the **latest release** (built, tested, carrying `dist/` and
# `web/dist/`). That second default lives in install.mjs. `AGENT_USAGES_BASE_URL`
# overrides both halves at once, which is what a mirror or a local test server sets.
set -eu

BASE=${AGENT_USAGES_BASE_URL:-https://raw.githubusercontent.com/liruohrh/agent-usages/refs/heads/master/scripts}
MIN_NODE=22.18

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

BASE=${BASE%/}
if [ -z "$BASE" ]; then
  printf '%s\n' 'install.sh: AGENT_USAGES_BASE_URL 不能为空' >&2
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
      "  （网络不通，或基址不对？AGENT_USAGES_BASE_URL 可以指向镜像或本地目录）" >&2
    exit 1
  }
elif command -v wget >/dev/null 2>&1; then
  wget -q -O "$installer" "$url" || {
    printf '%s\n' "install.sh: 下载失败：$url" \
      "  （网络不通，或基址不对？AGENT_USAGES_BASE_URL 可以指向镜像或本地目录）" >&2
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

# `"$@"` is every argument this script received, untouched. Not `exec`: that would
# replace this shell, skip the EXIT trap and leave the temp dir behind on every
# successful install. Running node in the foreground and forwarding the status is
# externally the same (same exit code, same foreground process, Ctrl-C still reaches
# node) and still cleans up.
status=0
"$NODE" "$installer" "$@" || status=$?
exit "$status"
