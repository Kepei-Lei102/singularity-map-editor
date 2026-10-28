#!/bin/bash
# 私有 Node 运行环境；仅在本进程中修改 PATH。
set -e
ROOT="$(cd -- "$(dirname -- "$0")/.." && pwd)"
CACHE="$ROOT/.runtime"
usable() { "$1" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)' >/dev/null 2>&1; }
# 优先使用已安装且完整的环境。
if command -v node >/dev/null 2>&1 && usable "$(command -v node)" && command -v npm >/dev/null 2>&1 && npm --version >/dev/null 2>&1; then
  exec node "$ROOT/scripts/launch.mjs" "$@"
fi
case "$(uname -m)" in
  arm64) ARCH=arm64 ;;
  x86_64) ARCH=x64 ;;
  *) printf '不支持的 Mac 架构：%s\n' "$(uname -m)" >&2; exit 1 ;;
esac
NODE="$CACHE/node-darwin-$ARCH/bin/node"
if [ ! -x "$NODE" ] || ! usable "$NODE" || ! "$NODE" "$CACHE/node-darwin-$ARCH/lib/node_modules/npm/bin/npm-cli.js" --version >/dev/null 2>&1; then
  mkdir -p "$CACHE"
  WORK="$(mktemp -d "$CACHE/download.XXXXXX")"
  trap 'rm -rf -- "$WORK"' EXIT
  ready=false
  for BASE in https://npmmirror.com/mirrors/node https://nodejs.org/dist; do
    printf '正在从 %s 准备 Node.js 22 LTS……\n' "$BASE"
    if ! curl -fL --retry 1 --connect-timeout 10 --max-time 45 "$BASE/latest-v22.x/SHASUMS256.txt" -o "$WORK/sums"; then continue; fi
    FILE=''; HASH=''
    while read -r hash file; do
      if [[ "$file" =~ ^node-v22\.[0-9]+\.[0-9]+-darwin-$ARCH\.tar\.gz$ ]] && [[ "$hash" =~ ^[0-9a-f]{64}$ ]]; then
        FILE="$file"; HASH="$hash"; break
      fi
    done < "$WORK/sums"
    if [ -z "$FILE" ]; then printf '镜像没有可用的校验清单，尝试下一来源。\n'; continue; fi
    VERSION="${FILE#node-}"; VERSION="${VERSION%-darwin-*}"
    if ! curl -fL --retry 1 --connect-timeout 10 --max-time 600 "$BASE/$VERSION/$FILE" -o "$WORK/archive.tar.gz"; then continue; fi
    actual="$(shasum -a 256 "$WORK/archive.tar.gz")"; actual="${actual%% *}"
    if [ "$actual" != "$HASH" ]; then printf '下载校验失败，尝试下一来源。\n' >&2; continue; fi
    # 每次解压进入新的空目录；不在下载目录内运行解释器。
    EXTRACT="$(mktemp -d "$WORK/extract.XXXXXX")"
    if ! tar -xzf "$WORK/archive.tar.gz" -C "$EXTRACT"; then continue; fi
    PACKAGE="$EXTRACT/${FILE%.tar.gz}"
    if ! usable "$PACKAGE/bin/node" || ! "$PACKAGE/bin/node" "$PACKAGE/lib/node_modules/npm/bin/npm-cli.js" --version >/dev/null 2>&1; then continue; fi
    if [ -e "$CACHE/node-darwin-$ARCH" ]; then mv "$CACHE/node-darwin-$ARCH" "$WORK/previous"; fi
    mv "$PACKAGE" "$CACHE/node-darwin-$ARCH"
    ready=true; break
  done
  if [ "$ready" != true ]; then
    printf '\n自动准备 Node.js 失败，请检查网络、磁盘空间和目录写入权限后重试。也可从 https://nodejs.org/ 手动安装 Node.js 22+ LTS。\n' >&2
    exit 1
  fi
  rm -rf -- "$WORK"
  trap - EXIT
fi
export PATH="$(dirname -- "$NODE"):$PATH"
exec "$NODE" "$ROOT/scripts/launch.mjs" "$@"
