import { runTool, MOVES_FOCUS } from "./tools.js";
import { DEFAULT_PREFS, loadPrefs, savePrefs } from "./prefs.js";
import { loadBaselines, removeBaseline, fetchSnapshot, compareSnapshot } from "./deface.js";
import { getRateStatus, isHardDenied } from "./reflect.js";
import { loadHistoryList, saveHistoryEntry, removeHistoryEntry, groupByHost } from "./history.js";

const $ = (id) => document.getElementById(id);
const log = $("log");
let ws = null;
let retry = null;
let speaking = false;
let awakeUntil = 0;
let recog = null;
let recogWanted = false;
let pushToTalk = false;
let prefs = structuredClone(DEFAULT_PREFS);

// ---------- per-tab agent sessions ----------
// One conversation (and one Gemma agent on the bridge) per browser tab. A session is keyed by a stable id
// and points at a tab (`tabId`). When Marco opens a page in a new tab for you, the session moves to that tab,
// so the conversation carries on there instead of splitting into an empty chat.
const sessions = new Map(); // sid -> { tabId, title, url, log: [{kind,text}], busy, unread, lastVia }
let current = null;         // sid shown in the panel
let following = true;       // true: panel follows the active tab; false: pinned to `current`
let suppressFollowUntil = 0; // set while a tool moves browser focus, so the chat doesn't jump away

const sidForTab = (tabId) => [...sessions].find(([, s]) => s.tabId === tabId)?.[0];

function ensureSession(tab) {
  let sid = sidForTab(tab.id);
  if (!sid) {
    sid = String(tab.id);
    if (sessions.has(sid)) sid = `${tab.id}-${Date.now()}`; // that id already belongs to a session that moved tabs
    sessions.set(sid, { tabId: tab.id, title: "", url: "", log: [], busy: false, unread: false, lastVia: "text", historyId: null });
  }
  const s = sessions.get(sid);
  s.title = tab.title || s.title || "New tab";
  s.url = tab.url || s.url;
  return sid;
}

function selectSession(sid) {
  if (historyOpen) setHistoryOpen(false);
  current = sid;
  const s = sessions.get(sid);
  s.unread = false;
  log.replaceChildren();
  if (!s.log.length) paintMsg("status", "Ask me about this tab: summarise it, find something in it, explain an error, or \"scan this site\".");
  s.log.forEach((m) => paintMsg(m.kind, m.text));
  renderChips();
}

function short(t, n) {
  t = (t || "").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

function renderChips() {
  const chips = $("chips");
  chips.replaceChildren();
  for (const [sid, s] of sessions) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = `chip${sid === current ? " current" : ""}${s.busy ? " busy" : ""}${s.unread ? " unread" : ""}`;
    b.textContent = short(s.title, 22);
    b.title = s.url || s.title;
    b.onclick = () => { following = false; selectSession(sid); };
    chips.appendChild(b);
  }
  const s = sessions.get(current);
  $("agentname").textContent = s ? `${following ? "Following" : "Pinned to"}: ${short(s.title, 40)}` : "";
  $("follow").classList.toggle("on", following);
  syncSessions();
}

// Tell the bridge which tabs have an agent, so one agent can ask another ("check my docs tab").
let syncTimer = null;
function syncSessions() {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => {
    if (ws?.readyState !== WebSocket.OPEN) return;
    const list = [...sessions].map(([sid, s]) => ({ sid, id: s.tabId, title: s.title, url: s.url }));
    ws.send(JSON.stringify({ type: "tabs", sessions: list }));
  }, 300);
}

async function followActive() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (tab) selectSession(ensureSession(tab));
}

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  if (!following || Date.now() < suppressFollowUntil) return;
  try {
    selectSession(ensureSession(await chrome.tabs.get(tabId)));
  } catch {}
});

chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  const sid = sidForTab(tabId);
  if (sid && (info.title || info.url)) {
    const s = sessions.get(sid);
    s.title = tab.title || s.title;
    s.url = tab.url || s.url;
    renderChips();
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  const sid = sidForTab(tabId);
  if (!sid) return;
  sessions.delete(sid);
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "close", session: sid }));
  if (current === sid) { following = true; followActive(); } else renderChips();
});

