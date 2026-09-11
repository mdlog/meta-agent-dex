#!/usr/bin/env bash
# The spec's §10 checks, in one place. Exit non-zero on the first failure.
set -euo pipefail
cd "$(dirname "$0")"
MP4=out/meta-agent-dex-demo.mp4
echo "1. streams + duration"
ffprobe -v error -show_entries stream=codec_type,codec_name,width,height,r_frame_rate:format=duration -of csv=p=0 "$MP4"
dur=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$MP4")
python3 -c "import sys; d=float('$dur'); print(f'   {d:.1f}s'); sys.exit(0 if d <= 180 else 1)"
echo "2. caption cue counts (ass == srt)"
python3 - <<'PY'
import sys
a = open("out/captions.ass").read().count(",Cap,")
b = open("out/meta-agent-dex-demo.srt").read().count("-->")
print(f"   ass={a} srt={b}"); sys.exit(0 if a == b and a > 0 else 1)
PY
echo "3. narrated numbers match the take"
python3 - <<'PY'
import json, subprocess, sys
t = json.load(open("out/take.json"))
n = json.loads(subprocess.check_output(["node", "--experimental-strip-types", "script.ts", "--narration"], text=True, stderr=subprocess.DEVNULL))
b5 = next(x["text"] for x in n if x["id"] == "05-settlement")
b3 = next(x["text"] for x in n if x["id"] == "03-agents-pricing")
ok = all(s in b5 for s in (t["agent"]["name"], t["navT0"], t["navT1"], f"answered {t['answer']}", f"paid the {t['paid']} side")) and f"session {t['openSession']}" in b3
print("   ", "ok" if ok else "MISMATCH", "-", t["agent"]["name"], t["navT0"], "->", t["navT1"], t["answer"], t["paid"], "case", t["case"]); sys.exit(0 if ok else 1)
PY
echo "4. speculators back on wind-down"
n=0; for pid in $(pgrep -f "bots/speculator[.]ts"); do n=$((n+1)); printf "   pid %s  " "$pid"; tr '\0' '\n' < "/proc/$pid/environ" | grep -E "^AGENT_(THESIS|WIND_DOWN)=" | paste -sd' '; done
[ "$n" = 2 ] || { echo "   expected 2 speculator processes, found $n"; exit 1; }
echo "5. nothing large staged"
git -C .. status --short | grep -E "\.(mp4|webm|mp3)$" && { echo "   media staged!"; exit 1; } || echo "   ok"
echo "all checks passed"
