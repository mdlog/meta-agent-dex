#!/usr/bin/env python3
"""Burned-in captions (ASS) and the upload SRT, from edge-tts word boundaries.
Also writes the route-chip events and the segment timeline build.py consumes."""
import json
import pathlib

VIDEO = pathlib.Path(__file__).resolve().parent
OUT = VIDEO / "out"
PUBLIC_HOST = "meta-agent.mdloglabs.org"


def _flush(lines, start, end, out):
    if lines:
        out.append({"start": start, "end": end, "text": "\\N".join(lines)})


def cues(words, offset_s, delay_s, max_chars=42, max_lines=2, min_s=1.2):
    """Greedy: fill a line to max_chars, a cue to max_lines, and always end a cue
    at sentence-final punctuation so a thought is never split across cards."""
    out, lines, cur, start, prev_end = [], [], "", None, 0.0
    for w in words:
        t = w["text"]
        if start is None:
            start = offset_s + delay_s + w["start"]
        if cur and len(cur) + 1 + len(t) > max_chars:
            lines.append(cur)
            cur = ""
            if len(lines) == max_lines:
                _flush(lines, start, offset_s + delay_s + prev_end, out)
                lines, start = [], offset_s + delay_s + w["start"]
        cur = (cur + " " + t).strip()
        prev_end = w["end"]
        if t.endswith((".", "?", "!")):
            lines.append(cur)
            cur = ""
            _flush(lines, start, offset_s + delay_s + prev_end, out)
            lines, start = [], None
    if cur:
        lines.append(cur)
    if lines:
        _flush(lines, start, offset_s + delay_s + prev_end, out)
    # minimum readable duration, without overlapping the next cue
    for i, c in enumerate(out):
        want = c["start"] + min_s
        nxt = out[i + 1]["start"] if i + 1 < len(out) else float("inf")
        c["end"] = max(c["end"], min(want, nxt))
    return out


def ass_time(s):
    h, rem = divmod(s, 3600)
    m, sec = divmod(rem, 60)
    return f"{int(h)}:{int(m):02d}:{sec:05.2f}"


def srt_time(s):
    h, rem = divmod(s, 3600)
    m, sec = divmod(rem, 60)
    return f"{int(h):02d}:{int(m):02d}:{int(sec):02d},{int(round((sec - int(sec)) * 1000)):03d}"


HEADER = """[Script Info]
ScriptType: v4.00+
PlayResX: 1920
PlayResY: 1080
WrapStyle: 2
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Cap,Inter,40,&H00ECF3F0,&H00FFFFFF,&H00000000,&H8C000000,0,0,0,0,100,100,0,0,3,0,0,2,200,200,64,1
Style: Chip,DejaVu Sans Mono,24,&H00ECF3F0,&H00FFFFFF,&H00000000,&HA0000000,0,0,0,0,100,100,0,0,3,0,0,9,0,28,24,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""


def main():
    audio = json.loads((OUT / "audio" / "index.json").read_text())
    clips = {c["id"]: c for c in json.loads((OUT / "clips" / "index.json").read_text())}
    timeline, events, srt, t = [], [], [], 0.0
    for row in audio:
        words = json.loads((OUT / "audio" / row["words"]).read_text())
        for c in cues(words, t, row["delayMs"] / 1000):
            events.append(f"Dialogue: 0,{ass_time(c['start'])},{ass_time(c['end'])},Cap,,0,0,0,,{c['text']}")
            srt.append((c["start"], c["end"], c["text"].replace("\\N", "\n")))
        routes = clips[row["id"]]["routes"]
        for i, r in enumerate(routes):
            if not r["route"]:
                continue
            end = routes[i + 1]["atS"] if i + 1 < len(routes) else row["segmentS"]
            label = r["route"] if "." in r["route"].split("/")[0] else PUBLIC_HOST + r["route"]
            events.append(f"Dialogue: 1,{ass_time(t + r['atS'])},{ass_time(t + end)},Chip,,0,0,0,,{label}")
        timeline.append({"id": row["id"], "startS": round(t, 3), "segmentS": row["segmentS"]})
        t += row["segmentS"]
    (OUT / "captions.ass").write_text(HEADER + "\n".join(events) + "\n")
    (OUT / "captions.srt").write_text("".join(f"{i}\n{srt_time(a)} --> {srt_time(b)}\n{txt}\n\n" for i, (a, b, txt) in enumerate(srt, 1)))
    (OUT / "timeline.json").write_text(json.dumps(timeline, indent=1))
    print(f"{len(srt)} cues, total {t:.1f}s -> captions.ass / captions.srt / timeline.json")


if __name__ == "__main__":
    main()
