# judge-eval video source

The 2:27 English explainer at `../judge-eval.mp4`, its poster and its SRT are
built from this folder. The renderer is a single HTML page driven by
`window.renderAt(t)`: no CSS animations, no wall clock, so every frame is
deterministic and re-renderable.

## Layout

| Path | Role |
|---|---|
| `src/narration.json` | scene text, TTS speech overrides, voice and pacing |
| `audio/<scene>.mp3` / `.srt` | edge-tts output, one file per scene |
| `src/build-timeline.py` | ffprobe durations → `src/timeline.js`, `src/timeline.json`, `src/subtitles.srt` |
| `src/index.html` | all scenes, CSS and the `renderAt(t)` timeline |
| `src/fixtures-labels.js` | the 150 pair cells of the eval grid, in display order |
| `src/mix-audio.py` | narration + low music bed + hard-cut SFX → `audio/mix.wav` |
| `src/render-video.mjs` | Playwright screenshots piped to ffmpeg → `../judge-eval.mp4`, `../judge-eval-poster.png` |
| `fonts/` | Geist, Geist Mono and Jersey 10, self-hosted |
| `brand/` | the affido wordmark copied from `frontend/static/brand/` |

## Rebuild

```bash
cd docs/assets/judge-eval
python3 src/build-timeline.py       # only after changing narration/audio
python3 src/mix-audio.py
node src/render-video.mjs           # needs frontend/node_modules (Playwright)
```

`src/render-video.mjs` writes the final MP4 and poster to `docs/assets/`.
`audio/mix.wav` and `out/` are ignored: regenerate them.

The narration is generated with `edge-tts` (`en-US-AndrewNeural`, rate `+2%`).
The MP3s are kept so the video can be rebuilt offline; the voice is synthetic,
not a recorded human.

## Editorial boundary

The video has no RFC references by design: it is a public explainer, not a
design record. It states the eval numbers and the 150-pair / one-domain limit
on screen. It is a motion-graphic explainer, not a recording of the product.
