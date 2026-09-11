#!/usr/bin/env bash
# on  = restart both speculators quoting (AGENT_WIND_DOWN=0) for the take
# off = back to the launcher's default, redeem-only (AGENT_WIND_DOWN=1)
set -euo pipefail
cd "$(dirname "$0")/.."
case "${1:-}" in
  on)  MODE=0 ;;
  off) MODE=1 ;;
  *) echo "usage: bash video/speculators.sh on|off" >&2; exit 64 ;;
esac
pkill -f "bots/speculator[.]ts" || true
sleep 2
AGENT_WIND_DOWN=$MODE npm run --silent speculators
sleep 3
echo "--- running speculators (want two, AGENT_WIND_DOWN=$MODE):"
for pid in $(pgrep -f "bots/speculator[.]ts"); do
  printf "  pid %s  " "$pid"; tr '\0' '\n' < "/proc/$pid/environ" | grep -E "^AGENT_(THESIS|WIND_DOWN)=" | paste -sd' '
done
