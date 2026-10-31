// Browser tools Marco can call. Every tool runs against the agent's own tab (tabId),
// not whichever tab happens to be in front. Tools return { text, image? } (image = base64 jpeg).

import { fetchSnapshot, loadBaselines, saveBaseline, compareSnapshot } from "./deface.js";
import { runReflectionCheck } from "./reflect.js";

const getTab = async (tabId) => {
  if (tabId != null) return chrome.tabs.get(tabId);
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab) throw new Error("no tab");
  return tab;
};
const isWeb = (tab) => /^https?:/.test(tab.url || "");
const inPage = async (tab, func, args = []) =>
  (await chrome.scripting.executeScript({ target: { tabId: tab.id }, func, args }))[0].result;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function httpUrl(raw) {
  try {
    let s = String(raw || "").trim();
    if (!/^[a-z][a-z0-9+.-]*:/i.test(s)) s = `https://${s}`; // "github.com/trending" -> https://...
    const u = new URL(s);
    return /^https?:$/.test(u.protocol) ? u : null;
  } catch {
    return null;
  }
}

// Resolves with the tab once it finishes loading (or after the timeout, so a slow page can't hang the agent).
function waitLoaded(tabId, ms = 12000) {
  return new Promise((resolve) => {
    const finish = async () => {
      chrome.tabs.onUpdated.removeListener(onUpdated);
      clearTimeout(timer);
      resolve(await chrome.tabs.get(tabId));
    };
    const onUpdated = (id, info) => { if (id === tabId && info.status === "complete") finish(); };
    const timer = setTimeout(finish, ms);
    chrome.tabs.onUpdated.addListener(onUpdated);
  });
}

// ---- functions injected into the page (must be self-contained) ----

function readPage(offset) {
  const label = (e) => (e.innerText || e.value || e.getAttribute("aria-label") || "").trim().replace(/\s+/g, " ").slice(0, 40);
  const uniq = (a) => [...new Set(a.filter(Boolean))];
  const root = document.querySelector("main,article,[role=main]") || document.body;
  const text = (root.innerText || "").replace(/\n{3,}/g, "\n\n").trim();
  const LIMIT = 8000;
  return {
    meta: document.querySelector('meta[name="description"],meta[property="og:description"]')?.content || "",
    headings: [...document.querySelectorAll("h1,h2,h3")]
      .slice(0, 25)
      .map((h) => `${h.tagName} ${(h.innerText || "").trim().slice(0, 90)}`),
    selection: String(getSelection() || "").trim().slice(0, 1500),
    links: document.links.length,
    forms: document.forms.length,
    images: document.images.length,
    buttons: uniq([...document.querySelectorAll("button,[role=button],input[type=submit],a.btn,a.button,a[class*=btn],a[class*=button]")].map(label)).slice(0, 15),
    nav: uniq([...document.querySelectorAll("nav a,header a")].map(label)).slice(0, 14),
    fields: uniq([...document.querySelectorAll("input,textarea,select")]
      .filter((e) => !["hidden", "submit", "button"].includes(e.type))
      .map((e) => (e.getAttribute("aria-label") || e.placeholder || e.name || e.type || "").trim())).slice(0, 10),
    total: text.length,
    chunk: text.slice(offset, offset + LIMIT),
  };
}

function searchPage(query) {
  const text = (document.body.innerText || "").replace(/\s+/g, " ");
  const q = query.toLowerCase();
  const hay = text.toLowerCase();
  const snippets = [];
  let i = hay.indexOf(q);
  let count = 0;
  while (i !== -1) {
    count++;
    if (snippets.length < 6) snippets.push(text.slice(Math.max(0, i - 150), i + q.length + 150));
    i = hay.indexOf(q, i + q.length);
  }
  return { count, snippets };
}

