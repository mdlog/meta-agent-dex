#!/usr/bin/env bash
# One-shot: commit the working tree and publish it to GitHub.
# Run from anywhere:  bash scripts/push-to-github.sh
set -euo pipefail
cd "$(dirname "$0")/.."

echo "==> repo: $PWD"
git add -A

# Refuse to publish if a private key ever slips past .gitignore.
if git diff --cached --name-only | xargs -r grep -lE 'PRIVATE_KEY *= *0x[a-fA-F0-9]{64}|"botKey"' 2>/dev/null | grep .; then
  echo "ABORT: a private key is staged. Fix .gitignore before pushing." >&2
  exit 1
fi
echo "==> $(git diff --cached --name-only | wc -l) files staged, no keys found"

if git rev-parse HEAD >/dev/null 2>&1; then
  git commit -m "Meta-Agent DEX: verified design + control-plane spike" || echo "(nothing new to commit)"
else
  git commit -m "Meta-Agent DEX: verified design + control-plane spike

Pivots Forecast Arena to a meta-layer market on autonomous agent
performance. Every load-bearing protocol claim in the design was checked
against live Somnia Shannon before any UI was written: self-serve
operator/venue registration, third-party Event Contract creation via
scheduleAndCreateMarket, and settlement by the DreamDEX oracle committee
reading a contract we deployed.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01MnSaKrrKekHLhrvJBZCzDk"
fi

if git remote get-url origin >/dev/null 2>&1; then
  echo "==> origin exists, pushing"
  git push -u origin main
else
  echo "==> creating public repo meta-agent-dex"
  gh repo create meta-agent-dex --public --source=. --remote=origin --push \
    --description "Meta-Agent DEX — speculate on autonomous AI trading agents. Somnia Network + DreamDEX Event Contracts."
fi

echo
echo "==> done"
git log --oneline -1
gh repo view --json url -q .url 2>/dev/null || git remote get-url origin
