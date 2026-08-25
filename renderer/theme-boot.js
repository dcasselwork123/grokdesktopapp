"use strict";

/**
 * Apply appearance before CSS paints (CSP: external script only).
 * Preference is light | dark | system; data-theme is always the resolved light/dark.
 */
(() => {
  const KEY = "grok_desktop_theme";
  const PREFS = ["light", "dark", "system"];
  const DEFAULT = "dark";
  const LIGHT_BG = "#f3f2f0";
  const DARK_BG = "#1a1a1a";

  function readPref() {
    try {
      const v = localStorage.getItem(KEY);
      if (PREFS.includes(v)) return v;
    } catch {
      /* private mode / quota */
    }
    return DEFAULT;
  }

  function resolvedTheme(pref) {
    if (pref === "light" || pref === "dark") return pref;
    try {
      return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
    } catch {
      return "dark";
    }
  }

  function apply(pref) {
    const p = PREFS.includes(pref) ? pref : DEFAULT;
    const resolved = resolvedTheme(p);
    const root = document.documentElement;
    root.setAttribute("data-theme", resolved);
    root.setAttribute("data-theme-pref", p);
    root.style.colorScheme = resolved;
    const themeColor = document.querySelector('meta[name="theme-color"]');
    if (themeColor) themeColor.setAttribute("content", resolved === "light" ? LIGHT_BG : DARK_BG);
    const colorScheme = document.querySelector('meta[name="color-scheme"]');
    if (colorScheme) colorScheme.setAttribute("content", resolved);
    const apple = document.querySelector('meta[name="apple-mobile-web-app-status-bar-style"]');
    if (apple) {
      apple.setAttribute("content", resolved === "light" ? "default" : "black-translucent");
    }
    return { pref: p, theme: resolved };
  }

  window.__grokTheme = {
    KEY,
    PREFS,
    DEFAULT,
    LIGHT_BG,
    DARK_BG,
    readPref,
    resolvedTheme,
    apply,
  };
  apply(readPref());
})();
