// Defacement monitoring: "remember what a page looks like, tell me if it changes unexpectedly."
// Pure fetch + text diffing, no DOM needed, so it works from the background service worker on a
// schedule (the tab doesn't have to be open) and from the side panel for an on-demand check.
// Shared by background.js (periodic checks) and tools.js (watch_page / check_defacement tools).

const STORE_KEY = "marco_deface_baselines";
const MAX_BASELINES = 40;

// Phrases that commonly appear in a real defacement message. A short heuristic list, not exhaustive -
// it only matters here if the phrase is NEW (absent from the saved baseline, present now).
export const DEFACE_PHRASES = [
  "hacked by", "owned by", "pwned by", "defaced by", "this site has been hacked",
  "this site has been defaced", "security team", "cyber army", "we are legion",
  "your security is weak", "h4ck3d", "pwn3d", "d3f4ced",
];

function stripTags(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function extractTitle(html) {
  return (/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] || "").replace(/\s+/g, " ").trim();
}

// FNV-1a 32-bit: fast, dependency-free, plenty good for "did this change" rather than cryptographic proof.
export function hashString(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

export async function fetchSnapshot(url) {
  const r = await fetch(url, { credentials: "omit", cache: "no-store", redirect: "follow" });
  const html = await r.text();
  const text = stripTags(html);
  return {
    url,
    title: extractTitle(html),
    length: text.length,
    hash: hashString(text),
    sample: text.slice(0, 400),
    status: r.status,
    savedAt: Date.now(),
  };
}

export async function loadBaselines() {
  const { [STORE_KEY]: v } = await chrome.storage.local.get(STORE_KEY);
  return v || {};
}

export async function saveBaseline(url, snap) {
  const all = await loadBaselines();
  all[url] = snap;
  const keys = Object.keys(all);
  if (keys.length > MAX_BASELINES) {
    keys.sort((a, b) => all[a].savedAt - all[b].savedAt);
    delete all[keys[0]];
  }
  await chrome.storage.local.set({ [STORE_KEY]: all });
}

export async function removeBaseline(url) {
  const all = await loadBaselines();
  delete all[url];
  await chrome.storage.local.set({ [STORE_KEY]: all });
}

// Compares a saved baseline to a fresh snapshot. Never writes anything: a real defacement must
// never get quietly accepted as the new "normal" just because someone asked to check it.
export function compareSnapshot(baseline, now) {
  if (baseline.hash === now.hash) {
    return { severity: "none", summary: "No change since the baseline was saved." };
  }
  const lower = now.sample.toLowerCase();
  const baseLower = baseline.sample.toLowerCase();
  const newPhrases = DEFACE_PHRASES.filter((p) => lower.includes(p) && !baseLower.includes(p));
  const lengthChangePct = baseline.length ? Math.round(((now.length - baseline.length) / baseline.length) * 100) : 0;
  const titleChanged = baseline.title !== now.title;

  let severity = "low";
  const reasons = [];
  if (newPhrases.length) {
    severity = "high";
    reasons.push(`new text matching a common defacement phrase: "${newPhrases[0]}"`);
  }
  if (lengthChangePct <= -60) {
    severity = severity === "high" ? severity : "high";
    reasons.push(`page text shrank by ${Math.abs(lengthChangePct)}% (content may have been replaced)`);
  } else if (Math.abs(lengthChangePct) >= 30 && titleChanged) {
    severity = severity === "high" ? severity : "medium";
    reasons.push(`title changed and page text length changed by ${lengthChangePct}%`);
  } else if (titleChanged) {
    severity = severity === "high" ? severity : "medium";
    reasons.push("page title changed");
  } else {
    reasons.push(`page text changed (length moved ${lengthChangePct >= 0 ? "+" : ""}${lengthChangePct}%) - this alone is common for a normal content update`);
  }

  return {
    severity,
    titleChanged,
    oldTitle: baseline.title,
    newTitle: now.title,
    lengthChangePct,
    newPhrases,
    summary: reasons.join("; "),
  };
}
