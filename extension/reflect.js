// Passive reflected-input ("reflected XSS recon") checker.
//
// What it does: for each existing query-string parameter on an ALLOWLISTED page, it re-requests the
// page with that one parameter's value replaced by a unique, harmless, alphanumeric marker plus four
// individual probe characters ( " ' < > ). It never sends a <script> tag, an event handler, or any
// construct that could execute - the probe cannot do anything even if reflected completely unescaped.
// It then looks at where the marker landed in the response and how the probe characters came back
// (raw / HTML-entity-encoded / JS-string-escaped / URL-encoded / stripped) to classify the reflection.
//
// Hard safety gates, enforced here in code (the model cannot talk its way past these):
//   1. The hostname must already be on the user's own allowlist (prefs.reflectAllowlist). Empty by default.
//   2. The user is always asked to confirm before any request is sent, regardless of the "don't ask me"
//      settings used elsewhere in the extension.
//   3. A recognised sensitive hostname (government/education/bank/healthcare keywords) asks a second,
//      more explicit confirmation every time, even if already allowlisted.
//   4. Requests are rate-limited per domain and capped per run. Cookies are never sent (credentials: "omit").
//   5. Only a short, redacted snippet of each response is ever stored or shown - never the full page.

const LOG_KEY = "marco_reflect_log";
const RATE_KEY = "marco_reflect_rate";
const LAST_RUN_KEY = "marco_reflect_last";
const MAX_LOG = 200;
const MAX_PARAMS_PER_RUN = 5;
const MAX_RUNS_PER_DOMAIN_PER_HOUR = 10;
const MIN_DELAY_MS = 400;

export const NOTICE = "Authorised testing only: this only runs against sites you have added to the allowlist yourself, as the owner or with the owner's permission.";

// Parameter names we skip: session/auth/action-like params aren't useful for a reflection test and
// swapping them could interfere with how the page behaves.
const SKIP_PARAM = /token|csrf|session|auth|signature|secret|password|delete|remove|action|cmd|exec/i;

