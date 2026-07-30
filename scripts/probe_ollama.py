#!/usr/bin/env python3
"""Check that the Ollama endpoint can do what the app design assumes.

The design leans on two things being true:

  1. gemma4:12b reliably returns schema-valid JSON, because the deterministic
     matching layer consumes it directly. If it only mostly works, the chat
     pathway needs a repair loop and the whole thing gets slower and flakier.
  2. gemma4:12b can read text off a slide image, because pitch decks are usually
     exported slides with no extractable text layer. It is multimodal, so the
     same model covers both paths - no second model, no OCR dependency.

Thinking is on by default and dominates latency (chat 17s vs 3s, extraction
44s vs 11s with "think": false on Ollama's native /api/chat). It is not a free
win: with thinking off the weakest-three areas stopped agreeing across runs at
temperature 0, and that ranking is what picks the experts. So the app runs chat
turns with thinking off for responsiveness, and the single final extraction with
thinking on for a stable, reproducible recommendation. THINK below flips the
mode so the tradeoff stays measurable rather than becoming folklore.

Run it before building against either assumption:

    OLLAMA_BASE_URL=... OLLAMA_API_KEY=... python3 scripts/probe_ollama.py

Reports pass/fail and per-call latency. Exits non-zero if an assumption fails.
"""

import base64
import io
import json
import os
import sys
import time
import urllib.error
import urllib.request

BASE = os.environ.get("OLLAMA_BASE_URL", "").rstrip("/")
KEY = os.environ.get("OLLAMA_API_KEY", "")
# One multimodal model for both paths.
MODEL = os.environ.get("OLLAMA_MODEL", "gemma4:12b")
# 1/0 - thinking on is slow but makes the ranking reproducible.
THINK = os.environ.get("OLLAMA_THINK", "1") == "1"

# Trimmed version of the real extraction schema. Confidence is 0-5 to match the
# self-score pathway, so both pathways feed the matcher identically.
# Stage is deliberately absent: the founder is asked directly in one tap, which
# is instant and correct. Inferring it cost ~35s and was wrong two runs in three.
#
# All eight areas are required rather than left to the model's discretion. An
# array of "the ones it felt like scoring" leaves the ranking incomplete, and
# silently so - a missing area is not the same as a low-confidence one.
AREA_IDS = ["validate", "strategy", "product", "market", "ip", "funding", "pitch", "founder"]

SCHEMA = {
    "type": "object",
    "properties": {
        "sector": {"type": "string"},
        **{
            aid: {
                "type": "object",
                "properties": {
                    "confidence": {"type": "integer", "minimum": 0, "maximum": 5},
                    "evidence": {"type": "string"},
                },
                "required": ["confidence", "evidence"],
            }
            for aid in AREA_IDS
        },
    },
    "required": ["sector", *AREA_IDS],
}

SAMPLE = """
We're two engineers building a sensor that detects early corrosion in mining
conveyor belts. We have a working prototype deployed at one site in the
Pilbara and a signed pilot with a second. We've spoken to about fifteen
maintenance managers. We haven't filed anything for the sensor design and
we're not sure whether we should. Neither of us has raised money before and
we don't really know what a data room is. Revenue so far is the pilot fee.
"""


def call(payload, timeout=180):
    # No keep_alive: the endpoint preloads gemma4:12b into VRAM, and sending
    # our own value would reset its unload timer. Sticking to one model also
    # means we never evict it and never pay a reload stall mid-session.
    req = urllib.request.Request(
        f"{BASE}/api/chat",
        data=json.dumps(payload).encode(),
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {KEY}",
        },
    )
    start = time.monotonic()
    with urllib.request.urlopen(req, timeout=timeout) as r:
        body = json.loads(r.read())
    return body, time.monotonic() - start


