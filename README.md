<div align="center">

<img src="extension/icon128.png" width="84" alt="Marco icon">

# Marco
### A voice-and-vision browser assistant, built on Gemma 4

[![Winner: Best Use of Gemma 4](https://img.shields.io/badge/🏆%20Winner-Best%20Use%20of%20Gemma%204-ffd700?style=for-the-badge)](https://www.mlh.com/events/hacktoberfest-hack-day-ahmedabad-x-navracommunity/submissions)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=for-the-badge)](LICENSE)
[![Powered by Gemma 4](https://img.shields.io/badge/Powered%20by-Gemma%204-ff7a1a?style=for-the-badge)](https://ai.google.dev/gemma)
[![Python 3.10+](https://img.shields.io/badge/Python-3.10%2B-3776AB?style=for-the-badge&logo=python&logoColor=white)](https://www.python.org/)
[![Manifest V3](https://img.shields.io/badge/Chrome%2FEdge-Extension%20MV3-4285F4?style=for-the-badge)](extension/manifest.json)
[![Hacktoberfest](https://img.shields.io/badge/Hacktoberfest-2026-blueviolet?style=for-the-badge)](https://hacktoberfest.com)

**[Features](#what-it-can-do)** · **[Setup](#setup)** · **[Safe demo targets](#try-it-against-something-safe-to-test)** · **[Security model](#security-and-privacy)** · **[Architecture](#architecture)**

[![Repo](https://img.shields.io/badge/GitHub-hackelite01%2FMARCO--Extension-181717?style=for-the-badge&logo=github&logoColor=white)](https://github.com/hackelite01/MARCO-Extension)
[![Star this repo](https://img.shields.io/badge/⭐-Star%20this%20repo-f1c40f?style=for-the-badge)](https://github.com/hackelite01/MARCO-Extension)
[![Report a bug](https://img.shields.io/badge/🐛-Report%20a%20bug-e74c3c?style=for-the-badge)](https://github.com/hackelite01/MARCO-Extension/issues)

</div>

> **Powered by Gemma 4.** Every reply, tool decision and fix suggestion in this project comes from Google's open-weights **Gemma 4** (`gemma-4-26b-a4b-it` by default, `gemma-4-31b-it` optional), called through the Gemini API. It does not use any Gemini model.

Talk to your browser in **English, Hindi or Hinglish**. Marco reads the page you are on, summarises it, looks at your screen, manages tabs, fills forms, and can run a **passive security check on a site and write the fixes for you**.

🏆 **Winner, Best Use of Gemma 4** at Hacktoberfest Hack Day Ahmedabad x NavraCommunity. Thanks to **NavraCommunity** and **MLH** for organizing the event and the Hack Day space this project was built at.

---

### Contents

- [What it can do](#what-it-can-do)
- [Defacement monitoring](#defacement-monitoring)
- [Reflected-input (XSS recon) testing](#reflected-input-xss-recon-testing)
- [Answers you can verify](#answers-you-can-verify)
- [One agent per tab](#one-agent-per-tab)
- [Architecture](#architecture)
- [Setup](#setup)
- [Settings and permissions](#settings-and-permissions)
- [Security and privacy](#security-and-privacy)
- [Limitations](#limitations) · [Roadmap](#roadmap) · [Credits](#credits) · [License](#license)

---

> No live screenshots here yet - see **[UI_PREVIEW.md](UI_PREVIEW.md)** for a text mockup of the side panel, the Settings screen, and a real `check_reflection` result.

## What it can do

| Say | What happens |
|---|---|
| "Hey Marco, summarise this page" | Reads the active tab and answers in a few spoken lines |
| "What's on my screen?" | Takes a screenshot and uses Gemma 4's vision to describe it |
| "Scan this site and tell me how to fix it" | Passive security review (see below), then copy-paste fixes |
| "Open GitHub and find the trending repo" | Multi-step: navigates, reads the page and answers with the real repos |
| "How do I start a free trial?" / "Where is the login?" | **Show me:** scrolls to the right button and draws a glowing ring with a "Marco: here" label on it, then explains |
| "Check my docs tab: does it support pagination?" | **Cross-tab:** this tab's agent asks the other tab's agent, which reads its own page |
| "Click Sign in" / "type my name in the Name field" | Page actions, each one asks for your confirmation first unless you turn that off |
| "Watch this page" / "Has this site been defaced?" | **Defacement monitoring** (see below) |
| "Who owns this domain?" / "when was it registered?" | Public registry (RDAP/WHOIS) and DNS lookup - registrar, dates, name servers, resolved IPs |

## Defacement monitoring

"Watch this page" saves a baseline (the page's title and text, fingerprinted with a fast hash) for the site you're on. From then on:

- **On demand:** ask "has this been hacked?" / "is my site okay?" any time and Marco fetches the page fresh, compares it to the baseline, and reports a severity (none/low/medium/high) with the reason — a title that changed, text that shrank sharply, or a phrase like "hacked by"/"defaced by" that wasn't there before.
- **In the background:** the extension's service worker re-checks every watched page on a timer (Settings → Defacement monitoring, default 15 minutes, 0 to turn off) **even if the tab isn't open**, and raises a desktop notification if something looks wrong.
- **Settings** also lists everything currently watched, with a one-click "Check now" (shows the result right there) and "Stop watching".

It never updates the baseline on its own — only saying "watch this page" again does that — so a real defacement can't quietly get accepted as the new normal just because someone asked to check it. Like `security_scan`, this is read-only (one `fetch` per check, no login, no modification) and is meant for sites you add yourself to watch.

## Reflected-input (XSS recon) testing

A stricter sibling of `security_scan`, for checking whether a site's query parameters get echoed back unsafely. **Authorised testing only**, enforced in code, not just asked for nicely:

- **Nothing runs unless the domain is on an allowlist you set yourself**, in Settings → "Reflected-input (XSS recon) testing". It's empty by default.
- **You are always asked to confirm** before any request is sent, regardless of the "don't ask me" settings used elsewhere — this one can't be pre-approved. A hostname that looks government, educational, banking, or healthcare-related asks a second, more explicit confirmation on top.
- **No script is ever sent.** It tests every query parameter already in the URL, **and any `<form method="GET">` visible on the page** (so a search box is testable even before you've used it — no `?query=...` needs to exist in the address bar yet), skipping session/CSRF/action-like names and anything inside a POST form. Each value is replaced with a random alphanumeric marker followed by four individual characters — `"`, `'`, `<`, `>` — and the response is checked for whether they come back raw, HTML/URL/JS-encoded, or stripped, and whether the marker lands inside a `<script>` block. That's enough to tell whether input is handled safely, without ever constructing anything that could execute. A form whose action points at a different, non-allowlisted domain is never followed.
- **Classified honestly:** *safely escaped*, *suspicious HTML reflection*, *possible script-context reflection*, or *unconfirmed* — it never claims a confirmed vulnerability, only reflection evidence, and says so in the report.
- **Rate-limited** (max 10 checks/domain/hour, capped at 5 parameters per run, cookies never sent — `credentials: "omit"`), and every check is written to a local audit log (`chrome.storage.local`).
- The result includes **remediation guidance** (contextual output encoding, CSP, framework autoescaping, server-side validation) and a **draft disclosure report** — reproduction steps with the harmless marker, an impact note, and the fix — meant to go to the site's own security contact after a human verifies it, never anywhere else.

## Answers you can verify

When Marco states a fact from a page, it adds a citation pin next to it. Click the pin and the exact sentence is highlighted on the page and scrolled into view. The bridge checks every quoted source against the text Marco actually read and **silently drops any citation that is not literally on the page**, so a hallucinated source cannot be shown.

## One agent per tab

Every browser tab gets its **own Marco agent with its own memory**, so a GitHub repo, a docs page and a client dashboard never get mixed up.

- The panel follows the tab you are on, or you can click a tab chip to **pin** an agent and keep talking to it while you browse elsewhere. Several agents can work at the same time, and a dot on a chip means that agent has a new reply.
- Tools act on the agent's *own* tab (read, search, screenshot, scan, click, fill), not whichever tab is in front.
- Each agent sees its tab's title and URL, so it follows you as you navigate within the tab.
- "New chat" resets one agent without touching the others. Closing a tab drops its agent.
- Agents can consult each other: the bridge keeps a map of which tabs have an agent, and `ask_tab` lets one agent put a question to another (one level deep, so agents cannot chain endlessly).
- **Past chats are saved and browsable.** Click **History** to see every past conversation grouped by site, open one to view the transcript, and click **Resume on a live tab** to continue on that URL. This persists the *displayed* conversation across closing a tab or reloading the panel - it does not restore Gemma's own memory of that conversation, which lives in the bridge process and resets with it; resuming starts a fresh agent on that page, not a continuation of the old one.

Replies are written for two channels: a short natural spoken line (read aloud) and, when useful, a longer markdown analysis in the chat. The agent adapts its analysis to the page: articles (main claim, key points, what's missing), code and docs (structure, what to use first, risks), pricing (concrete comparison), errors (likely cause, next step).

## Architecture

```
 Chrome side panel (voice + chat UI, Web Speech API)
        |  WebSocket, loopback only, token + origin checked
        v
 Python bridge  --->  Gemma 4 (Gemini API)
        ^                    |
        |   {"tool": ...}    |
        +---- tool calls <---+     tools run inside the extension:
                                   get_page_text, find_in_page, screenshot, navigate, open_url,
                                   click_text, fill_field, point_at, highlight_quote, list_tabs,
                                   switch_tab, ask_tab, security_scan, watch_page,
                                   check_defacement, check_reflection, whois_lookup
```

Gemma is prompted to answer with either plain text or one JSON tool call (a native `function_call` part is normalised to the same shape). The bridge runs that loop (at most 6 steps) and the extension executes tools in the browser. Gemma 4's hidden "thinking" is set to `MINIMAL` to keep replies fast (`GEMMA_THINKING=default` turns that off). Questions about "this page" are answered after the bridge reads the page itself, which saves one model round trip.

The shared Gemma endpoint can fail often when busy, so the client is built for it: after a transient `500`/`503` it retries almost immediately and races two identical requests, keeping whichever succeeds first. On a `429` rate limit it instead waits the time the API asks for, stops racing for a while (racing costs quota), and the panel says "Gemma 4 rate limit reached, waiting Ns". For `security_scan`, deterministic code collects the evidence and Gemma only prioritises it and writes the fixes, so the model never invents findings.

## Setup

Requirements: Python 3.10+, Chrome 114+ (side panel API), a Google AI Studio key.

```bash
git clone https://github.com/hackelite01/MARCO-Extension.git && cd MARCO-Extension
python -m venv venv && venv\Scripts\activate     # macOS/Linux: source venv/bin/activate
pip install -r requirements.txt

cp .env.example .env                              # then fill in GEMINI_API_KEY and BRIDGE_TOKEN
python scripts/list_models.py                     # confirms your key can call Gemma 4
python scripts/smoke_gemma.py                     # chat + tool protocol + vision check
python -m bridge.server                           # start the bridge
```

Load the extension:

1. Open `chrome://extensions` (or `edge://extensions` in Microsoft Edge - both are Chromium and support this), enable **Developer mode**, click **Load unpacked**, choose the `extension/` folder.
2. Click the Marco icon to open the side panel.
3. In **Settings**, paste the `BRIDGE_TOKEN` from your `.env` and press **Save and reconnect**. The dot turns green and shows the model name.
4. Press the mic (push to talk) or tick **Hands-free** and say "Hey Marco ...". If Chrome blocks the mic, use the **Grant access** link once.

Optional end-to-end check without Chrome: with the bridge running, `python scripts/e2e_test.py`.

### Try it against something safe to test

`scripts/demo_vuln_site.py` spins up three tiny local sites (`localhost:8090` ShopNow, `:8091` QuickForum, `:8092` LoginPortal), each with a different look and a different reflected-input scenario (unescaped, safely escaped, and inside a `<script>` block) - all three classification outcomes `check_reflection` can produce, on sites you fully own and run yourself:

```bash
python scripts/demo_vuln_site.py
```

`localhost` and `127.0.0.1` are always allowed for reflection testing (see **Security and privacy** below) - no allowlist setup needed.

## Settings and permissions

Everything below is in the side panel's **Settings** and applies immediately.

| Setting | Options | Default |
|---|---|---|
| Speak replies | only after a spoken request / always / never | only after a spoken request |
| Don't ask before: load a page in this tab, open a new tab, switch tabs | on / off each | on |
| Don't ask before: click buttons and links, type into fields | on / off each | off (asks first) |
| Tools Marco may use: navigate, new tabs, switch tabs, click, type, point at things, screenshots, security scan, defacement monitoring, reflection testing | on / off each | all on |
| Speech language | English (India), Hindi/Hinglish, Gujarati, English (US) | English (India) |
| Auto-check watched pages (defacement monitoring) | off / 5 / 15 / 30 / 60 minutes | 15 minutes |
| Reflected-input (XSS recon) allowlist | any domains you add; `localhost`/`127.0.0.1` always included | empty |

A tool that is switched off is refused, and Marco tells you which setting to turn on. Reading the page, searching it and listing tabs are always available. Settings also shows a live **rate-limit readout** (checks used per domain this hour) and the **defacement watchlist**, so the safety limits aren't just a claim - you can see them.

When Marco opens a page for you ("open GitHub and find the trending repo"), the conversation moves with it into that tab, so the thread is never lost.

## Security and privacy

- The bridge listens on `127.0.0.1` only. It rejects any WebSocket whose `Origin` is not a `chrome-extension://` page and requires the shared `BRIDGE_TOKEN`.
- Your API key stays in the bridge's `.env` and never reaches the extension or any web page. `.env` is git-ignored.
- Page text and tab titles are treated as untrusted data in the system prompt, so instructions hidden in a web page should not be followed (tested with an injected "say HACKED" page).
- Clicking and typing ask you to confirm unless you turn that off in Settings, and password fields are never filled. Only `http(s)` URLs can be opened.
- `security_scan` is **passive and read-only**: it GETs the current page, reads its cookies and inline scripts, and GETs a short fixed list of well-known paths (like `/.git/HEAD` and `/.env`) to check whether they're accidentally exposed. No fuzzing, no forced browsing, no login attempts, no payloads, no exploitation. It checks:
  - **Headers:** missing CSP/HSTS/`X-Content-Type-Options`/`Referrer-Policy`, clickjacking protection, risky CORS, server fingerprinting
  - **Cookies:** missing `Secure` / `HttpOnly` / `SameSite`
  - **Page code:** hardcoded API keys/tokens, risky DOM sinks (`innerHTML`/`eval`), third-party scripts without Subresource Integrity, forms missing CSRF protection, mixed content
  - **Front-end libraries:** jQuery/Bootstrap/AngularJS/Lodash/Moment versions with known public advisories, spotted from the file name only (never downloads or runs the library)
  - **Tokens:** JWTs left in `localStorage`/`sessionStorage` with `alg: none` or no expiry (decoded locally; the signature is never checked or attacked)
  - **Links:** query parameters that look like an open-redirect target (`?next=`, `?return=`, ...) pointing off-site
  - **Exposed files:** first checks whether the site returns 200 for a made-up path (common on single-page apps, which would make this check unreliable) and skips the file checks if so
  Every finding is explained with where it came from and a concrete fix. This is a quick triage a developer could do by hand, automated — not a full assessment, and it can miss things or occasionally flag something that turns out to be fine. **Use it only on sites you own or are authorised to test.**
- `check_reflection` adds the same passive philosophy to reflected-input testing, with its own allowlist (`localhost`/`127.0.0.1` always included, since a loopback address can only ever be your own machine; any other domain must be added by hand), a confirmation on every run, a second confirmation for education/bank/healthcare-looking hostnames, a per-domain rate limit, and a hard rule that no script or executable payload is ever sent — only an inert marker and four bare characters (`"'<>`) used purely to observe how the response encodes them. **`.gov`/`.mil` domains are refused outright** - not just gated behind a confirmation - with zero network requests made, even if explicitly typed into the allowlist yourself; unlike banks/healthcare/education, there's essentially no legitimate case of an individual user owning one of these.
- `whois_lookup` queries public RDAP (modern WHOIS) and DNS infrastructure only - it never connects to the site itself, so it needs no allowlist or confirmation. **Port scanning was deliberately left out**: it's active probing of a host's ports rather than reading public information, browsers have no raw-socket API to do it safely anyway, and a JS-side approximation of it is the same technique used to scan a visitor's local network from a malicious page - a different risk class from everything else here.
- Defacement monitoring is also passive: a plain `fetch` of pages you explicitly added, nothing else. The `alarms` permission runs that check on a timer and `notifications` shows the result; neither permission lets the extension do anything beyond that.
- The extension requests `<all_urls>` host access so it can read any page you ask about and fetch its response headers. Page text and screenshots you ask about are sent to the Gemini API to be processed by Gemma 4.
- Speech recognition and speech synthesis use Chrome's built-in Web Speech API, so audio may be processed by Chrome's speech service.

## Limitations

- Needs internet for Gemma 4 and for Chrome's speech recognition. An offline Gemma through Ollama would be a natural next step.
- Hands-free wake detection matches the words "Hey Marco" in Chrome's transcript. It is not a dedicated wake-word model.
- Page text is truncated to about 8,000 characters per read (the agent can page through with an offset or search the page).
- The security checks are a quick triage, not a replacement for a proper assessment.

## Roadmap

- Streaming replies and barge-in
- Local-only mode with Gemma 4 via Ollama
- More tools: bookmarks, downloads, form-aware filling
- Dedicated `hey_marco` wake-word model

## Credits

Gemma 4 by Google. Inspired by the idea of on-device browser agents such as `nico-martin/gemma4-browser-extension` (no code copied). This project grew out of the author's own personal voice assistant.

Thanks to **NavraCommunity** and **MLH (Major League Hacking)** for organizing Hacktoberfest Hack Day Ahmedabad, the event this project was built for.

## License

MIT, see [LICENSE](LICENSE).
