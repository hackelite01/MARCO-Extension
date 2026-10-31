"""Thin async wrapper around Gemma 4 served through the Gemini API."""
import asyncio
import json
import random
import re
import time

from google import genai
from google.genai import errors, types

from . import config

MAX_ATTEMPTS = 8
MAX_RATE_WAIT = 20  # seconds; longest we will sit out a rate limit before retrying
RETRYABLE = (429, 500, 503, 504)


def _retry_after(err):
    """Seconds the API asks us to wait after a 429 (from its RetryInfo, or 'retry in 13.2s' in the message)."""
    for d in ((getattr(err, "details", None) or {}).get("error", {}).get("details", [])):
        if "RetryInfo" in str(d.get("@type", "")):
            m = re.match(r"([\d.]+)", str(d.get("retryDelay", "")))
            if m:
                return float(m.group(1)) + 0.5
    m = re.search(r"retry in ([\d.]+)s", str(err))
    return float(m.group(1)) + 0.5 if m else 8.0


async def _first_success(tasks):
    """Wait for the first task that succeeds; cancel the rest. Returns (result, None) or (None, last_error)."""
    pending, last = set(tasks), None
    while pending:
        done, pending = await asyncio.wait(pending, return_when=asyncio.FIRST_COMPLETED)
        for t in done:
            if t.exception() is None:
                for p in pending:
                    p.cancel()
                return t.result(), None
            last = t.exception()
    return None, last


class Gemma:
    def __init__(self):
        self.client = genai.Client(api_key=config.API_KEY)
        self.model = config.MODEL
        # Some Gemma endpoints reject system_instruction; we detect that once and
        # fold the instructions into the first user turn instead.
        self._system_in_prompt = False
        # Gemma 4 "thinks" by default (100-200 hidden tokens, ~3s per call). MINIMAL cuts that
        # while keeping tool calls reliable. Set GEMMA_THINKING=default to turn this off.
        self._minimal_thinking = config.THINKING != "default"
        self._no_hedge_until = 0.0  # monotonic time before which we do not race duplicate requests

    @staticmethod
    def _contents(messages, system, fold_system):
        out = []
        for i, m in enumerate(messages):
            parts = []
            text = m["text"]
            if fold_system and i == 0:
                text = f"{system}\n\n---\n\n{text}"
            parts.append(types.Part.from_text(text=text))
            if m.get("image"):
                mime = "image/png" if m["image"][:4] == b"\x89PNG" else "image/jpeg"
                parts.append(types.Part.from_bytes(data=m["image"], mime_type=mime))
            out.append(types.Content(role=m["role"], parts=parts))
        return out

    async def chat(self, system, messages, temperature=0.4, max_tokens=900, on_retry=None):
        async def call():
            fold = self._system_in_prompt
            cfg = types.GenerateContentConfig(
                temperature=temperature,
                max_output_tokens=max_tokens,
                system_instruction=None if fold else system,
                thinking_config=types.ThinkingConfig(thinking_level="MINIMAL") if self._minimal_thinking else None,
            )
            resp = await self.client.aio.models.generate_content(
                model=self.model,
                contents=self._contents(messages, system, fold),
                config=cfg,
            )
            out = self._extract(resp)
            if not out:
                raise ValueError("empty answer")
            return out

        # The shared Gemma endpoint fails a large share of requests when it is busy. Failures are fast, so
        # instead of long back-offs we retry almost immediately and, after the first failure, race two
        # identical requests and keep whichever succeeds first.
        last = None
        for attempt in range(MAX_ATTEMPTS):
            # Racing two requests costs quota, so only do it while we are not being rate limited.
            racers = 2 if attempt > 0 and time.monotonic() > self._no_hedge_until else 1
            out, err = await _first_success([asyncio.create_task(call()) for _ in range(racers)])
            if err is None:
                return out
            last = err
            wait = 0.25 + random.random() * 0.5
            if isinstance(err, errors.APIError):
                if err.code == 400 and not self._system_in_prompt and "nstruction" in str(err):
                    self._system_in_prompt = True
                    continue
                if err.code == 400 and self._minimal_thinking and "hinking" in str(err):
                    self._minimal_thinking = False
                    continue
                if err.code == 429:
                    # Per-minute quota: do what the API asks (wait), say so, and stop doubling requests for a while.
                    wait = min(_retry_after(err), MAX_RATE_WAIT)
                    self._no_hedge_until = time.monotonic() + 90
                    if on_retry:
                        await on_retry(f"Gemma 4 rate limit reached, waiting {wait:.0f}s...")
                    await asyncio.sleep(wait)
                    continue
                if err.code not in RETRYABLE:
                    raise err
            elif not isinstance(err, ValueError):
                raise err
            if attempt >= 2 and on_retry:
                await on_retry("Gemma 4 is busy right now, retrying...")
            await asyncio.sleep(wait)
        if isinstance(last, ValueError):
            return ""
        raise last

    @staticmethod
    def _extract(resp):
        """Text of the answer. Gemma 4 sometimes emits a native function_call part instead of the
        JSON text we asked for; normalise it to the same {"tool", "args"} JSON the agent parses."""
        texts, call = [], None
        for cand in resp.candidates or []:
            for part in (cand.content.parts if cand.content and cand.content.parts else []):
                if getattr(part, "thought", False):
                    continue
                if part.function_call and call is None:
                    call = {"tool": part.function_call.name, "args": dict(part.function_call.args or {})}
                elif part.text:
                    texts.append(part.text)
        text = "".join(texts).strip()
        return text or (json.dumps(call) if call else "")
