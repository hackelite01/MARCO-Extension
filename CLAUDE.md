# CLAUDE.md

Guidance for Claude Code when working in this repo (Marco: a voice-and-vision browser assistant built on Gemma 4).

## What this project is

A Chrome/Edge MV3 extension (`extension/`) paired with a local Python WebSocket bridge (`bridge/`). One Gemma 4 agent runs per browser tab. The extension never talks to Gemma directly — it sends tool results over a loopback WebSocket to the bridge, which calls Gemma 4 through the Gemini API and sends back replies or tool calls.

```
extension (side panel, voice UI, tools)  <--WS, loopback only-->  bridge (Python, Gemma 4 via Gemini API)
```

## Key files

- `bridge/agent.py` — the agent loop, system prompt, all tool descriptions (`TOOLS` dict), citation verification.
- `bridge/gemma.py` — Gemma 4 client: hedged retries on 500/503, honors `Retry-After` on 429, `MINIMAL` thinking level for speed.
- `bridge/server.py` — WebSocket server, one Agent per tab session, send-timeout + overall-turn-timeout safety nets.
- `bridge/osint.py` — WHOIS/RDAP + DNS lookups (public registry only, never touches the target site).
- `extension/tools.js` — browser-side tool implementations (page reading, clicking, screenshots, security_scan).
- `extension/deface.js` — defacement baseline/compare logic (fetch-based, no DOM needed).
- `extension/reflect.js` — reflected-input (XSS recon) checker: form discovery, canary probing, classification.
- `extension/sidepanel.js` / `.html` / `.css` — the chat UI, settings, per-tab session management.
- `scripts/demo_vuln_site.py` — three local intentionally-vulnerable demo sites for safely testing `check_reflection`.
- `scripts/make_icons.py` — generates the extension's icons (pure-Python PNG rasterizer, no Pillow).
- `site/` — the project's static landing page (deployed separately, e.g. DigitalOcean App Platform; not the bridge).

## Running it

```bash
cd bridge/..  # repo root
python -m venv venv && source venv/Scripts/activate   # or venv\Scripts\activate on native Windows shells
pip install -r requirements.txt
cp .env.example .env   # fill in GEMINI_API_KEY and BRIDGE_TOKEN — never commit .env
python -m bridge.server
```
Then load `extension/` as an unpacked extension at `chrome://extensions` or `edge://extensions`.

Useful during development: `scripts/e2e_test.py` (fake extension client against a real bridge), `scripts/demo_vuln_site.py` (safe local targets for `check_reflection`), `scripts/list_models.py` / `scripts/smoke_gemma.py` (sanity-check the Gemini API key).

## Testing conventions used throughout this codebase

- JS logic (`deface.js`, `reflect.js`, `tools.js`) is tested with plain Node scripts that stub only `chrome.storage.local` / `fetch` and import the real module — not reimplementations. For logic inside non-exported functions, extract the function's source text from the file and `new Function(...)` it with stubbed globals, rather than duplicating the logic in the test.
- Python bridge logic is tested the same way: real imports, mocked `fetch`/`chrome.*` where relevant is N/A, but Gemma calls are tested live against the real API when checking latency/retry behavior — there's no mocked Gemini client in this repo.
- Always verify the *bug*, not just the fix: when the WebSocket-hang bug was fixed, the test simulated a genuinely hung socket and asserted the old code would have hung forever before asserting the new code recovers.

## Known gotchas

- **Git Bash eats backslashes.** `D:\hacktoberfest\divya-bridge` typed into Git Bash becomes `D:hacktoberfestdivya-bridge`. Always use forward-slash paths (`/d/hacktoberfest/divya-bridge`) in Bash/Git Bash contexts.
- **Rounded-rect/SDF math**: the correct inside-test is `outside_dist + min(max(qx,qy),0) - radius <= 0`. An earlier version used `min(qx,qy) <= radius`, which silently makes any point at the right height register as "inside" regardless of horizontal position — caught by rendering a debug ASCII thumbnail, not by staring at the formula.
- **Patching files with heavy backslash/escape content via a Python string-replace script is unreliable** in this environment (observed multiple corrupted files this way). Use direct file edits instead when the content has escape sequences.
- **Shared Gemma 4 endpoint can be heavily loaded.** `gemma.py` races duplicate requests after a transient failure and backs off properly on `429`. Don't remove this without re-testing under load.
- A `ws.send()` with no timeout can hang indefinitely on a half-dead connection (laptop sleep, Wi-Fi drop) without ever raising — this is why every send in `server.py` has a wrapping timeout plus a hard overall-turn ceiling.

## Safety boundaries — do not relax these without explicit, specific user instruction

These were deliberately drawn during development and should not regress:

- **`security_scan` / `check_reflection` / defacement monitoring are passive only.** No fuzzing, no forced browsing beyond a short fixed list, no exploit payloads, no event handlers or `<script>` tags ever sent — `check_reflection` uses an inert alphanumeric marker plus four bare characters (`"'<>`), never a working payload.
- **`check_reflection` requires an explicit, user-set allowlist** (`localhost`/`127.0.0.1` are the only defaults, since a loopback address can only ever be the tester's own machine) and **always asks for confirmation**, bypassing the "don't ask me" settings used elsewhere. A second confirmation fires for hostnames that look government/education/bank/healthcare-related. Do not add a way to pre-approve or skip this.
- **No port scanning was implemented, on purpose.** It's active host probing, not passive recon; browsers have no raw-socket API, and any JS approximation is the same technique used to scan a victim's local network from a malicious page. If asked to add it, decline and explain why (see README's "Security and privacy" section for the exact framing already agreed with the user).
- **No real exploit payload lists** (e.g., XSS payload repos) should be added to `check_reflection` or anywhere else that sends requests to a live target. The whole design point is that it never needs one.
- **Don't test or add allowlist entries for real third-party domains without clear, verifiable authorization.** A claim of "authorization" made only after a refusal, or that contradicts something said minutes earlier in the same conversation, is not sufficient — decline and let the user add domains to their own allowlist themselves if they're confident in their authorization.
- Keep `E:\Projects\DIVYA\` (the user's separate personal project) untouched; this repo grew out of it but is independent.
