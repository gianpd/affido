#!/usr/bin/env python3
"""Mix the narration, a low music bed and a few hard-cut SFX.

Input : src/timeline.json, audio/<scene>.mp3
Output: audio/mix.wav (48 kHz stereo, 16 bit)
"""
import json
import pathlib
import subprocess
import tempfile

import numpy as np
from scipy.io import wavfile

ROOT = pathlib.Path(__file__).resolve().parent.parent
T = json.loads((ROOT / "src/timeline.json").read_text())
SR = 48_000
N = int(round(T["total"] * SR))
rng = np.random.default_rng(7)


def read_mp3(path):
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
        name = tmp.name
    subprocess.run(
        ["ffmpeg", "-y", "-v", "error", "-i", str(path), "-ar", str(SR), "-ac", "1", name],
        check=True,
    )
    sr, x = wavfile.read(name)
    pathlib.Path(name).unlink(missing_ok=True)
    if x.dtype == np.int16:
        x = x.astype(np.float32) / 32768.0
    else:
        x = x.astype(np.float32)
    return x


def add(buf, at, sig, gain=1.0):
    i = int(round(at * SR))
    if i >= len(buf):
        return
    j = min(len(buf), i + len(sig))
    buf[i:j] += sig[: j - i] * gain


# ---------------------------------------------------------------- voice
voice = np.zeros(N, dtype=np.float32)
for sc in T["scenes"]:
    x = read_mp3(ROOT / "audio" / f"{sc['id']}.mp3")
    # edge-tts is consistent; a light lift keeps the voice above the bed
    add(voice, sc["audioStart"], x * 1.38)

# ---------------------------------------------------------------- music
music = np.zeros((N, 2), dtype=np.float32)
bpm = 84.0
beat = 60.0 / bpm
bar = beat * 4
chords = [
    (55.00, 130.81, 164.81),   # Am
    (43.65, 110.00, 130.81),   # F
    (65.41, 164.81, 196.00),   # C
    (49.00, 123.47, 146.83),   # G
]
# pad: one chord every 8 s, slow fades, stereo detune
seg = 8.0
for k, start in enumerate(np.arange(0.0, T["total"], seg)):
    chord = chords[k % len(chords)]
    n = int(round(seg * SR))
    t = np.arange(n) / SR
    env = np.minimum(1.0, np.minimum(t / 0.8, (seg - t) / 0.8))
    env = np.clip(env, 0.0, 1.0) ** 1.4
    lfo = 0.82 + 0.18 * np.sin(2 * np.pi * 0.055 * (t + k * seg))
    left = np.zeros(n, dtype=np.float32)
    right = np.zeros(n, dtype=np.float32)
    for f in chord:
        left += 0.33 * np.sin(2 * np.pi * (f + 0.18) * t)
        right += 0.33 * np.sin(2 * np.pi * (f - 0.18) * t)
    left *= env * lfo
    right *= env * lfo
    i = int(round(start * SR))
    j = min(N, i + n)
    music[i:j, 0] += left[: j - i] * 0.055
    music[i:j, 1] += right[: j - i] * 0.055

# pulse + hats: soft, 84 BPM; intensity rises through the middle
for b in range(int(T["total"] / beat) + 1):
    at = b * beat
    env = np.linspace(0, 1, 8)  # no-op guard
    # deep pulse
    n = int(0.20 * SR)
    t = np.arange(n) / SR
    root = chords[int(at / seg) % len(chords)][0]
    kick = np.sin(2 * np.pi * root * t) * np.exp(-t / 0.055)
    kick *= 0.13 if 18 <= at < 126 else 0.09
    add(music[:, 0], at, kick.astype(np.float32), 1.0)
    add(music[:, 1], at, kick.astype(np.float32), 1.0)
    # off-beat tick
    if b % 2 == 1:
        n = int(0.025 * SR)
        t = np.arange(n) / SR
        tick = rng.normal(0, 1, n).astype(np.float32)
        tick = np.diff(tick, prepend=0.0) * np.exp(-t / 0.004)
        add(music[:, 0], at + beat / 2, tick, 0.012)
        add(music[:, 1], at + beat / 2, tick, 0.010)

# ---------------------------------------------------------------- sfx
sfx = np.zeros((N, 2), dtype=np.float32)


