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
# Shutdown is graceful (open redemptions finish first); wait for it rather than
# starting a second process on the same key.
for _ in $(seq 1 30); do pgrep -f "bots/speculator[.]ts" >/dev/null || break; sleep 1; done
pkill -KILL -f "bots/speculator[.]ts" 2>/dev/null || true
AGENT_WIND_DOWN=$MODE npm run --silent speculators
sleep 3
echo "--- running speculators (want two, AGENT_WIND_DOWN=$MODE):"
for pid in $(pgrep -f "bots/speculator[.]ts"); do
  printf "  pid %s  " "$pid"; tr '\0' '\n' < "/proc/$pid/environ" | grep -E "^AGENT_(THESIS|WIND_DOWN)=" | paste -sd' '
done