// ---------- chat UI ----------
const esc = (s) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// Escape first, then apply a tiny markdown subset, so model/page text can never inject HTML.
function render(text) {
  return esc(text)
    .replace(/```(?:\w+)?\n?([\s\S]*?)```/g, (_, c) => `<pre><code>${c}</code></pre>`)
    .replace(/`([^`\n]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
    // [[exact quote]] citations (already verified by the bridge) become clickable "show on page" pins
    .replace(/\[\[([^\]]{3,200})\]\]/g, (_, q) => `<button type="button" class="cite" data-q="${q}" title="Show on the page: ${q}">&#128205;</button>`)
    .replace(/\n/g, "<br>");
}

log.addEventListener("click", async (e) => {
  const pin = e.target.closest(".cite");
  if (!pin) return;
  const s = sessions.get(current);
  if (!s) return;
  suppressFollowUntil = Date.now() + 4000;
  const res = await runTool("highlight_quote", { quote: pin.dataset.q }, { prefs, ask: () => true }, s.tabId);
  pin.title = res.text;
});

function paintMsg(kind, text) {
  const el = document.createElement("div");
  el.className = `msg ${kind}`;
  if (kind === "bot") el.innerHTML = render(text);
  else el.textContent = text;
  log.appendChild(el);
  log.scrollTop = log.scrollHeight;
}

function addMsg(sid, kind, text) {
  const s = sessions.get(sid);
  if (!s) return;
  s.log.push({ kind, text });
  if (s.log.length > 60) s.log.shift();
  if (sid === current) paintMsg(kind, text);
  else { s.unread = true; renderChips(); }
  if (kind === "user" || kind === "bot") persistHistory(sid);
}

// ---------- persistent chat history (survives closing the tab or reloading the panel) ----------
// Saves the DISPLAYED transcript only - it does not restore Gemma's own memory of the conversation,
// which lives in the bridge process. A history entry's id outlives the live tab session's id.
const historySaveTimers = new Map();
function persistHistory(sid) {
  const s = sessions.get(sid);
  if (!s || !s.log.length) return;
  if (!s.historyId) s.historyId = crypto.randomUUID();
  clearTimeout(historySaveTimers.get(sid));
  historySaveTimers.set(sid, setTimeout(() => {
    saveHistoryEntry(s.historyId, { title: s.title, url: s.url, log: s.log });
  }, 500));
}

// ---------- history panel (browse + view past chats, grouped by site) ----------
let historyOpen = false;

function setHistoryOpen(open) {
  historyOpen = open;
  $("historyPanel").hidden = !open;
  log.hidden = open;
  $("historyBtn").classList.toggle("on", open);
  if (open) renderHistoryList();
}

async function renderHistoryList() {
  const panel = $("historyPanel");
  const entries = await loadHistoryList();
  if (!entries.length) {
    panel.innerHTML = '<p class="hempty">No past chats saved yet. History is saved automatically as you talk to Marco on each tab.</p>';
    return;
  }
  const groups = groupByHost(entries);
  panel.replaceChildren();
  for (const [host, items] of groups) {
    const group = document.createElement("div");
    group.className = "hgroup";
    const h = document.createElement("h4");
    h.textContent = host;
    group.appendChild(h);
    for (const e of items) {
      const row = document.createElement("div");
      row.className = "historyitem";
      const when = new Date(e.updatedAt).toLocaleString();
      row.innerHTML = `<span class="htitle" title="${esc(e.url)}">${esc(short(e.title || e.url, 30))}</span>
        <span class="htime">${esc(when)}</span>
        <button type="button" data-view>View</button>
        <button type="button" data-del>Delete</button>`;
      row.querySelector("[data-view]").onclick = () => renderHistoryTranscript(e);
      row.querySelector("[data-del]").onclick = async () => { await removeHistoryEntry(e.id); renderHistoryList(); };
      group.appendChild(row);
    }
    panel.appendChild(group);
  }
}

function renderHistoryTranscript(entry) {
  const panel = $("historyPanel");
  panel.replaceChildren();
  const bar = document.createElement("div");
  bar.className = "htranscript-bar";
  bar.innerHTML = `<span class="hinfo" title="${esc(entry.url)}">${esc(entry.title || entry.url)} &middot; read-only, Marco won't remember this conversation</span>
    <button type="button" data-resume>Resume on a live tab</button>
    <button type="button" data-back>Back</button>`;
  bar.querySelector("[data-back]").onclick = () => renderHistoryList();
  bar.querySelector("[data-resume]").onclick = () => { chrome.tabs.create({ url: entry.url }); setHistoryOpen(false); };
  panel.appendChild(bar);
  for (const m of entry.log) {
    const el = document.createElement("div");
    el.className = `msg ${m.kind}`;
    if (m.kind === "bot") el.innerHTML = render(m.text);
    else el.textContent = m.text;
    panel.appendChild(el);
  }
}