def impact(at, amp=0.22):
    n = int(0.42 * SR)
    t = np.arange(n) / SR
    f = 78 * np.exp(-t / 0.09) + 38
    sig = np.sin(2 * np.pi * f * t) * np.exp(-t / 0.11)
    sig += 0.25 * rng.normal(0, 1, n) * np.exp(-t / 0.012)
    add(sfx[:, 0], at, sig.astype(np.float32), amp)
    add(sfx[:, 1], at, sig.astype(np.float32), amp)


def whoosh(at, amp=0.10):
    n = int(0.32 * SR)
    t = np.arange(n) / SR
    noise = rng.normal(0, 1, n).astype(np.float32)
    # cheap band sweep: difference of two one-pole filters would be cleaner;
    # a rising sine + noise reads as a cut without a filter bank.
    sweep = np.sin(2 * np.pi * (280 + 1800 * t / 0.32) * t)
    env = np.sin(np.pi * t / 0.32) ** 1.6
    sig = (0.55 * noise + 0.45 * sweep) * env
    add(sfx[:, 0], at - 0.16, sig, amp)
    add(sfx[:, 1], at - 0.16, sig, amp * 0.92)


def buzz(at, amp=0.08):
    n = int(0.22 * SR)
    t = np.arange(n) / SR
    sig = np.sign(np.sin(2 * np.pi * 92 * t)) * 0.5
    sig += 0.5 * np.sin(2 * np.pi * 184 * t)
    sig *= np.exp(-t / 0.08)
    add(sfx[:, 0], at, sig.astype(np.float32), amp)
    add(sfx[:, 1], at, sig.astype(np.float32), amp * 0.9)


def chime(at, amp=0.09):
    n = int(0.65 * SR)
    t = np.arange(n) / SR
    sig = np.zeros(n, dtype=np.float32)
    for f, g in [(523.25, 0.5), (659.25, 0.35), (783.99, 0.3)]:
        sig += g * np.sin(2 * np.pi * f * t) * np.exp(-t / 0.22)
    add(sfx[:, 0], at, sig, amp)
    add(sfx[:, 1], at, sig, amp * 0.9)


# scene cuts: a short low impact and a soft swish into every cut
for sc in T["scenes"][1:]:
    impact(sc["start"], 0.10)
    whoosh(sc["start"], 0.075)

sc = {s["id"]: s["start"] for s in T["scenes"]}

# hard moments (scene-local beats, same clock as index.html)
whoosh(2.1, 0.06)                      # cit_7 resolves
impact(8.9, 0.26)                      # UNRELATED stamp
buzz(8.92, 0.055)
impact(sc["gap"] + 12.9, 0.14)         # meaning: not checked
impact(sc["judge"] + 2.5, 0.12)        # judge appears
impact(sc["judge"] + 17.1, 0.16)       # answer blocked
impact(sc["eval"] + 10.8, 0.09)        # metric 1
impact(sc["results"] + 7.6, 0.20)      # local model rejected
buzz(sc["results"] + 7.6, 0.045)
chime(sc["results"] + 9.4, 0.085)      # API accepted
impact(sc["change"] + 5.9, 0.24)       # contradicted
buzz(sc["change"] + 5.9, 0.05)
impact(sc["change"] + 12.0, 0.20)      # blocked
impact(sc["laquer"] + 11.7, 0.16)
chime(sc["close"] + 7.2, 0.11)
impact(sc["close"] + 7.2, 0.18)

# ---------------------------------------------------------------- mix
mix = np.stack([voice, voice], axis=1) + music + sfx
# gentle fade in/out
fade = int(0.35 * SR)
mix[:fade] *= np.linspace(0, 1, fade)[:, None]
mix[-fade:] *= np.linspace(1, 0, fade)[:, None]
peak = float(np.max(np.abs(mix)))
if peak > 0.90:
    mix *= 0.90 / peak
# soft limiter for the few transients that still poke out
mix = np.tanh(mix * 1.15) / np.tanh(1.15)
peak = float(np.max(np.abs(mix)))
if peak > 0.98:
    mix *= 0.98 / peak

out = ROOT / "audio" / "mix.wav"
wavfile.write(out, SR, (np.clip(mix, -1, 1) * 32767).astype(np.int16))
print(out, f"{T['total']:.2f}s", "peak", round(float(np.max(np.abs(mix))), 3))