const SENSITIVE_HINT = /\.gov\b|\.mil\b|\.edu\b|bank|treasury|\birs\b|healthcare|hospital|\bclinic\b|insurance/i;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function attr(tag, name) {
  const m = new RegExp(`${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag);
  return m ? (m[1] ?? m[2] ?? m[3] ?? "") : null;
}

const NON_TESTABLE_TYPES = new Set(["submit", "button", "image", "reset", "file", "checkbox", "radio", "password"]);

// Finds GET forms on the page (so a search box can be tested even before the user has ever searched,
// i.e. before its parameter exists in the address bar at all) and lists their fields. Plain regex
// parsing of the raw HTML - good enough for well-formed forms, not a full HTML parser.
export function extractGetForms(html, pageUrl) {
  const forms = [];
  const formRe = /<form\b([^>]*)>([\s\S]*?)<\/form>/gi;
  let fm;
  while ((fm = formRe.exec(html))) {
    const [, openTag, body] = fm;
    const method = (attr(openTag, "method") || "get").toLowerCase();
    if (method !== "get") continue; // never test a POST form - we only ever send GET requests
    const rawAction = attr(openTag, "action");
    let action;
    try { action = new URL(rawAction || "", pageUrl); } catch { continue; }

    const fields = [];
    const fieldRe = /<(input|select|textarea)\b([^>]*)(?:\/?>|>[\s\S]*?<\/\1>)/gi;
    let fdm;
    while ((fdm = fieldRe.exec(body))) {
      const [, tagName, fattrs] = fdm;
      const name = attr(fattrs, "name");
      if (!name) continue;
      const type = tagName.toLowerCase() === "input" ? (attr(fattrs, "type") || "text").toLowerCase() : "text";
      fields.push({ name, type, value: attr(fattrs, "value") || "", hidden: type === "hidden" });
    }
    if (fields.length) forms.push({ action: action.toString(), fields });
  }
  return forms;
}

const SEARCH_HINT = /search|query|\bq\b|find|keyword|lookup/i;

// Fallback for search boxes that aren't inside a plain <form method="GET"> - e.g. a JS-driven search
// widget. Finds any <input> that looks like a search field (type="search", or a name/id/placeholder/
// aria-label containing a search-ish word) ANYWHERE on the page, not just inside a <form>, and offers
// it as a candidate to test against the CURRENT page URL (many such widgets still support `?name=...`
// as a shareable/bookmarkable link even when the on-page JS is what normally drives them).
function extractStandaloneSearchInputs(html) {
  const out = [];
  const inputRe = /<input\b([^>]*)\/?>/gi;
  let m;
  while ((m = inputRe.exec(html))) {
    const tag = m[1];
    const type = (attr(tag, "type") || "text").toLowerCase();
    if (NON_TESTABLE_TYPES.has(type)) continue;
    // Prefer name="" (what a real form submission would use); fall back to id="" since some JS-driven
    // widgets build their own query string from the element's id when there's no name at all.
    const name = attr(tag, "name") || attr(tag, "id");
    if (!name) continue;
    const hints = [name, attr(tag, "placeholder"), attr(tag, "aria-label")].filter(Boolean).join(" ");
    if (type === "search" || SEARCH_HINT.test(hints)) out.push({ name, value: attr(tag, "value") || "" });
  }
  return out;
}

// A loopback address can only ever be the tester's own machine - there's no third party it could
// belong to - so these are always allowed and don't need to be added to the list by hand.
const ALWAYS_LOCAL = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

// Unlike bank/healthcare/education (where a small clinic, a personal fintech project, or a
// university researcher could plausibly own a real domain), a .gov/.mil domain is realistically
// never something an individual hackathon user owns. These are hard-denied - not just a second
// confirmation - and the Settings UI refuses to even save one into the allowlist (see sidepanel.js).
export function isHardDenied(hostname) {
  const h = (hostname || "").toLowerCase();
  return /\.gov$|\.gov\.[a-z]{2,}$|\.mil$|\.mil\.[a-z]{2,}$/.test(h);
}

export function isAllowlisted(hostname, list) {
  const h = (hostname || "").toLowerCase();
  if (isHardDenied(h)) return false;
  if (ALWAYS_LOCAL.has(h) || h.endsWith(".localhost")) return true;
  return (list || []).some((d) => {
    const entry = String(d || "").trim().toLowerCase().replace(/^\*\./, "");
    return entry && (h === entry || h.endsWith(`.${entry}`));
  });
}

export function looksSensitive(hostname) {
  return SENSITIVE_HINT.test(hostname || "");
}

function randomCanary() {
  return `mcR${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

// The actual probe appended after the random token. Four single characters, nothing that forms
// a tag, attribute, or executable construct on its own.
const PROBE_CHARS = `"'<>`;

// The 4 probe characters were appended immediately after the canary with nothing in between, so a
// faithful reflection should show them (raw or encoded) starting at that exact position. We parse
// strictly in order from there instead of free-scanning ahead, so ordinary HTML markup that happens
// to follow (every page has '<' and '>' somewhere soon after any text) is never mistaken for our probe.
const ENCODED_FORMS = {
  '"': { entity: ["&quot;", "&#34;", "&#x22;"], url: ["%22"], js: ['\\"', "\\u0022", "\\x22"] },
  "'": { entity: ["&#39;", "&apos;", "&#x27;"], url: ["%27"], js: ["\\'", "\\u0027", "\\x27"] },
  "<": { entity: ["&lt;", "&#60;", "&#x3c;"], url: ["%3C", "%3c"], js: ["\\u003c", "\\x3c"] },
  ">": { entity: ["&gt;", "&#62;", "&#x3e;"], url: ["%3E", "%3e"] , js: ["\\u003e", "\\x3e"] },
};

function analyzeProbe(after) {
  let pos = 0;
  let raw = 0, encoded = 0, missing = 0;
  const kinds = new Set();
  for (const ch of PROBE_CHARS) {
    if (after[pos] === ch) { raw++; pos += 1; continue; }
    const forms = ENCODED_FORMS[ch];
    let matched = false;
    for (const kind of ["entity", "url", "js"]) {
      for (const tok of forms[kind]) {
        if (after.startsWith(tok, pos)) { encoded++; kinds.add(kind); pos += tok.length; matched = true; break; }
      }
      if (matched) break;
    }
    if (!matched) missing++;
  }
  return { raw, encoded, missing, kinds: [...kinds] };
}

function classifyContext(html, canary) {
  const idx = html.indexOf(canary);
  if (idx === -1) return { category: "not_reflected", summary: "The marker did not come back in the response at all." };

  const before = html.slice(Math.max(0, idx - 300), idx);
  const after = html.slice(idx + canary.length, idx + canary.length + 40);
  const snippet = html.slice(Math.max(0, idx - 40), idx + canary.length + 40).replace(/\s+/g, " ");

  const lastOpenScript = before.lastIndexOf("<script");
  const lastCloseScript = before.lastIndexOf("</script");
  const inScript = lastOpenScript > lastCloseScript;

  const { raw, encoded, missing, kinds } = analyzeProbe(after);

  let category, summary;
  if (inScript) {
    category = "possible_script_context_reflection";
    summary = "The input is reflected inside a <script> block. Script context has different escaping rules than HTML, so this needs a closer manual look even if the characters appear encoded here.";
  } else if (raw > 0) {
    category = "suspicious_html_reflection";
    summary = "The input is reflected in the page body/markup with at least one of \" ' < > coming back unescaped. This is the pattern that often allows breaking out of HTML into a tag or attribute.";
  } else if (encoded > 0 || missing === PROBE_CHARS.length) {
    category = "safely_escaped_reflection";
    summary = missing === PROBE_CHARS.length
      ? "The special test characters did not come back at all (likely stripped or filtered), which is a safe outcome for this check."
      : `The special test characters came back encoded (${kinds.join(", ")}), which is the expected safe behaviour.`;
  } else {
    category = "unconfirmed";
    summary = "The marker was reflected but the surrounding encoding could not be classified confidently.";
  }
  return { category, summary, snippet, inScript };
}

function redactUrl(url, testedParam) {
  const u = new URL(url);
  for (const k of [...u.searchParams.keys()]) {
    if (k !== testedParam) u.searchParams.set(k, "[redacted]");
  }
  return u.toString();
}

async function rateLimited(domain) {
  const { [RATE_KEY]: all = {} } = await chrome.storage.local.get(RATE_KEY);
  const now = Date.now();
  const hits = (all[domain] || []).filter((t) => now - t < 3600_000);
  if (hits.length >= MAX_RUNS_PER_DOMAIN_PER_HOUR) return true;
  hits.push(now);
  all[domain] = hits;
  await chrome.storage.local.set({ [RATE_KEY]: all });
  return false;
}

async function appendLog(entries) {
  const { [LOG_KEY]: log = [] } = await chrome.storage.local.get(LOG_KEY);
  const next = [...log, ...entries].slice(-MAX_LOG);
  await chrome.storage.local.set({ [LOG_KEY]: next });
}

export async function getLog() {
  const { [LOG_KEY]: log = [] } = await chrome.storage.local.get(LOG_KEY);
  return log;
}

// Read-only view of rate-limit usage per domain, for showing in the UI. Does not consume a slot.
export async function getRateStatus() {
  const { [RATE_KEY]: all = {} } = await chrome.storage.local.get(RATE_KEY);
  const now = Date.now();
  const out = [];
  for (const [domain, hits] of Object.entries(all)) {
    const active = (hits || []).filter((t) => now - t < 3600_000);
    if (!active.length) continue;
    const resetMs = Math.max(0, 3600_000 - (now - Math.min(...active)));
    out.push({ domain, used: active.length, max: MAX_RUNS_PER_DOMAIN_PER_HOUR, resetMinutes: Math.ceil(resetMs / 60000) });
  }
  return out;
}

const CATEGORY_FIX = {
  possible_script_context_reflection: "Never place untrusted input inside a <script> block as raw text. If data must reach client-side JS, JSON-encode it into a data-* attribute or a JSON island, or use a templating layer that JS-escapes by default.",
  suspicious_html_reflection: "Apply contextual output encoding for wherever this value is rendered (HTML-escape for body text, attribute-encode for attributes). Most modern template engines (Jinja2 autoescape, React, Vue, Rails ERB with <%=) do this by default - check whether autoescaping was disabled for this field. Add a Content-Security-Policy as a second layer of defence, and validate/allow-list the input server-side.",
  safely_escaped_reflection: "No action needed for this parameter based on this check, though input validation server-side is still good practice.",
  unconfirmed: "Worth a manual look: fetch the URL yourself and view-source around the marker to see the exact context.",
  not_reflected: "No action needed - this input doesn't appear to be echoed back on this page.",
};

// Builds the human-readable report text (what the tool returns, and what the user can paste into
// a disclosure email). Always hedges: this is reflection evidence, never a confirmed exploit.
function buildReport(hostname, results, skipped, blocked) {
  const lines = [`${NOTICE}`, "", `Passive reflected-input check on ${hostname} (${results.length} parameter(s) tested, cookies not sent):`, ""];
  if (!results.length) lines.push("No query parameters were tested.");
  for (const r of results) {
    lines.push(`Parameter "${r.param}" (from ${r.source || "the address bar"}): ${r.category.replace(/_/g, " ").toUpperCase()}`);
    lines.push(`  ${r.summary}`);
    if (r.category !== "not_reflected") {
      lines.push(`  Reproduction: request ${r.redactedUrl} (marker in "${r.param}" only; other params redacted here)`);
      if (r.snippet) lines.push(`  Evidence snippet: ...${r.snippet}...`);
    }
    lines.push(`  Fix: ${CATEGORY_FIX[r.category]}`);
    lines.push("");
  }
  if (skipped.length) lines.push(`Skipped (session/action-like parameter, not tested): ${skipped.join(", ")}`);
  if (blocked) lines.push("Stopped early: rate limit for this domain reached (max checks/hour). Try again later.");
  lines.push("");
  lines.push("This is automated reflection evidence only, not a confirmed vulnerability - it never ran a script or exploit. A human should verify any SUSPICIOUS/POSSIBLE finding before reporting it to the site owner. If confirmed, report it through the owner's security contact or disclosure programme with: the affected URL and parameter (redact any session/secret values), the steps above, the impact (reflected script execution in a victim's browser if this input is not properly encoded), and the fix suggested.");
  return lines.join("\n");
}

// Builds one GET request URL for a candidate: the page's own address-bar params (source "url"), or a
// discovered <form method="get"> (source "form") - for a form, every OTHER field keeps its default
// value so the request looks like a real submission, and only the tested field carries the marker.
function buildProbeUrl(candidate, canary) {
  const url = new URL(candidate.baseUrl);
  for (const [k, v] of candidate.otherFields || []) url.searchParams.set(k, v);
  url.searchParams.set(candidate.param, canary + PROBE_CHARS);
  return url;
}

function collectCandidates(target, formsHtml) {
  const candidates = [];
  const seen = new Set();
  const add = (baseUrl, param, otherFields, source) => {
    const key = `${baseUrl}|${param}`;
    if (seen.has(key) || SKIP_PARAM.test(param)) return;
    seen.add(key);
    candidates.push({ baseUrl, param, otherFields, source });
  };

  for (const param of target.searchParams.keys()) {
    const others = [...target.searchParams].filter(([k]) => k !== param);
    add(`${target.origin}${target.pathname}`, param, others, "the address bar");
  }

  if (formsHtml) {
    for (const form of extractGetForms(formsHtml, target.toString())) {
      const actionHost = new URL(form.action).hostname;
      if (actionHost !== target.hostname) continue; // never follow a form onto a different, unreviewed domain
      const testable = form.fields.filter((f) => !f.hidden && !NON_TESTABLE_TYPES.has(f.type));
      const others = form.fields.filter((f) => f.hidden).map((f) => [f.name, f.value]);
      for (const f of testable) add(form.action.split("?")[0], f.name, others, "a search/input form on the page");
    }
    // Fallback for search boxes that aren't inside a plain GET <form> at all (common on JS-driven
    // sites) - only used if proper forms didn't already fill the run, and tested against the page itself.
    if (candidates.length < MAX_PARAMS_PER_RUN) {
      for (const f of extractStandaloneSearchInputs(formsHtml)) {
        add(`${target.origin}${target.pathname}`, f.name, [], "a search box detected on the page (best-effort guess)");
      }
    }
  }
  return candidates;
}

const skippedNames = (names) => names.filter((n) => SKIP_PARAM.test(n));

// tab: {url}. prefs: {reflectAllowlist: string[]}. ask: async (question) => boolean.
export async function runReflectionCheck(tab, prefs, ask) {
  const target = new URL(tab.url);
  const allowlist = prefs.reflectAllowlist || [];

  if (isHardDenied(target.hostname)) {
    return {
      text: `${NOTICE}\n\n${target.hostname} is a .gov/.mil domain. This is refused outright, not just gated behind a confirmation - these are never something an individual user owns, so there is no "add it to the allowlist" path for this category at all.`,
    };
  }
  if (!isAllowlisted(target.hostname, allowlist)) {
    return {
      text: `${NOTICE}\n\n${target.hostname} is not authorised for testing. Nothing was sent to it.`,
    };
  }
  if (looksSensitive(target.hostname)) {
    const ok = await ask(`${target.hostname} looks like it could be a government, education, banking, healthcare, or similar sensitive site. Only continue if you are the owner or have explicit written authorisation to test it. Continue?`);
    if (!ok) return { text: "Cancelled - sensitive-site confirmation declined." };
  }

  // Also look for a GET search/input form on the page itself, so a search box can be tested even
  // before its parameter exists in the address bar (i.e. before the user has ever searched).
  let formsHtml = null;
  const existingParamCount = [...target.searchParams.keys()].length;
  if (existingParamCount < MAX_PARAMS_PER_RUN) {
    if (await rateLimited(target.hostname)) {
      return { text: `${NOTICE}\n\nRate limit reached for ${target.hostname} (max checks/hour) - try again later.` };
    }
    try {
      const r = await fetch(target.toString(), { credentials: "omit", cache: "no-store", redirect: "follow" });
      formsHtml = await r.text();
    } catch { /* page fetch failed; fall back to address-bar params only */ }
  }

  const all = collectCandidates(target, formsHtml);
  const toTest = all.slice(0, MAX_PARAMS_PER_RUN);
  const skipped = [
    ...skippedNames([...target.searchParams.keys()]),
    ...(formsHtml ? extractGetForms(formsHtml, target.toString()).flatMap((f) => skippedNames(f.fields.filter((x) => !x.hidden).map((x) => x.name))) : []),
  ];

  if (!toTest.length) {
    return {
      text: formsHtml
        ? `No testable parameters found on ${target.hostname} - no query parameters in the address bar, and no GET search/input form was found on the page.`
        : `This page's URL has no query parameters, so there's nothing to test.`,
    };
  }

  const ok = await ask(`${NOTICE}\n\nAbout to send ${toTest.length} harmless test request(s) to ${target.hostname} (no cookies sent, no scripts, just a random marker in a parameter) to check for reflected-input issues. Continue?`);
  if (!ok) return { text: "Cancelled - user declined." };

  const results = [];
  const auditEntries = [];
  let blocked = false;
  for (const candidate of toTest) {
    if (await rateLimited(target.hostname)) { blocked = true; break; }
    const canary = randomCanary();
    const probeUrl = buildProbeUrl(candidate, canary);
    let cls;
    try {
      const r = await fetch(probeUrl.toString(), { credentials: "omit", cache: "no-store", redirect: "follow" });
      const html = await r.text();
      cls = classifyContext(html, canary);
    } catch (e) {
      cls = { category: "unconfirmed", summary: `Request failed: ${String(e).slice(0, 100)}` };
    }
    const redactedUrl = redactUrl(probeUrl.toString(), candidate.param);
    results.push({ param: candidate.param, source: candidate.source, redactedUrl, ...cls });
    auditEntries.push({ ts: Date.now(), hostname: target.hostname, param: candidate.param, category: cls.category, redactedUrl });
    await sleep(MIN_DELAY_MS);
  }

  await appendLog(auditEntries);
  await chrome.storage.local.set({ [LAST_RUN_KEY]: { hostname: target.hostname, at: Date.now(), results } });
  return { text: buildReport(target.hostname, results, skipped, blocked) };
}