// Draws a pulsing ring and a "Marco: ..." label over an element, following it while the page scrolls.
function pointAt(text) {
  const want = text.trim().toLowerCase();
  if (!want) return null;
  const name = (e) =>
    (e.innerText || e.value || e.placeholder || e.getAttribute("aria-label") || e.title || "").trim().replace(/\s+/g, " ").toLowerCase();
  const visible = (e) => {
    const r = e.getBoundingClientRect();
    const cs = getComputedStyle(e);
    return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none";
  };
  const all = [...document.querySelectorAll("a,button,input,textarea,select,summary,label,h1,h2,h3,[role=button],[role=link],[role=tab],[role=menuitem]")].filter(visible);
  const el =
    all.find((e) => name(e) === want) ||
    all.find((e) => name(e).includes(want)) ||
    all.find((e) => name(e).length > 2 && want.includes(name(e)));
  if (!el) return null;

  if (!document.getElementById("marco-style")) {
    const st = document.createElement("style");
    st.id = "marco-style";
    st.textContent =
      "@keyframes marco-pulse{0%,100%{box-shadow:0 0 0 0 rgba(255,122,26,.65),0 0 18px 4px rgba(255,122,26,.45)}50%{box-shadow:0 0 0 10px rgba(255,122,26,0),0 0 26px 8px rgba(255,122,26,.6)}}" +
      "#marco-ring{position:fixed;z-index:2147483647;pointer-events:none;border:3px solid #ff7a1a;border-radius:10px;animation:marco-pulse 1.2s ease-in-out infinite;transition:all .15s}" +
      "#marco-tag{position:fixed;z-index:2147483647;pointer-events:none;background:#ff7a1a;color:#fff;font:600 12px/1 system-ui,sans-serif;padding:6px 9px;border-radius:8px;box-shadow:0 2px 8px rgba(0,0,0,.35)}";
    document.documentElement.appendChild(st);
  }
  document.getElementById("marco-ring")?.remove();
  document.getElementById("marco-tag")?.remove();
  const ring = document.createElement("div");
  ring.id = "marco-ring";
  const tag = document.createElement("div");
  tag.id = "marco-tag";
  tag.textContent = "Marco: here";
  document.documentElement.append(ring, tag);

  el.scrollIntoView({ block: "center", behavior: "smooth" });
  const place = () => {
    const r = el.getBoundingClientRect();
    Object.assign(ring.style, { left: `${r.left - 6}px`, top: `${r.top - 6}px`, width: `${r.width + 12}px`, height: `${r.height + 12}px` });
    const below = r.bottom + 40 < innerHeight;
    Object.assign(tag.style, { left: `${Math.max(8, r.left)}px`, top: `${below ? r.bottom + 10 : Math.max(8, r.top - 34)}px` });
  };
  const timer = setInterval(place, 50);
  place();
  setTimeout(() => { clearInterval(timer); ring.remove(); tag.remove(); }, 9000);
  return name(el).slice(0, 60) || el.tagName.toLowerCase();
}

// Highlights an exact quote with the CSS Custom Highlight API (no DOM changes) and scrolls to it.
// Quotes are matched word by word so punctuation and whitespace differences do not matter.
function highlightQuote(quote) {
  const words = String(quote).match(/[\p{L}\p{N}]+/gu) || [];
  if (!words.length) return false;
  const esc = (w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const build = (ws) => new RegExp(ws.map(esc).join("[^\\p{L}\\p{N}]+"), "iu");
  // Whole quote first; if it spans several elements, fall back to its beginning (8, 5, then 4 words).
  const attempts = [words.length, 8, 5, 4].filter((n, i, a) => n <= words.length && a.indexOf(n) === i).map((n) => build(words.slice(0, n)));
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) {
    const n = walker.currentNode;
    const p = n.parentElement;
    if (n.nodeValue.trim() && p && !/^(SCRIPT|STYLE|NOSCRIPT)$/.test(p.tagName)) nodes.push(n);
  }
  for (const re of attempts) {
    for (const n of nodes) {
      const m = re.exec(n.nodeValue);
      if (!m) continue;
      const range = new Range();
      range.setStart(n, m.index);
      range.setEnd(n, m.index + m[0].length);
      if (!document.getElementById("marco-hl-style")) {
        const st = document.createElement("style");
        st.id = "marco-hl-style";
        st.textContent = "::highlight(marco-quote){background-color:#ffd54a;color:#111}";
        document.documentElement.appendChild(st);
      }
      CSS.highlights.set("marco-quote", new Highlight(range));
      n.parentElement.scrollIntoView({ block: "center", behavior: "smooth" });
      setTimeout(() => CSS.highlights.delete("marco-quote"), 15000);
      return true;
    }
  }
  return false;
}

