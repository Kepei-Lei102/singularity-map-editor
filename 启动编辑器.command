#!/bin/bash
# Finder 双击或 bash 启动编辑器.command [工程路径]
SCRIPT_DIR="$(cd -- "$(dirname -- "$0")" && pwd)" || exit 1
bash "$SCRIPT_DIR/scripts/bootstrap-macos.sh" "$@"
result=$?
if [ "$result" -ne 0 ] && [ "$result" -ne 130 ] && [ -t 0 ]; then
  read -r -p '启动未完成，请查看上面的错误；按回车关闭……'
fi
exit "$result"
