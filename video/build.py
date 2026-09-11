#!/usr/bin/env python3
"""Trims each clip to its segment, muxes its narration, concatenates, burns the
captions and the route chip, and refuses to emit anything over 3:00."""
import json
import pathlib
import shutil
import subprocess
import sys

VIDEO = pathlib.Path(__file__).resolve().parent
OUT = VIDEO / "out"
SEG = OUT / "seg"
FINAL = OUT / "meta-agent-dex-demo.mp4"
LIMIT_S = 180.0


def run(*args, cwd=None):
    subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", *args], check=True, cwd=cwd)


def probe(path, entries="format=duration"):
    return subprocess.check_output(
        ["ffprobe", "-v", "error", "-show_entries", entries, "-of", "csv=p=0", str(path)], text=True
    ).strip()


def main():
    timeline = json.loads((OUT / "timeline.json").read_text())
    audio = {a["id"]: a for a in json.loads((OUT / "audio" / "index.json").read_text())}
    clips = {c["id"]: c for c in json.loads((OUT / "clips" / "index.json").read_text())}
    SEG.mkdir(exist_ok=True)
    parts = []
    for row in timeline:
        i, seg_s = row["id"], row["segmentS"]
        clip = OUT / "clips" / clips[i]["clip"]
        rec_s = float(probe(clip))
        if rec_s + 0.05 < seg_s:
            sys.exit(f"{i}: clip is {rec_s:.2f}s but the segment needs {seg_s:.2f}s — re-record it (record.ts --only={i})")
        delay_ms = audio[i]["delayMs"]
        out = SEG / f"{i}.mp4"
        run(
            "-i", str(clip), "-i", str(OUT / "audio" / audio[i]["mp3"]),
            "-filter_complex",
            f"[0:v]fps=30,scale=1920:1080:flags=lanczos,setsar=1,trim=duration={seg_s},setpts=PTS-STARTPTS[v];"
            f"[1:a]aresample=48000,adelay={delay_ms}|{delay_ms},apad,atrim=duration={seg_s},asetpts=PTS-STARTPTS[a]",
            "-map", "[v]", "-map", "[a]", "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p",
            "-c:a", "aac", "-b:a", "160k", "-ar", "48000", "-ac", "2", str(out),
        )
        parts.append(out)
        print(f"  {i}: {seg_s:.2f}s")
    lst = SEG / "list.txt"
    lst.write_text("".join(f"file '{p.name}'\n" for p in parts))
    concat = SEG / "concat.mp4"
    run("-f", "concat", "-safe", "0", "-i", str(lst), "-c", "copy", str(concat))
    # burn captions: run from OUT so the ass filter gets a plain relative path
    run("-i", str(concat.relative_to(OUT)), "-vf", "ass=captions.ass",
        "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p",
        "-c:a", "copy", "-movflags", "+faststart", FINAL.name, cwd=OUT)
    shutil.copy(OUT / "captions.srt", FINAL.with_suffix(".srt"))
    total = float(probe(FINAL))
    wh = probe(FINAL, "stream=width,height,r_frame_rate")
    run("-i", str(FINAL), "-vf", "fps=1/5,scale=480:-1,tile=6x6", str(OUT / "contact.png"))
    print(f"\n{FINAL.name}: {total:.1f}s, {wh}")
    if total > LIMIT_S:
        sys.exit(f"over the 3:00 ceiling by {total - LIMIT_S:.1f}s — apply the cut list in video/tts.py and re-run tts → record → captions → build")
    print("ok: under 3:00. Contact sheet:", OUT / "contact.png")


if __name__ == "__main__":
    main()