function clickByText(text) {
  const want = text.trim().toLowerCase();
  const els = [...document.querySelectorAll("a,button,[role=button],input[type=submit],input[type=button]")];
  const label = (e) => (e.innerText || e.value || e.getAttribute("aria-label") || "").trim().toLowerCase();
  const el = els.find((e) => label(e) === want) || els.find((e) => label(e).includes(want));
  if (!el) return `No button or link matching "${text}"`;
  el.scrollIntoView({ block: "center" });
  el.click();
  return `Clicked "${label(el).slice(0, 60)}"`;
}

// fillByLabel/clickByText are ordinary assistant actions ("search for X", "click Sign in"). They never
// inspect, filter, flag, or alter what the user asked to type or click - the only refusal is a password
// field - and they are completely separate from check_reflection/security_scan: an everyday search typed
// here never needs a domain on the reflection allowlist and never gets treated as a security test.
function fillByLabel(label, value) {
  const want = label.trim().toLowerCase();
  const fields = [...document.querySelectorAll("input,textarea")].filter(
    (e) => !["hidden", "submit", "button", "checkbox", "radio", "file"].includes(e.type)
  );
  const names = (e) => {
    const lab = e.id ? document.querySelector(`label[for="${CSS.escape(e.id)}"]`)?.innerText : "";
    return [e.placeholder, e.getAttribute("aria-label"), e.name, e.id, lab, e.closest("label")?.innerText]
      .filter(Boolean).join(" | ").toLowerCase();
  };
  const el = fields.find((e) => names(e).includes(want));
  if (!el) return `No input matching "${label}"`;
  if (el.type === "password") return "Refusing to type into a password field.";
  const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value").set.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  return `Filled "${label}"`;
}