$("historyBtn").onclick = () => setHistoryOpen(!historyOpen);

function notice(html) {
  $("notice").innerHTML = html;
  $("notice").hidden = !html;
}

// ---------- speech out ----------
function scriptLang(text) {
  if (/[઀-૿]/.test(text)) return "gu-IN";
  if (/[ऀ-ॿ]/.test(text)) return "hi-IN";
  return $("lang").value;
}

function pickVoice(lang) {
  const norm = (l) => l.replace("_", "-").toLowerCase();
  const pool = speechSynthesis.getVoices().filter((v) => norm(v.lang).startsWith(lang.slice(0, 2).toLowerCase()));
  const nice = /natural|neural|online|google|neerja|swara|heera|kalpana|dhwani|niranjan/i;
  return pool.find((v) => nice.test(v.name) && norm(v.lang) === lang.toLowerCase()) || pool.find((v) => nice.test(v.name)) || pool[0] || null;
}

// Spoken output is a short headline: at most three sentences / ~280 chars, no code, links or markdown.
function brief(text) {
  const clean = text
    .split(/\n\s*\n/)[0]
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/\[\[[^\]]*\]\]/g, "")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/[*`#_>|]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const sentences = clean.match(/[^.!?।]+[.!?।]?/g) || [clean];
  let out = "";
  for (const sen of sentences.slice(0, 3)) if ((out + sen).length <= 280) out += sen; else break;
  return (out || clean.slice(0, 280)).trim();
}

function speak(text) {
  const plain = brief(text);
  if (!plain) return;
  speechSynthesis.cancel();
  const lang = scriptLang(plain);
  const u = new SpeechSynthesisUtterance(plain);
  u.voice = pickVoice(lang);
  u.lang = lang;
  u.rate = 1.05;
  speaking = true;
  u.onend = u.onerror = () => { speaking = false; };
  speechSynthesis.speak(u);
}

function shouldSpeak(s) {
  return prefs.speak === "always" || (prefs.speak === "voice" && s?.lastVia === "voice");
}

// ---------- bridge connection ----------
async function connect() {
  clearTimeout(retry);
  const { token = "", port = 8765 } = await chrome.storage.local.get(["token", "port"]);
  $("token").value = token;
  $("port").value = port;
  if (!token) {
    $("settings").open = true;
    notice("Paste your BRIDGE_TOKEN in Settings, then Save.");
    return;
  }
  try { ws?.close(); } catch {}
  ws = new WebSocket(`ws://127.0.0.1:${port}`);
  ws.onopen = () => ws.send(JSON.stringify({ type: "auth", token }));
  ws.onmessage = onMessage;
  ws.onclose = () => {
    $("dot").classList.remove("on");
    $("model").textContent = "offline";
    for (const s of sessions.values()) s.busy = false;
    renderChips();
    retry = setTimeout(connect, 3000);
  };
}

async function onMessage(ev) {
  const msg = JSON.parse(ev.data);
  const sid = msg.session != null ? String(msg.session) : null;
  if (msg.type === "ready") {
    $("dot").classList.add("on");
    $("model").textContent = msg.model;
    notice("");
    syncSessions();
  } else if (msg.type === "status") {
    if (sid === current) addMsg(sid, "status", msg.text);
  } else if (msg.type === "reply") {
    const s = sessions.get(sid);
    if (s) s.busy = false;
    addMsg(sid, "bot", msg.text);
    if (sid === current && shouldSpeak(s)) speak(msg.say || msg.text);
    renderChips();
  } else if (msg.type === "tool_call") {
    await handleToolCall(msg, sid);
  }
}

async function handleToolCall(msg, sid) {
  const s = sessions.get(sid);
  let res;
  if (!s) {
    res = { text: "This conversation's tab was closed." };
  } else {
    if (MOVES_FOCUS.has(msg.tool)) suppressFollowUntil = Date.now() + 4000;
    res = await runTool(msg.tool, msg.args, { prefs, ask: (q) => window.confirm(q) }, s.tabId);
    if (res.adoptTabId) {
      s.tabId = res.adoptTabId;
      try {
        const t = await chrome.tabs.get(res.adoptTabId);
        s.title = t.title || s.title;
        s.url = t.url || s.url;
      } catch {}
      renderChips();
    }
  }
  ws.send(JSON.stringify({ type: "tool_result", id: msg.id, text: res.text, image: res.image || null }));
}

