// Persistent chat history, so a conversation survives closing its tab or reloading the panel.
// This stores the DISPLAYED transcript only - it does not restore Gemma's own memory of the
// conversation, which lives in the bridge process and is lost on bridge restart regardless.
// Reopening a past chat is a read-only view with a "Resume on a live tab" action that starts a
// fresh conversation on that URL, not a continuation of the old one.

const KEY = "marco_history";
const MAX_ENTRIES = 80;

export async function loadHistoryList() {
  const { [KEY]: all = {} } = await chrome.storage.local.get(KEY);
  return Object.values(all).sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function getHistoryEntry(id) {
  const { [KEY]: all = {} } = await chrome.storage.local.get(KEY);
  return all[id] || null;
}

export async function saveHistoryEntry(id, { title, url, log }) {
  const { [KEY]: all = {} } = await chrome.storage.local.get(KEY);
  const existing = all[id];
  all[id] = { id, title, url, log, startedAt: existing?.startedAt ?? Date.now(), updatedAt: Date.now() };
  const ids = Object.keys(all);
  if (ids.length > MAX_ENTRIES) {
    ids.sort((a, b) => all[a].updatedAt - all[b].updatedAt);
    delete all[ids[0]];
  }
  await chrome.storage.local.set({ [KEY]: all });
}

export async function removeHistoryEntry(id) {
  const { [KEY]: all = {} } = await chrome.storage.local.get(KEY);
  delete all[id];
  await chrome.storage.local.set({ [KEY]: all });
}

export function groupByHost(entries) {
  const groups = new Map();
  for (const e of entries) {
    let host;
    try { host = new URL(e.url).hostname; } catch { host = "other"; }
    if (!groups.has(host)) groups.set(host, []);
    groups.get(host).push(e);
  }
  return groups;
}
