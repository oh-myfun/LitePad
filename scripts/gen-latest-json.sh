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
# ⚠️ latest.json 的 `signature` 字段必须是 **`.sig` 文件的原文（base64 字符串）**——
#    tauri-plugin-updater 会先对它做 base64 解码、再按 minisign 明文解析+验签
#    （见 tauri-plugin-updater-2.12.0 src/updater.rs:1540 + error.rs:60 的报错文案）。
#    直接把 base64 解码后的明文塞进去会让解码器在换行符处报
#    `Invalid symbol 10`（即本次 v0.13.0 更新安装失败的根因）。所以这里**原样**取 .sig 内容。
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

# 用 node 拼装：signature 直接取 .sig 原文（base64 字符串），tauri 会自行 base64 解码。
# 自检：该 base64 解码后必须是 minisign 明文（以 untrusted comment: 开头），否则说明拿错文件。
node -e '
  const fs = require("fs");
  const [sigPath, ver, url, outPath] = process.argv.slice(1);
  const sigB64 = fs.readFileSync(sigPath, "utf8").trim();
  let sigText;
  try { sigText = Buffer.from(sigB64, "base64").toString("utf8"); }
  catch { console.error("✗ .sig 不是合法 base64，中止"); process.exit(1); }
  if (!sigText.startsWith("untrusted comment:")) {
    console.error("✗ .sig 解码后不是 minisign 明文（应以 untrusted comment: 开头），中止"); process.exit(1);
  }
  const json = {
    version: ver,
    notes: `LitePad v${ver}`,
    pub_date: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
    platforms: { "windows-x86_64": { signature: sigB64, url } },
  };
  fs.writeFileSync(outPath, JSON.stringify(json, null, 2) + "\n");
' "$SIG" "$VER" "$URL" "$SRC/latest.json"

echo "✓ latest.json 已生成（v$VER → $URL），signature 为 .sig 原文 base64"