async function send(text, via = "text") {
  text = text.trim();
  if (!text || current == null) return;
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    notice("Bridge is offline. Start it with: python -m bridge.server");
    return;
  }
  const sid = current;
  const s = sessions.get(sid);
  let tab;
  try { tab = await chrome.tabs.get(s.tabId); } catch { notice("That tab was closed."); return; }
  s.title = tab.title || s.title;
  s.url = tab.url || s.url;
  speechSynthesis.cancel();
  addMsg(sid, "user", text);
  s.busy = true;
  s.lastVia = via;
  renderChips();
  ws.send(JSON.stringify({ type: "user", session: sid, text, via, tab: { id: tab.id, title: tab.title, url: tab.url } }));
}

// ---------- speech in (Web Speech API) ----------
const WAKE = /\b(?:hey|hi|hello|ok|okay)?\s*(?:marco|marko|macro|mako)\b[\s,.!]*/i;

function handleHeard(text) {
  if (pushToTalk) {
    pushToTalk = false;
    stopListening();
    send(text, "voice");
    return;
  }
  const m = text.match(WAKE);
  if (m) {
    const rest = text.replace(WAKE, "").trim();
    if (rest) send(rest, "voice");
    else { awakeUntil = Date.now() + 8000; if (current) addMsg(current, "status", "Listening..."); }
  } else if (Date.now() < awakeUntil) {
    awakeUntil = 0;
    send(text, "voice");
  }
}

function startListening() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) { notice("Speech recognition isn't available in this browser."); return; }
  recogWanted = true;
  recog = new SR();
  recog.lang = $("lang").value;
  recog.continuous = true;
  recog.interimResults = false;
  recog.onresult = (e) => {
    for (let i = e.resultIndex; i < e.results.length; i++) {
      if (!e.results[i].isFinal || speaking) continue;
      const t = e.results[i][0].transcript.trim();
      if (t) handleHeard(t);
    }
  };
  recog.onerror = (e) => {
    if (e.error === "not-allowed" || e.error === "service-not-allowed") {
      recogWanted = false;
      notice('Microphone blocked. <button id="grant">Grant access</button>');
      $("grant").onclick = () => chrome.tabs.create({ url: chrome.runtime.getURL("mic.html") });
    }
  };
  recog.onend = () => {
    if (recogWanted) try { recog.start(); } catch {}
    else $("mic").classList.remove("live");
  };
  try { recog.start(); $("mic").classList.add("live"); } catch {}
}

function stopListening() {
  recogWanted = false;
  try { recog?.stop(); } catch {}
  $("mic").classList.remove("live");
}

// ---------- settings ----------
// A checkbox's data-tool can list several tool names ("watch_page,check_defacement") when one
// switch should turn a whole feature on/off together.
const toolKeys = (el) => el.dataset.tool.split(",");

function paintPrefs() {
  document.querySelectorAll("[data-auto]").forEach((el) => { el.checked = prefs.autoAllow[el.dataset.auto] === true; });
  document.querySelectorAll("[data-tool]").forEach((el) => { el.checked = toolKeys(el).every((k) => prefs.enabled[k] !== false); });
  $("speak").value = prefs.speak;
  $("defaceMinutes").value = String(prefs.defaceMinutes);
  $("reflectAllowlist").value = (prefs.reflectAllowlist || []).join("\n");
}

document.querySelectorAll("[data-auto]").forEach((el) => {
  el.onchange = () => { prefs.autoAllow[el.dataset.auto] = el.checked; savePrefs(prefs); };
});
document.querySelectorAll("[data-tool]").forEach((el) => {
  el.onchange = () => { toolKeys(el).forEach((k) => { prefs.enabled[k] = el.checked; }); savePrefs(prefs); };
});
$("speak").onchange = (e) => { prefs.speak = e.target.value; savePrefs(prefs); };
$("defaceMinutes").onchange = (e) => { prefs.defaceMinutes = Number(e.target.value); savePrefs(prefs); };
$("reflectAllowlist").onchange = (e) => {
  const entered = e.target.value.split("\n").map((s) => s.trim().toLowerCase()).filter(Boolean);
  const denied = entered.filter(isHardDenied);
  prefs.reflectAllowlist = entered.filter((d) => !isHardDenied(d));
  e.target.value = prefs.reflectAllowlist.join("\n"); // reflect what was actually saved, not what was typed
  savePrefs(prefs);
  if (denied.length) notice(`${denied.join(", ")} ${denied.length > 1 ? "are" : "is"} .gov/.mil and can't be added - these are refused outright, not gated behind a confirmation.`);
};
$("resetprefs").onclick = () => { prefs = structuredClone(DEFAULT_PREFS); savePrefs(prefs); paintPrefs(); paintWatchlist(); };

