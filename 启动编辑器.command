#!/bin/bash
# Finder 双击或 bash 启动编辑器.command [工程路径]
SCRIPT_DIR="$(cd -- "$(dirname -- "$0")" && pwd)" || exit 1
if ! command -v node >/dev/null 2>&1; then
  printf '\n请先安装 Node.js LTS：https://nodejs.org/ （需要22或更新版本）\n安装后重新打开此脚本。\n'
  read -r -p '按回车关闭……'
  exit 1
fi
node "$SCRIPT_DIR/scripts/launch.mjs" "$@"
result=$?
if [ "$result" -ne 0 ] && [ "$result" -ne 130 ]; then
  read -r -p '启动未完成，请查看上面的错误；按回车关闭……'
fi
exit "$result"
