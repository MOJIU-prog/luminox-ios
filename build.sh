#!/bin/bash
# =============================================================================
# build.sh —— 在 Mac 上一条命令出 ipa
# -----------------------------------------------------------------------------
# 用法：
#   ./build.sh                                  # 未签名 ipa（拿去 Sideloadly 签）
#   ./build.sh --team ABCDE12345 --export       # 已签名 ipa（本机有证书）
#   ./build.sh --team ABCDE12345 --run          # 直接装到已连接的 iPhone
#   ./build.sh --list-devices                   # 看能装到哪些设备
#
# 为什么脚本要这么长：
#  · xcodebuild 的报错很难读，这里把常见失败翻成人话（证书 / Team / 设备 / 磁盘）
#  · 未签名和已签名是两条完全不同的路径，混在一起最容易出错
#    （未签名必须 CODE_SIGNING_ALLOWED=NO，否则 xcodebuild 会因为找不到证书直接失败）
# =============================================================================
set -uo pipefail

SCHEME="LuminoxMobile"
PROJECT="LuminoxMobile.xcodeproj"
BUILD_DIR="build"
TEAM=""
DO_EXPORT=0
DO_RUN=0
DO_LIST=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --team)        TEAM="$2"; shift 2 ;;
    --export)      DO_EXPORT=1; shift ;;
    --run)         DO_RUN=1; shift ;;
    --list-devices) DO_LIST=1; shift ;;
    -h|--help)     sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "未知参数: $1"; exit 1 ;;
  esac
done

red()   { printf '\033[31m%s\033[0m\n' "$*"; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }
yellow(){ printf '\033[33m%s\033[0m\n' "$*"; }
step()  { printf '\n\033[1m=== %s ===\033[0m\n' "$*"; }

# ---------- 0. 环境检查 ----------
step "0. 环境"
if ! command -v xcodebuild >/dev/null 2>&1; then
  red "没有 xcodebuild。这台机器不是 Mac，或者没装 Xcode。"
  echo "  没有 Mac 的话，改用 .github/workflows/build-ios.yml 云端构建。"
  exit 1
fi
echo "Xcode: $(xcodebuild -version | head -1)"
echo "macOS: $(sw_vers -productVersion)"

if command -v xcrun >/dev/null 2>&1; then
  echo "SDK  : $(xcrun --sdk iphoneos --show-sdk-version 2>/dev/null || echo '未找到 iPhoneOS SDK')"
fi

if [[ ! -d "$PROJECT" ]]; then
  red "找不到 $PROJECT"
  if command -v xcodegen >/dev/null 2>&1; then
    yellow "用 XcodeGen 重新生成工程…"
    xcodegen generate || exit 1
  else
    echo "  装了 xcodegen 的话可以自动重建：brew install xcodegen && xcodegen generate"
    exit 1
  fi
fi

# ---------- 1. 列表设备 ----------
if [[ $DO_LIST -eq 1 ]]; then
  step "1. 可用设备"
  xcrun xctrace list devices 2>/dev/null | sed -n '/^== Devices ==/,/^== /p' | head -30
  echo ""
  echo "上面 'iPhone' 或 'iPad' 开头的就是能装的设备。"
  green "完成"
  exit 0
fi

# ---------- 2. Team 检查 ----------
step "1. 签名身份"
if [[ -z "$TEAM" ]]; then
  yellow "没传 --team，将构建【未签名】包（拿去做侧载签名用）"
  echo "  已签名的用法：./build.sh --team ABCDE12345 --export"
  echo "  自己的 Team ID 在 https://developer.apple.com/account → Membership 里看"