function pageScan() {
  const out = { secrets: [], sinks: 0, noSri: [], scripts: [], forms: [], mixed: 0 };
  const redact = (s) => `${s.slice(0, 6)}...(${s.length} chars)`;
  const secretRes = [
    [/AKIA[0-9A-Z]{16}/, "AWS access key ID"],
    [/AIza[0-9A-Za-z_-]{35}/, "Google API key"],
    [/ghp_[0-9A-Za-z]{36}/, "GitHub personal token"],
    [/xox[baprs]-[0-9A-Za-z-]{10,}/, "Slack token"],
    [/sk_live_[0-9a-zA-Z]{24,}/, "Stripe live secret key"],
    [/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/, "Private key block"],
  ];
  const sinkRe = /\.innerHTML\s*=|\.outerHTML\s*=|document\.write(?:ln)?\s*\(|\beval\s*\(|insertAdjacentHTML\s*\(/g;
  for (const s of document.scripts) {
    if (s.src) {
      try {
        const u = new URL(s.src, location.href);
        out.scripts.push(u.href);
        if (u.origin !== location.origin && !s.integrity) out.noSri.push(u.href.slice(0, 120));
      } catch {}
      continue;
    }
    const t = s.textContent || "";
    for (const [re, name] of secretRes) {
      const m = t.match(re);
      if (m) out.secrets.push(`${name}: ${redact(m[0])}`);
    }
    out.sinks += (t.match(sinkRe) || []).length;
  }
  for (const f of document.forms) {
    const action = (f.action || location.href).slice(0, 100);
    const method = (f.method || "get").toLowerCase();
    const hasPw = !!f.querySelector("input[type=password]");
    if (hasPw && method === "get") out.forms.push(`Password form uses GET: ${action}`);
    if (hasPw && location.protocol === "https:" && action.startsWith("http:")) out.forms.push(`Password form posts over HTTP: ${action}`);
    if (method === "post" && !f.querySelector("input[type=hidden][name*=csrf i],input[type=hidden][name*=token i],input[type=hidden][name*=nonce i],input[type=hidden][name*=authenticity i]"))
      out.forms.push(`POST form with no obvious CSRF token (heuristic): ${action}`);
  }
  if (location.protocol === "https:")
    out.mixed = document.querySelectorAll('script[src^="http:"],link[rel=stylesheet][href^="http:"],iframe[src^="http:"]').length;
  return out;
}

// Looks for JWTs left in browser storage (decodes header/payload only, never verifies the signature)
// and for links whose query string points somewhere else via a redirect-style parameter.
function findClientSideIssues() {
  const out = { tokens: [], redirects: [] };

  const b64urlToStr = (s) => {
    try {
      const pad = s.replace(/-/g, "+").replace(/_/g, "/").padEnd(s.length + ((4 - (s.length % 4)) % 4), "=");
      return decodeURIComponent([...atob(pad)].map((c) => "%" + c.charCodeAt(0).toString(16).padStart(2, "0")).join(""));
    } catch {
      return null;
    }
  };
  const checkJwt = (where, value) => {
    const m = /^([A-Za-z0-9_-]{10,})\.([A-Za-z0-9_-]{10,})\.[A-Za-z0-9_-]{5,}$/.exec(String(value || "").trim());
    if (!m) return;
    try {
      const header = JSON.parse(b64urlToStr(m[1]));
      const payload = JSON.parse(b64urlToStr(m[2]));
      if (!header || typeof header !== "object") return;
      const flags = [];
      if (String(header.alg || "").toLowerCase() === "none") flags.push("alg is \"none\": this token is unsigned");
      if (!payload || !payload.exp) flags.push("no \"exp\" claim: this token never expires");
      else if (payload.exp * 1000 - Date.now() > 1000 * 60 * 60 * 24 * 400) flags.push("expiry is more than a year away");
      out.tokens.push({ where, alg: header.alg || "?", flags });
    } catch {}
  };
  try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); checkJwt(`localStorage.${k}`, localStorage.getItem(k)); } } catch {}
  try { for (let i = 0; i < sessionStorage.length; i++) { const k = sessionStorage.key(i); checkJwt(`sessionStorage.${k}`, sessionStorage.getItem(k)); } } catch {}

  const redirectParam = /^(redirect|redirect_uri|redirecturl|url|next|return|return_to|returnurl|dest|destination|continue|goto|target)$/i;
  const seen = new Set();
  for (const a of document.links) {
    if (out.redirects.length >= 5) break;
    let u;
    try { u = new URL(a.href, location.href); } catch { continue; }
    for (const [k, v] of u.searchParams) {
      if (!redirectParam.test(k) || !v) continue;
      let abs;
      try { abs = new URL(v, location.href); } catch { continue; }
      if (!/^https?:$/.test(abs.protocol) || abs.origin === location.origin) continue;
      const key = `${k}|${abs.origin}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.redirects.push(`?${k}=...${abs.origin} (found on a link to ${u.pathname || "/"})`);
    }
  }
  return out;
}

// ---- tools ----

async function securityScan(tab) {
  if (!isWeb(tab)) return { text: "Not an http(s) page, nothing to scan." };
  const url = new URL(tab.url);
  const https = url.protocol === "https:";
  const findings = [];
  const add = (sev, title, evidence = "") => findings.push({ sev, title, evidence });

  try {
    const r = await fetch(tab.url, { credentials: "omit", cache: "no-store" });
    const h = r.headers;
    const csp = h.get("content-security-policy") || "";
    if (!csp) add("medium", "Missing Content-Security-Policy");
    else if (/script-src[^;]*'unsafe-(inline|eval)'/.test(csp)) add("medium", "CSP allows unsafe-inline/unsafe-eval scripts", csp.slice(0, 160));
    if (https && !h.get("strict-transport-security")) add("medium", "Missing Strict-Transport-Security (HSTS)");
    if ((h.get("x-content-type-options") || "").toLowerCase() !== "nosniff") add("low", "Missing X-Content-Type-Options: nosniff");
    if (!h.get("x-frame-options") && !/frame-ancestors/.test(csp)) add("medium", "No clickjacking protection (X-Frame-Options / frame-ancestors)");
    if (!h.get("referrer-policy")) add("low", "Missing Referrer-Policy");
    for (const k of ["server", "x-powered-by"]) if (h.get(k)) add("low", `Technology disclosure via ${k}`, h.get(k));
    if (h.get("access-control-allow-origin") === "*" && h.get("access-control-allow-credentials") === "true")
      add("high", "CORS allows any origin together with credentials");
  } catch (e) {
    add("info", "Could not fetch response headers", String(e).slice(0, 120));
  }

  try {
    const cookies = await chrome.cookies.getAll({ url: tab.url });
    const group = (pred) => cookies.filter(pred).map((c) => c.name).slice(0, 8).join(", ");
    const noSecure = https && group((c) => !c.secure);
    const noHttpOnly = group((c) => !c.httpOnly);
    const noSameSite = group((c) => c.sameSite === "unspecified" || c.sameSite === "no_restriction");
    if (noSecure) add("medium", "Cookies without Secure flag", noSecure);
    if (noHttpOnly) add("low", "Cookies readable by JavaScript (no HttpOnly)", noHttpOnly);
    if (noSameSite) add("low", "Cookies without a restrictive SameSite", noSameSite);
  } catch {}

  const p = await inPage(tab, pageScan);
  p.secrets.forEach((s) => add("high", "Possible secret in inline JavaScript", s));
  if (p.sinks) add("low", `Inline script uses risky DOM sinks (${p.sinks} places: innerHTML/eval/document.write)`, "Review whether user-controlled data reaches them");
  if (p.noSri.length) add("low", `${p.noSri.length} third-party script(s) without Subresource Integrity`, p.noSri.slice(0, 3).join("\n"));
  p.forms.forEach((f) => add("medium", f.startsWith("POST") ? "Possible missing CSRF protection" : "Insecure password form", f));
  if (p.mixed) add("medium", `${p.mixed} mixed-content resource(s) loaded over HTTP`);

  // Front-end JS library versions with known public advisories, spotted from the CDN/file name in the URL.
  // This only reads a version NUMBER out of a filename; it never fetches or runs the library's code.
  const LIB_ADVISORIES = [
    [/jquery[.-](1\.(?:[0-9]|1[01])\.\d+|2\.[01]\.\d+)(?:\.min)?\.js/i, "jQuery", "versions before 1.12.0/2.2.0 have public XSS advisories in .html()/.append()"],
    [/jquery-ui[.-](1\.[0-9]\.\d+)/i, "jQuery UI", "1.x releases before 1.13 have public XSS advisories (e.g. in the datepicker)"],
    [/bootstrap[.-](2\.\d+\.\d+|3\.[0-3]\.\d+)/i, "Bootstrap", "2.x and early 3.x have public XSS advisories in tooltip/popover/affix"],
    [/angular(?:\.min)?[.-](1\.[0-5]\.\d+)\.js/i, "AngularJS 1.x", "versions before 1.6 have public sandbox-escape XSS advisories, and 1.x itself is end of life"],
    [/lodash[.-](\d\.\d+\.\d+)/i, "Lodash", "versions before 4.17.21 have a public prototype-pollution advisory"],
    [/moment[.-](\d\.\d+\.\d+)/i, "Moment.js", "versions before 2.29.4 have a public ReDoS advisory, and the project is in maintenance mode"],
  ];
  const seenLib = new Set();
  for (const src of p.scripts) {
    for (const [re, lib, note] of LIB_ADVISORIES) {
      const m = re.exec(src);
      if (m && !seenLib.has(lib + m[1])) {
        seenLib.add(lib + m[1]);
        add("medium", `Possibly outdated ${lib} (${m[1]})`, `${note}.\n    file: ${src.slice(0, 140)}\n    Check the project's changelog/advisories for this exact version before assuming it's affected.`);
      }
    }
  }

  const tokens = await inPage(tab, findClientSideIssues);
  tokens.tokens.forEach((t) => {
    if (t.flags.length) add("medium", `JWT in ${t.where} looks weak`, t.flags.join("; "));
  });
  tokens.redirects.forEach((r) => add("low", "Link with an open-redirect-style parameter", `${r}\nIf the server redirects to this value without checking it against an allow-list, it can be used for phishing.`));

  // A few common "left exposed by accident" files. First checks whether the site 200s on ANY unknown
  // path (common for single-page apps), which would make this check unreliable, and skips it if so.
  try {
    const probePath = `/__marco_probe_${Math.random().toString(36).slice(2)}`;
    const probe = await fetch(url.origin + probePath, { credentials: "omit", cache: "no-store", redirect: "manual" });
    if (probe.status === 200) {
      add("info", "Skipped exposed-file check", "This site returns 200 for an unrelated made-up path, so a 200 response can't be used to tell whether a specific file is really exposed (common for single-page apps).");
    } else {
      const SENSITIVE_PATHS = [
        ["/.git/HEAD", (t) => /^ref:\s*refs\//.test(t.trim())],
        ["/.env", (t) => /^[A-Z_][A-Z0-9_]*\s*=/m.test(t) && !/^\s*</.test(t)],
        ["/.git/config", (t) => /\[core\]/.test(t)],
        ["/wp-config.php.bak", (t) => /DB_PASSWORD|define\(/i.test(t)],
        ["/server-status", (t) => /Apache Server Status/i.test(t)],
      ];
      for (const [path, verify] of SENSITIVE_PATHS) {
        try {
          const r = await fetch(url.origin + path, { credentials: "omit", cache: "no-store", redirect: "manual" });
          if (r.status !== 200) continue;
          const text = await r.text();
          if (verify(text)) {
            add("high", `Possibly exposed file: ${path}`, `GET ${url.origin}${path} returned 200 with content matching this file's expected format. If this is genuinely exposed, remove it from the public web root or block the path in your server config, and rotate any secrets it may contain.`);
          }
        } catch {}
      }
    }
  } catch {}

  const order = { high: 0, medium: 1, low: 2, info: 3 };
  findings.sort((a, b) => order[a.sev] - order[b.sev]);
  const lines = findings.map((f) => `[${f.sev.toUpperCase()}] ${f.title}${f.evidence ? `\n    evidence: ${f.evidence}` : ""}`);
  return { text: `Passive scan of ${url.origin} (no requests beyond one GET of this page):\n${lines.join("\n") || "No findings from these checks."}` };
}

