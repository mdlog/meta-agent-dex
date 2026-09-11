# Demo video pipeline

Produces `out/meta-agent-dex-demo.mp4` (+ `.srt`) from the live app on
`localhost:3009`. Spec: `docs/superpowers/specs/2026-09-11-demo-video-design.md`.

## One-time setup

    npm --prefix video install
    python3 -m venv video/.venv && video/.venv/bin/pip install edge-tts

## Re-shoot, start to finish (≈20 min)

    bash video/speculators.sh on            # optional: lets the layer-2 agents quote during the take
    node --experimental-strip-types video/select.ts        # → out/take.json (aborts if not filmable)
    video/.venv/bin/python video/tts.py                                   # → out/audio/*.mp3 + index.json
    node --experimental-strip-types video/record.ts --probe # every selector resolves?
    node --experimental-strip-types video/record.ts        # → out/clips/*.webm
    video/.venv/bin/python video/captions.py                              # → out/captions.ass + .srt
    video/.venv/bin/python video/build.py                                 # → out/meta-agent-dex-demo.mp4
    bash video/speculators.sh off           # back to redeem-only

Tests: `node --experimental-strip-types --test video/test/*.test.ts` and
`python3 -m unittest discover -s video/test -p "test_*.py"`.
