// User settings, stored in chrome.storage.local and applied immediately (no reload needed).

export const DEFAULT_PREFS = {
  // Which tools Marco may use at all. Reading the page, searching it and listing tabs are always on.
  enabled: { point_at: true, screenshot: true, security_scan: true, navigate: true, open_url: true, switch_tab: true, click_text: true, fill_field: true, watch_page: true, check_defacement: true, check_reflection: true },
  // Actions that run without a confirmation dialog. Opening/navigating is low risk, so on by default;
  // clicking and typing into pages ask first unless you turn that off.
  autoAllow: { navigate: true, open_url: true, switch_tab: true, click_text: false, fill_field: false },
  // When replies are spoken aloud: "voice" = only after a spoken request, "always", or "never".
  speak: "voice",
  // How often (minutes) the background worker re-checks every watched page for defacement on its
  // own, even with no tab open, and raises a desktop notification. 0 turns this off.
  defaceMinutes: 15,
  // Domains the reflected-input check is allowed to run against. Empty by default - the project
  // owner (you) must add a domain here before check_reflection will do anything with it, whether
  // you're testing your own site or a client's with their written permission.
  reflectAllowlist: [],
};

export async function loadPrefs() {
  const { prefs = {} } = await chrome.storage.local.get("prefs");
  return {
    enabled: { ...DEFAULT_PREFS.enabled, ...prefs.enabled },
    autoAllow: { ...DEFAULT_PREFS.autoAllow, ...prefs.autoAllow },
    speak: prefs.speak || DEFAULT_PREFS.speak,
    defaceMinutes: prefs.defaceMinutes ?? DEFAULT_PREFS.defaceMinutes,
    reflectAllowlist: Array.isArray(prefs.reflectAllowlist) ? prefs.reflectAllowlist : DEFAULT_PREFS.reflectAllowlist,
  };
}

export const savePrefs = (prefs) => chrome.storage.local.set({ prefs });
