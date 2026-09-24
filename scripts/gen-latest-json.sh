#!/usr/bin/env bash
# B107：从构建产物生成 tauri updater 的发布 feed（latest.json）。
#
# updater 的 endpoint 指向 GitHub Releases 的 `latest/download/latest.json`（静态文件）。
# tauri-action 会自动生成它，而本项目的 release.yml 是手写步骤 —— 本脚本补上这一步。
# 它**只生成 latest.json**，直接写在 tauri 构建目录（target/release/bundle/nsis/）内、
# 与 setup.exe / .exe.sig 同处；exe 与 .sig 本就由 `tauri build` 产出，这里**不另拷贝第二份**。
# release 步骤直接从该构建目录上传这三件。
#
# ⚠️ tauri v2 的 NSIS 更新器产物 = 安装包 exe + 同名 `.exe.sig`（没有 .nsis.zip 封装）。
#    `.sig` 文件本身是「对 minisign 明文签名再包一层 base64」的单行文件；latest.json 的
#    `signature` 字段必须放 **base64 解码后的明文签名**（tauri 用 minisign-verify 按
#    「untrusted comment 行 + base64 签名体」逐行解析，直接喂 base64 原文会验签失败）。
#    `url` 必须与实际上传的 Release 附件名一致，否则下载 404（应用退回 available 态）。
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

VER=$(node -p "require('./package.json').version")
SRC=src-tauri/target/release/bundle/nsis
EXE="LitePad_${VER}_x64-setup.exe"

if [ ! -f "$SRC/$EXE" ]; then
  echo "✗ 未发现 $SRC/$EXE：请先跑 tauri build 产出当前版本安装包" >&2
  exit 1
fi

SIG="$SRC/$EXE.sig"
if [ ! -f "$SIG" ]; then
  echo "⚠ 未发现 $SIG：本次发布不含更新器产物（未配置签名私钥？只带 exe 发布）"
  exit 0
fi

REPO="${GITHUB_REPOSITORY:-oh-myfun/LitePad}"
URL="https://github.com/$REPO/releases/download/v$VER/$EXE"

# 用 node 拼装：signature 是含换行的多行明文，必须走 JSON.stringify 安全转义。
# 直接写在 tauri 构建目录内（与 exe / .sig 同处），release 步骤从这里上传，不复制第二份。
node -e '
  const fs = require("fs");
  const [sigPath, ver, url, outPath] = process.argv.slice(1);
  const sigText = Buffer.from(fs.readFileSync(sigPath, "utf8").trim(), "base64").toString("utf8");
  if (!sigText.startsWith("untrusted comment:")) {
    console.error("✗ 签名解码结果不是 minisign 明文格式，中止"); process.exit(1);
  }
  const json = {
    version: ver,
    notes: `LitePad v${ver}`,
    pub_date: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
    platforms: { "windows-x86_64": { signature: sigText, url } },
  };
  fs.writeFileSync(outPath, JSON.stringify(json, null, 2) + "\n");
' "$SIG" "$VER" "$URL" "$SRC/latest.json"

echo "✓ latest.json 已生成（v$VER → $URL），位于 $SRC/latest.json"