const TOOLS = {
  async get_page_text({ offset }, tab) {
    if (!isWeb(tab)) return { text: `This page type (${(tab.url || "").split(":")[0]}) can't be read.` };
    const off = Math.max(0, Number(offset) || 0);
    const p = await inPage(tab, readPage, [off]);
    const end = off + p.chunk.length;
    const head = [
      `Title: ${tab.title}`,
      `URL: ${tab.url}`,
      p.meta && `Description: ${p.meta}`,
      `Page has ${p.links} links, ${p.forms} forms, ${p.images} images.`,
      p.headings.length && `Outline:\n${p.headings.join("\n")}`,
      p.nav.length && `Navigation: ${p.nav.join(" | ")}`,
      p.buttons.length && `Buttons: ${p.buttons.join(" | ")}`,
      p.fields.length && `Input fields: ${p.fields.join(" | ")}`,
      p.selection && `USER HAS SELECTED THIS TEXT:\n${p.selection}`,
    ].filter(Boolean);
    const tail = end < p.total ? `\n...[showing characters ${off}-${end} of ${p.total}; call get_page_text with offset ${end} for more]` : "";
    return { text: `${head.join("\n")}\n\nContent:\n${p.chunk}${tail}` };
  },

  async find_in_page({ query }, tab) {
    if (!isWeb(tab)) return { text: "Can't search this page type." };
    const r = await inPage(tab, searchPage, [String(query || "")]);
    if (!r.count) return { text: `No matches for "${query}".` };
    return { text: `${r.count} match(es) for "${query}":\n${r.snippets.map((s, i) => `${i + 1}. ...${s}...`).join("\n")}` };
  },

  async point_at({ text }, tab) {
    if (!isWeb(tab)) return { text: "Can't point on this page type." };
    if (!tab.active) await chrome.tabs.update(tab.id, { active: true });
    const found = await inPage(tab, pointAt, [String(text || "")]);
    return { text: found ? `Pointing at "${found}" on the page; the user can see a glowing ring around it.` : `Couldn't find anything matching "${text}" on the visible page. Re-read the page for the exact button or link text.` };
  },

  async highlight_quote({ quote }, tab) {
    if (!isWeb(tab)) return { text: "Can't highlight on this page type." };
    if (!tab.active) await chrome.tabs.update(tab.id, { active: true });
    const ok = await inPage(tab, highlightQuote, [String(quote || "")]);
    return { text: ok ? "Highlighted the quote on the page." : "That quote was not found on the page." };
  },

  async list_tabs(_args, tab) {
    const tabs = await chrome.tabs.query({});
    return { text: tabs.map((t) => `${t.id}: ${t.title} (${t.url})${t.id === tab.id ? " [this agent's tab]" : ""}`).join("\n") };
  },

  async switch_tab({ tab_id }) {
    const t = await chrome.tabs.update(Number(tab_id), { active: true });
    await chrome.windows.update(t.windowId, { focused: true });
    return { text: `Switched to: ${t.title}` };
  },

  async navigate({ url }, tab, ctx) {
    const u = httpUrl(url);
    if (!u) return { text: "Only http(s) URLs are allowed." };
    if (!ctx.allow("navigate", `Marco wants to go to ${u.href}`)) return { text: "User declined." };
    const loaded = waitLoaded(tab.id);
    await chrome.tabs.update(tab.id, { url: u.href });
    const t = await loaded;
    return { text: `Loaded "${t.title}" (${t.url}) in this tab. Call get_page_text to read it.` };
  },

  async open_url({ url }, _tab, ctx) {
    const u = httpUrl(url);
    if (!u) return { text: "Only http(s) URLs are allowed." };
    if (!ctx.allow("open_url", `Marco wants to open ${u.href} in a new tab`)) return { text: "User declined." };
    const created = await chrome.tabs.create({ url: u.href });
    const t = await waitLoaded(created.id);
    // The agent keeps working in the tab it opened; the panel re-points this conversation at it.
    return { text: `Opened "${t.title}" (${t.url}) in a new tab. You are now working in that tab. Call get_page_text to read it.`, adoptTabId: created.id };
  },

  async screenshot(_args, tab) {
    // captureVisibleTab only sees the front tab, so bring this agent's tab forward first.
    if (!tab.active) {
      await chrome.tabs.update(tab.id, { active: true });
      await sleep(400);
    }
    const data = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "jpeg", quality: 60 });
    return { text: `Screenshot of "${tab.title}" attached.`, image: data.split(",")[1] };
  },

  async click_text({ text }, tab, ctx) {
    if (!isWeb(tab)) return { text: "Can't act on this page." };
    if (!ctx.allow("click_text", `Marco wants to click "${text}" on ${new URL(tab.url).host}`)) return { text: "User declined." };
    return { text: await inPage(tab, clickByText, [String(text)]) };
  },

  async fill_field({ label, value }, tab, ctx) {
    if (!isWeb(tab)) return { text: "Can't act on this page." };
    if (!ctx.allow("fill_field", `Marco wants to type into "${label}" on ${new URL(tab.url).host}`)) return { text: "User declined." };
    return { text: await inPage(tab, fillByLabel, [String(label), String(value)]) };
  },

  async security_scan(_args, tab) {
    return securityScan(tab);
  },

  async watch_page(_args, tab) {
    if (!isWeb(tab)) return { text: "Can't watch this page type." };
    const snap = await fetchSnapshot(tab.url);
    await saveBaseline(snap.url, snap);
    return { text: `Saved a baseline for ${snap.url} (title: "${snap.title}", ${snap.length} characters of text). Call check_defacement later to see if it has changed.` };
  },

  // Always asks via ctx.ask directly (not ctx.allow), so this can never be auto-approved by the
  // "don't ask me" settings used for click/fill/navigate - confirmation here is not optional.
  async check_reflection(_args, tab, ctx) {
    if (!isWeb(tab)) return { text: "Can't test this page type." };
    return runReflectionCheck(tab, ctx.prefs, ctx.ask);
  },

  async check_defacement(_args, tab) {
    if (!isWeb(tab)) return { text: "Can't check this page type." };
    const baselines = await loadBaselines();
    const saved = baselines[tab.url];
    const now = await fetchSnapshot(tab.url);
    if (!saved) {
      await saveBaseline(now.url, now);
      return { text: `No baseline existed for ${now.url}, so I saved the current state as the baseline (title: "${now.title}"). Nothing to compare yet - check again later or after making a change to test it.` };
    }
    const cmp = compareSnapshot(saved, now);
    const savedWhen = new Date(saved.savedAt).toLocaleString();
    if (cmp.severity === "none") return { text: `No change detected on ${now.url} since the baseline was saved (${savedWhen}).` };
    return {
      text: [
        `Comparing ${now.url} to the baseline saved ${savedWhen}:`,
        `Severity: ${cmp.severity.toUpperCase()}`,
        `Reason: ${cmp.summary}`,
        cmp.titleChanged ? `Title: "${cmp.oldTitle}" -> "${cmp.newTitle}"` : null,
        cmp.newPhrases?.length ? `Matched phrase(s): ${cmp.newPhrases.join(", ")}` : null,
        "This baseline was NOT updated, so you can keep checking against the original. If this change is expected (a real content update), tell the user they can re-run watch_page to accept it as the new baseline.",
      ].filter(Boolean).join("\n"),
    };
  },
};

// Tools that move browser focus; the panel uses this to stay on the current conversation.
export const MOVES_FOCUS = new Set(["navigate", "open_url", "switch_tab", "screenshot", "point_at", "highlight_quote"]);

// ctx = { prefs, ask(question) -> boolean }. Applies the user's Settings before any tool runs.
export async function runTool(name, args, ctx, tabId) {
  const fn = TOOLS[name];
  if (!fn) return { text: `Unknown tool ${name}` };
  if (ctx.prefs.enabled[name] === false) {
    return { text: `The "${name}" tool is turned off in Settings (Tools Marco may use). Tell the user to enable it if they want this.` };
  }
  const full = { ...ctx, allow: (kind, question) => ctx.prefs.autoAllow[kind] === true || ctx.ask(question) };
  try {
    const tab = await getTab(tabId);
    return await fn(args || {}, tab, full);
  } catch (e) {
    return { text: `${name} failed: ${e.message}` };
  }
}
