#!/usr/bin/env bash
#
# 定性对照（计划 §5.1）：同一输入跑两遍 —— 有反方 Agent / 无反方 Agent，
# 把两份报告的第 3 段（反面证据）并排落在 .offerlens/compare/ 下。
#
# 做法：不起 Pi TUI，而是驱动 Web SSE 桥（web/server.ts）——它直接调用与 Pi 扩展
# 完全相同的 runCheckFlow；「无反方」通过 check 请求的 ablateContrarian 开关实现，
# 对应 orchestrator 里那个默认关闭的消融分支。
#
# 措辞纪律（计划明确要求）：
#   ✅ "去掉反方 Agent 后第 3 段退化为占位行"
#   ❌ "假阴性率上升 X%"  —— 没有做测量就不得出现任何百分比数字
#
# 用法：
#   npm run web            # 另开一个终端，先启动 Web 桥
#   bash scripts/compare-contrarian.sh [问题]
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PORT="${PORT:-8787}"
BASE="http://127.0.0.1:${PORT}"
QUESTION="${1:-字节 2027 届前端实习转正率}"
OUT_DIR=".offerlens/compare"

mkdir -p "$OUT_DIR"

if [ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "$BASE/" 2>/dev/null || true)" != "200" ]; then
	echo "✗ Web 桥未启动。请先另开终端运行：npm run web（或 PORT=$PORT npm run web）" >&2
	exit 1
fi

# ── 跑一例，等报告落盘后打印 markdown ────────────────────────────────────
run_case() {
	local label="$1" ablate="$2" sid code
	echo "[compare] 运行「${label}」（ablateContrarian=${ablate}）…" >&2
	sid="$(curl -s -X POST "$BASE/api/check" \
		-H 'content-type: application/json' \
		-d "{\"q\":\"${QUESTION}\",\"ablateContrarian\":${ablate}}" \
		| sed -E 's/.*"sessionId":"([^"]+)".*/\1/')"

	if ! printf '%s' "$sid" | grep -qE '^web-'; then
		echo "✗ 启动失败（未取得 sessionId）：$sid" >&2
		exit 1
	fi

	# 报告在 runCheckFlow 完成、done 之前落盘；轮询到 200 即就绪（含采集网络耗时）
	for _ in $(seq 1 300); do
		code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$BASE/api/report?session=$sid" || true)"
		[ "$code" = "200" ] && break
		sleep 1
	done

	if [ "$code" != "200" ]; then
		echo "✗ 报告未生成（超时）。检查 Web 桥日志。" >&2
		exit 1
	fi
	curl -s "$BASE/api/report?session=$sid"
}

# ── 只取第 3 段 ─────────────────────────────────────────────────────────
section3() {
	awk '/^## 3\./{f=1} /^## 4\./{f=0} f'
}

run_case "有反方 Agent" false >"$OUT_DIR/with-contrarian.md"
run_case "无反方 Agent" true  >"$OUT_DIR/without-contrarian.md"

{
	echo "# 定性对照：有反方 Agent vs 无反方 Agent（第 3 段并排）"
	echo
	echo "> 输入：${QUESTION}"
	echo "> 说明：两遍使用完全相同的输入与内容源；唯一差别是第二遍通过 ablateContrarian"
	echo "> 关闭了反方 Agent。下面只做**定性**陈述，不给出任何未测量的量化指标。"
	echo
	echo "## 有反方 Agent"
	echo
	echo '```markdown'
	section3 <"$OUT_DIR/with-contrarian.md"
	echo '```'
	echo
	echo "## 无反方 Agent"
	echo
	echo '```markdown'
	section3 <"$OUT_DIR/without-contrarian.md"
	echo '```'
	echo
	echo "## 对照结论"
	echo
	echo "- 有反方时，第 3 段是该 Agent 在独立上下文里构造的、与主管结论**对立**的原始输出。"
	echo "- 无反方时，第 3 段退化为占位行——没有独立的反方视角可供阅读。"
	echo "- 完整报告：\`$OUT_DIR/with-contrarian.md\`、\`$OUT_DIR/without-contrarian.md\`。"
} >"$OUT_DIR/README-comparison.md"

echo "" >&2
echo "✓ 对照已生成：" >&2
echo "  - $OUT_DIR/with-contrarian.md" >&2
echo "  - $OUT_DIR/without-contrarian.md" >&2
echo "  - $OUT_DIR/README-comparison.md（第 3 段并排）" >&2