else
  echo "Team ID: $TEAM"
  # 看看本机有没有对应的签名证书
  CERTS=$(security find-identity -v -p codesigning 2>/dev/null | grep -c "valid identities found" || echo 0)
  FOUND=$(security find-identity -v -p codesigning 2>/dev/null | grep -c "$TEAM" || true)
  if [[ "$FOUND" -eq 0 ]]; then
    yellow "本机钥匙串里没有找到 Team $TEAM 的证书。"
    echo "  Xcode 可以自动申请：打开 Xcode → Settings → Accounts → 加你的 Apple ID"
    echo "  或者：xcodebuild -allowProvisioningUpdates 会自动去申请（本脚本已带这个参数）"
  else
    green "找到 $FOUND 个可用签名证书"
  fi
fi

mkdir -p "$BUILD_DIR"
rm -rf "$BUILD_DIR/Luminox.xcarchive" "$BUILD_DIR/Luminox" "$BUILD_DIR/export"
rm -f  "$BUILD_DIR/Luminox.ipa" "$BUILD_DIR/Luminox-unsigned.ipa"

# ---------- 3. 构建 ----------
if [[ -z "$TEAM" ]]; then
  # ===== 未签名路径 =====
  step "2. 构建（未签名）"
  # CODE_SIGNING_ALLOWED=NO 是必须的：不关掉的话 xcodebuild 会因为找不到
  # 签名证书直接报 "No signing certificate found"，根本走不到打包那步。
  LOG="$BUILD_DIR/build.log"
  xcodebuild \
    -project "$PROJECT" \
    -scheme "$SCHEME" \
    -configuration Release \
    -sdk iphoneos \
    -destination 'generic/platform=iOS' \
    -archivePath "$BUILD_DIR/Luminox.xcarchive" \
    CODE_SIGN_IDENTITY="" \
    CODE_SIGNING_REQUIRED=NO \
    CODE_SIGNING_ALLOWED=NO \
    DEVELOPMENT_TEAM="" \
    archive > "$LOG" 2>&1
  RC=$?

  if [[ $RC -ne 0 ]]; then
    red "构建失败（xcodebuild exit=$RC）"
    echo "--- 最后 40 行 ---"
    tail -40 "$LOG"
    echo "------------------"
    grep -qi "unable to find a destination" "$LOG" && echo "→ 提示：没有装 iOS 平台组件。Xcode → Settings → Components 装 iOS SDK"
    grep -qi "no such module" "$LOG"            && echo "→ 提示：依赖缺失。这个工程零第三方依赖，正常不会出现，检查有没有手动加过依赖"
    grep -qi "www" "$LOG"                       && echo "→ 提示：www 目录可能没被当成文件夹引用，见 project.yml 里的 type: folder"
    exit 1
  fi
  green "构建成功"

  step "3. 打包成 ipa"
  APP="$BUILD_DIR/Luminox.xcarchive/Products/Applications/Luminox.app"
  if [[ ! -d "$APP" ]]; then
    red "找不到产物 $APP"
    ls -R "$BUILD_DIR/Luminox.xcarchive/Products" 2>/dev/null | head -20
    exit 1
  fi
  PAYLOAD="$BUILD_DIR/Luminox"
  mkdir -p "$PAYLOAD/Payload"
  cp -R "$APP" "$PAYLOAD/Payload/"
  ( cd "$PAYLOAD" && zip -qry ../Luminox-unsigned.ipa Payload )
  rm -rf "$PAYLOAD"

  step "4. 结果"
  if [[ -f "$BUILD_DIR/Luminox-unsigned.ipa" ]]; then
    SIZE=$(du -h "$BUILD_DIR/Luminox-unsigned.ipa" | cut -f1)
    green "ipa: $BUILD_DIR/Luminox-unsigned.ipa  ($SIZE)"
    echo ""
    echo "这个包【没有签名】，iPhone 上装不了。下一步："
    echo "  · Windows → Sideloadly（选这个 ipa + 你的 Apple ID）"
    echo "  · Mac     → AltStore / Xcode 重新签名"
    echo "  · 有 Team → 重跑：./build.sh --team <TEAM> --export"
  else
    red "打包失败"
    exit 1
  fi

