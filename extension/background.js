import { loadBaselines, saveBaseline, fetchSnapshot, compareSnapshot } from "./deface.js";

const ALARM = "marco-deface-sweep";
const DEFAULT_MINUTES = 15;

chrome.runtime.onInstalled.addListener(async () => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  const { prefs } = await chrome.storage.local.get("prefs");
  scheduleSweep(prefs?.defaceMinutes ?? DEFAULT_MINUTES);
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.prefs) {
    scheduleSweep(changes.prefs.newValue?.defaceMinutes ?? DEFAULT_MINUTES);
  }
});

function scheduleSweep(minutes) {
  chrome.alarms.clear(ALARM);
  const n = Number(minutes);
  if (n > 0) chrome.alarms.create(ALARM, { periodInMinutes: Math.max(1, n) });
}

// Checks every watched page in the background, even if no tab for it is open, and raises a
// desktop notification for anything that looks like it might have been defaced. Read-only:
// it never updates a baseline itself, so a real defacement can't silently become "normal".
async function sweepBaselines() {
  const baselines = await loadBaselines();
  for (const [url, saved] of Object.entries(baselines)) {
    let now;
    try {
      now = await fetchSnapshot(url);
    } catch {
      continue; // site unreachable right now; try again next sweep
    }
    const cmp = compareSnapshot(saved, now);
    if (cmp.severity === "high" || cmp.severity === "medium") {
      chrome.notifications.create(`marco-deface-${Date.now()}`, {
        type: "basic",
        iconUrl: chrome.runtime.getURL("icon128.png"),
        title: cmp.severity === "high" ? "Possible defacement detected" : "Watched page changed",
        message: `${new URL(url).host}: ${cmp.summary}`.slice(0, 280),
        priority: cmp.severity === "high" ? 2 : 1,
      });
    }
  }
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM) sweepBaselines();
});
