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

## What to look at before sending it

- `out/contact.png` — one frame every 5 s. No SIMULATED DATA bar, no 404, no empty
  table where the narration says there are rows.
- `out/take.json` — the agent, both markets and the Beat-3 case the video claims.
- `out/meta-agent-dex-demo.srt` — read it once; it is exactly what the voice says.
- `bash video/verify.sh` — duration ≤ 3:00, streams, cue counts, narrated numbers
  against the take, speculators back on `AGENT_WIND_DOWN=1`, no media staged.

## How the shots are made

- Terminal shots and the end card are a full-screen iframe over the page that is
  already loaded, so cutting back to the app is a DOM removal, not a navigation.
- The explorer shot is a screenshot of the real Shannon explorer page for the
  tape's newest transaction, captured off-camera at the start of Beat 4 (the
  explorer takes ~12 s to render, longer than the beat can wait).
- `video/tts.py --timing-only` recomputes segment lengths after a change to
  `minVisualMs` or an action's hold without re-synthesising the voice.

## First take — 2026-09-11

Neural Drift, session #32 open (case A: the skeptic's NO bids resting at
0.158/0.151/0.144/0.138), session #30 settled NO · Down (200.00 → 28.45).
173.2 s at rate +6% with the spec's four cuts applied.
