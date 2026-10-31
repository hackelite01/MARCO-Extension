# Marco — UI Preview

A text mockup of the side panel, built to match the real layout in `extension/sidepanel.html` /
`.css` / `.js`. No screenshots are embedded here — this is an ASCII/box-drawing sketch of the actual
shipped UI, kept in Markdown so it's easy to read straight from GitHub without opening the extension.

## Main chat view

```
┌──────────────────────────────────────────────────────────┐
│ ● Marco                              gemma-4-26b-a4b-it   │  <- green dot = connected
│ ▸ Settings                                                │
├──────────────────────────────────────────────────────────┤
│ [ShopNow ×] [QuickForum] [LoginPortal]                    │  <- tab chips, current one highlighted
│ Following: ShopNow          [Follow tab]  [New chat]      │
├──────────────────────────────────────────────────────────┤
│                                                            │
│              Summarise this page and give me prices       │  <- you (right-aligned)
│                                                            │
│  ┌────────────────────────────────────────────────────┐  │
│  │ This is the pricing page for Acme Cloud. You can    │  │  <- Marco (left-aligned)
│  │ compare Starter and Pro, or contact sales.          │  │
│  │                                                      │  │
│  │ • Starter: $9/month 📍, 1 project 📍                 │  │  <- 📍 = citation pin,
│  │ • Pro: $29/month 📍, priority support 📍             │  │     click to highlight the
│  │ • Enterprise: contact sales 📍                       │  │     source sentence on the page
│  └────────────────────────────────────────────────────┘  │
│                                                            │
│                   Using security_scan...                  │  <- status line (italic, centered)
│                                                            │
│  ┌────────────────────────────────────────────────────┐  │
│  │ Found a few medium-risk issues with headers and     │  │
│  │ cookies. Here's how to fix each one...              │  │
│  └────────────────────────────────────────────────────┘  │
│                                                            │
├──────────────────────────────────────────────────────────┤
│ [🎙] [ Ask this tab's agent anything................ ] [Send] │
│ ☐ Hands-free: say "Hey Marco"                             │
│ Each tab has its own agent and memory. Security scans are │
│ passive and only for sites you own or are authorised to   │
│ test.                                                      │
└──────────────────────────────────────────────────────────┘
```

## "Show me" — pointing at the page

When you ask "how do I start a free trial?", Marco reads the page, then draws a pulsing ring directly
on the live page (not inside the panel):

```
   on the actual web page, injected by the extension:

   ┌───────────────────────────┐
   │  ╭╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╮        │
   │  ╎  [ Start free ]╎◀── glowing orange ring, pulses for ~9s
   │  ╰╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╯        │
   │       ▲                   │
   │   ┌───┴────────┐          │
   │   │ Marco: here │         │   <- small floating label
   │   └────────────┘          │
   └───────────────────────────┘
```

## Settings panel

```
┌──────────────────────────────────────────────────────────┐
│ ▾ Settings                                                │
│  Bridge token [ ••••••••••••••••••• ]   Port [ 8765 ]     │
│  [Save & reconnect]                                       │
│                                                            │
│  ┌ VOICE ─────────────────────────────────────────────┐   │
│  │ Speech language   [ English (India)        ▾ ]     │   │
│  │ Speak replies     [ Only when I ask by voice ▾ ]    │   │
│  └──────────────────────────────────────────────────┘   │
│                                                            │
│  ┌ DON'T ASK ME BEFORE MARCO CAN... ───────────────────┐   │
│  │ ☑ load a page in the current tab                    │   │
│  │ ☑ open a new tab          ☑ switch to another tab   │   │
│  │ ☐ click buttons and links ☐ type into fields        │   │
│  └──────────────────────────────────────────────────┘   │
│                                                            │
│  ┌ TOOLS MARCO MAY USE ────────────────────────────────┐   │
│  │ ☑ navigate   ☑ new tabs   ☑ switch tabs             │   │
│  │ ☑ click      ☑ type       ☑ point at things         │   │
│  │ ☑ screenshots            ☑ passive security scan    │   │
│  │ ☑ defacement monitoring  ☑ reflection (XSS) testing │   │
│  └──────────────────────────────────────────────────┘   │
│                                                            │
│  ┌ DEFACEMENT MONITORING ──────────────────────────────┐   │
│  │ Auto-check watched pages every [ 15 minutes      ▾ ]│   │
│  │  acme.example         saved 2h ago  [Check now] [×] │   │
│  │  shop.local           saved 5m ago  [Check now] [×] │   │
│  └──────────────────────────────────────────────────┘   │
│                                                            │
│  ┌ REFLECTED-INPUT (XSS RECON) TESTING ────────────────┐   │
│  │ ⚠ Authorised testing only. localhost/127.0.0.1      │   │
│  │   are always allowed. Anything else needs your      │   │
│  │   explicit permission, added below.                 │   │
│  │ Allowlisted domains:                                │   │
│  │ ┌──────────────────────────────────────────────┐   │   │
│  │ │ localhost                                     │   │   │
│  │ └──────────────────────────────────────────────┘   │   │
│  │  localhost   3/10 used this hour                    │   │
│  └──────────────────────────────────────────────────┘   │
│                                                            │
│  [Reset to defaults]                                      │
└──────────────────────────────────────────────────────────┘
```

## A real `check_reflection` result (as shown in the chat)

```
┌────────────────────────────────────────────────────────────┐
│ Authorised testing only: this only runs against sites you  │
│ have added to the allowlist yourself.                      │
│                                                              │
│ Passive reflected-input check on localhost:8090             │
│ (1 parameter tested, cookies not sent):                     │
│                                                              │
│ Parameter "q" (from a search/input form on the page):       │
│   SUSPICIOUS HTML REFLECTION                                │
│   The input is reflected with " ' < > coming back raw.      │
│   Reproduction: http://localhost:8090/search?q=mcR...        │
│   Fix: Apply contextual output encoding (HTML-escape for     │
│   body text)... add a Content-Security-Policy...             │
│                                                              │
│ This is automated reflection evidence only, not a           │
│ confirmed vulnerability.                                     │
└────────────────────────────────────────────────────────────┘
```

## Color palette

Matches `extension/sidepanel.css` and the generated icon:

| Role | Dark mode | Light mode |
|---|---|---|
| Background | `#0b0d12` | `#f5f6fa` |
| Panel | `#161920` | `#ffffff` |
| Accent (orange) | `#ff7a1a` | `#ff7a1a` |
| Text | `#eef0f4` | `#15171c` |
| Muted text | `#8b93a7` | `#5d6578` |

---
*This file is hand-drawn ASCII, not a generated screenshot — it's meant to let someone understand the UI from the repo alone, without installing the extension.*
