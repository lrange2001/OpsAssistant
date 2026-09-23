#!/bin/zsh
# 构建 ForFreedom Assistant.app
# 用法:zsh ~/ForFreedom/code/FreedomAssistant/mac-app/build.sh
set -e
cd "$(dirname "$0")"

APP_NAME=ForFreedomAssistant
APP="$APP_NAME.app"

# 图标(只生成一次,之后复用 AppIcon.icns)
if [ ! -f AppIcon.icns ]; then
  echo "[1/3] 生成图标…"
  swift gen_icon.swift
  rm -rf icon.iconset && mkdir icon.iconset
  for s in 16 32 128 256 512; do
    sips -z $s $s icon_1024.png --out icon.iconset/icon_${s}x${s}.png >/dev/null
    sips -z $((s*2)) $((s*2)) icon_1024.png --out icon.iconset/icon_${s}x${s}@2x.png >/dev/null
  done
  iconutil -c icns icon.iconset -o AppIcon.icns
  rm -rf icon.iconset icon_1024.png
else
  echo "[1/3] 图标已存在,跳过"
fi

echo "[2/3] 编译 Swift…"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
swiftc -O -o "$APP/Contents/MacOS/$APP_NAME" main.swift -framework Cocoa -framework WebKit

echo "[3/3] 组装 .app…"
cp Info.plist "$APP/Contents/Info.plist"
cp AppIcon.icns "$APP/Contents/Resources/AppIcon.icns"
# 内嵌后端与页面(app 独立运行,不依赖仓库源码)
mkdir -p "$APP/Contents/Resources/app"
cp ../server.py ../index.html "$APP/Contents/Resources/app/"
cp -R ../backend "$APP/Contents/Resources/app/backend"
rm -rf "$APP/Contents/Resources/app/backend/__pycache__"   # 不把开发机字节码打进包
# 预编译字节码:首启免现场编译 .py(实测省约 100ms);打包机与运行机同为本机,pyc 无版本错配问题
python3 -m compileall -q "$APP/Contents/Resources/app/backend"
cp -R ../static "$APP/Contents/Resources/app/static"
touch "$APP"

echo "构建完成: $(pwd)/$APP"
echo "安装到 ~/Applications:cp -R '$APP' ~/Applications/ && touch ~/Applications/'$APP'"
