#!/usr/bin/env bash
# Bring the live demo up: fund the operator keys, start the runners, start the keeper.
#
# Assumes the app is already built and serving (npm run build && npx next start -p 3009)
# and that `npm run provision` has created .data/demo-operators.json.
#
#   bash scripts/start-demo.sh
#
# Operators need STT for gas only. The collateral lives in the vault, and the
# operator key cannot withdraw it — that separation is the product, so the
# funding here is deliberately just gas.
set -euo pipefail
cd "$(dirname "$0")/.."

BASE="${BASE:-http://localhost:3009}"
LOGS="${LOGS:-.data/logs}"
mkdir -p "$LOGS"

[ -f .data/demo-operators.json ] || { echo "run 'npm run provision' first" >&2; exit 1; }
TOKEN=$(grep '^AGENT_CYCLE_TOKEN=' .env.local | cut -d= -f2)
[ -n "$TOKEN" ] || { echo "AGENT_CYCLE_TOKEN missing from .env.local" >&2; exit 1; }

echo "==> funding operator keys with gas"
node --experimental-strip-types scripts/fund-operators.ts

echo "==> starting runners"
# Thresholds tuned to the 5-minute BTC/ETH series that Shannon actually rolls:
# the defaults want 90s of price history and 240s of remaining life, which a
# 300s contract only offers in its first minute.
export AGENT_POLL_MS=8000 AGENT_LOOKBACK_SEC=30 AGENT_DRIFT_THRESHOLD=8000 \
       AGENT_MIN_RUNWAY_SEC=45 AGENT_MIN_REVERT_SEC=60 AGENT_REVERSION_BAND=120000 \
       AGENT_COOLDOWN_MS=30000 AGENT_MAX_ORDER=15000000 \
       SOMNIA_RPC_URL=https://dream-rpc.somnia.network \
       SOMNIA_INDEXER_URL=https://dev.smk.somnia.host/v1/graphql \
       SOMNIA_WS_RPC_URL=wss://api.infra.testnet.somnia.network/ws

node --experimental-strip-types -e '
import fs from "node:fs";
const ops = JSON.parse(fs.readFileSync(".data/demo-operators.json", "utf8"));
const strategy = { "alpha-z": "momentum", "neural-drift": "mean-reversion", "kestrel-7": "momentum" };
fs.writeFileSync(".data/runners.txt", ops.map((o) => [o.slug, o.vault, o.operatorKey, strategy[o.slug] ?? "momentum"].join("|")).join("\n") + "\n");
'

while IFS='|' read -r slug vault key strat; do
  [ -z "$slug" ] && continue
  AGENT_OPERATOR_KEY="$key" AGENT_VAULT="$vault" AGENT_SLUG="$slug" \
  AGENT_API="$BASE" AGENT_STRATEGY="$strat" \
    setsid nohup node --experimental-strip-types bots/runner.ts > "$LOGS/runner-$slug.log" 2>&1 < /dev/null &
  echo "    $slug ($strat)"
done < .data/runners.txt

echo "==> starting keeper"
BASE="$BASE" AGENT_CYCLE_TOKEN="$TOKEN" CYCLE_INTERVAL_MS=45000 \
  setsid nohup node --experimental-strip-types scripts/agent-cycle.ts --open > "$LOGS/keeper.log" 2>&1 < /dev/null &

sleep 2
echo
echo "up. logs in $LOGS/"
echo "  tail -f $LOGS/keeper.log"
echo "  tail -f $LOGS/runner-alpha-z.log"