// ---------- defacement watchlist (shown in Settings) ----------
async function paintWatchlist() {
  const box = $("watchlist");
  const baselines = await loadBaselines();
  const urls = Object.keys(baselines);
  if (!urls.length) {
    box.innerHTML = '<p class="empty">Nothing watched yet. Say &ldquo;watch this page&rdquo; on a tab to add it.</p>';
    return;
  }
  box.replaceChildren();
  for (const url of urls) {
    const b = baselines[url];
    const row = document.createElement("div");
    row.className = "watchitem";
    const when = new Date(b.savedAt).toLocaleString();
    row.innerHTML = `<span class="wtitle" title="${esc(url)}">${esc(short(b.title || url, 28))}</span>
      <span class="wsev" data-badge>saved ${esc(when)}</span>
      <button type="button" data-check>Check now</button>
      <button type="button" data-forget>Stop watching</button>`;
    row.querySelector("[data-check]").onclick = async (e) => {
      const badge = row.querySelector("[data-badge]");
      badge.textContent = "checking...";
      try {
        const now = await fetchSnapshot(url);
        const cmp = compareSnapshot(b, now);
        badge.textContent = cmp.severity === "none" ? "unchanged" : `${cmp.severity}: ${cmp.summary}`.slice(0, 80);
        badge.className = `wsev ${cmp.severity}`;
      } catch (err) {
        badge.textContent = `check failed: ${err.message}`.slice(0, 80);
      }
    };
    row.querySelector("[data-forget]").onclick = async () => { await removeBaseline(url); paintWatchlist(); };
    box.appendChild(row);
  }
}
async function paintRateLimit() {
  const box = $("ratelimit");
  const status = await getRateStatus();
  if (!status.length) {
    box.innerHTML = '<p class="empty">No reflection checks run in the last hour.</p>';
    return;
  }
  box.replaceChildren();
  for (const s of status) {
    const row = document.createElement("div");
    row.className = "watchitem";
    const full = s.used >= s.max;
    row.innerHTML = `<span class="wtitle" title="${esc(s.domain)}">${esc(s.domain)}</span>
      <span class="wsev${full ? " high" : ""}">${s.used}/${s.max} used this hour${full ? ` - resets in ~${s.resetMinutes}m` : ""}</span>`;
    box.appendChild(row);
  }
}
$("settings").addEventListener("toggle", () => { if ($("settings").open) { paintWatchlist(); paintRateLimit(); } });

// ---------- wiring ----------
$("send").onclick = () => { send($("text").value); $("text").value = ""; };
$("text").onkeydown = (e) => { if (e.key === "Enter") $("send").click(); };
$("mic").onclick = () => {
  if (recogWanted) { stopListening(); $("handsfree").checked = false; return; }
  pushToTalk = true;
  startListening();
};
$("handsfree").onchange = (e) => {
  pushToTalk = false;
  if (e.target.checked) startListening(); else stopListening();
};
$("lang").onchange = async (e) => {
  await chrome.storage.local.set({ lang: e.target.value });
  if (recogWanted) { stopListening(); startListening(); }
};
$("save").onclick = async () => {
  await chrome.storage.local.set({ token: $("token").value.trim(), port: Number($("port").value) || 8765 });
  connect();
};
$("follow").onclick = () => { following = true; followActive(); };
$("clear").onclick = () => {
  const s = sessions.get(current);
  if (!s) return;
  s.log = [];
  s.historyId = null; // a genuinely new conversation, not a silent overwrite of the old history entry
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "reset", session: current }));
  selectSession(current);
};

(async () => {
  const { lang } = await chrome.storage.local.get("lang");
  if (lang) $("lang").value = lang;
  prefs = await loadPrefs();
  paintPrefs();
  paintWatchlist();
  paintRateLimit();
  speechSynthesis.getVoices();
  await followActive();
  connect();
})();
