#!/usr/bin/env bash
#
# asciinema 录屏脚本（计划 §5.4）。
#
# 用法：
#   asciinema rec -c "bash scripts/record-demo.sh" demo.cast
#
# 说明：本脚本只负责把「演示叙事」按顺序回放成一段可读的终端记录。
# 它不替你做真实安装/运行——涉及 Pi 交互会话（/doctor、/check、/tree）的部分
# 是「旁白 + 期望输出」，需要在真实 Pi 会话里手动跑一遍才是真正的演示。
#
set -euo pipefail

p() { printf '%s\n' "$*"; }
cmd() { p "\$ $*"; }
beat() { sleep "${1:-0.8}"; }

clear
cmd "npm install"
beat
cmd "pi install ./ -l"
beat
p "Installing ./..."
p "Installed ./"
beat 1

p ""
p "# 0. 确认扩展已装载（占位 provider 出现在模型目录里）"
beat
cmd "pi --offline --approve --list-models | grep offerlens"
p "offerlens-placeholder  offerlens-placeholder-v1  128K  16.4K  no  no"
beat 1

p ""
p "# 1. 通道自检（在 Pi 会话内输入 /doctor）"
cmd "/doctor"
p "  ✓ bilibili     wbi 签名搜索正常，返回 20 条"
p "  ✓ web          网页抓取正常（via direct）"
p "  ✓ rss          解析 https://github.blog/feed/ 得到 10 条"
p "  ✗ youtube      yt-dlp 未安装（用户环境自备，/doctor 已提示）"
p "  ✗ xiaohongshu  not supported by design (requires login)"
p "  • dispatchMode  stub（stub=占位模型进程内执行；subagent=派发子 pi 进程）"
p "  ✓ agents        collector / verifier / contrarian 已就位（.pi/agents/）"
beat 1

p ""
p "# 2. 主流程"
cmd "/check 字节 2027 届前端实习转正率"
p "……（假设规划 → 三分支派发 → 采集/质检/反方 → 聚合 → 报告）"
p "# 报告以 offerlens-report 消息呈现：5 段，第 5 段「信息缺口」强制非空"
beat 1

p ""
p "# 3. 假设树（Pi 内置 /tree；label 即状态机 hyp/<slug>/<state>）"
cmd "/tree"
p "hyp/softad        (abandoned)            假设不成立，已放弃（附 5 段裁决摘要）"
p "hyp/stale         (supported)            主张成立：信息确已过期"
p "hyp/insufficient  (insufficient-evidence) 公开样本不足以判定"
beat 1

p ""
p "# 4. 报告第 5 段（信息缺口）——自动列出无法判定的部分及原因"
p "# 样本量不足 / 后验对单一特征敏感 / 来源不可达 / 小红书 by-design 排除 …"
beat 1

p ""
p "# 5. 隔离演示：主管想在派发反方时夹带质检结论"
cmd "# dispatch_contrarian 的参数 schema 只有 claim + evidence_ids"
p "# → 夹带 verdicts/reasoning/summary 会在类型层面无处可放（fail-closed）"
beat 1

p ""
p "# 6. 导出报告"
cmd "/report"
p "✓ 已导出 .offerlens/reports/<session>.md"
beat 1

p ""
p "# 7. 定性对照（有/无反方 Agent）"
cmd "npm run web   # 另开终端"
cmd "bash scripts/compare-contrarian.sh"
p "✓ .offerlens/compare/README-comparison.md（第 3 段并排）"
beat 2

p ""
p "—— 完 ——"