def slide_image():
    """A synthetic 'exported slide' - text rendered into pixels, no text layer.
    Stands in for the pitch decks founders will actually upload."""
    from PIL import Image, ImageDraw

    img = Image.new("RGB", (1000, 620), "#14263a")
    d = ImageDraw.Draw(img)
    d.text((60, 70), "CORRO-SENSE", fill="#f5b921")
    d.text((60, 150), "Early corrosion detection for mining conveyors", fill="white")
    d.text((60, 250), "- Prototype live at one Pilbara site", fill="#cfe0f0")
    d.text((60, 300), "- Second pilot signed", fill="#cfe0f0")
    d.text((60, 350), "- 15 maintenance manager interviews", fill="#cfe0f0")
    d.text((60, 400), "- No patent filed yet", fill="#cfe0f0")
    d.text((60, 500), "Seeking: first raise, IP guidance", fill="#f5b921")
    buf = io.BytesIO()
    img.save(buf, "PNG")
    return base64.b64encode(buf.getvalue()).decode()


def probe_structured(runs=3):
    print(f"[1] {MODEL} - schema-valid JSON over {runs} runs")
    ok = 0
    results = []
    for i in range(runs):
        try:
            body, secs = call(
                {
                    "model": MODEL,
                    "stream": False,
                    "think": THINK,
                    "format": SCHEMA,
                    "options": {"temperature": 0},
                    "messages": [
                        {
                            "role": "system",
                            "content": (
                                "Score how well evidenced each area of this founder's venture is, "
                                "0 to 5, where 0 is no evidence at all and 5 is clearly strong. "
                                "Score every area. Evidence must be a short verbatim quote from "
                                "the founder, or an empty string if they said nothing about it. "
                                "Reply with JSON only."
                            ),
                        },
                        {"role": "user", "content": SAMPLE.strip()},
                    ],
                }
            )
            raw = body["message"]["content"]
            data = json.loads(raw)
            missing = [a for a in AREA_IDS if a not in data]
            assert not missing, f"missing areas: {missing}"
            weakest = sorted(AREA_IDS, key=lambda a: data[a]["confidence"])[:3]
            ok += 1
            results.append(tuple(sorted(weakest)))
            print(
                f"    run {i+1}: ok  {secs:5.1f}s  areas={len(AREA_IDS)}"
                f"  weakest={weakest}"
            )
        except (json.JSONDecodeError, AssertionError, KeyError) as e:
            print(f"    run {i+1}: BAD OUTPUT  {type(e).__name__}: {e}")
        except urllib.error.URLError as e:
            print(f"    run {i+1}: TRANSPORT   {e}")
    stable = len(set(results)) == 1 if results else False
    print(f"    -> {ok}/{runs} valid; weakest-three {'STABLE' if stable else 'VARIES ACROSS RUNS'}\n")
    return ok == runs and stable


def probe_vision():
    print(f"[2] {MODEL} - reading text off a slide image")
    try:
        body, secs = call(
            {
                "model": MODEL,
                "stream": False,
                "think": THINK,
                "options": {"temperature": 0},
                "messages": [
                    {
                        "role": "user",
                        "content": "Transcribe every word visible in this slide. Output the text only.",
                        "images": [slide_image()],
                    }
                ],
            }
        )
        text = body["message"]["content"]
        wanted = ["corro", "pilbara", "pilot", "patent"]
        hit = [w for w in wanted if w in text.lower()]
        print(f"    {secs:5.1f}s, recovered {len(hit)}/{len(wanted)} key terms: {hit}")
        print(f"    transcript: {' '.join(text.split())[:180]}")
        good = len(hit) >= 3
        print(f"    -> {'usable' if good else 'NOT USABLE for image-only decks'}\n")
        return good
    except urllib.error.URLError as e:
        print(f"    TRANSPORT ERROR: {e}\n")
        return False


def main():
    if not BASE or not KEY:
        sys.exit("set OLLAMA_BASE_URL and OLLAMA_API_KEY (see .env.example)")
    print(f"endpoint: {BASE}   think={THINK}\n")
    results = [probe_structured(), probe_vision()]
    if all(results):
        print("Both assumptions hold - the design is safe to build against.")
        return 0
    print("At least one assumption failed; see above before building on it.")
    return 1


if __name__ == "__main__":
    sys.exit(main())
