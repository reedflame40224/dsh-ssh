#!/bin/sh
# dsh-remote 启动器：优先自带 node，其次系统 node（>=18），都没有则报错退出 127。
# 用法: start.sh [--stdio]   （M2 只有 stdio 模式）

SELF_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

NODE=""
# 一级：内置 node（--with-node 变体包携带，落位 node/bin/node）
if [ -x "$SELF_DIR/node/bin/node" ]; then
  NODE="$SELF_DIR/node/bin/node"
else
  # 二级：系统 node，且 major>=18（node -e 打印 major，退出码 0 表可用）
  if command -v node >/dev/null 2>&1 && node -e 'const major = Number(process.versions.node.split(".")[0]); console.log(major); process.exit(major >= 18 ? 0 : 1)' >/dev/null 2>&1; then
    NODE=$(command -v node)
  fi
fi

if [ -z "$NODE" ]; then
  echo 'dsh-remote: 未找到可用 node（>=18），请安装或改用内置 node 变体包' >&2
  exit 127
fi

exec "$NODE" "$SELF_DIR/dsh-remote-server.cjs" "$@"