else
  # ===== 已签名路径 =====
  step "2. 构建（已签名，Team=$TEAM）"
  LOG="$BUILD_DIR/build-signed.log"
  xcodebuild \
    -project "$PROJECT" \
    -scheme "$SCHEME" \
    -configuration Release \
    -sdk iphoneos \
    -destination 'generic/platform=iOS' \
    -archivePath "$BUILD_DIR/Luminox.xcarchive" \
    DEVELOPMENT_TEAM="$TEAM" \
    CODE_SIGN_STYLE=Automatic \
    -allowProvisioningUpdates \
    archive > "$LOG" 2>&1
  RC=$?

  if [[ $RC -ne 0 ]]; then
    red "构建失败（xcodebuild exit=$RC）"
    echo "--- 最后 40 行 ---"
    tail -40 "$LOG"
    echo "------------------"
    grep -qi "no signing certificate" "$LOG" && echo "→ 提示：钥匙串里没有该 Team 的证书。Xcode → Settings → Accounts 登录你的 Apple ID"
    grep -qi "failed to register bundle" "$LOG" && echo "→ 提示：Bundle ID 被别人占了，改 product.yml / pbxproj 里的 PRODUCT_BUNDLE_IDENTIFIER"
    grep -qi "has not been registered" "$LOG"   && echo "→ 提示：首次用免费账号需要在 Xcode 里手动跑一次以注册设备"
    exit 1
  fi
  green "构建成功"

  # 导出。Development 方式最省事（不需要 App Store 那一套）
  step "3. 导出 ipa"
  cat > "$BUILD_DIR/export.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>method</key>
    <string>development</string>
    <key>teamID</key>
    <string>$TEAM</string>
    <key>signingStyle</key>
    <string>automatic</string>
    <key>stripSwiftSymbols</key>
    <true/>
    <key>compileBitcode</key>
    <false/>
</dict>
</plist>
PLIST

  xcodebuild -exportArchive \
    -archivePath "$BUILD_DIR/Luminox.xcarchive" \
    -exportOptionsPlist "$BUILD_DIR/export.plist" \
    -exportPath "$BUILD_DIR/export" \
    -allowProvisioningUpdates > "$BUILD_DIR/export.log" 2>&1
  RC=$?
  if [[ $RC -ne 0 ]]; then
    red "导出失败"
    tail -30 "$BUILD_DIR/export.log"
    exit 1
  fi

  FOUND_IPA=$(find "$BUILD_DIR/export" -name "*.ipa" | head -1)
  if [[ -n "$FOUND_IPA" ]]; then
    cp "$FOUND_IPA" "$BUILD_DIR/Luminox.ipa"
    step "4. 结果"
    green "ipa: $BUILD_DIR/Luminox.ipa  ($(du -h "$BUILD_DIR/Luminox.ipa" | cut -f1))"
    echo ""
    echo "已签名，可以："
    echo "  · AirDrop / 微信传给自己 → iPhone 上用「文件」App 打开（需要装过一次）"
    echo "  · Apple Configurator 2 拖进去"
    echo "  · 或者直接：./build.sh --team $TEAM --run"
  else
    red "没找到导出的 ipa"
    ls -R "$BUILD_DIR/export" 2>/dev/null | head
    exit 1
  fi
fi

# ---------- 5. 直接装到设备 ----------
if [[ $DO_RUN -eq 1 ]]; then
  step "5. 安装到已连接设备"
  if ! command -v ios-deploy >/dev/null 2>&1; then
    yellow "没装 ios-deploy。用 Xcode 装也行（Product → Run）。"
    echo "  装一下：brew install ios-deploy"
  else
    APP="$BUILD_DIR/Luminox.xcarchive/Products/Applications/Luminox.app"
    ios-deploy --bundle "$APP" --debug 2>&1 | tail -20
  fi
fi

echo ""
green "完成。构建日志在 $BUILD_DIR/*.log"
