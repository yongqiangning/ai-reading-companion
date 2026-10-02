#!/usr/bin/env bash
# 把本地朗读服务装成 macOS 登录项：开机自动起、崩了自动拉起、纯后台无窗口。
# 装完不需要再管它，打开 main.html 就能用。
#
# 用法：
#   bash install-service.sh            # 默认装 qwen3
#   bash install-service.sh qwen3      # Qwen3-TTS（MLX，本地离线，音色最好也最快）
#
# 卸载：bash uninstall-service.sh
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
LABEL="com.reader.tts"          # 当前用的 Label
LEGACY_LABEL="com.audio8.tts"   # 早期版本用过的 Label，装的时候顺手清掉
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

ENGINE="${1:-qwen3}"
case "$ENGINE" in
  qwen3) ;;
  *) echo "未知引擎：${ENGINE}（现在只有 qwen3）" >&2; exit 1 ;;
esac

VENV="$HERE/.venv-qwen3"
START="$HERE/start-qwen3.sh"

if [ ! -x "$VENV/bin/python" ]; then
  echo "还没装 Qwen3-TTS。先跑： bash \"$HERE/setup-qwen3.sh\"" >&2
  exit 1
fi

mkdir -p "$HOME/Library/LaunchAgents"

# ★ 判据用 `launchctl print`，**不要用 `launchctl list | grep`**。
#   踩过：原先用 `launchctl list | grep "$LABEL"` 判断注册没注册上，它在某些
#   shell 上下文里查的是另一个 domain、看不到 gui 域的服务 —— 于是 bootstrap
#   明明成功了，却打印「开机自启没装上」，害人反复重跑。
#   `print` 的退出码可靠：注册了 0、没有 113，错误走 stderr 不走 stdout。
registered() { launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1; }

# 历史 Label 顺手清掉。**当前 Label 不在这里动** —— 见下面 PLIST_SAME 的注释。
if launchctl print "gui/$(id -u)/$LEGACY_LABEL" >/dev/null 2>&1; then
  echo "== 摘掉历史登录项 $LEGACY_LABEL =="
  launchctl bootout "gui/$(id -u)/$LEGACY_LABEL" 2>/dev/null || true
fi
rm -f "$HOME/Library/LaunchAgents/$LEGACY_LABEL.plist"

# 顺手清掉手动的 pid 文件，免得两个入口打架
rm -f "$HERE/service.pid"

echo "== 写登录项：${PLIST}（引擎 ${ENGINE}）=="
# 先写临时文件再原子替换：别让 launchd 读到写了一半的 plist。
PLIST_NEW="$(mktemp -t com.reader.tts)"
cat > "$PLIST_NEW" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>

  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$START</string>
  </array>

  <key>WorkingDirectory</key>
  <string>$HERE</string>

  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>$HOME</string>
    <key>PATH</key>
    <string>/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>HF_HUB_OFFLINE</key>
    <string>1</string>
    <key>HF_HUB_DISABLE_XET</key>
    <string>1</string>
  </dict>

  <!-- 登录后立刻起，不用等第一次用到 -->
  <key>RunAtLoad</key>
  <true/>

  <!-- 崩了（非 0 退出 / 被信号杀）就拉起来，但「主动正常退出」不再重启。
       ★ 不能用 <true/>：那样连正常退出也会被无限重启。实测的翻车场景——
         8024 已经被另一个实例（手动 start-bg.sh 起的那个）占着，
         本服务每 10 秒起一次、每次 bind 失败，service.log 里滚出十几条
         "address already in use"，而人完全看不出是「两个实例在打架」。
         改成只在失败时重启后，start-qwen3.sh 里那个「端口已占用就正常退出」
         的守卫才不会变成死循环。 -->
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>

  <!-- 起不来时别疯转，最多每 10 秒重试一次 -->
  <key>ThrottleInterval</key>
  <integer>10</integer>

  <!-- 日志沿用同一个文件，tail 一个地方就够 -->
  <key>StandardOutPath</key>
  <string>$HERE/service.log</string>
  <key>StandardErrorPath</key>
  <string>$HERE/service.log</string>
</dict>
</plist>
PLIST_EOF

# ★ 内容没变就别碰注册。
#   踩过（这次真踩了）：为了验证改动重跑本脚本 → 先 bootout 摘掉旧注册，
#   结果 bootstrap 失败 → 注册再也回不来，白白把好好的开机自启搞没了。
#   而 bootout 是照常生效的，于是「重跑一次更保险」反而变成「重跑一次就废」。
#   cmp 一致 + 已注册 → 只 kickstart 重启进程，注册原样不动。
PLIST_SAME=""
if registered && cmp -s "$PLIST_NEW" "$PLIST"; then PLIST_SAME=1; fi
mv -f "$PLIST_NEW" "$PLIST"
# mktemp 建出来的文件是 600，mv 会把权限一起带过来。launchd 对登录项权限有讲究，
# 统一成 644（跟其它 app 装的登录项一致）。
chmod 644 "$PLIST"

