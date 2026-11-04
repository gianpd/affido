# docs/assets

Recordings of the running stack. Binaries live here so the README can show the
product instead of describing it.

## `gate-rejection.gif` / `gate-rejection.mp4`

The citation gate refusing a tampered quote, then publishing the reply whose
quote verifies. 30.5 s; GIF 960x730 at 12 fps (README), MP4 1440x900 at 30 fps
(everywhere else).

What is on screen, in order: the documents library and a vendor agreement's
clause 7.2 at line 8 (with the staged `source sha256`) → a strict question
(`citations: "required"`) → the model claims fees are payable **annually** →
the decision graph shows `corpus_annotate` and `answer_publish` both **error**,
and the annotation node opens the proposed quote beside
`{"error":"quote_mismatch","detail":"quote is not an exact span of …"}` → the
chat labels that reply *No document evidence* → the same model, asked to quote
exactly, publishes with the citation reference and the **Files used** panel
(`line 8 · attribution_verified`) → end card.

Honest boundaries, because this is a recording and not an illustration:

- **The model is the deterministic faux provider**, the same one the quickstart
  runs. Its transcript lives in `agent/citation-gate-demo.ts`; the corpus tools,
  the verifier and the publish gate are the shipped ones and were not modified.
  The refusal is theirs: the scripted model only proposes text that is not in the
  stored document.
- **There is no "REJECTED" chip in the chat**, because the product has none. The
  refusal is visible where the product shows it: the trace's error nodes and the
  gate's reason, plus the *no document evidence* label on the reply.
- **The UI never renders `textSha256`.** The document preview shows the source
  hash only; the stored-bytes hash is the mechanism, not a screen.
- The reply after a refused quote is *shown as prose with a label*, not withheld.
  A run that ends without any exit reports `evidence: "none"` on the envelope.

To see it yourself on the running stack: `./dev.sh up`, upload a short text file
whose clause 7.2 reads `7.2 Fees are payable quarterly in advance.` (Documents →
Add a document), turn **Strict citations** on in the chat and ask *"What does
clause 7.2 of the vendor agreement say?"* — then ask it to quote the clause
exactly. The two answers differ by one word, and only the second one publishes
with a citation.

To regenerate after a UI or gate change, use the capture pipeline in the
marketing repo (`marketing/launch-assets/gate-rejection/capture-script/`: reset,
seed, record with Playwright, encode with ffmpeg). Re-record rather than editing
frames: the value of this asset is that nothing in it was staged by hand.

The end card carries `github.com/gianpd/affido`. If the public repository moves,
change `REPO=` in that `encode.sh` and re-encode (≈20 s) — the takes do not
change.

## `judge-eval.mp4` / `judge-eval-poster.png`

A 2:27 English motion-graphic explainer on the citation coherence check. It is
not a screen recording: the renderer is a deterministic HTML timeline, recorded
frame by frame with Playwright and encoded with ffmpeg. 1920x1080, 30 fps,
synthetic English voiceover, burned-in captions; `judge-eval.srt` carries the
same captions as a soft track for players that want them.

The argument, in order: a quote can be an exact, hash-verified span of the
document and still be attached to a sentence it does not support → resolving
`[cit_7]` shows the span is byte-identical to the stored document while the
sentence is about the annual fee and the span about terminating the lease → the
check therefore asks one typed question (`supported` / `unrelated` /
`contradicted`) → 150 hand-labelled pairs (60 Italian, 60 dev, 30 test), with
false accepts and false rejects measured against a fixed bar → the local encoder
cuts false accepts but rejects half of the supported pairs, while the decision
model reaches 30/30 with 0% / 0% and ~200 ms per pair → the consequence is
claim-level faithfulness at write time, not a score computed after the answer
exists → the comparison with LAQuer is a comparison of moments (control vs
post-hoc measurement), so the numbers are not comparable.

There is no RFC jargon in the video, by design; the design record is
`docs/rfc/0017-citation-coherence-judge.md` and
`docs/rfc/0018-d1-openrouter-judge.md`. The source, narration, fonts and rebuild
commands live in [`judge-eval/`](judge-eval/README.md).

The eval numbers are the 2026-11-03 run on the 150-row set (60 Italian, 60 dev,
30 test); the 30/30 is the held-out slice, and a perfect held-out score does not
claim generalization. The video says so on screen.
