#!/usr/bin/env python3
"""Narration via edge-tts, one file per beat, with word boundaries for captions.

Runs the spec's length rule: > 172 s at +0% -> re-render at +6%; still over ->
stop and print the cut list, because a faster voice would cost the judges more
than a shorter script does.
"""
import asyncio
import json
import pathlib
import subprocess
import sys

VIDEO = pathlib.Path(__file__).resolve().parent
OUT = VIDEO / "out" / "audio"
VOICE = "en-US-AndrewNeural"
GAP_S = 0.4
LIMIT_S = 172.0
CUT_LIST = [
    'Beat 3: "What is on this book came from the processes you just saw:" -> "That is"',
    'Beat 4: drop "visible to anyone and counted by nothing"',
    'Beat 6: drop "the first meta-market we minted,"',
    'Beat 2: drop "It cannot withdraw."',
]


def segment_seconds(audio_s: float, delay_ms: int, min_visual_ms: int) -> float:
    return max(audio_s + delay_ms / 1000 + GAP_S, min_visual_ms / 1000)


def apply_rule(total_s: float, rate: str):
    if total_s <= LIMIT_S:
        return ("ok", rate)
    if rate == "+0%":
        return ("rerender", "+6%")
    return ("cut", rate)


def narration():
    raw = subprocess.check_output(
        ["node", "--experimental-strip-types", str(VIDEO / "script.ts"), "--narration"],
        text=True, stderr=subprocess.DEVNULL,
    )
    return json.loads(raw)


def duration_s(mp3: pathlib.Path) -> float:
    out = subprocess.check_output(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(mp3)], text=True
    )
    return float(out.strip())


async def synth(text: str, mp3: pathlib.Path, rate: str):
    import edge_tts

    words = []
    com = edge_tts.Communicate(text, VOICE, rate=rate, boundary="WordBoundary")
    with mp3.open("wb") as f:
        async for chunk in com.stream():
            if chunk["type"] == "audio":
                f.write(chunk["data"])
            elif chunk["type"] == "WordBoundary":
                words.append({
                    "start": chunk["offset"] / 1e7,
                    "end": (chunk["offset"] + chunk["duration"]) / 1e7,
                    "text": chunk["text"],
                })
    return words


async def render(rate: str):
    OUT.mkdir(parents=True, exist_ok=True)
    index = []
    for beat in narration():
        base = beat["id"]
        mp3 = OUT / f"{base}.mp3"
        for attempt in range(3):
            try:
                words = await synth(beat["text"], mp3, rate)
                break
            except Exception as e:  # network hiccup: retry, then give up loudly
                if attempt == 2:
                    raise
                print(f"  {base}: {e!r}; retrying", file=sys.stderr)
                await asyncio.sleep(2 * (attempt + 1))
        (OUT / f"{base}.words.json").write_text(json.dumps(words, indent=1))
        audio_s = duration_s(mp3)
        seg = segment_seconds(audio_s, beat["delayMs"], beat["minVisualMs"])
        index.append({
            "id": beat["id"], "mp3": mp3.name, "words": f"{base}.words.json",
            "delayMs": beat["delayMs"], "minVisualMs": beat["minVisualMs"],
            "audioS": round(audio_s, 3), "segmentS": round(seg, 3), "rate": rate,
        })
        print(f"  {base}: {audio_s:6.2f}s speech -> {seg:6.2f}s segment ({len(words)} words)")
    return index


def retime():
    """Recompute segment lengths from the existing audio after script timing changes."""
    index = json.loads((OUT / "index.json").read_text())
    by_id = {b["id"]: b for b in narration()}
    for row in index:
        b = by_id[row["id"]]
        row["delayMs"], row["minVisualMs"] = b["delayMs"], b["minVisualMs"]
        row["segmentS"] = round(segment_seconds(row["audioS"], b["delayMs"], b["minVisualMs"]), 3)
        print(f"  {row['id']}: {row['audioS']:6.2f}s speech -> {row['segmentS']:6.2f}s segment")
    total = sum(r["segmentS"] for r in index)
    print(f"total {total:.1f}s")
    (OUT / "index.json").write_text(json.dumps(index, indent=1))


def main():
    if "--timing-only" in sys.argv:
        retime()
        return
    rate = "+0%"
    while True:
        print(f"rendering at rate {rate}")
        index = asyncio.run(render(rate))
        total = sum(b["segmentS"] for b in index)
        print(f"total {total:.1f}s (limit {LIMIT_S:.0f}s)")
        verdict, rate = apply_rule(total, rate)
        if verdict == "ok":
            break
        if verdict == "cut":
            print("still over after +6%. Apply the cut list, in order, in video/script.ts:")
            for c in CUT_LIST:
                print("  -", c)
            sys.exit(2)
    (OUT / "index.json").write_text(json.dumps(index, indent=1))
    print("wrote", OUT / "index.json")


if __name__ == "__main__":
    main()