echo "== 加载 =="
if [ -n "$PLIST_SAME" ]; then
  echo "   登录项内容没变，不动注册，直接重启服务。"
  launchctl kickstart -k "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || true
else
  if registered; then
    echo "   配置有变，重新注册。"
    launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
    sleep 1
  fi

  # ★ 清掉手动起的残留实例。它会占着 8024，让 LaunchAgent 起来的那个 bind 失败，
  #   然后两边无限重启（service.log 里刷满 address already in use）。
  pkill -f "serve-qwen3.py" >/dev/null 2>&1 || true
  # 等端口真的空出来再注册，别让新实例一上来就撞上还在关闭中的旧进程。
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    curl -sS --noproxy '*' --max-time 2 "http://127.0.0.1:${PORT:-8024}/api/health" 2>/dev/null | grep -q '"engine"' || break
    sleep 1
  done

  # bootstrap 的坑：已经注册过时它返回 5（Input/output error），极易被误判成失败；
  # bootout 又是异步的，紧接着 bootstrap 偶尔会撞上还没摘干净。
  # 所以重试几次，每次都以「print 认不认」为准，不看 bootstrap 自己的返回值。
  for _ in 1 2 3; do
    launchctl bootstrap "gui/$(id -u)" "$PLIST" >/dev/null 2>&1 || true
    registered && break
    sleep 2
  done

  # 换老接口再试一次：它走另一条代码路径，在部分受限会话里能成。
  if ! registered; then
    launchctl load -w "$PLIST" >/dev/null 2>&1 || true
    sleep 1
  fi
fi

if ! registered; then
  echo "   ⚠️  注册没成功，而且旧注册已经被摘掉了 —— 现在没有开机自启。" >&2
  echo "      补一句就回来了（Agent / 受限 shell 里 launchctl 的注册接口被系统限制，报 I/O error）：" >&2
  echo "        launchctl bootstrap gui/\$(id -u) \"$PLIST\"" >&2
  echo "      （或者重跑本脚本。plist 已经写好在原位，下次登录 launchd 也会自动加载它。）" >&2
  # ★ 只有 8024 上确实没人应答才手动起，否则就是跟 launchd 抢同一个端口。
  if curl -sS --noproxy '*' --max-time 2 "http://127.0.0.1:${PORT:-8024}/api/health" 2>/dev/null | grep -q '"engine"'; then
    echo "      不过 ${PORT:-8024} 上已经有服务在跑，就不重复起了。" >&2
  else
    nohup bash "$START" > "$HERE/service.log" 2>&1 &
    echo $! > "$HERE/service.pid"
  fi
fi

echo "== 等服务就绪（启动不再加载模型，正常几秒）=="
ok=""
for _ in $(seq 1 90); do
  if curl -sS --noproxy '*' --max-time 3 "http://127.0.0.1:${PORT:-8024}/api/health" >/dev/null 2>&1; then
    ok=1
    break
  fi
  sleep 2
done

echo
if [ -n "$ok" ]; then
  # ★ 这里**不再**等 `"loaded":true`。模型改成「页面打开才加载、页面关掉就释放」，
  #   启动时 loaded 永远是 false —— 再等下去只会白等 60 秒然后超时退出。
  echo "装好了（Qwen3-TTS），服务正在跑："
  curl -sS --noproxy '*' --max-time 5 "http://127.0.0.1:${PORT:-8024}/api/health"
  echo
  echo "模型不常驻：打开 main.html 时自动加载，关闭标签页后自动释放（4136MB → 约 126MB）。"
  echo "想让它一直热着（开机就占用内存），在 plist 里加环境变量 QWEN3_PRELOAD=1。"
  echo
  if registered; then
    echo "以后开机自动起，不用再管。卸载： bash \"$HERE/uninstall-service.sh\""
    # 服务进程由 launchd 领养，跟任何终端窗口都没关系：关窗口不会把它带走，
    # 重启电脑它自己会回来。所以装完之后那个终端随手关掉就行。
    echo "服务归 launchd 管：关掉终端窗口不影响它。想确认状态："
    echo "  launchctl print gui/\$(id -u)/$LABEL | grep -E 'state|pid'"
  else
    echo "注意：开机自启没装上（launchctl 注册失败），这次是手动起的。"
    echo "      电脑重启后需要重跑本脚本，或直接： bash \"$HERE/start-bg.sh\""
  fi
else
  echo "服务没就绪。看日志排查：" >&2
  echo "  tail -30 \"$HERE/service.log\"" >&2
  exit 1
fi
