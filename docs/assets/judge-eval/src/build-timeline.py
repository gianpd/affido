#!/usr/bin/env python3
"""Build the video timeline from narration.json + generated MP3 durations.

Writes src/timeline.js (consumed by index.html), src/timeline.json (render and
audio mix) and src/subtitles.srt (display text, shifted onto the video clock).
"""
import json, re, subprocess, pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent
NAR = json.loads((ROOT / "src/narration.json").read_text())
lead, tail = NAR.get("lead", 0.35), NAR.get("tail", 0.7)


def duration(path: pathlib.Path) -> float:
    out = subprocess.check_output(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "default=nw=1:nk=1", str(path)]
    )
    return float(out.decode().strip())


def parse_srt(text: str):
    cues = []
    for block in re.split(r"\n\s*\n", text.strip()):
        lines = block.splitlines()
        if len(lines) < 3:
            continue
        times = re.match(r"(\d+):(\d+):(\d+),(\d+) --> (\d+):(\d+):(\d+),(\d+)", lines[1])
        if not times:
            continue
        g = list(map(int, times.groups()))
        start = g[0] * 3600 + g[1] * 60 + g[2] + g[3] / 1000
        end = g[4] * 3600 + g[5] * 60 + g[6] + g[7] / 1000
        cues.append({"start": start, "end": end, "text": " ".join(lines[2:]).strip()})
    return cues


def sentences(text: str):
    return [s.strip() for s in re.split(r"(?<=[.!?])\s+", text) if s.strip()]


def srt_time(t: float) -> str:
    ms = int(round(t * 1000))
    h, ms = divmod(ms, 3600_000)
    m, ms = divmod(ms, 60_000)
    s, ms = divmod(ms, 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


scenes = []
cursor = 0.0
all_cues = []
for sc in NAR["scenes"]:
    audio = ROOT / "audio" / f"{sc['id']}.mp3"
    dur = duration(audio)
    start = cursor
    audio_start = start + lead
    end = audio_start + dur + tail
    scenes.append({
        "id": sc["id"], "no": sc["no"], "kicker": sc["kicker"],
        "title": sc["title"], "text": sc["text"],
        "start": round(start, 3), "audioStart": round(audio_start, 3),
        "duration": round(dur, 3), "end": round(end, 3),
    })
    cues = parse_srt((ROOT / "audio" / f"{sc['id']}.srt").read_text())
    display = sentences(sc["text"])
    if len(display) == len(cues):
        for cue, sentence in zip(cues, display):
            cue["text"] = sentence
    for cue in cues:
        all_cues.append({
            "start": round(audio_start + cue["start"], 3),
            "end": round(audio_start + cue["end"], 3),
            "text": cue["text"],
        })
    cursor = end

outro = 2.2
total = round(cursor + outro, 3)
data = {"lead": lead, "tail": tail, "outro": outro, "total": total, "scenes": scenes, "cues": all_cues}
(ROOT / "src/timeline.json").write_text(json.dumps(data, ensure_ascii=False, indent=2))
(ROOT / "src/timeline.js").write_text(
    "window.TIMELINE = " + json.dumps(data, ensure_ascii=False, separators=(",", ":")) + ";\n"
)
blocks = []
for i, cue in enumerate(all_cues, 1):
    blocks.append(f"{i}\n{srt_time(cue['start'])} --> {srt_time(cue['end'])}\n{cue['text']}\n")
(ROOT / "src/subtitles.srt").write_text("\n".join(blocks))
print(json.dumps({"total": total, "scenes": [(s["id"], s["start"], s["end"]) for s in scenes]}, indent=1))
