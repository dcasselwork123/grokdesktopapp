"use strict";

(() => {
  const $ = (sel) => document.querySelector(sel);

  const els = {
    sessionList: $("#session-list"),
    btnNew: $("#btn-new"),
    btnRefresh: $("#btn-refresh"),
    btnSend: $("#btn-send"),
    btnStop: $("#btn-stop"),
    btnRemote: $("#btn-remote-info"),
    btnCwdBrowse: $("#btn-cwd-browse"),
    btnAttach: $("#btn-attach"),
    fileAttach: $("#file-attach"),
    fileVoice: $("#file-voice"),
    attachStrip: $("#attach-strip"),
    queueStrip: $("#queue-strip"),
    btnMic: $("#btn-mic"),
    voiceStrip: $("#voice-strip"),
    voiceStripText: $("#voice-strip-text"),
    slashMenu: $("#slash-menu"),
    prompt: $("#prompt"),
    messages: $("#messages"),
    chatTitle: $("#chat-title"),
    chatProject: $("#chat-project"),
    sidechatBadge: $("#sidechat-badge"),
    modelSelector: $("#model-selector"),
    modelSelectBtn: $("#model-select-btn"),
    modelSelectLabel: $("#model-select-label"),
    modelMenu: $("#model-menu"),
    effortSlider: $("#effort-slider"),
    effortValue: $("#effort-value"),
    accessSelector: $("#access-selector"),
    accessSelectBtn: $("#access-select-btn"),
    accessSelectLabel: $("#access-select-label"),
    accessMenu: $("#access-menu"),
    folderTrust: $("#folder-trust"),
    folderTrustDismiss: $("#folder-trust-dismiss"),
    cwdInput: $("#cwd-input"),
    sessionIdHint: $("#session-id-hint"),
    runningBar: $("#running-bar"),
    runningText: $("#running-text"),
    statusPill: $("#status-pill"),
    statusDot: $("#status-dot"),
    statusText: $("#status-text"),
    modalBackdrop: $("#modal-backdrop"),
    modalClose: $("#modal-close"),
    sidebarToggle: $("#sidebar-toggle"),
    folderPickerBackdrop: $("#folder-picker-backdrop"),
    folderPickerList: $("#folder-picker-list"),
    folderPickerEmpty: $("#folder-picker-empty"),
    folderPickerCancel: $("#folder-picker-cancel"),
    btnSelectMode: $("#btn-select-mode"),
    bulkBar: $("#bulk-bar"),
    bulkCount: $("#bulk-count"),
    btnBulkArchive: $("#btn-bulk-archive"),
    btnBulkDelete: $("#btn-bulk-delete"),
    btnBulkCancel: $("#btn-bulk-cancel"),
    contextMenu: $("#session-context-menu"),
    setupGate: $("#setup-gate"),
    setupTitle: $("#setup-title"),
    setupMessage: $("#setup-message"),
    setupDetails: $("#setup-details"),
    setupInstallCmd: $("#setup-install-cmd"),
    setupActions: $("#setup-actions"),
    setupHint: $("#setup-hint"),
    btnAccount: $("#btn-account"),
    accountInitials: $("#account-initials"),
    accountPopover: $("#account-popover"),
    accountPopAvatar: $("#account-pop-avatar"),
    accountPopName: $("#account-pop-name"),
    accountPopEmail: $("#account-pop-email"),
    accountPopHint: $("#account-pop-hint"),
    btnAccountLoginX: $("#btn-account-login-x"),
    btnAccountLoginEmail: $("#btn-account-login-email"),
    btnAccountLogout: $("#btn-account-logout"),
    reconnectBanner: document.getElementById("reconnect-banner"),
    sessionBanner: document.getElementById("session-banner"),
    sessionBannerText: document.getElementById("session-banner-text"),
    sessionBannerAction: document.getElementById("session-banner-action"),
    sessionBannerDismiss: document.getElementById("session-banner-dismiss"),
    usageBtn: document.getElementById("usage-btn"),
    usagePieFill: document.getElementById("usage-pie-fill"),
    usagePopover: document.getElementById("usage-popover"),
    usagePopBody: document.getElementById("usage-pop-body"),
    usagePopClose: document.getElementById("usage-pop-close"),
    btnUpdate: document.getElementById("btn-update"),
    updateBackdrop: document.getElementById("update-backdrop"),
    updateTitle: document.getElementById("update-title"),
    updateCommit: document.getElementById("update-commit"),
    updateNote: document.getElementById("update-note"),
    updateProgress: document.getElementById("update-progress"),
    updateCancel: document.getElementById("update-cancel"),
    updateConfirm: document.getElementById("update-confirm"),
  };

  const state = {
    sessions: [],
    models: [],
    efforts: [], // ordered low → high for the slider
    activeSessionId: null,
    activeProject: null,
    running: false,
    runId: null,
    abortController: null,
    liveShell: null,
    streamSessionId: null,
    attachingRunId: null,
    turnGen: 0,
    liveSessionIds: new Set(),
    pendingReattach: null, // { sessionId, clientTurnId, startedAt, turnGen }
    awaitingAnswers: false,
    recoverInFlight: false,
    usage: null,
    usageTimer: null,
    draftMode: true, // true until first message of a new chat
    attachments: [], // { id, name, mimeType, dataUrl }
    selectedModel: null,
    modelMenuOpen: false,
    sendInFlight: false,
    turnDone: null,
    sidechatMode: false,
    pendingForkFrom: null,
    pendingSidechat: null,
    promptQueue: [], // follow-ups to send after the current turn (CLI Enter)
    slashIndex: 0,
    // Projects start collapsed; only ids in this set are expanded
    expandedProjects: new Set(),
    selectMode: false,
    selectedIds: new Set(),
    lastClickedSessionId: null,
    contextSessionId: null,
    renamingSessionId: null,
    renameDraft: "",
    // Setup gate: CLI installed + signed in
    setupReady: false,
    setup: null,
    loginPollTimer: null,
    loginMethod: null,
    appUpdate: null,
    updateTimer: null,
    updateApplying: false,
    lastUpdateCheckAt: 0,
    permissionMode: "bypassPermissions",
    accessMenuOpen: false,
    seenFolders: [],
    seenFoldersLocal: [],
    voice: {
      phase: "idle", // idle | recording | transcribing
      startedAt: 0,
      timer: null,
      stream: null,
      ctx: null,
      processor: null,
      worklet: null,
      source: null,
      mute: null,
      poll: null,
      pcmSent: 0,
      chunks: [],
      sampleRate: 16000,
      sessionId: null,
      events: null,
      sendChain: Promise.resolve(),
      pcmPending: [],
      pcmCount: 0,
      insertStart: null,
      insertEnd: null,
      liveText: "",
    },
  };

  // Preferred left→right order for the effort slider (unknown ids sort last)
  const EFFORT_ORDER = ["low", "medium", "high", "xhigh", "max"];
  const PERMISSION_MODES = [
    { id: "bypassPermissions", label: "Full access" },
    { id: "dontAsk", label: "Safer" },
  ];
  const ACCESS_TOOLTIP =
    "Full access lets Grok run tools in this folder without asking (phone uses this too). Safer denies tools and usually cancels the turn.";

  const MAX_ATTACHMENTS = 8;
  // Keep attachments small so vision is fast and uploads stay reliable
  const MAX_IMAGE_EDGE = 1280;
  const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
  const VOICE_MAX_SECONDS = 180;
  const VOICE_TARGET_RATE = 16000;
  const VOICE_MAX_FILE_BYTES = 8 * 1024 * 1024;
  const LAST_SESSION_KEY = "grok_desktop_last_session";
  const LAST_CWD_KEY = "grok_desktop_last_cwd";
  const MD_DEBOUNCE_MS = 64;

  function isMobileViewport() {
    return window.matchMedia("(max-width: 800px)").matches;
  }

  /** Phone / remote Safari — not a narrow Electron window on the PC. */
  function isPhoneUi() {
    return isMobileViewport() && !isElectron();
  }

  if (isPhoneUi()) document.body.classList.add("phone-ui");
  if (isElectron()) document.body.classList.add("is-electron");

  function isLoopbackPage() {
    const host = String(location.hostname || "").toLowerCase();
    return host === "127.0.0.1" || host === "localhost" || host === "[::1]" || host === "::1";
  }

  function persistLastSession(id) {
    try {
      if (id) localStorage.setItem(LAST_SESSION_KEY, id);
      else localStorage.removeItem(LAST_SESSION_KEY);
    } catch {
      /* ignore quota / private mode */
    }
  }

  function readLastSessionId() {
    try {
      return localStorage.getItem(LAST_SESSION_KEY);
    } catch {
      return null;
    }
  }

  function setActiveSessionId(id) {
    state.activeSessionId = id || null;
    if (!state.sidechatMode) persistLastSession(state.activeSessionId);
  }

  function isElectron() {
    return !!(window.grokDesktop && window.grokDesktop.isElectron);
  }

  // ---------- Working folder (cwd) ----------
  function persistLastCwd(cwd) {
    try {
      if (cwd) localStorage.setItem(LAST_CWD_KEY, cwd);
    } catch {
      /* ignore quota / private mode */
    }
  }

  let lastPostedCwd = "";

  /** Desktop/loopback only — tells remote chat policy which folder was last used here. */
  function persistLastCwdToServer(cwd) {
    const value = (cwd || "").trim();
    if (!value) return;
    if (isPhoneUi() || (!isElectron() && !isLoopbackPage())) return;
    if (cwdsEqual(value, lastPostedCwd)) return;
    lastPostedCwd = value;
    api("/api/remote/settings", {
      method: "POST",
      body: JSON.stringify({ lastCwd: value }),
    }).catch(() => {
      lastPostedCwd = "";
    });
  }

  function readLastCwd() {
    try {
      return (localStorage.getItem(LAST_CWD_KEY) || "").trim();
    } catch {
      return "";
    }
  }

  function setCwd(cwd) {
    const prev = getCwd();
    const value = (cwd || "").trim();
    els.cwdInput.value = value;
    els.cwdInput.title = value || "Choose working folder";
    if (value) persistLastCwd(value);
    persistLastCwdToServer(value);
    if (!cwdsEqual(prev, value)) {
      refreshSeenFolders();
    } else {
      updateFolderTrustWarning();
    }
  }

  function getCwd() {
    return els.cwdInput.value.trim();
  }

  function rememberedCwd() {
    return getCwd() || readLastCwd() || "";
  }

  /** Normalize for path equality (Windows-friendly: slashes + case). */
  function normalizeCwd(p) {
    if (!p) return "";
    let s = String(p).trim().replace(/[\\/]+$/, "");
    s = s.replace(/\//g, "\\");
    return s;
  }

  function cwdsEqual(a, b) {
    return normalizeCwd(a).toLowerCase() === normalizeCwd(b).toLowerCase();
  }

  function getActiveSession() {
    if (!state.activeSessionId) return null;
    return state.sessions.find((s) => s.id === state.activeSessionId) || null;
  }

  /**
   * Apply a user-chosen working folder. If it differs from the current session's
   * folder, start a fresh draft chat in the new folder (don't continue old chat).
   */
  function changeWorkingFolder(nextCwd) {
    const next = (nextCwd || "").trim();
    if (!next) return;

    const session = getActiveSession();

    // Same folder as the open session → keep chatting there
    if (session && cwdsEqual(next, session.cwd)) {
      setCwd(next);
      unlockPrompt({ focus: true });
      return;
    }

    // Already a blank draft on this folder
    if (!state.activeSessionId && state.draftMode && cwdsEqual(next, getCwd())) {
      unlockPrompt({ focus: true });
      return;
    }

    // Different folder (or leaving an existing session) → new chat in that folder
    startNewSession({ cwd: next });
  }

  /** Unique project folders from past sessions (for mobile picker). */
  function listKnownWorkspaces() {
    const map = new Map();
    for (const s of state.sessions) {
      const cwd = (s.cwd || "").trim();
      if (!cwd || map.has(cwd)) continue;
      map.set(cwd, {
        cwd,
        project: s.project || projectNameFromPath(cwd),
      });
    }
    return [...map.values()].sort((a, b) =>
      a.project.localeCompare(b.project, undefined, { sensitivity: "base" })
    );
  }

  function projectNameFromPath(cwd) {
    if (!cwd) return "Project";
    const normalized = cwd.replace(/[\\/]+$/, "");
    const parts = normalized.split(/[\\/]/);
    return parts[parts.length - 1] || normalized;
  }

  async function browseFolderDesktop() {
    if (!isElectron() || typeof window.grokDesktop.pickFolder !== "function") {
      return;
    }
    try {
      const chosen = await window.grokDesktop.pickFolder(getCwd() || undefined);
      if (chosen) changeWorkingFolder(chosen);
    } catch (err) {
      console.warn("Folder picker failed:", err);
    }
  }

  function openMobileFolderPicker() {
    const workspaces = listKnownWorkspaces();
    els.folderPickerList.innerHTML = "";

    if (workspaces.length === 0) {
      els.folderPickerEmpty.classList.remove("hidden");
    } else {
      els.folderPickerEmpty.classList.add("hidden");
      for (const ws of workspaces) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "folder-picker-item";
        btn.setAttribute("role", "option");
        btn.innerHTML = `<span class="fp-name"></span><span class="fp-path"></span>`;
        btn.querySelector(".fp-name").textContent = ws.project;
        btn.querySelector(".fp-path").textContent = ws.cwd;
        btn.addEventListener("click", () => {
          closeMobileFolderPicker();
          startNewSession({ cwd: ws.cwd });
        });
        els.folderPickerList.appendChild(btn);
      }
    }

    els.folderPickerBackdrop.classList.remove("hidden");
  }

  function closeMobileFolderPicker() {
    els.folderPickerBackdrop.classList.add("hidden");
  }

  // ---------- URL / token ----------
  function readTokenFromUrl() {
    const u = new URL(window.location.href);
    if (u.searchParams.has("token")) {
      // Bootstrap only — server already minted the HttpOnly cookie on this page load.
      try {
        u.searchParams.delete("token");
        const clean = u.pathname + (u.searchParams.toString() ? `?${u.searchParams}` : "") + u.hash;
        window.history.replaceState({}, "", clean || "/");
      } catch {
        /* ignore */
      }
    }
    try {
      localStorage.removeItem("grok_desktop_token");
    } catch {
      /* ignore */
    }
    try {
      sessionStorage.removeItem("grok_desktop_token");
    } catch {
      /* ignore */
    }
  }

  function apiUrl(path) {
    // Query token is bootstrap-only; API calls use the same-origin cookie.
    return new URL(path, window.location.origin).toString();
  }

  async function api(path, opts = {}) {
    const headers = { ...(opts.headers || {}) };
    if (opts.body && !headers["Content-Type"]) {
      headers["Content-Type"] = "application/json";
    }
    const res = await fetch(apiUrl(path), { ...opts, headers });
    if (!res.ok) {
      let msg = res.statusText;
      try {
        const j = await res.json();
        msg = j.error || msg;
      } catch {
        /* ignore */
      }
      throw new Error(msg);
    }
    const ct = res.headers.get("content-type") || "";
    if (ct.includes("application/json")) return res.json();
    return res;
  }

  // ---------- Status ----------
  function setStatus(ok, text) {
    els.statusPill.classList.toggle("ok", !!ok);
    els.statusPill.classList.toggle("err", ok === false);
    els.statusText.textContent = text;
  }

  // ---------- Models / effort ----------
  function getModelValue() {
    return state.selectedModel || state.models[0]?.id || "grok-4.5";
  }

  function modelLabel(id) {
    const m = state.models.find((x) => x.id === id);
    return (m && (m.name || m.id)) || id || "Model";
  }

  function closeModelMenu() {
    if (!els.modelMenu || !els.modelSelectBtn) return;
    state.modelMenuOpen = false;
    els.modelMenu.classList.add("hidden");
    if (els.modelSelector) els.modelSelector.classList.remove("open");
    els.modelSelectBtn.setAttribute("aria-expanded", "false");
  }

  function openModelMenu() {
    if (!els.modelMenu || !els.modelSelectBtn) return;
    renderModelMenu();
    state.modelMenuOpen = true;
    els.modelMenu.classList.remove("hidden");
    if (els.modelSelector) els.modelSelector.classList.add("open");
    els.modelSelectBtn.setAttribute("aria-expanded", "true");
    const selected = els.modelMenu.querySelector('.model-option[aria-selected="true"]');
    if (selected) {
      try {
        selected.focus();
      } catch {
        /* ignore */
      }
    }
  }

  function toggleModelMenu() {
    if (state.modelMenuOpen) closeModelMenu();
    else openModelMenu();
  }

  function renderModelMenu() {
    if (!els.modelMenu) return;
    els.modelMenu.innerHTML = "";
    const current = getModelValue();
    for (const m of state.models) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "model-option";
      btn.setAttribute("role", "option");
      btn.dataset.id = m.id;
      const selected = m.id === current;
      btn.setAttribute("aria-selected", selected ? "true" : "false");
      btn.innerHTML = `<span class="model-option-name"></span><svg class="model-option-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" aria-hidden="true"><path d="M5 12.5l5 5 9-10"/></svg>`;
      btn.querySelector(".model-option-name").textContent = m.name || m.id;
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        setModelValue(m.id);
        closeModelMenu();
        if (els.modelSelectBtn) els.modelSelectBtn.focus();
      });
      els.modelMenu.appendChild(btn);
    }
  }

  function setModelValue(id, { syncEfforts = true } = {}) {
    const match = state.models.find((x) => x.id === id);
    const next = match ? match.id : state.models[0]?.id || id || "grok-4.5";
    const changed = state.selectedModel !== next;
    state.selectedModel = next;
    if (els.modelSelectLabel) els.modelSelectLabel.textContent = modelLabel(next);
    if (els.modelSelectBtn) {
      els.modelSelectBtn.title = `Model: ${modelLabel(next)}`;
    }
    renderModelMenu();
    if (syncEfforts && changed) {
      const m = state.models.find((x) => x.id === next);
      if (m) populateEfforts(m);
    }
  }

  function populateModels(models) {
    state.models = Array.isArray(models) ? models : [];
    const prev = state.selectedModel;
    const keep = prev && state.models.find((x) => x.id === prev);
    const next = keep ? keep.id : state.models[0]?.id;
    if (next) setModelValue(next);
    else {
      state.selectedModel = null;
      if (els.modelSelectLabel) els.modelSelectLabel.textContent = "Model";
      renderModelMenu();
    }
  }

  function effortRank(e) {
    const key = String(e.value || e.id || "").toLowerCase();
    const idx = EFFORT_ORDER.indexOf(key);
    return idx === -1 ? 100 : idx;
  }

  function effortLabel(e) {
    return String(e.label || e.id || e.value || "").replace(/\s*Effort$/i, "");
  }

  function getEffortValue() {
    const i = Number(els.effortSlider.value) || 0;
    const e = state.efforts[i];
    return e ? e.value || e.id : "high";
  }

  function setEffortValue(value) {
    if (!state.efforts.length) return;
    const idx = state.efforts.findIndex(
      (e) => (e.value || e.id) === value
    );
    const i = idx >= 0 ? idx : state.efforts.length - 1;
    els.effortSlider.value = String(i);
    updateEffortUI();
  }

  function updateEffortUI() {
    const i = Number(els.effortSlider.value) || 0;
    const e = state.efforts[i];
    const max = Math.max(1, state.efforts.length - 1);
    const pct = (i / max) * 100;
    els.effortSlider.style.setProperty("--effort-pct", `${pct}%`);
    els.effortValue.textContent = e ? effortLabel(e) : "—";
    els.effortSlider.setAttribute(
      "aria-valuetext",
      e ? effortLabel(e) : ""
    );
    els.effortSlider.title = e
      ? `Effort: ${effortLabel(e)}`
      : "Reasoning effort";
  }

  function populateEfforts(model) {
    const raw = model?.efforts?.length
      ? model.efforts
      : [
          { id: "high", value: "high", label: "High", default: true },
          { id: "medium", value: "medium", label: "Medium" },
          { id: "low", value: "low", label: "Low" },
        ];

    // Slider reads left → right as increasing effort
    const efforts = [...raw].sort((a, b) => effortRank(a) - effortRank(b));
    state.efforts = efforts;

    const max = Math.max(0, efforts.length - 1);
    els.effortSlider.min = "0";
    els.effortSlider.max = String(max);
    els.effortSlider.step = "1";
    els.effortSlider.disabled = efforts.length < 2;

    let defaultVal = model?.defaultEffort || "high";
    for (const e of efforts) {
      if (e.default) defaultVal = e.value || e.id;
    }
    setEffortValue(defaultVal);
  }

  els.effortSlider.addEventListener("input", updateEffortUI);

  if (els.modelSelectBtn) {
    els.modelSelectBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleModelMenu();
    });
    els.modelSelectBtn.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        if (!state.modelMenuOpen) openModelMenu();
      } else if (e.key === "Escape") {
        closeModelMenu();
      }
    });
  }
  if (els.modelMenu) {
    els.modelMenu.addEventListener("keydown", (e) => {
      const options = [...els.modelMenu.querySelectorAll(".model-option")];
      const idx = options.indexOf(document.activeElement);
      if (e.key === "Escape") {
        e.preventDefault();
        closeModelMenu();
        if (els.modelSelectBtn) els.modelSelectBtn.focus();
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        const next = options[Math.min(options.length - 1, idx + 1)] || options[0];
        if (next) next.focus();
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        const prev = options[Math.max(0, idx - 1)] || options[options.length - 1];
        if (prev) prev.focus();
      } else if (e.key === "Home") {
        e.preventDefault();
        if (options[0]) options[0].focus();
      } else if (e.key === "End") {
        e.preventDefault();
        if (options.length) options[options.length - 1].focus();
      }
    });
  }
  document.addEventListener("click", (e) => {
    if (!state.modelMenuOpen) return;
    if (els.modelSelector && els.modelSelector.contains(e.target)) return;
    closeModelMenu();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && state.modelMenuOpen) closeModelMenu();
  });

  // ---------- Access (permission mode) + folder trust ----------
  function canUseDesktopPolicyUi() {
    return (isElectron() || isLoopbackPage()) && !isPhoneUi();
  }

  function getPermissionMode() {
    const id = state.permissionMode;
    return PERMISSION_MODES.some((m) => m.id === id) ? id : "bypassPermissions";
  }

  function permissionLabel(id) {
    const m = PERMISSION_MODES.find((x) => x.id === id);
    return m ? m.label : "Full access";
  }

  function closeAccessMenu() {
    if (!els.accessMenu || !els.accessSelectBtn) return;
    state.accessMenuOpen = false;
    els.accessMenu.classList.add("hidden");
    if (els.accessSelector) els.accessSelector.classList.remove("open");
    els.accessSelectBtn.setAttribute("aria-expanded", "false");
  }

  function openAccessMenu() {
    if (!els.accessMenu || !els.accessSelectBtn) return;
    renderAccessMenu();
    state.accessMenuOpen = true;
    els.accessMenu.classList.remove("hidden");
    if (els.accessSelector) els.accessSelector.classList.add("open");
    els.accessSelectBtn.setAttribute("aria-expanded", "true");
    const selected = els.accessMenu.querySelector('.model-option[aria-selected="true"]');
    if (selected) {
      try {
        selected.focus();
      } catch {
        /* ignore */
      }
    }
  }

  function toggleAccessMenu() {
    if (state.accessMenuOpen) closeAccessMenu();
    else openAccessMenu();
  }

  function renderAccessMenu() {
    if (!els.accessMenu) return;
    els.accessMenu.replaceChildren();
    const current = getPermissionMode();
    for (const m of PERMISSION_MODES) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "model-option";
      btn.setAttribute("role", "option");
      btn.dataset.id = m.id;
      btn.setAttribute("aria-selected", m.id === current ? "true" : "false");
      btn.innerHTML =
        `<span class="model-option-name"></span><svg class="model-option-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" aria-hidden="true"><path d="M5 12.5l5 5 9-10"/></svg>`;
      btn.querySelector(".model-option-name").textContent = m.label;
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        setPermissionMode(m.id);
        closeAccessMenu();
        if (els.accessSelectBtn) els.accessSelectBtn.focus();
      });
      els.accessMenu.appendChild(btn);
    }
  }

  function persistPermissionMode(mode) {
    if (!canUseDesktopPolicyUi()) return;
    api("/api/remote/settings", {
      method: "POST",
      body: JSON.stringify({ permissionMode: mode }),
    }).catch(() => {
      /* server may ignore until settings persist is live */
    });
  }

  function setPermissionMode(id, { persist = true } = {}) {
    const next = PERMISSION_MODES.some((m) => m.id === id) ? id : "bypassPermissions";
    const changed = state.permissionMode !== next;
    state.permissionMode = next;
    if (els.accessSelectLabel) els.accessSelectLabel.textContent = permissionLabel(next);
    if (els.accessSelectBtn) els.accessSelectBtn.title = ACCESS_TOOLTIP;
    renderAccessMenu();
    if (persist && changed) persistPermissionMode(next);
  }

  function folderIsSeen(cwd) {
    const value = (cwd || "").trim();
    if (!value) return true;
    if (state.seenFolders.some((p) => cwdsEqual(p, value))) return true;
    return state.seenFoldersLocal.some((p) => cwdsEqual(p, value));
  }

  function updateFolderTrustWarning() {
    if (!els.folderTrust) return;
    const cwd = getCwd();
    const show = !isPhoneUi() && !!cwd && !folderIsSeen(cwd);
    els.folderTrust.classList.toggle("hidden", !show);
  }

  function ingestSeenFolders(info) {
    const list = info && Array.isArray(info.seenFolders) ? info.seenFolders : [];
    state.seenFolders = list.filter((p) => typeof p === "string" && p.trim()).map((p) => p.trim());
    if (info && (info.permissionMode === "bypassPermissions" || info.permissionMode === "dontAsk")) {
      setPermissionMode(info.permissionMode, { persist: false });
    }
    updateFolderTrustWarning();
  }

  function refreshSeenFolders() {
    updateFolderTrustWarning();
    if (!isElectron() && !isLoopbackPage()) return;
    api("/api/remote")
      .then((info) => {
        ingestSeenFolders(info);
      })
      .catch(() => {
        updateFolderTrustWarning();
      });
  }

  function markFolderSeen(cwd) {
    const value = (cwd || getCwd() || "").trim();
    if (!value) return;
    if (!state.seenFoldersLocal.some((p) => cwdsEqual(p, value))) {
      state.seenFoldersLocal.push(value);
    }
    updateFolderTrustWarning();
    if (!canUseDesktopPolicyUi()) return;
    api("/api/remote/settings", {
      method: "POST",
      body: JSON.stringify({ seenFolder: value }),
    })
      .then((info) => {
        if (info && Array.isArray(info.seenFolders)) ingestSeenFolders(info);
      })
      .catch(() => {
        /* local hide still applies */
      });
  }

  function applyDesktopOnlyComposerChrome() {
    const phone = isPhoneUi();
    if (els.accessSelector) els.accessSelector.classList.toggle("hidden", phone);
    if (phone) closeAccessMenu();
    updateFolderTrustWarning();
  }

  setPermissionMode(state.permissionMode, { persist: false });
  applyDesktopOnlyComposerChrome();

  if (els.accessSelectBtn) {
    els.accessSelectBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleAccessMenu();
    });
    els.accessSelectBtn.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        if (!state.accessMenuOpen) openAccessMenu();
      } else if (e.key === "Escape") {
        closeAccessMenu();
      }
    });
  }
  if (els.accessMenu) {
    els.accessMenu.addEventListener("keydown", (e) => {
      const options = [...els.accessMenu.querySelectorAll(".model-option")];
      const idx = options.indexOf(document.activeElement);
      if (e.key === "Escape") {
        e.preventDefault();
        closeAccessMenu();
        if (els.accessSelectBtn) els.accessSelectBtn.focus();
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        const next = options[Math.min(options.length - 1, idx + 1)] || options[0];
        if (next) next.focus();
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        const prev = options[Math.max(0, idx - 1)] || options[options.length - 1];
        if (prev) prev.focus();
      }
    });
  }
  if (els.folderTrustDismiss) {
    els.folderTrustDismiss.addEventListener("click", () => {
      markFolderSeen(getCwd());
    });
  }
  document.addEventListener("click", (e) => {
    if (!state.accessMenuOpen) return;
    if (els.accessSelector && els.accessSelector.contains(e.target)) return;
    closeAccessMenu();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && state.accessMenuOpen) closeAccessMenu();
  });

  // ---------- Sessions ----------
  function relativeTime(iso) {
    if (!iso) return "";
    const t = Date.parse(iso);
    if (!t) return "";
    const diff = Date.now() - t;
    const m = Math.floor(diff / 60000);
    if (m < 1) return "just now";
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 48) return `${h}h ago`;
    const d = Math.floor(h / 24);
    return `${d}d ago`;
  }

  function groupSessions(sessions) {
    const map = new Map();
    for (const s of sessions) {
      const key = s.project || "Other";
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(s);
    }
    return map;
  }

  function flatSessionIds() {
    return state.sessions.map((s) => s.id);
  }

  function isProjectExpanded(project) {
    return state.expandedProjects.has(project);
  }

  function toggleProjectExpanded(project) {
    if (state.expandedProjects.has(project)) {
      state.expandedProjects.delete(project);
    } else {
      state.expandedProjects.add(project);
    }
    renderSessionList();
  }

  function expandProjectForSession(sessionId) {
    const s = state.sessions.find((x) => x.id === sessionId);
    if (s?.project) state.expandedProjects.add(s.project);
  }

  function updateSelectModeUI() {
    document.body.classList.toggle("select-mode", state.selectMode);
    if (els.btnSelectMode) {
      els.btnSelectMode.textContent = state.selectMode ? "Done" : "Select";
      els.btnSelectMode.classList.toggle("active", state.selectMode);
    }
    const n = state.selectedIds.size;
    if (els.bulkBar) {
      els.bulkBar.classList.toggle("hidden", !state.selectMode && n === 0);
    }
    if (els.bulkCount) {
      els.bulkCount.textContent =
        n === 0 ? "Select sessions" : n === 1 ? "1 selected" : `${n} selected`;
    }
    const has = n > 0;
    if (els.btnBulkArchive) els.btnBulkArchive.disabled = !has;
    if (els.btnBulkDelete) els.btnBulkDelete.disabled = !has;
  }

  function visibleSessionIds() {
    const ids = [];
    for (const [project, list] of groupSessions(state.sessions)) {
      if (!isProjectExpanded(project)) continue;
      for (const s of list) ids.push(s.id);
    }
    return ids.length ? ids : flatSessionIds();
  }

  function syncSessionSelectionUI() {
    updateSelectModeUI();
    if (!els.sessionList) return;
    for (const btn of els.sessionList.querySelectorAll(".session-item")) {
      btn.classList.toggle("selected", state.selectedIds.has(btn.dataset.id));
    }
  }

  function setSelectMode(on) {
    state.selectMode = !!on;
    if (!state.selectMode) {
      state.selectedIds.clear();
      state.lastClickedSessionId = null;
    }
    syncSessionSelectionUI();
  }

  function toggleSessionSelected(id, { range = false } = {}) {
    if (!id) return;
    if (range && state.lastClickedSessionId) {
      const ids = visibleSessionIds();
      const a = ids.indexOf(state.lastClickedSessionId);
      const b = ids.indexOf(id);
      if (a >= 0 && b >= 0) {
        const [lo, hi] = a < b ? [a, b] : [b, a];
        for (let i = lo; i <= hi; i++) state.selectedIds.add(ids[i]);
      } else if (state.selectedIds.has(id)) {
        state.selectedIds.delete(id);
      } else {
        state.selectedIds.add(id);
      }
    } else if (state.selectedIds.has(id)) {
      state.selectedIds.delete(id);
    } else {
      state.selectedIds.add(id);
    }
    state.lastClickedSessionId = id;
    if (state.selectedIds.size > 0) state.selectMode = true;
    syncSessionSelectionUI();
  }

  function selectedIdsSnapshot() {
    return [...state.selectedIds].filter(Boolean);
  }

  function idsForContextAction(sessionId) {
    if (sessionId && state.selectedIds.size > 1 && state.selectedIds.has(sessionId)) {
      return selectedIdsSnapshot();
    }
    return sessionId ? [sessionId] : [];
  }

  function hideContextMenu() {
    if (!els.contextMenu) return;
    els.contextMenu.classList.add("hidden");
    els.contextMenu.setAttribute("aria-hidden", "true");
    state.contextSessionId = null;
  }

  function showContextMenu(x, y, sessionId) {
    if (!els.contextMenu) return;
    state.contextSessionId = sessionId;
    const multi = state.selectedIds.size > 1 && state.selectedIds.has(sessionId);
    const n = multi ? state.selectedIds.size : 1;
    const del = els.contextMenu.querySelector('[data-action="delete"]');
    const arch = els.contextMenu.querySelector('[data-action="archive"]');
    const rename = els.contextMenu.querySelector('[data-action="rename"]');
    if (del) del.textContent = n > 1 ? `Delete ${n}…` : "Delete…";
    if (arch) arch.textContent = n > 1 ? `Archive ${n}` : "Archive";
    if (rename) {
      rename.style.display = multi ? "none" : "";
      const sep = rename.nextElementSibling;
      if (sep && sep.classList.contains("context-menu-sep")) {
        sep.style.display = multi ? "none" : "";
      }
    }
    els.contextMenu.classList.remove("hidden");
    els.contextMenu.setAttribute("aria-hidden", "false");

    // Position then clamp to viewport
    const pad = 8;
    els.contextMenu.style.left = "0px";
    els.contextMenu.style.top = "0px";
    const rect = els.contextMenu.getBoundingClientRect();
    let left = x;
    let top = y;
    if (left + rect.width > window.innerWidth - pad) {
      left = window.innerWidth - rect.width - pad;
    }
    if (top + rect.height > window.innerHeight - pad) {
      top = window.innerHeight - rect.height - pad;
    }
    els.contextMenu.style.left = `${Math.max(pad, left)}px`;
    els.contextMenu.style.top = `${Math.max(pad, top)}px`;
  }

  function startRename(sessionId) {
    if (!sessionId) return;
    const s = state.sessions.find((x) => x.id === sessionId);
    if (!s) return;
    hideContextMenu();
    state.renamingSessionId = sessionId;
    state.renameDraft = s.title || "";
    renderSessionList();
  }

  function cancelRename() {
    if (!state.renamingSessionId) return;
    state.renamingSessionId = null;
    state.renameDraft = "";
    renderSessionList();
  }

  async function commitRename(sessionId, rawTitle) {
    const s = state.sessions.find((x) => x.id === sessionId);
    const current = (s && s.title) || "";
    const next = String(rawTitle ?? "")
      .replace(/\s+/g, " ")
      .trim();
    state.renamingSessionId = null;
    state.renameDraft = "";
    if (!s || next === current) {
      renderSessionList();
      return;
    }
    try {
      const result = await api(`/api/sessions/${encodeURIComponent(sessionId)}`, {
        method: "PATCH",
        body: JSON.stringify({ title: next }),
      });
      if (result && result.session) {
        state.sessions = state.sessions.map((x) =>
          x.id === sessionId ? { ...x, ...result.session } : x
        );
      } else if (result && result.title != null) {
        state.sessions = state.sessions.map((x) =>
          x.id === sessionId ? { ...x, title: result.title } : x
        );
      }
      if (state.activeSessionId === sessionId) {
        setActiveMeta(state.sessions.find((x) => x.id === sessionId) || result.session);
      }
      renderSessionList();
      setStatus(true, "Session renamed");
    } catch (err) {
      setStatus(false, err.message || "Rename failed");
      renderSessionList();
    }
  }

  async function runBulkAction(action, ids) {
    const list = [...new Set((ids || []).filter(Boolean))];
    if (!list.length) return;

    if (action === "delete") {
      const label =
        list.length === 1
          ? "Delete this session permanently?"
          : `Delete ${list.length} sessions permanently?`;
      if (!window.confirm(label + "\n\nThis cannot be undone.")) return;
    }

    const cwdKeep = rememberedCwd();
    try {
      const result = await api("/api/sessions/bulk", {
        method: "POST",
        body: JSON.stringify({ action, ids: list }),
      });
      const removed = new Set(
        (result.results || []).filter((r) => r.ok).map((r) => r.id)
      );
      let droppedActive = false;
      for (const id of removed) {
        state.selectedIds.delete(id);
        if (state.activeSessionId === id) droppedActive = true;
      }
      if (droppedActive) {
        setActiveSessionId(null);
        state.draftMode = true;
        setActiveMeta(null);
        if (cwdKeep) setCwd(cwdKeep);
        showEmptyState();
      }
      if (state.selectedIds.size === 0) state.selectMode = false;
      await refreshSessions();
      if (cwdKeep && !getCwd()) setCwd(cwdKeep);
      updateSelectModeUI();

      if (result.failed > 0) {
        const first = (result.results || []).find((r) => !r.ok);
        setStatus(
          false,
          first?.error ||
            `${result.failed} of ${list.length} ${action} operation(s) failed`
        );
      } else {
        setStatus(
          true,
          action === "archive"
            ? list.length === 1
              ? "Session archived"
              : `${list.length} sessions archived`
            : list.length === 1
              ? "Session deleted"
              : `${list.length} sessions deleted`
        );
      }
    } catch (err) {
      setStatus(false, err.message || `${action} failed`);
    }
  }

  function renderSessionList() {
    const groups = groupSessions(state.sessions);
    els.sessionList.innerHTML = "";
    updateSelectModeUI();

    if (state.sessions.length === 0) {
      const empty = document.createElement("div");
      empty.className = "empty-state";
      empty.style.margin = "24px 8px";
      empty.style.fontSize = "13px";
      empty.textContent = "No sessions yet. Hit + New to start.";
      els.sessionList.appendChild(empty);
      return;
    }

    for (const [project, list] of groups) {
      const expanded = isProjectExpanded(project);
      const group = document.createElement("div");
      group.className = "project-group" + (expanded ? "" : " collapsed");
      group.dataset.project = project;

      const header = document.createElement("button");
      header.type = "button";
      header.className = "project-group-header";
      header.setAttribute("aria-expanded", expanded ? "true" : "false");
      header.title = expanded ? "Collapse project" : "Expand project";
      header.innerHTML = `
        <span class="chevron" aria-hidden="true">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4">
            <path d="M6 9l6 6 6-6" />
          </svg>
        </span>
        <span class="pg-name"></span>
        <span class="pg-count"></span>`;
      header.querySelector(".pg-name").textContent = project;
      header.querySelector(".pg-count").textContent = String(list.length);
      header.addEventListener("click", (e) => {
        e.preventDefault();
        toggleProjectExpanded(project);
      });
      group.appendChild(header);

      const sessionsEl = document.createElement("div");
      sessionsEl.className = "project-group-sessions";
      sessionsEl.setAttribute("role", "group");
      sessionsEl.setAttribute("aria-label", `${project} sessions`);

      for (const s of list) {
        const selected = state.selectedIds.has(s.id);
        const renaming = s.id === state.renamingSessionId;
        const btn = document.createElement(renaming ? "div" : "button");
        if (!renaming) btn.type = "button";
        btn.className =
          "session-item" +
          (s.id === state.activeSessionId ? " active" : "") +
          (selected ? " selected" : "") +
          (isSessionLive(s.id) ? " live" : "") +
          (renaming ? " renaming" : "");
        btn.dataset.id = s.id;
        btn.dataset.project = project;
        btn.setAttribute("role", "listitem");
        btn.innerHTML = `
          <span class="radio" aria-hidden="true"></span>
          <span class="check" aria-hidden="true"></span>
          <span class="meta">
            <span class="title"></span>
            <span class="sub"></span>
          </span>`;
        btn.querySelector(".title").textContent = s.title || "Untitled";
        btn.querySelector(".sub").textContent = relativeTime(s.updatedAt);

        let suppressClick = false;

        if (renaming) {
          const titleEl = btn.querySelector(".title");
          const input = document.createElement("input");
          input.type = "text";
          input.className = "title-input";
          input.value =
            state.renamingSessionId === s.id ? state.renameDraft : s.title || "";
          input.maxLength = 120;
          input.setAttribute("aria-label", "Session name");
          input.addEventListener("click", (e) => e.stopPropagation());
          input.addEventListener("mousedown", (e) => e.stopPropagation());
          input.addEventListener("input", () => {
            state.renameDraft = input.value;
          });
          input.addEventListener("keydown", (e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              e.stopPropagation();
              input.blur();
            } else if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              input.dataset.cancelled = "1";
              cancelRename();
            }
          });
          input.addEventListener("blur", () => {
            if (input.dataset.cancelled === "1") return;
            if (state.renamingSessionId !== s.id) return;
            void commitRename(s.id, input.value);
          });
          titleEl.replaceWith(input);
          requestAnimationFrame(() => {
            input.focus();
            input.select();
          });
        }

        btn.addEventListener("click", (e) => {
          if (renaming) {
            e.preventDefault();
            e.stopPropagation();
            return;
          }
          if (suppressClick) {
            suppressClick = false;
            e.preventDefault();
            e.stopPropagation();
            return;
          }
          // Multi-select: modifier keys or select mode
          if (state.selectMode || e.ctrlKey || e.metaKey || e.shiftKey) {
            e.preventDefault();
            toggleSessionSelected(s.id, { range: e.shiftKey });
            return;
          }
          openSession(s.id);
        });

        btn.addEventListener("contextmenu", (e) => {
          e.preventDefault();
          if (renaming) return;
          suppressClick = true;
          showContextMenu(e.clientX, e.clientY, s.id);
        });

        // Touch long-press for context menu (mobile)
        let pressTimer = null;
        btn.addEventListener(
          "touchstart",
          (e) => {
            if (renaming || e.touches.length !== 1) return;
            const t = e.touches[0];
            pressTimer = setTimeout(() => {
              pressTimer = null;
              suppressClick = true;
              showContextMenu(t.clientX, t.clientY, s.id);
            }, 520);
          },
          { passive: true }
        );
        const clearPress = () => {
          if (pressTimer) {
            clearTimeout(pressTimer);
            pressTimer = null;
          }
        };
        btn.addEventListener("touchend", clearPress);
        btn.addEventListener("touchmove", clearPress);
        btn.addEventListener("touchcancel", clearPress);

        sessionsEl.appendChild(btn);
      }

      group.appendChild(sessionsEl);
      els.sessionList.appendChild(group);
    }
  }

  async function refreshSessions() {
    try {
      const data = await api("/api/sessions?limit=100");
      state.sessions = data.sessions || [];
      // Drop selections for sessions that no longer exist
      for (const id of [...state.selectedIds]) {
        if (!state.sessions.some((s) => s.id === id)) state.selectedIds.delete(id);
      }
      if (
        state.renamingSessionId &&
        !state.sessions.some((s) => s.id === state.renamingSessionId)
      ) {
        state.renamingSessionId = null;
        state.renameDraft = "";
      }
      await refreshLiveRuns({ render: false });
      // Don't remount an in-progress rename field
      if (!state.renamingSessionId) renderSessionList();
      else updateSelectModeUI();
      setStatus(true, "Connected");
    } catch (err) {
      setStatus(false, err.message || "Offline");
    }
  }

  // ---------- Messages UI ----------
  function clearMessages() {
    els.messages.innerHTML = "";
  }

  function showEmptyState() {
    clearMessages();
    const div = document.createElement("div");
    div.className = "empty-state";
    div.innerHTML = `
      <h1>What should we build?</h1>
      <p>Start a new chat or pick a session on the left. Grok runs on this machine with full tool access — same power as the CLI, without living in a terminal.</p>`;
    els.messages.appendChild(div);
  }

  /** Split a markdown table row on `|`, ignoring pipes inside `inline code`. */
  function splitTableCells(line) {
    let s = String(line || "").trim();
    if (s.startsWith("|")) s = s.slice(1);
    if (s.endsWith("|")) s = s.slice(0, -1);
    const cells = [];
    let cur = "";
    let inCode = false;
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (ch === "`") inCode = !inCode;
      if (ch === "|" && !inCode) {
        cells.push(cur.trim());
        cur = "";
      } else {
        cur += ch;
      }
    }
    cells.push(cur.trim());
    return cells;
  }

  function isMarkdownTableRow(line) {
    if (!line || line.startsWith("<")) return false;
    return /^\s*\|/.test(line);
  }

  function isMarkdownTableSeparator(line) {
    if (!isMarkdownTableRow(line) && !/^\s*:?-+:?\s*\|/.test(line)) return false;
    const cells = splitTableCells(line);
    return cells.length > 0 && cells.every((c) => /^:?-+:?$/.test(c));
  }

  function tableAlignFromCell(cell) {
    const left = cell.startsWith(":");
    const right = cell.endsWith(":");
    if (left && right) return "center";
    if (right) return "right";
    return "left";
  }

  function renderMarkdownTable(headers, rows, aligns) {
    const colCount = Math.max(
      headers.length,
      aligns.length,
      ...rows.map((r) => r.length),
      1
    );
    const pad = (arr) => {
      const out = arr.slice(0, colCount);
      while (out.length < colCount) out.push("");
      return out;
    };
    const alignFor = (i) => aligns[i] || "left";
    const cell = (tag, text, i) => {
      const align = alignFor(i);
      const style = align !== "left" ? ` style="text-align:${align}"` : "";
      return `<${tag}${style}>${text || ""}</${tag}>`;
    };
    const head = pad(headers)
      .map((h, i) => cell("th", h, i))
      .join("");
    const body = rows
      .map((row) => `<tr>${pad(row).map((c, i) => cell("td", c, i)).join("")}</tr>`)
      .join("");
    return `<div class="md-table-wrap"><table class="md-table"><thead><tr>${head}</tr></thead>${
      body ? `<tbody>${body}</tbody>` : ""
    }</table></div>`;
  }

  /** Turn GFM pipe tables into HTML. Skips fenced-code blocks. */
  function convertMarkdownTables(text) {
    const lines = text.split("\n");
    const out = [];
    let i = 0;
    let inPre = false;
    while (i < lines.length) {
      const line = lines[i];
      if (inPre) {
        out.push(line);
        if (line.includes("</pre>")) inPre = false;
        i++;
        continue;
      }
      if (line.includes("<pre")) {
        out.push(line);
        if (!line.includes("</pre>")) inPre = true;
        i++;
        continue;
      }
      if (
        i + 1 < lines.length &&
        isMarkdownTableRow(line) &&
        isMarkdownTableSeparator(lines[i + 1])
      ) {
        const headers = splitTableCells(line);
        const aligns = splitTableCells(lines[i + 1]).map(tableAlignFromCell);
        const rows = [];
        i += 2;
        while (i < lines.length && isMarkdownTableRow(lines[i]) && !isMarkdownTableSeparator(lines[i])) {
          rows.push(splitTableCells(lines[i]));
          i++;
        }
        // Isolate from surrounding text so paragraph wrapping does not wrap the table.
        if (out.length && out[out.length - 1] !== "") out.push("");
        out.push(renderMarkdownTable(headers, rows, aligns));
        if (i < lines.length && lines[i] !== "") out.push("");
        continue;
      }
      out.push(line);
      i++;
    }
    return out.join("\n");
  }

  /** Minimal markdown → HTML (bold, code, fences, lists, headers, tables). */
  function renderMarkdown(text, opts = {}) {
    if (!text) return "";
    const escaped = text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");

    // fenced code
    let html = escaped.replace(/```([\w-]*)\n([\s\S]*?)```/g, (_, lang, code) => {
      return `<pre><code class="lang-${lang || "text"}">${code.replace(/\n$/, "")}</code></pre>`;
    });

    // GFM tables before inline so `|` inside `code` stays in one cell
    html = convertMarkdownTables(html);

    // inline code
    html = html.replace(/`([^`\n]+)`/g, "<code>$1</code>");

    // bold / italic
    html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    html = html.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, "<em>$1</em>");

    // One inline copy of each generated file. Paths already in the media
    // strip (or seen earlier in this body) stay text so /imagine is not doubled.
    const shown = new Set();
    if (opts.skipMedia) {
      for (const key of opts.skipMedia) shown.add(String(key).toLowerCase());
    }
    const embedMedia = (rel, alt, fromMarkdownImage) => {
      const key = mediaKey(rel);
      if (key && shown.has(key)) {
        return fromMarkdownImage ? "" : escapeHtml(rel);
      }
      if (key) shown.add(key);
      return renderMediaHtml(rel, alt);
    };
    const replaceOutsideCode = (input, re, replacer) =>
      input
        .split(/(<pre[\s\S]*?<\/pre>|<code>[\s\S]*?<\/code>)/gi)
        .map((part, i) => (i % 2 === 1 ? part : part.replace(re, replacer)))
        .join("");

    html = replaceOutsideCode(
      html,
      /!\[([^\]]*)\]\(((?:images|videos)\/[A-Za-z0-9._-]+\.(?:jpe?g|png|webp|gif|mp4|webm))\)/gi,
      (_, alt, rel) => embedMedia(rel, alt, true)
    );
    html = replaceOutsideCode(
      html,
      /(?<!["/=])\b((?:images|videos)\/[A-Za-z0-9._-]+\.(?:jpe?g|png|webp|gif|mp4|webm))\b/gi,
      (rel) => embedMedia(rel)
    );

    // headers
    html = html.replace(/^### (.+)$/gm, '<div class="md-h">$1</div>');
    html = html.replace(/^## (.+)$/gm, '<div class="md-h">$1</div>');
    html = html.replace(/^# (.+)$/gm, '<div class="md-h">$1</div>');

    // unordered list lines
    html = html.replace(/^[-*] (.+)$/gm, '<div class="md-li">$1</div>');

    // paragraphs: double newlines
    html = html
      .split(/\n{2,}/)
      .map((block) => {
        if (!block.trim()) return "";
        if (
          block.startsWith("<pre") ||
          block.startsWith('<div class="md-')
        ) {
          return block;
        }
        return `<p>${block.replace(/\n/g, "<br>")}</p>`;
      })
      .join("");

    return html;
  }

  function renderMediaHtml(rel, alt) {
    const url = sessionMediaUrl(rel);
    const norm = normalizeRelMedia(rel) || rel;
    if (!url) return escapeHtml(rel);
    const label = escapeHtml(alt || rel);
    const relAttr = escapeHtml(norm);
    if (/\.(mp4|webm)$/i.test(rel)) {
      return `<video class="generated-media-item" src="${escapeHtml(url)}" controls playsinline data-media-rel="${relAttr}"></video>`;
    }
    return `<img class="generated-media-item" src="${escapeHtml(url)}" alt="${label}" data-media-rel="${relAttr}">`;
  }

  function appendUserMessage(text, imageDataUrls = []) {
    const empty = els.messages.querySelector(".empty-state");
    if (empty) empty.remove();

    const wrap = document.createElement("div");
    wrap.className = "msg user";
    wrap.innerHTML = `<div class="bubble"></div>`;
    const bubble = wrap.querySelector(".bubble");
    if (imageDataUrls.length) {
      const imgs = document.createElement("div");
      imgs.className = "msg-images";
      for (const src of imageDataUrls) {
        const img = document.createElement("img");
        img.src = src;
        img.alt = "Attached image";
        imgs.appendChild(img);
      }
      bubble.appendChild(imgs);
    }
    if (text) {
      const p = document.createElement("div");
      p.textContent = text;
      bubble.appendChild(p);
    }
    els.messages.appendChild(wrap);
    scrollToBottom();
    return wrap;
  }

  // ---------- Image attachments ----------
  function renderAttachments() {
    if (!els.attachStrip) return;
    els.attachStrip.innerHTML = "";
    if (!state.attachments.length) {
      els.attachStrip.classList.add("hidden");
      updateSendEnabled();
      return;
    }
    els.attachStrip.classList.remove("hidden");
    for (const att of state.attachments) {
      const chip = document.createElement("div");
      chip.className = "attach-chip";
      chip.innerHTML = `<img alt=""/><button type="button" class="attach-remove" title="Remove" aria-label="Remove">×</button>`;
      chip.querySelector("img").src = att.dataUrl;
      chip.querySelector(".attach-remove").addEventListener("click", () => {
        state.attachments = state.attachments.filter((a) => a.id !== att.id);
        renderAttachments();
      });
      els.attachStrip.appendChild(chip);
    }
    updateSendEnabled();
  }

  function clearAttachments() {
    state.attachments = [];
    renderAttachments();
  }

  function updateSendEnabled() {
    const hasText = !!els.prompt.value.trim();
    const hasImg = state.attachments.length > 0;
    els.btnSend.disabled = !hasText && !hasImg;
    if (els.btnSend) {
      els.btnSend.title = state.running && (hasText || hasImg)
        ? "Queue follow-up (Enter) · Ctrl+Enter sends now"
        : "Send (Enter)";
    }
  }

  function queuePreview(item) {
    const text = String(item.text || "").replace(/\s+/g, " ").trim();
    const n = item.images?.length || 0;
    if (text && n) return `${text} · ${n} image${n === 1 ? "" : "s"}`;
    if (text) return text;
    if (n) return `${n} image${n === 1 ? "" : "s"}`;
    return "Follow-up";
  }

  function renderQueue() {
    if (!els.queueStrip) return;
    els.queueStrip.innerHTML = "";
    const visible = state.promptQueue.filter((q) => !q.silent);
    if (!visible.length) {
      els.queueStrip.classList.add("hidden");
      return;
    }
    els.queueStrip.classList.remove("hidden");
    for (const item of visible) {
      const row = document.createElement("div");
      row.className = "queue-item";
      row.innerHTML =
        `<span class="queue-item-mark">Queued</span>` +
        `<span class="queue-item-text"></span>` +
        `<button type="button" class="queue-item-remove" title="Remove" aria-label="Remove queued follow-up">×</button>`;
      row.querySelector(".queue-item-text").textContent = queuePreview(item);
      row.querySelector(".queue-item-remove").addEventListener("click", () => {
        state.promptQueue = state.promptQueue.filter((q) => q.id !== item.id);
        renderQueue();
      });
      els.queueStrip.appendChild(row);
    }
  }

  function enqueueFollowUp({ text, images }) {
    state.promptQueue.push({
      id: `q-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      text: text || "",
      images: Array.isArray(images) ? images.slice() : [],
    });
    renderQueue();
  }

  function clearPromptQueue() {
    if (!state.promptQueue.length) return;
    state.promptQueue = [];
    renderQueue();
  }

  function drainPromptQueue() {
    if (state.running || state.sendInFlight) return;
    if (!state.promptQueue.length) return;
    const next = state.promptQueue.shift();
    renderQueue();
    if (next) void sendPrompt({ queued: next });
  }

  function readFileAsDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error || new Error("Read failed"));
      reader.readAsDataURL(file);
    });
  }

  /**
   * Downscale + re-encode as JPEG. Screenshots as PNG stay multi‑MB and make
   * vision turns slow / flaky; JPEG keeps quality fine for chat.
   */
  function compressDataUrl(dataUrl) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        let { width, height } = img;
        const maxEdge = Math.max(width, height);
        const scale = maxEdge > MAX_IMAGE_EDGE ? MAX_IMAGE_EDGE / maxEdge : 1;
        const w = Math.max(1, Math.round(width * scale));
        const h = Math.max(1, Math.round(height * scale));
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        // White background so transparent PNGs don't go black as JPEG
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, w, h);
        ctx.drawImage(img, 0, 0, w, h);
        try {
          // Prefer smaller files for reliable round-trips
          let quality = 0.78;
          let out = canvas.toDataURL("image/jpeg", quality);
          // If still huge, step quality down
          while (out.length > 900000 && quality > 0.45) {
            quality -= 0.1;
            out = canvas.toDataURL("image/jpeg", quality);
          }
          resolve(out);
        } catch {
          resolve(dataUrl);
        }
      };
      img.onerror = () => resolve(dataUrl);
      img.src = dataUrl;
    });
  }

  async function addImageFiles(fileList) {
    const files = [...(fileList || [])].filter((f) => f.type.startsWith("image/"));
    if (!files.length) return;

    for (const file of files) {
      if (state.attachments.length >= MAX_ATTACHMENTS) {
        alert(`You can attach up to ${MAX_ATTACHMENTS} images.`);
        break;
      }
      if (file.size > MAX_IMAGE_BYTES) {
        alert(`${file.name} is too large (max ~12MB).`);
        continue;
      }
      try {
        let dataUrl = await readFileAsDataUrl(file);
        dataUrl = await compressDataUrl(dataUrl);
        const mimeMatch = /^data:(image\/[a-zA-Z0-9.+-]+);base64,/.exec(dataUrl);
        const baseName = (file.name || "image").replace(/\.[^.]+$/, "");
        state.attachments.push({
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          name: `${baseName}.jpg`,
          mimeType: mimeMatch ? mimeMatch[1] : "image/jpeg",
          dataUrl,
        });
      } catch (err) {
        console.warn("Failed to attach image:", err);
      }
    }
    renderAttachments();
  }

  const TOOL_LABELS = {
    read_file: "Read",
    search_replace: "Edit",
    write: "Write",
    write_file: "Write",
    delete_file: "Delete",
    run_terminal_command: "Terminal",
    run_terminal_cmd: "Terminal",
    bash: "Terminal",
    shell: "Terminal",
    grep: "Search",
    grep_search: "Search",
    list_dir: "List",
    glob: "Find files",
    glob_file_search: "Find files",
    web_search: "Web search",
    web_fetch: "Fetch",
    open_page: "Open page",
    image_gen: "Image",
    image_edit: "Image edit",
    image_to_video: "Video",
    reference_to_video: "Video",
    spawn_subagent: "Subagent",
    todo_write: "Todos",
    ask_user_question: "Ask",
  };

  const MEDIA_TOOL_NAMES = new Set([
    "image_gen",
    "image_edit",
    "image_to_video",
    "reference_to_video",
  ]);
  const REL_MEDIA_RE =
    /\b((?:images|videos)[/\\][A-Za-z0-9][A-Za-z0-9._-]*\.(?:jpe?g|png|webp|gif|mp4|webm))\b/gi;

  function isMediaToolName(name) {
    return MEDIA_TOOL_NAMES.has(
      String(name || "")
        .trim()
        .toLowerCase()
    );
  }

  function normalizeRelMedia(p) {
    if (!p || typeof p !== "string") return null;
    const rel = p
      .trim()
      .replace(/\\/g, "/")
      .replace(/\/+/g, "/")
      .replace(/^\/+/, "");
    if (
      !/^(images|videos)\/[A-Za-z0-9][A-Za-z0-9._-]*\.(jpe?g|png|webp|gif|mp4|webm)$/i.test(
        rel
      )
    ) {
      return null;
    }
    return rel;
  }

  function mediaKey(rel) {
    const norm = normalizeRelMedia(rel);
    return norm ? norm.toLowerCase() : "";
  }

  function collectMediaShown(root) {
    const seen = new Set();
    if (!root || typeof root.querySelectorAll !== "function") return seen;
    root.querySelectorAll("[data-media-rel]").forEach((el) => {
      const key = mediaKey(el.getAttribute("data-media-rel"));
      if (key) seen.add(key);
    });
    return seen;
  }

  function extractRelMedia(value, out, seen, depth) {
    if (value == null || depth > 8) return;
    if (typeof value === "string") {
      REL_MEDIA_RE.lastIndex = 0;
      let m;
      while ((m = REL_MEDIA_RE.exec(value))) {
        const rel = normalizeRelMedia(m[1]);
        if (!rel) continue;
        const key = rel.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(rel);
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) extractRelMedia(item, out, seen, depth + 1);
      return;
    }
    if (typeof value === "object") {
      for (const item of Object.values(value)) extractRelMedia(item, out, seen, depth + 1);
    }
  }

  function mediaPathsFrom(src) {
    const out = [];
    const seen = new Set();
    if (src && Array.isArray(src.media)) {
      for (const p of src.media) {
        const rel = normalizeRelMedia(p);
        if (!rel) continue;
        const key = rel.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(rel);
      }
    }
    extractRelMedia(src, out, seen, 0);
    return out;
  }

  function sessionMediaUrl(rel) {
    const sid = state.activeSessionId || state.streamSessionId;
    const norm = normalizeRelMedia(rel);
    if (!sid || !norm) return "";
    return apiUrl(`/api/sessions/${encodeURIComponent(sid)}/media/${norm}`);
  }

  function looksLikeCallId(s) {
    return /^call[-_]/i.test(String(s || "").trim());
  }

  function basenamePath(p) {
    if (!p) return "";
    const s = String(p).replace(/[\\/]+$/, "");
    const parts = s.split(/[\\/]/);
    return parts[parts.length - 1] || s;
  }

  function formatToolStatus(status) {
    const raw = String(status || "").trim();
    const key = raw.toLowerCase().replace(/\s+/g, "_");
    if (!key) return "";
    if (["in_progress", "pending", "running", "updated", "started"].includes(key)) {
      return "running";
    }
    if (["completed", "complete", "success", "done", "ok"].includes(key)) {
      return "done";
    }
    if (["failed", "error", "errored"].includes(key)) return "failed";
    if (["cancelled", "canceled"].includes(key)) return "cancelled";
    return raw.replace(/_/g, " ");
  }

  function prettyToolKind(name) {
    const key = String(name || "").trim();
    if (!key || looksLikeCallId(key)) return "";
    return TOOL_LABELS[key] || TOOL_LABELS[key.toLowerCase()] || key.replace(/_/g, " ");
  }

  function toolInputOf(src) {
    if (!src || typeof src !== "object") return {};
    if (src.rawInput && typeof src.rawInput === "object") return src.rawInput;
    if (src.input && typeof src.input === "object") return src.input;
    if (src.arguments && typeof src.arguments === "object") return src.arguments;
    return {};
  }

  /** Human label for a live grok tool event or a restored {id,title,name,status}. */
  function describeTool(src) {
    const id = src.toolCallId || src.id || "";
    const rawName =
      src.toolName ||
      src.name ||
      src.kind ||
      (src._meta && src._meta["x.ai/tool"] && src._meta["x.ai/tool"].name) ||
      "";
    const input = toolInputOf(src);
    let title = src.title && !looksLikeCallId(src.title) ? String(src.title) : "";
    const kind =
      prettyToolKind(rawName) ||
      (title ? prettyToolKind(title.split(/\s+/)[0]) : "") ||
      (title ? title.split(/\s+/)[0] : "") ||
      "";

    let detail = "";
    const filePath =
      input.path || input.file_path || input.target_file || input.filePath;
    const cmd = input.command || input.cmd;
    const query = input.query || input.pattern || input.grep || input.prompt;
    if (filePath) detail = basenamePath(filePath);
    else if (cmd) detail = String(cmd).replace(/\s+/g, " ").trim().slice(0, 88);
    else if (query) detail = String(query).replace(/\s+/g, " ").trim().slice(0, 88);
    else if (title) {
      const stripped = kind
        ? title.replace(new RegExp("^" + kind.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*", "i"), "")
        : title;
      const asPath = basenamePath(stripped);
      detail = asPath && asPath !== kind ? asPath : stripped;
      if (detail.toLowerCase() === String(kind).toLowerCase()) detail = "";
    }

    return {
      id,
      kind: kind || "Tool",
      detail,
      status: formatToolStatus(src.status),
      rawName,
    };
  }

  function bindThoughtToggle(shell) {
    if (!shell.thoughtToggle || shell.thoughtToggle._bound) return;
    shell.thoughtToggle._bound = true;
    shell.thoughtToggle.addEventListener("click", () => {
      const open = shell.thoughtWrap.classList.toggle("open");
      shell.thoughtToggle.setAttribute("aria-expanded", open ? "true" : "false");
    });
  }

  function ensureThoughtUi(shell) {
    if (!shell || !shell.el) return;
    if (shell.thoughtWrap && shell.thoughtBody) {
      bindThoughtToggle(shell);
      return;
    }
    let wrap = shell.el.querySelector(".thought-block");
    if (!wrap) {
      wrap = document.createElement("div");
      wrap.className = "thought-block hidden open";
      wrap.innerHTML = `
        <button type="button" class="thought-toggle" aria-expanded="true">
          <span class="thought-chevron" aria-hidden="true">▸</span>
          <span class="thought-label">Thinking</span>
          <span class="thought-preview"></span>
        </button>
        <div class="thought-body"></div>`;
      const tools = shell.el.querySelector(".tools");
      shell.el.insertBefore(wrap, tools || shell.el.firstChild);
    }
    shell.thoughtWrap = wrap;
    shell.thoughtToggle = wrap.querySelector(".thought-toggle");
    shell.thoughtBody = wrap.querySelector(".thought-body");
    shell.thoughtPreview = wrap.querySelector(".thought-preview");
    bindThoughtToggle(shell);
  }

  function appendThought(shell, chunk) {
    if (!shell) return;
    if (chunk) shell.thought = (shell.thought || "") + chunk;
    if (!shell.thought) return;
    ensureThoughtUi(shell);
    shell.thoughtWrap.classList.remove("hidden");
    if (!shell.thoughtWrap.classList.contains("open")) {
      shell.thoughtWrap.classList.add("open");
      if (shell.thoughtToggle) shell.thoughtToggle.setAttribute("aria-expanded", "true");
    }
    if (shell.thoughtBody) shell.thoughtBody.textContent = shell.thought;
    if (shell.thoughtPreview) {
      const preview = shell.thought.replace(/\s+/g, " ").trim();
      shell.thoughtPreview.textContent =
        preview.length > 88 ? preview.slice(0, 88) + "…" : preview;
    }
    scrollToBottom();
  }

  function appendAssistantShell() {
    const wrap = document.createElement("div");
    wrap.className = "msg assistant";
    wrap.innerHTML = `
      <div class="thought-block hidden open">
        <button type="button" class="thought-toggle" aria-expanded="true">
          <span class="thought-chevron" aria-hidden="true">▸</span>
          <span class="thought-label">Thinking</span>
          <span class="thought-preview"></span>
        </button>
        <div class="thought-body"></div>
      </div>
      <div class="tools"></div>
      <div class="question-cards"></div>
      <div class="generated-media hidden"></div>
      <div class="body"></div>`;
    els.messages.appendChild(wrap);
    scrollToBottom();
    const shell = {
      el: wrap,
      toolsEl: wrap.querySelector(".tools"),
      questionsEl: wrap.querySelector(".question-cards"),
      questionMap: new Map(),
      mediaEl: wrap.querySelector(".generated-media"),
      mediaShown: new Set(),
      bodyEl: wrap.querySelector(".body"),
      thoughtWrap: wrap.querySelector(".thought-block"),
      thoughtToggle: wrap.querySelector(".thought-toggle"),
      thoughtBody: wrap.querySelector(".thought-body"),
      thoughtPreview: wrap.querySelector(".thought-preview"),
      text: "",
      thought: "",
      toolMap: new Map(),
      toolUsed: false,
      sessionId: state.activeSessionId,
    };
    bindThoughtToggle(shell);
    return shell;
  }

  function shouldRenderShell(shell) {
    if (!shell || !shell.bodyEl) return false;
    if (shell.el && !shell.el.isConnected) return false;
    if (
      shell.sessionId &&
      state.activeSessionId &&
      shell.sessionId !== state.activeSessionId
    ) {
      return false;
    }
    return true;
  }

  function flushAssistantMarkdown(shell) {
    if (!shell) return;
    if (shell.mdTimer) {
      clearTimeout(shell.mdTimer);
      shell.mdTimer = 0;
    }
    if (!shouldRenderShell(shell)) return;
    shell.bodyEl.innerHTML = renderMarkdown(shell.text, {
      skipMedia: shell.mediaShown,
    });
    scrollToBottom();
  }

  function scheduleAssistantMarkdown(shell) {
    if (!shell || !shouldRenderShell(shell)) return;
    if (shell.mdTimer) return;
    shell.mdTimer = setTimeout(() => {
      shell.mdTimer = 0;
      flushAssistantMarkdown(shell);
    }, MD_DEBOUNCE_MS);
  }

  function updateAssistantText(shell, chunk) {
    if (!shell) return;
    shell.text += chunk;
    scheduleAssistantMarkdown(shell);
  }

  function markToolUsed(shell) {
    if (!shell) return;
    shell.toolUsed = true;
    if (!shouldRenderShell(shell) || !shell.el) return;
    if (shell.el.querySelector(".tool-used-flag")) return;
    const flag = document.createElement("div");
    flag.className = "tool-used-flag";
    flag.textContent = "Grok ran a command";
    if (shell.toolsEl && shell.toolsEl.parentNode) {
      shell.toolsEl.parentNode.insertBefore(flag, shell.toolsEl.nextSibling);
    } else {
      shell.el.appendChild(flag);
    }
  }

  function upsertTool(shell, src) {
    if (!shell || !shouldRenderShell(shell)) return;
    const ask = extractAskFromSrc(src);
    if (ask) {
      upsertQuestionCard(shell, src, ask);
      return;
    }
    if (!shell.toolsEl) return;
    markToolUsed(shell);
    const info = describeTool(src || {});
    const id = info.id || src.id || src.toolCallId;
    if (!id) return;
    let chip = shell.toolMap.get(id);
    if (!chip) {
      chip = document.createElement("div");
      chip.className = "tool-chip";
      chip.innerHTML = `<span class="tool-kind"></span><span class="tool-detail"></span><span class="tool-status"></span>`;
      shell.toolsEl.appendChild(chip);
      shell.toolMap.set(id, chip);
    }
    const prevKind = chip.dataset.kind || "";
    const prevDetail = chip.dataset.detail || "";
    const kind =
      info.kind && info.kind !== "Tool" ? info.kind : prevKind || info.kind || "Tool";
    const detail = info.detail || prevDetail;
    chip.dataset.kind = kind;
    if (detail) chip.dataset.detail = detail;
    chip.querySelector(".tool-kind").textContent = kind;
    const detailEl = chip.querySelector(".tool-detail");
    detailEl.textContent = detail;
    detailEl.hidden = !detail;
    if (info.status) {
      chip.querySelector(".tool-status").textContent = info.status;
      chip.classList.remove("running", "done", "failed", "cancelled");
      chip.classList.add(info.status);
    }
    if (
      isMediaToolName(info.rawName) ||
      isMediaToolName(src && (src.toolName || src.name))
    ) {
      const media = mediaPathsFrom(src);
      if (media.length) showGeneratedMedia(shell, media);
      else if (info.status === "done") {
        void refreshSessionMedia(shell);
      }
    }
    scrollToBottom();
  }

  function clipAskText(value, max) {
    const s = String(value == null ? "" : value).replace(/\s+/g, " ").trim();
    if (!s) return "";
    return s.length > max ? s.slice(0, max) : s;
  }

  function isAskToolName(name) {
    const key = String(name || "")
      .trim()
      .toLowerCase()
      .replace(/[\s-]+/g, "_");
    return key === "ask_user_question" || key === "askuserquestion";
  }

  function isOtherOptionLabel(label) {
    return /^(other|other…|other\.\.\.)(\b|$)/i.test(String(label || "").trim());
  }

  function normalizeAskOption(raw, index) {
    if (raw == null) return null;
    if (typeof raw === "string") {
      const label = clipAskText(raw, 200);
      if (!label) return null;
      return { label, description: "", preview: "", isOther: isOtherOptionLabel(label) };
    }
    if (typeof raw !== "object") return null;
    const label = clipAskText(
      raw.label || raw.title || raw.value || raw.text || `Option ${index + 1}`,
      200
    );
    if (!label) return null;
    return {
      label,
      description: clipAskText(raw.description || raw.detail || raw.hint || "", 500),
      preview: raw.preview == null ? "" : clipAskText(raw.preview, 500),
      isOther: !!(raw.isOther || raw.other || isOtherOptionLabel(label)),
    };
  }

  function ensureAskOther(options) {
    const list = Array.isArray(options) ? options.slice() : [];
    if (list.some((o) => o && o.isOther)) return list;
    list.push({
      label: "Other…",
      description: "Type your own answer",
      preview: "",
      isOther: true,
    });
    return list;
  }

  function normalizeAskQuestion(raw, index) {
    if (typeof raw === "string") {
      const question = clipAskText(raw, 800);
      if (!question) return null;
      return { question, options: ensureAskOther([]), multiSelect: false };
    }
    if (!raw || typeof raw !== "object") return null;
    const question = clipAskText(
      raw.question || raw.prompt || raw.text || `Question ${index + 1}`,
      800
    );
    if (!question) return null;
    const rawOpts = raw.options || raw.choices || [];
    const options = [];
    if (Array.isArray(rawOpts)) {
      for (let i = 0; i < rawOpts.length && options.length < 12; i++) {
        const opt = normalizeAskOption(rawOpts[i], i);
        if (opt) options.push(opt);
      }
    }
    return {
      question,
      options: ensureAskOther(options),
      multiSelect: !!(raw.multi_select || raw.multiSelect || raw.multiple),
    };
  }

  function extractAskFromSrc(src) {
    if (!src || typeof src !== "object") return null;
    const id = src.toolCallId || src.id || null;
    const named = isAskToolName(src.toolName || src.name || src.kind || src.title);
    let rawQs = Array.isArray(src.questions) ? src.questions : null;
    if (!rawQs) {
      const input = toolInputOf(src);
      if (Array.isArray(input.questions)) rawQs = input.questions;
    }
    if (!rawQs && src._meta && src._meta["x.ai/tool"] && src._meta["x.ai/tool"].input) {
      const metaIn = src._meta["x.ai/tool"].input;
      if (Array.isArray(metaIn.questions)) rawQs = metaIn.questions;
    }
    const questions = Array.isArray(rawQs)
      ? rawQs.map(normalizeAskQuestion).filter(Boolean).slice(0, 12)
      : [];
    if (!questions.length) {
      return named ? { id, questions: [], answers: src.answers || null } : null;
    }
    return { id, questions, answers: Array.isArray(src.answers) ? src.answers : null };
  }

  function formatAskAnswersPrompt(pairs, override) {
    const lines = ["<user_answers>"];
    for (const p of pairs || []) {
      lines.push(`Question: ${clipAskText(p.question, 800)}`);
      lines.push(`Answer: ${clipAskText(p.answer, 800)}`);
    }
    lines.push("</user_answers>");
    const block = lines.join("\n");
    return override
      ? `Use this choice instead of any earlier pick.\n\n${block}`
      : block;
  }

  function ensureQuestionsEl(shell) {
    if (shell && shell.questionsEl && shell.questionsEl.isConnected) return shell.questionsEl;
    if (!shell || !shell.el) return null;
    let el = shell.el.querySelector(".question-cards");
    if (!el) {
      el = document.createElement("div");
      el.className = "question-cards";
      if (shell.toolsEl && shell.toolsEl.parentNode) {
        shell.toolsEl.parentNode.insertBefore(el, shell.toolsEl.nextSibling);
      } else if (shell.bodyEl && shell.bodyEl.parentNode) {
        shell.bodyEl.parentNode.insertBefore(el, shell.bodyEl);
      } else {
        shell.el.appendChild(el);
      }
    }
    shell.questionsEl = el;
    return el;
  }

  function shellFromQuestionEl(el) {
    if (state.liveShell && state.liveShell.el && el && state.liveShell.el.contains(el)) {
      return state.liveShell;
    }
    const wrap = el && el.closest && el.closest(".msg.assistant");
    if (!wrap) return state.liveShell;
    return {
      el: wrap,
      toolsEl: wrap.querySelector(".tools"),
      questionsEl: wrap.querySelector(".question-cards"),
      bodyEl: wrap.querySelector(".body"),
      sessionId: state.activeSessionId,
    };
  }

  function findExistingQuestionRec(id) {
    if (!id || !els.messages) return null;
    let el = null;
    try {
      el = els.messages.querySelector(`.question-card[data-ask-id="${CSS.escape(String(id))}"]`);
    } catch {
      el = null;
    }
    return el && el._askRec ? el._askRec : null;
  }

  function setQuestionCardMode(el, mode) {
    if (!el) return;
    el.classList.remove("pending", "submitting", "answered", "expired");
    el.classList.add(mode);
    el.dataset.mode = mode;
  }

  function upsertQuestionCard(shell, src, ask) {
    if (!shell || !ask || !shouldRenderShell(shell)) return;
    const id = ask.id || (src && (src.toolCallId || src.id));
    if (!id) return;
    if (!shell.questionMap) shell.questionMap = new Map();
    let rec = shell.questionMap.get(id) || findExistingQuestionRec(id);
    const questions =
      ask.questions && ask.questions.length
        ? ask.questions
        : (rec && rec.ask && rec.ask.questions) || [];
    const answers =
      (ask.answers && ask.answers.length && ask.answers) ||
      (src && src.answers && src.answers.length && src.answers) ||
      (rec && rec.ask && rec.ask.answers) ||
      null;
    const status = formatToolStatus((src && src.status) || "");
    if (!rec) {
      const host = ensureQuestionsEl(shell);
      if (!host) return;
      const el = document.createElement("div");
      el.className = "question-card pending";
      el.tabIndex = 0;
      el.dataset.askId = id;
      host.appendChild(el);
      rec = {
        el,
        ask: { id, questions, answers },
        step: 0,
        picks: [],
        answersSoFar: [],
        mode: "pending",
        toolStatus: status,
      };
    } else {
      rec.ask = rec.ask || { id, questions: [], answers: null };
      rec.ask.id = id;
      if (questions.length) rec.ask.questions = questions;
      if (answers && answers.length) rec.ask.answers = answers;
      if (status) rec.toolStatus = status;
      if (!rec.el.isConnected) {
        const host = ensureQuestionsEl(shell);
        if (host) host.appendChild(rec.el);
      }
    }
    rec.el._askRec = rec;
    rec.el.dataset.askId = id;
    shell.questionMap.set(id, rec);

    if (rec.ask.answers && rec.ask.answers.length) {
      rec.mode = "answered";
    } else if (rec.mode === "submitting" || rec.mode === "answered") {
      /* keep */
    } else if (
      (state.liveShell === shell && state.running) ||
      (state.running && state.streamSessionId === state.activeSessionId) ||
      state.awaitingAnswers
    ) {
      rec.mode = "pending";
    } else if (
      rec.toolStatus === "done" ||
      rec.toolStatus === "failed" ||
      rec.toolStatus === "cancelled"
    ) {
      rec.mode = "expired";
    } else {
      rec.mode = "pending";
    }
    renderQuestionCard(shell, rec);
  }

  function promptLooksIdle() {
    if (!els.prompt) return true;
    if (String(els.prompt.value || "").trim()) return false;
    if (state.attachments && state.attachments.length) return false;
    if (state.voice && state.voice.phase && state.voice.phase !== "idle") return false;
    return true;
  }

  function latestPendingQuestionRec() {
    if (!els.messages) return null;
    const cards = els.messages.querySelectorAll(".question-card.pending");
    for (let i = cards.length - 1; i >= 0; i--) {
      const rec = cards[i]._askRec;
      if (rec && rec.mode === "pending") return rec;
    }
    return null;
  }

  function isRecommendedOptionLabel(label) {
    return /\(\s*recommended\s*\)/i.test(String(label || ""));
  }

  function applyPendingQuestions(shell, run) {
    const asks = (run && run.pendingQuestions) || [];
    for (const ask of asks) {
      if (ask && ((ask.questions && ask.questions.length) || ask.id)) {
        upsertQuestionCard(shell, ask, ask);
      }
    }
  }

  function expireQuestionCards(shell) {
    const maps = [];
    if (shell && shell.questionMap) maps.push(shell.questionMap);
    if (els.messages) {
      els.messages.querySelectorAll(".question-card").forEach((el) => {
        if (el._askRec && el._askRec.mode === "pending") {
          el._askRec.mode = "expired";
          renderQuestionCard(shellFromQuestionEl(el), el._askRec);
        }
      });
      return;
    }
    for (const map of maps) {
      for (const rec of map.values()) {
        if (rec.mode === "pending") {
          rec.mode = "expired";
          renderQuestionCard(shell, rec);
        }
      }
    }
  }

  function currentPickAnswer(rec) {
    const q = rec.ask.questions[rec.step];
    if (!q) return null;
    const pick = rec.picks[rec.step] || { selected: new Set(), otherText: "" };
    const otherText = String(pick.otherText || "").trim();
    if (otherText) {
      return { question: q.question, answer: `Other: ${otherText}` };
    }
    const labels = [];
    for (const i of pick.selected || []) {
      const opt = q.options[i];
      if (opt && !opt.isOther) labels.push(opt.label);
    }
    if (!labels.length) return null;
    return { question: q.question, answer: labels.join(", ") };
  }

  function advanceOrSubmitQuestion(shell, rec) {
    const answer = currentPickAnswer(rec);
    if (!answer) return;
    rec.answersSoFar = rec.answersSoFar || [];
    rec.answersSoFar[rec.step] = answer;
    if (rec.step < rec.ask.questions.length - 1) {
      rec.step += 1;
      renderQuestionCard(shell, rec);
      if (rec.el) rec.el.focus();
      return;
    }
    void submitQuestionCard(shell, rec);
  }

  function commitQuestionOther(shell, rec) {
    const pick =
      rec.picks[rec.step] || (rec.picks[rec.step] = { selected: new Set(), otherText: "" });
    if (!String(pick.otherText || "").trim()) return;
    pick.selected = new Set();
    advanceOrSubmitQuestion(shell, rec);
  }

  function selectQuestionOptionByIndex(rec, index) {
    const q = rec.ask && rec.ask.questions[rec.step];
    if (!q || rec.mode !== "pending") return;
    const shell = shellFromQuestionEl(rec.el);
    const visible = q.options.filter((o) => !o.isOther);
    const other = q.options.find((o) => o.isOther);
    if (index === visible.length && other) {
      const pick =
        rec.picks[rec.step] || (rec.picks[rec.step] = { selected: new Set(), otherText: "" });
      pick.otherOpen = true;
      renderQuestionCard(shell, rec);
      const input = rec.el.querySelector(".question-other-input");
      if (input) input.focus();
      return;
    }
    const opt = visible[index];
    if (!opt) return;
    const realIndex = q.options.indexOf(opt);
    const pick =
      rec.picks[rec.step] || (rec.picks[rec.step] = { selected: new Set(), otherText: "" });
    if (q.multiSelect) {
      if (pick.selected.has(realIndex)) pick.selected.delete(realIndex);
      else pick.selected.add(realIndex);
      renderQuestionCard(shell, rec);
    } else {
      pick.selected = new Set([realIndex]);
      pick.otherText = "";
      advanceOrSubmitQuestion(shell, rec);
    }
  }

  async function submitQuestionCard(shell, rec) {
    if (rec.mode === "submitting" || rec.mode === "answered") return;
    const pairs = [];
    for (let i = 0; i < rec.ask.questions.length; i++) {
      const stored = rec.answersSoFar && rec.answersSoFar[i];
      if (stored) pairs.push(stored);
      else if (i === rec.step) {
        const cur = currentPickAnswer(rec);
        if (cur) pairs.push(cur);
      }
    }
    if (!pairs.length) return;
    rec.mode = "submitting";
    rec.ask.answers = pairs;
    renderQuestionCard(shell, rec);

    const override = rec.toolStatus === "done";
    const prompt = formatAskAnswersPrompt(pairs, override);
    try {
      if ((state.awaitingAnswers || (state.running && state.runId)) && state.runId) {
        try {
          await api("/api/chat/answer", {
            method: "POST",
            body: JSON.stringify({
              runId: state.runId,
              sessionId: state.streamSessionId || state.activeSessionId,
              answers: pairs,
            }),
          });
          state.awaitingAnswers = false;
          rec.mode = "answered";
          renderQuestionCard(shellFromQuestionEl(rec.el) || shell, rec);
          return;
        } catch {
          /* fall back to a follow-up turn */
        }
      }
      state.promptQueue.unshift({
        id: `q-ans-${Date.now()}`,
        text: prompt,
        images: [],
        silent: true,
      });
      rec.mode = "answered";
      renderQuestionCard(shellFromQuestionEl(rec.el) || shell, rec);
      if (state.running || state.abortController) {
        await interruptCurrentTurn();
      } else {
        drainPromptQueue();
      }
    } catch (err) {
      rec.mode = "pending";
      rec.ask.answers = null;
      state.promptQueue = state.promptQueue.filter((q) => q.text !== prompt);
      renderQueue();
      renderQuestionCard(shellFromQuestionEl(rec.el) || shell, rec);
      appendShellWarning(shell, networkErrorMessage(err));
    }
  }

  function renderQuestionCard(shell, rec) {
    const el = rec && rec.el;
    if (!el) return;
    const ask = rec.ask || { questions: [], answers: [] };
    setQuestionCardMode(el, rec.mode);
    el._askRec = rec;
    el.setAttribute("role", "group");
    el.setAttribute("aria-label", "Question from Grok");

    if (rec.mode === "answered") {
      el.innerHTML = "";
      const sum = document.createElement("div");
      sum.className = "question-card-summary";
      const title = document.createElement("div");
      title.className = "question-card-summary-label";
      title.textContent = "You chose";
      sum.appendChild(title);
      const pairs = ask.answers && ask.answers.length
        ? ask.answers
        : (ask.questions || []).map((q) => ({ question: q.question, answer: "" }));
      for (const a of pairs) {
        const row = document.createElement("div");
        row.className = "question-card-summary-row";
        if (a.question) {
          const q = document.createElement("div");
          q.className = "question-card-summary-q";
          q.textContent = a.question;
          row.appendChild(q);
        }
        const ans = document.createElement("div");
        ans.className = "question-card-summary-a";
        const check = document.createElement("span");
        check.className = "question-card-check";
        check.setAttribute("aria-hidden", "true");
        check.textContent = "✓";
        const lab = document.createElement("span");
        lab.textContent = a.answer || "";
        ans.appendChild(check);
        ans.appendChild(lab);
        row.appendChild(ans);
        sum.appendChild(row);
      }
      el.appendChild(sum);
      return;
    }

    if (rec.mode === "expired") {
      el.innerHTML = "";
      for (const q of ask.questions || []) {
        const qel = document.createElement("div");
        qel.className = "question-card-q";
        qel.textContent = q.question || "";
        el.appendChild(qel);
      }
      const note = document.createElement("div");
      note.className = "question-card-expired-note";
      note.textContent = "Grok moved on. Send a message if you still want to choose.";
      el.appendChild(note);
      return;
    }

    const questions = ask.questions || [];
    if (!questions.length) {
      el.innerHTML = "";
      const wait = document.createElement("div");
      wait.className = "question-card-q";
      wait.textContent =
        rec.mode === "submitting" ? "Sending…" : "Grok is asking a question…";
      el.appendChild(wait);
      return;
    }

    const step = Math.min(rec.step || 0, questions.length - 1);
    rec.step = step;
    const q = questions[step];
    const disabled = rec.mode === "submitting";
    el.innerHTML = "";

    if (questions.length > 1) {
      const prog = document.createElement("div");
      prog.className = "question-card-progress";
      prog.textContent = `${step + 1} of ${questions.length}`;
      el.appendChild(prog);
    }

    const qel = document.createElement("div");
    qel.className = "question-card-q";
    qel.textContent = q.question;
    el.appendChild(qel);

    const opts = document.createElement("div");
    opts.className = "question-card-options" + (q.multiSelect ? " multi" : "");
    const pick =
      rec.picks[step] || (rec.picks[step] = { selected: new Set(), otherText: "", otherOpen: false });

    let optNum = 0;
    function decorateOptionButton(btn, opt, number) {
      const recommended = isRecommendedOptionLabel(opt.label);
      if (recommended) btn.classList.add("recommended");
      const main = document.createElement("span");
      main.className = "question-opt-main";
      if (number > 0 && number <= 9) {
        const n = document.createElement("span");
        n.className = "question-opt-num";
        n.textContent = String(number);
        main.appendChild(n);
      }
      const body = document.createElement("span");
      body.className = "question-opt-body";
      const lab = document.createElement("span");
      lab.className = "question-opt-label";
      lab.textContent = opt.label;
      body.appendChild(lab);
      if (opt.description) {
        const desc = document.createElement("span");
        desc.className = "question-opt-desc";
        desc.textContent = opt.description;
        body.appendChild(desc);
      }
      if (opt.preview) {
        const prev = document.createElement("span");
        prev.className = "question-opt-preview";
        prev.textContent = opt.preview;
        body.appendChild(prev);
      }
      main.appendChild(body);
      btn.appendChild(main);
    }

    q.options.forEach((opt, i) => {
      if (opt.isOther) return;
      optNum += 1;
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "question-opt" + (q.multiSelect && pick.selected.has(i) ? " selected" : "");
      btn.disabled = disabled;
      decorateOptionButton(btn, opt, optNum);
      btn.addEventListener("click", () => {
        if (q.multiSelect) {
          if (pick.selected.has(i)) pick.selected.delete(i);
          else pick.selected.add(i);
          renderQuestionCard(shell, rec);
        } else {
          pick.selected = new Set([i]);
          pick.otherText = "";
          advanceOrSubmitQuestion(shell, rec);
        }
      });
      opts.appendChild(btn);
    });
    el.appendChild(opts);

    const other = q.options.find((o) => o.isOther);
    if (other) {
      const otherWrap = document.createElement("div");
      otherWrap.className = "question-card-other";
      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = "question-opt other-toggle";
      toggle.disabled = disabled;
      optNum += 1;
      decorateOptionButton(toggle, other, optNum);
      const field = document.createElement("div");
      field.className =
        "question-other-field" + (pick.otherOpen || pick.otherText ? "" : " hidden");
      const input = document.createElement("input");
      input.type = "text";
      input.className = "question-other-input";
      input.placeholder = "Your answer";
      input.value = pick.otherText || "";
      input.disabled = disabled;
      input.maxLength = 800;
      const send = document.createElement("button");
      send.type = "button";
      send.className = "question-other-send";
      send.textContent =
        questions.length > 1 && step < questions.length - 1 ? "Next" : "Send";
      send.disabled = disabled;
      input.addEventListener("input", () => {
        pick.otherText = input.value;
      });
      input.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter") {
          ev.preventDefault();
          ev.stopPropagation();
          pick.otherText = input.value;
          commitQuestionOther(shell, rec);
        }
      });
      send.addEventListener("click", () => {
        pick.otherText = input.value;
        commitQuestionOther(shell, rec);
      });
      toggle.addEventListener("click", () => {
        pick.otherOpen = !pick.otherOpen;
        field.classList.toggle("hidden", !pick.otherOpen);
        if (pick.otherOpen) input.focus();
      });
      field.appendChild(input);
      field.appendChild(send);
      otherWrap.appendChild(toggle);
      otherWrap.appendChild(field);
      el.appendChild(otherWrap);
    }

    if (q.multiSelect) {
      const done = document.createElement("button");
      done.type = "button";
      done.className = "question-card-done";
      done.textContent =
        rec.mode === "submitting"
          ? "Sending…"
          : questions.length > 1 && step < questions.length - 1
            ? "Next"
            : "Done";
      done.disabled = disabled;
      done.addEventListener("click", () => advanceOrSubmitQuestion(shell, rec));
      el.appendChild(done);
    }

    if (rec.mode === "submitting") {
      const sending = document.createElement("div");
      sending.className = "question-card-sending";
      sending.textContent = "Sending…";
      el.appendChild(sending);
    } else if (rec.mode === "pending" && !isPhoneUi()) {
      const hint = document.createElement("div");
      hint.className = "question-card-hint";
      hint.textContent = "1–9 to choose";
      el.appendChild(hint);
    }

    if (rec.mode === "pending" && !rec.didFocus) {
      rec.didFocus = true;
      try {
        el.scrollIntoView({ block: "nearest", behavior: "smooth" });
      } catch {
        /* ignore */
      }
      if (promptLooksIdle()) {
        try {
          el.focus({ preventScroll: true });
        } catch {
          try {
            el.focus();
          } catch {
            /* ignore */
          }
        }
      }
    }

    scrollToBottom();
  }

  function showGeneratedMedia(shell, relPaths) {
    if (!shell || !shouldRenderShell(shell)) return;
    if (!shell.mediaEl) {
      const el = document.createElement("div");
      el.className = "generated-media";
      const body = shell.bodyEl;
      if (body && body.parentNode) body.parentNode.insertBefore(el, body);
      else if (shell.el) shell.el.appendChild(el);
      shell.mediaEl = el;
    }
    if (!shell.mediaShown) shell.mediaShown = new Set();
    let added = false;
    for (const raw of relPaths || []) {
      const rel = normalizeRelMedia(raw);
      if (!rel) continue;
      const key = rel.toLowerCase();
      if (shell.mediaShown.has(key)) continue;
      shell.mediaShown.add(key);
      if (/\.(mp4|webm)$/i.test(rel)) {
        const video = document.createElement("video");
        video.className = "generated-media-item";
        video.dataset.mediaRel = rel;
        video.src = sessionMediaUrl(rel);
        video.controls = true;
        video.setAttribute("playsinline", "");
        shell.mediaEl.appendChild(video);
      } else {
        const img = document.createElement("img");
        img.className = "generated-media-item";
        img.dataset.mediaRel = rel;
        img.src = sessionMediaUrl(rel);
        img.alt = rel;
        shell.mediaEl.appendChild(img);
      }
      added = true;
    }
    if (added) {
      shell.mediaEl.classList.remove("hidden");
      scrollToBottom();
    }
  }

  async function refreshSessionMedia(shell) {
    const sid = (shell && shell.sessionId) || state.activeSessionId || state.streamSessionId;
    if (!sid) return;
    try {
      const data = await api(`/api/sessions/${encodeURIComponent(sid)}/media`);
      const files = Array.isArray(data && data.files) ? data.files : [];
      if (!files.length) return;
      const seen = new Set();
      if (els.messages) {
        els.messages.querySelectorAll("[data-media-rel]").forEach((el) => {
          const rel = el.getAttribute("data-media-rel");
          if (rel) seen.add(rel.toLowerCase());
        });
      }
      const fresh = files.filter((rel) => !seen.has(String(rel).toLowerCase()));
      if (fresh.length) showGeneratedMedia(shell || state.liveShell, fresh);
    } catch {
      /* media may not exist yet */
    }
  }

  function scrollToBottom() {
    requestAnimationFrame(() => {
      els.messages.scrollTop = els.messages.scrollHeight;
    });
  }

  function setRunning(on, text) {
    const was = state.running;
    state.running = on;
    els.runningBar.classList.toggle("hidden", !on);
    if (text) els.runningText.textContent = text;
    if (els.prompt) {
      els.prompt.disabled = false;
      els.prompt.placeholder = on
        ? "Type a follow-up to queue…"
        : "Type a message or / for commands…";
    }
    if (els.btnAttach) els.btnAttach.disabled = false;
    updateSendEnabled();
    if (was !== on) renderSessionList();
  }

  function nextTurnGen() {
    state.turnGen += 1;
    return state.turnGen;
  }

  function isSessionLive(id) {
    if (!id) return false;
    if (state.running && state.streamSessionId === id) return true;
    return state.liveSessionIds.has(id);
  }

  /** Drop the SSE listener without cancelling Grok — the child keeps working. */
  function detachLiveTurn() {
    if (!state.running && !state.abortController) return false;
    const sid = state.streamSessionId;
    if (sid) state.liveSessionIds.add(sid);
    nextTurnGen();
    const ac = state.abortController;
    state.abortController = null;
    state.liveShell = null;
    state.attachingRunId = null;
    state.runId = null;
    state.streamSessionId = null;
    if (ac && !ac.signal.aborted) {
      try {
        ac.abort();
      } catch {
        /* ignore */
      }
    }
    setRunning(false);
    hideReconnectStatus();
    renderSessionList();
    void refreshSessions();
    return true;
  }

  async function refreshLiveRuns({ render = true } = {}) {
    try {
      const data = await api("/api/runs");
      if (!data || !Array.isArray(data.runs)) return;
      const next = new Set();
      for (const r of data.runs) {
        if (r && r.sessionId) next.add(r.sessionId);
      }
      if (state.running && state.streamSessionId) next.add(state.streamSessionId);
      const changed =
        next.size !== state.liveSessionIds.size ||
        [...next].some((id) => !state.liveSessionIds.has(id));
      state.liveSessionIds = next;
      if (changed && render) renderSessionList();
    } catch {
      /* keep last known live set */
    }
  }

  /** Chat is never gated on picking a folder. Unlock + focus the composer. */
  function unlockPrompt({ focus = true } = {}) {
    if (!els.prompt) return;
    if (els.prompt.disabled) els.prompt.disabled = false;
    if (els.btnAttach) els.btnAttach.disabled = false;
    updateSendEnabled();
    if (focus) {
      try {
        els.prompt.focus({ preventScroll: true });
      } catch {
        els.prompt.focus();
      }
    }
  }

  // ---------- Open session / new ----------
  function setActiveMeta(session) {
    if (!session) {
      els.chatTitle.textContent = state.sidechatMode ? "Side chat" : "New session";
      els.chatProject.textContent = "";
      els.sessionIdHint.textContent = "";
      return;
    }
    els.chatTitle.textContent = session.title || "Session";
    els.chatProject.textContent = session.project || "";
    els.sessionIdHint.textContent = session.id.slice(0, 8) + "…";
    if (session.cwd) setCwd(session.cwd);
    else if (!getCwd()) setCwd(guessDefaultCwd());
    if (session.model) {
      setModelValue(session.model);
    }
    if (session.effort) {
      setEffortValue(session.effort);
    }
  }

  async function openSession(id, opts = {}) {
    if (state.selectMode) {
      toggleSessionSelected(id);
      return;
    }
    const sameLive =
      !opts.forceReload &&
      state.running &&
      state.streamSessionId === id &&
      state.liveShell;
    if (!sameLive && (state.running || state.abortController)) {
      detachLiveTurn();
    }
    const switchingAway = state.activeSessionId && state.activeSessionId !== id;
    setActiveSessionId(id);
    state.draftMode = false;
    expandProjectForSession(id);
    clearAttachments();
    if (switchingAway) clearPromptQueue();
    closeSlashMenu();
    document.body.classList.remove("sidebar-open");
    renderSessionList();

    try {
      const data = await api(`/api/sessions/${encodeURIComponent(id)}`);
      setActiveMeta(data.session);
      clearMessages();
      if (!data.messages?.length) {
        showEmptyState();
      } else {
        for (const m of data.messages) {
          if (m.role === "user") {
            appendUserMessage(m.text);
          } else {
            const shell = appendAssistantShell();
            if (m.tools?.length) {
              for (const t of m.tools) {
                upsertTool(shell, t);
              }
            }
            if (m.media?.length) showGeneratedMedia(shell, m.media);
            if (m.text) {
              shell.text = m.text;
              flushAssistantMarkdown(shell);
            }
          }
        }
        scrollToBottom();
      }

      if (sameLive && state.liveShell) {
        const empty = els.messages.querySelector(".empty-state");
        if (empty) empty.remove();
        const fresh = reuseOrAppendAssistantShell();
        rebindShell(state.liveShell, fresh);
        showReconnectStatus("Live", "ok");
        unlockPrompt({ focus: false });
        return;
      }

      unlockPrompt({ focus: true });
      refreshUsage();
      if (!state.running) {
        // Don't block typing while we check for an in-flight run.
        void maybeAttachActiveRun(id);
      }
    } catch (err) {
      clearMessages();
      const div = document.createElement("div");
      div.className = "empty-state";
      div.innerHTML = `<h1>Couldn't load session</h1><p>${escapeHtml(networkErrorMessage(err))}</p>`;
      els.messages.appendChild(div);
      unlockPrompt({ focus: true });
    }
  }

  /**
   * Start a blank draft chat.
   * @param {{ cwd?: string }} [opts]
   */
  function startNewSession(opts = {}) {
    if (state.running || state.abortController) detachLiveTurn();
    if (state.selectMode) setSelectMode(false);
    state.activeSessionId = null;
    if (!opts.preserveLast) persistLastSession(null);
    state.draftMode = true;
    setActiveMeta(null);
    const cwd = (opts.cwd || rememberedCwd() || guessDefaultCwd() || "").trim();
    if (cwd) setCwd(cwd);
    clearAttachments();
    clearPromptQueue();
    closeSlashMenu();
    showEmptyState();
    renderSessionList();
    document.body.classList.remove("sidebar-open");
    unlockPrompt({ focus: true });
    refreshUsage();
  }

  /** Wipe this session's stored context; stay in the same chat. */
  async function clearCurrentSession() {
    closeSlashMenu();
    if (els.prompt) {
      els.prompt.value = "";
      autoResizePrompt();
    }
    clearAttachments();
    clearPromptQueue();

    const id = state.activeSessionId;
    if (!id) {
      startNewSession({ cwd: rememberedCwd() || undefined });
      return;
    }

    if (state.running || state.abortController) {
      try {
        await stopRun();
      } catch {
        /* still try to clear */
      }
    }

    try {
      const result = await api(`/api/sessions/${encodeURIComponent(id)}/clear`, {
        method: "POST",
      });
      state.draftMode = true;
      setActiveSessionId(id);
      if (result && result.session) {
        state.sessions = state.sessions.map((s) =>
          s.id === id ? { ...s, ...result.session, numMessages: 0 } : s
        );
        setActiveMeta(result.session);
      }
      showEmptyState();
      renderSessionList();
      document.body.classList.remove("sidebar-open");
      unlockPrompt({ focus: true });
      refreshUsage();
      showReconnectStatus(
        "Chat cleared. The next message starts this session with no prior context.",
        "ok"
      );
    } catch (err) {
      showReconnectStatus(networkErrorMessage(err), "warn");
    }
  }

  function guessDefaultCwd() {
    // Prefer last session cwd, else leave blank (server uses process.cwd)
    if (state.sessions[0]?.cwd) return state.sessions[0].cwd;
    return "";
  }

  /** New button: keep the current folder. Only ask on mobile when none is set. */
  function onNewSessionClick() {
    const cwd = rememberedCwd();
    if (isMobileViewport() && !cwd) {
      document.body.classList.remove("sidebar-open");
      openMobileFolderPicker();
      return;
    }
    startNewSession({ cwd: cwd || undefined });
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  function stripSidechatParams(u) {
    for (const key of ["parent", "cwd", "model", "effort", "btw"]) {
      u.searchParams.delete(key);
    }
    // Keep ?side=1 so a reload stays a side-chat window (no last-session steal).
    u.searchParams.set("side", "1");
    try {
      const clean =
        u.pathname + (u.searchParams.toString() ? `?${u.searchParams}` : "") + u.hash;
      window.history.replaceState({}, "", clean || "/");
    } catch {
      /* ignore */
    }
  }

  async function readSidechatInit() {
    let u;
    try {
      u = new URL(window.location.href);
    } catch {
      return null;
    }
    const sideParam = u.searchParams.get("side");
    if (!sideParam) return null;

    if (window.grokDesktop && typeof window.grokDesktop.getSidechatInit === "function") {
      try {
        const payload = await window.grokDesktop.getSidechatInit(sideParam);
        if (payload && typeof payload === "object") {
          stripSidechatParams(u);
          return payload;
        }
      } catch {
        /* fall through to query params */
      }
    }

    const payload = {
      parentSessionId: u.searchParams.get("parent") || null,
      cwd: u.searchParams.get("cwd") || "",
      model: u.searchParams.get("model") || "",
      effort: u.searchParams.get("effort") || "",
      prompt: u.searchParams.get("btw") || "",
      parentTitle: "",
    };
    stripSidechatParams(u);
    return payload;
  }

  function applySidechatChrome() {
    state.sidechatMode = true;
    document.body.classList.add("sidechat");
    if (els.sidechatBadge) els.sidechatBadge.classList.remove("hidden");
    if (els.chatTitle && (!els.chatTitle.textContent || els.chatTitle.textContent === "New session")) {
      els.chatTitle.textContent = "Side chat";
    }
    try {
      document.title = "Side chat — Grok Desktop";
    } catch {
      /* ignore */
    }
  }

  async function openSidechat({ prompt = "" } = {}) {
    const payload = {
      parentSessionId: state.activeSessionId || null,
      cwd: getCwd() || rememberedCwd() || "",
      model: getModelValue(),
      effort: getEffortValue(),
      prompt: prompt || "",
      parentTitle: (els.chatTitle && els.chatTitle.textContent) || "",
    };

    if (window.grokDesktop && typeof window.grokDesktop.openSidechat === "function") {
      try {
        const result = await window.grokDesktop.openSidechat(payload);
        if (result && result.ok) return true;
      } catch (err) {
        console.warn("openSidechat failed", err);
      }
    }

    try {
      const u = new URL(window.location.href);
      u.searchParams.set("side", "1");
      if (payload.parentSessionId) u.searchParams.set("parent", payload.parentSessionId);
      if (payload.cwd) u.searchParams.set("cwd", payload.cwd);
      if (payload.model) u.searchParams.set("model", payload.model);
      if (payload.effort) u.searchParams.set("effort", payload.effort);
      if (payload.prompt) u.searchParams.set("btw", payload.prompt);
      const opened = window.open(u.toString(), "_blank", "noopener,noreferrer");
      if (opened) return true;
    } catch {
      /* popup blocked */
    }

    if (els.sessionBanner && els.sessionBannerText) {
      els.sessionBannerText.textContent =
        "Couldn't open a new window for /btw — allow pop-ups, or use the desktop app.";
      els.sessionBanner.classList.remove("hidden", "ok");
      els.sessionBanner.classList.add("warn");
    }
    return false;
  }

  const SLASH_COMMANDS = [
    {
      id: "new",
      cmd: "/new",
      label: "New chat",
      hint: "Fresh draft in this folder",
      action: "new",
    },
    {
      id: "clear",
      cmd: "/clear",
      label: "Clear",
      hint: "Wipe this chat's context; stay in the same session",
      action: "clear",
    },
    {
      id: "btw",
      cmd: "/btw",
      label: "Side chat",
      hint: "Ask aside without interrupting",
      action: "btw",
    },
    {
      id: "imagine",
      cmd: "/imagine",
      label: "Imagine",
      hint: "Generate an image from a description",
      insert: "/imagine ",
    },
    {
      id: "export",
      cmd: "/export",
      label: "Export chat",
      hint: "Download this transcript as Markdown",
      action: "export",
    },
    {
      id: "help",
      cmd: "/help",
      label: "Help",
      hint: "Show these commands",
      action: "help",
    },
  ];

  function slashQueryFromPrompt() {
    if (!els.prompt) return null;
    const raw = els.prompt.value;
    if (!raw.startsWith("/")) return null;
    if (/\s/.test(raw)) return null;
    return raw.toLowerCase();
  }

  function matchingSlashCommands(query) {
    const q = String(query || "/").toLowerCase();
    return SLASH_COMMANDS.filter((item) => {
      const names = [item.cmd, ...(item.aliases || [])];
      return names.some((name) => name.startsWith(q));
    });
  }

  function slashMenuIsOpen() {
    return !!(els.slashMenu && !els.slashMenu.classList.contains("hidden"));
  }

  function closeSlashMenu() {
    if (!els.slashMenu) return;
    els.slashMenu.classList.add("hidden");
    els.slashMenu.setAttribute("aria-hidden", "true");
    els.slashMenu.replaceChildren();
    state.slashIndex = 0;
  }

  function renderSlashMenu() {
    if (!els.slashMenu) return;
    const query = slashQueryFromPrompt();
    if (query == null) {
      closeSlashMenu();
      return;
    }
    const matches = matchingSlashCommands(query);
    els.slashMenu.replaceChildren();
    if (!matches.length) {
      const empty = document.createElement("div");
      empty.className = "slash-menu-empty";
      empty.textContent = "No matching command";
      els.slashMenu.appendChild(empty);
      els.slashMenu.classList.remove("hidden");
      els.slashMenu.setAttribute("aria-hidden", "false");
      state.slashIndex = 0;
      return;
    }
    if (state.slashIndex >= matches.length) state.slashIndex = matches.length - 1;
    if (state.slashIndex < 0) state.slashIndex = 0;
    matches.forEach((item, i) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "slash-item" + (i === state.slashIndex ? " active" : "");
      btn.setAttribute("role", "option");
      btn.setAttribute("aria-selected", i === state.slashIndex ? "true" : "false");
      btn.dataset.id = item.id;
      btn.innerHTML =
        `<span class="slash-item-cmd"></span>` +
        `<span class="slash-item-body">` +
        `<span class="slash-item-label"></span>` +
        `<span class="slash-item-hint"></span>` +
        `</span>`;
      btn.querySelector(".slash-item-cmd").textContent = item.cmd;
      btn.querySelector(".slash-item-label").textContent = item.label;
      btn.querySelector(".slash-item-hint").textContent = item.hint;
      btn.addEventListener("mousedown", (e) => {
        e.preventDefault();
      });
      btn.addEventListener("click", () => {
        applySlashCommand(item);
      });
      els.slashMenu.appendChild(btn);
    });
    els.slashMenu.classList.remove("hidden");
    els.slashMenu.setAttribute("aria-hidden", "false");
    const active = els.slashMenu.querySelector(".slash-item.active");
    if (active && typeof active.scrollIntoView === "function") {
      active.scrollIntoView({ block: "nearest" });
    }
  }

  function moveSlashHighlight(delta) {
    if (!slashMenuIsOpen()) return;
    const items = els.slashMenu.querySelectorAll(".slash-item");
    if (!items.length) return;
    state.slashIndex = (state.slashIndex + delta + items.length) % items.length;
    items.forEach((el, i) => {
      const on = i === state.slashIndex;
      el.classList.toggle("active", on);
      el.setAttribute("aria-selected", on ? "true" : "false");
    });
    const active = items[state.slashIndex];
    if (active && typeof active.scrollIntoView === "function") {
      active.scrollIntoView({ block: "nearest" });
    }
  }

  function highlightedSlashCommand() {
    const query = slashQueryFromPrompt();
    if (query == null) return null;
    const matches = matchingSlashCommands(query);
    if (!matches.length) return null;
    return matches[Math.max(0, Math.min(state.slashIndex, matches.length - 1))] || null;
  }

  function applySlashSelection() {
    const item = highlightedSlashCommand();
    if (!item) return false;
    applySlashCommand(item);
    return true;
  }

  function applySlashCommand(item) {
    if (!item) return;
    closeSlashMenu();
    if (item.insert) {
      els.prompt.value = item.insert;
      autoResizePrompt();
      try {
        els.prompt.focus();
        const n = els.prompt.value.length;
        els.prompt.setSelectionRange(n, n);
      } catch {
        /* ignore */
      }
      return;
    }
    if (item.action === "new") {
      els.prompt.value = "";
      autoResizePrompt();
      clearAttachments();
      startNewSession({ cwd: rememberedCwd() || undefined });
      return;
    }
    if (item.action === "clear") {
      els.prompt.value = "";
      autoResizePrompt();
      void clearCurrentSession();
      return;
    }
    if (item.action === "btw") {
      els.prompt.value = "";
      autoResizePrompt();
      clearAttachments();
      void openSidechat({ prompt: "" });
      return;
    }
    if (item.action === "export") {
      els.prompt.value = "";
      autoResizePrompt();
      void exportCurrentChat();
      return;
    }
    if (item.action === "help") {
      els.prompt.value = "/";
      state.slashIndex = 0;
      autoResizePrompt();
      renderSlashMenu();
      try {
        els.prompt.focus();
        els.prompt.setSelectionRange(1, 1);
      } catch {
        /* ignore */
      }
    }
  }

  function exportFilename(title) {
    const safe = String(title || "chat")
      .replace(/[<>:"/\\|?*\u0000-\u001f]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 60);
    return `${safe || "chat"}.md`;
  }

  async function exportCurrentChat() {
    const id = state.activeSessionId;
    if (!id) {
      showReconnectStatus("Nothing to export — open a chat first.", "warn");
      return;
    }
    try {
      const data = await api(`/api/sessions/${encodeURIComponent(id)}`);
      const title = (data.session && data.session.title) || "Chat";
      const cwd = data.session && data.session.cwd;
      const lines = [`# ${title}`];
      if (cwd) lines.push(`Folder: \`${cwd}\``);
      lines.push("");
      const msgs = Array.isArray(data.messages) ? data.messages : [];
      if (!msgs.length) {
        showReconnectStatus("This chat is empty — nothing to export.", "warn");
        return;
      }
      for (const m of msgs) {
        const role = m.role === "user" ? "You" : "Grok";
        lines.push(`## ${role}`, "", String(m.text || "").trim() || "_(empty)_", "");
        const tools = Array.isArray(m.tools) ? m.tools : [];
        for (const t of tools) {
          if (!t || !t.questions || !t.questions.length) continue;
          lines.push("**Question**", "");
          for (const q of t.questions) {
            lines.push(`- ${q.question}`);
          }
          if (t.answers && t.answers.length) {
            lines.push("", "**You chose**", "");
            for (const a of t.answers) {
              lines.push(`- ${a.question}: ${a.answer}`);
            }
          }
          lines.push("");
        }
      }
      const blob = new Blob([lines.join("\n")], { type: "text/markdown;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = exportFilename(title);
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
      showReconnectStatus("Saved transcript as Markdown.", "ok");
    } catch (err) {
      showReconnectStatus(networkErrorMessage(err), "warn");
    }
  }

  /**
   * Local slash commands (TUI-style).
   * Returns true if fully handled, { rewrite } to send different text, or false.
   */
  function handleSlashCommand(text) {
    const raw = text.trim();
    if (!raw.startsWith("/")) return false;
    const cmd = raw.split(/\s+/)[0].toLowerCase();
    if (cmd === "/new") {
      els.prompt.value = "";
      autoResizePrompt();
      clearAttachments();
      closeSlashMenu();
      startNewSession({ cwd: rememberedCwd() || undefined });
      return true;
    }
    if (cmd === "/clear") {
      els.prompt.value = "";
      autoResizePrompt();
      closeSlashMenu();
      void clearCurrentSession();
      return true;
    }
    if (cmd === "/btw") {
      const rest = raw.slice(cmd.length).trim();
      els.prompt.value = "";
      autoResizePrompt();
      clearAttachments();
      closeSlashMenu();
      void openSidechat({ prompt: rest });
      return true;
    }
    if (cmd === "/help") {
      els.prompt.value = "/";
      state.slashIndex = 0;
      autoResizePrompt();
      renderSlashMenu();
      return true;
    }
    if (cmd === "/export") {
      els.prompt.value = "";
      autoResizePrompt();
      closeSlashMenu();
      void exportCurrentChat();
      return true;
    }
    if (cmd === "/imagine") {
      const rest = raw.slice(cmd.length).trim();
      if (!rest) {
        els.prompt.value = "/imagine ";
        autoResizePrompt();
        closeSlashMenu();
        return true;
      }
      closeSlashMenu();
      return { rewrite: `Generate one image of: ${rest}` };
    }
    return false;
  }

  async function interruptCurrentTurn() {
    if (!state.running && !state.abortController) return;
    const pending = state.turnDone;
    const shell = state.liveShell;
    await stopRun();
    if (pending) {
      try {
        await pending;
      } catch {
        /* ignore */
      }
    }
    if (shell && !shell.cancelledNote) {
      appendShellWarning(shell, "Turn cancelled.");
      shell.cancelledNote = true;
    }
  }

  // ---------- Send prompt (SSE) ----------
  async function sendPrompt(opts = {}) {
    const queued = opts.queued || null;
    const sendNow = !!opts.sendNow;
    let text = queued ? String(queued.text || "").trim() : els.prompt.value.trim();
    const pendingImages = queued
      ? (queued.images || []).slice()
      : state.attachments.slice();
    if (state.sendInFlight && !state.running) return;
    if (!state.setupReady) {
      setStatus(false, "Sign in required");
      showSetupGate();
      if (state.setup) renderSetupGate(state.setup);
      else checkSetupAndBoot({ force: true });
      return;
    }
    if (!queued && state.voice.phase === "recording") {
      await stopVoice({ transcribe: true });
      text = els.prompt.value.trim();
    }
    if (!text && !pendingImages.length) return;

    if (!queued && text) {
      const slash = handleSlashCommand(text);
      if (slash === true) return;
      if (slash && slash.rewrite) text = slash.rewrite;
    }

    // CLI: plain Enter mid-turn queues; Ctrl+Enter is cancel-and-send.
    if (!queued && (state.running || state.abortController) && !sendNow) {
      enqueueFollowUp({ text, images: pendingImages });
      els.prompt.value = "";
      clearAttachments();
      autoResizePrompt();
      return;
    }

    if (!queued && sendNow && (state.running || state.abortController)) {
      await interruptCurrentTurn();
    }
    if (state.sendInFlight) return;

    const model = getModelValue();
    const effort = getEffortValue();
    const cwd = getCwd() || undefined;
    const active = getActiveSession();
    // Folder changed after opening a session → never resume that session
    const cwdMismatch = !!(active && cwd && active.cwd && !cwdsEqual(cwd, active.cwd));
    if (cwdMismatch) {
      setActiveSessionId(null);
      state.draftMode = true;
    }
    const forkFrom = state.pendingForkFrom || null;
    if (forkFrom) state.pendingForkFrom = null;
    const isNew = state.draftMode || !state.activeSessionId || cwdMismatch || !!forkFrom;
    const reuseSessionId =
      state.activeSessionId && !cwdMismatch && !forkFrom ? state.activeSessionId : null;

    state.sendInFlight = true;
    const silent = !!(opts.silent || (queued && queued.silent));
    if (!silent) {
      appendUserMessage(
        text,
        pendingImages.map((a) => a.dataUrl)
      );
    } else {
      const empty = els.messages.querySelector(".empty-state");
      if (empty) empty.remove();
    }
    els.prompt.value = "";
    clearAttachments();
    autoResizePrompt();
    closeSlashMenu();
    els.btnSend.disabled = true;

    const shell = appendAssistantShell();
    const turnGen = nextTurnGen();
    setRunning(true, pendingImages.length ? "Uploading image…" : "Thinking…");

    const clientTurnId = newClientTurnId();
    const body = {
      prompt: text,
      model,
      effort,
      newSession: isNew,
      clientTurnId,
    };
    if (reuseSessionId) body.sessionId = reuseSessionId;
    if (forkFrom) body.forkFrom = forkFrom;
    if (cwd) body.cwd = cwd;
    if (!isPhoneUi()) body.permissionMode = getPermissionMode();
    if (pendingImages.length) {
      body.images = pendingImages.map((a) => ({
        data: a.dataUrl,
        mimeType: a.mimeType,
        name: a.name,
      }));
    }

    const headers = { "Content-Type": "application/json" };

    const ac = new AbortController();
    state.abortController = ac;
    state.liveShell = shell;
    state.streamSessionId = state.activeSessionId;
    shell.sessionId = state.activeSessionId;

    let gotSessionId = state.activeSessionId;
    let gotGrokEvent = false;
    const sendStarted = Date.now();
    const onSession = (sid) => {
      gotSessionId = sid;
      applyStreamSession(sid, shell);
    };
    const onGrokActivity = () => {
      gotGrokEvent = true;
    };
    // Heartbeat so long image turns never look frozen on one status line
    const heartbeat = setInterval(() => {
      if (!state.running || gotGrokEvent || state.attachingRunId) return;
      const secs = Math.round((Date.now() - sendStarted) / 1000);
      els.runningText.textContent = `Waiting for Grok… ${secs}s`;
    }, 3000);

    let sawDone = false;
    let aborted = false;
    let deferred = false;
    let streamStarted = false;
    let resolveTurn = null;
    state.turnDone = new Promise((resolve) => {
      resolveTurn = resolve;
    });

    const applyReconnectResult = async (rec, fallbackMessage) => {
      if (!rec) return;
      sawDone = !!rec.ok;
      aborted = !!rec.aborted;
      if (rec.deferred) {
        deferred = true;
        return;
      }
      if (rec.finished) {
        const sid = rec.sessionId || gotSessionId;
        if (sid) {
          nextTurnGen();
          await openSession(sid, { forceReload: true });
          sawDone = true;
          return;
        }
      }
      if (!sawDone && !aborted) {
        if (gotSessionId || clientTurnId) {
          deferred = true;
          return;
        }
        appendShellWarning(shell, fallbackMessage || "Connection lost.");
      }
    };

    try {
      const res = await fetch(apiUrl("/api/chat"), {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: ac.signal,
      });

      if (!res.ok) {
        let msg = res.statusText;
        try {
          msg = (await res.json()).error || msg;
        } catch {
          /* ignore */
        }
        throw new Error(msg);
      }

      streamStarted = true;
      if (cwd && !isPhoneUi()) markFolderSeen(cwd);
      sawDone = await readSseStream(res, shell, onSession, onGrokActivity);

      if (!sawDone && !ac.signal.aborted && (state.runId || gotSessionId || clientTurnId)) {
        await applyReconnectResult(
          await tryReconnectRun({
            runId: state.runId,
            sessionId: gotSessionId,
            clientTurnId,
            shell,
            onSession,
            onGrokActivity,
          }),
          "Connection lost — could not reconnect to the live turn."
        );
      } else if (ac.signal.aborted) {
        aborted = true;
      }
    } catch (err) {
      if (err.name === "AbortError" || ac.signal.aborted) {
        aborted = true;
      } else if (streamStarted || state.runId || gotSessionId || clientTurnId) {
        await applyReconnectResult(
          await tryReconnectRun({
            runId: state.runId,
            sessionId: gotSessionId,
            clientTurnId,
            shell,
            onSession,
            onGrokActivity,
          }),
          networkErrorMessage(err)
        );
      } else {
        appendShellWarning(shell, networkErrorMessage(err));
      }
    } finally {
      clearInterval(heartbeat);
      state.sendInFlight = false;
      if (aborted) {
        clearPendingReattach();
        if (turnGen === state.turnGen) await finishTurn(gotSessionId);
      } else if (deferred && !sawDone) {
        armPendingReattach({
          sessionId: gotSessionId,
          clientTurnId,
          startedAt: sendStarted,
          turnGen,
        });
      } else if (turnGen === state.turnGen) {
        if (sawDone) clearPendingReattach();
        await finishTurn(gotSessionId);
      } else if (gotSessionId) {
        state.liveSessionIds.add(gotSessionId);
        void refreshLiveRuns();
      }
      if (resolveTurn) resolveTurn();
    }
  }

  function appendShellWarning(shell, message) {
    if (!shell) return;
    const note = `⚠️ ${message}`;
    if (shell.text) shell.text += "\n\n" + note;
    else shell.text = note;
    flushAssistantMarkdown(shell);
  }

  function formatDoneWarning(data) {
    if (!data || data.ok) return "";
    if (data.stderr) {
      return `⚠️ Grok exited with code ${data.code}\n\n${String(data.stderr).slice(-1500)}`;
    }
    if (data.poisonedHint) {
      return (
        `⚠️ Grok exited unexpectedly (code ${data.code ?? "?"}). ` +
        `This session may be stuck after a crash — start a New chat and continue there.`
      );
    }
    if (data.code != null && data.code !== 0) {
      return `⚠️ Grok exited with code ${data.code}`;
    }
    return "⚠️ Turn ended with an error.";
  }

  function ensureAbortController() {
    if (!state.abortController || state.abortController.signal.aborted) {
      state.abortController = new AbortController();
    }
    return state.abortController;
  }

  function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(Object.assign(new Error("Aborted"), { name: "AbortError" }));
        return;
      }
      const t = setTimeout(resolve, ms);
      if (!signal) return;
      const onAbort = () => {
        clearTimeout(t);
        reject(Object.assign(new Error("Aborted"), { name: "AbortError" }));
      };
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  function ensureReconnectBanner() {
    if (els.reconnectBanner) return els.reconnectBanner;
    if (els.sessionBanner || !els.messages || !els.messages.parentNode) return null;
    const el = document.createElement("div");
    el.id = "reconnect-banner";
    el.setAttribute("role", "status");
    el.style.cssText =
      "display:none;padding:6px 16px;font-size:12px;line-height:1.35;opacity:0.88;";
    els.messages.parentNode.insertBefore(el, els.messages);
    els.reconnectBanner = el;
    return el;
  }

  function showReconnectStatus(text, kind) {
    const msg = text || "";
    if (els.runningText && msg) els.runningText.textContent = msg;

    const rb = els.reconnectBanner || ensureReconnectBanner();
    if (rb) {
      rb.textContent = msg;
      rb.hidden = !msg;
      rb.classList.toggle("hidden", !msg);
      rb.style.display = msg ? "" : "none";
    }

    if (els.sessionBanner && els.sessionBannerText) {
      els.sessionBannerText.textContent = msg;
      els.sessionBanner.classList.remove("info", "warn", "ok");
      if (msg) els.sessionBanner.classList.add(kind || "info");
      els.sessionBanner.classList.toggle("hidden", !msg);
    }
  }

  function hideReconnectStatus() {
    if (els.reconnectBanner) {
      els.reconnectBanner.textContent = "";
      els.reconnectBanner.hidden = true;
      els.reconnectBanner.classList.add("hidden");
      els.reconnectBanner.style.display = "none";
    }
    if (els.sessionBanner) {
      els.sessionBanner.classList.add("hidden");
      els.sessionBanner.classList.remove("info", "warn", "ok");
      if (els.sessionBannerText) els.sessionBannerText.textContent = "";
    }
  }

  function reuseOrAppendAssistantShell() {
    const nodes = els.messages.querySelectorAll(".msg.assistant");
    const last = nodes[nodes.length - 1];
    if (last) {
      const bodyEl = last.querySelector(".body");
      const hasText = !!(bodyEl && bodyEl.textContent && bodyEl.textContent.trim());
      if (!hasText) {
        const shell = {
          el: last,
          toolsEl: last.querySelector(".tools"),
          mediaEl: last.querySelector(".generated-media"),
          mediaShown: collectMediaShown(last),
          bodyEl,
          text: "",
          thought: "",
          toolMap: new Map(),
          questionsEl: last.querySelector(".question-cards"),
          questionMap: new Map(),
          toolUsed: !!(last.querySelector(".tool-used-flag") || last.querySelector(".tool-chip")),
          sessionId: state.activeSessionId,
        };
        last.querySelectorAll(".question-card").forEach((el) => {
          if (el._askRec && el.dataset.askId) {
            shell.questionMap.set(el.dataset.askId, el._askRec);
          }
        });
        ensureThoughtUi(shell);
        if (shell.toolUsed) markToolUsed(shell);
        return shell;
      }
    }
    const empty = els.messages.querySelector(".empty-state");
    if (empty) empty.remove();
    return appendAssistantShell();
  }

  function rebindShell(shell, fresh) {
    if (!shell || !fresh) return;
    shell.el = fresh.el;
    shell.toolsEl = fresh.toolsEl;
    const shown = shell.mediaShown ? [...shell.mediaShown] : [];
    shell.mediaEl = fresh.mediaEl || shell.mediaEl;
    shell.mediaShown = collectMediaShown(fresh.mediaEl || fresh.el);
    if (shown.length) showGeneratedMedia(shell, shown);
    shell.bodyEl = fresh.bodyEl;
    shell.thoughtWrap = fresh.thoughtWrap;
    shell.thoughtToggle = fresh.thoughtToggle;
    shell.thoughtBody = fresh.thoughtBody;
    shell.thoughtPreview = fresh.thoughtPreview;
    if (shell.thought) appendThought(shell, "");
    if (shell.text) flushAssistantMarkdown(shell);
    if (shell.toolMap && shell.toolsEl) {
      for (const chip of shell.toolMap.values()) {
        if (chip && !shell.toolsEl.contains(chip)) shell.toolsEl.appendChild(chip);
      }
    }
    shell.questionsEl = fresh.questionsEl || shell.questionsEl;
    if (shell.questionMap && shell.questionsEl) {
      for (const rec of shell.questionMap.values()) {
        if (rec && rec.el && !shell.questionsEl.contains(rec.el)) {
          shell.questionsEl.appendChild(rec.el);
        }
      }
    }
    if (shell.toolUsed) markToolUsed(shell);
  }

  function newClientTurnId() {
    try {
      if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
        return crypto.randomUUID();
      }
    } catch {
      /* ignore */
    }
    return `ct-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }

  function isPageHidden() {
    return typeof document.hidden === "boolean" ? document.hidden : false;
  }

  function networkErrorMessage(err) {
    const raw = String((err && err.message) || err || "").trim();
    const key = raw.toLowerCase();
    if (
      !raw ||
      key === "load failed" ||
      key === "failed to fetch" ||
      key.includes("network connection was lost") ||
      key.includes("the internet connection appears to be offline") ||
      key.includes("networkerror")
    ) {
      return "Connection lost. The turn is still running on the PC — come back to this chat to resume.";
    }
    return raw;
  }

  function normalizeRun(data) {
    if (!data || data.run === null) return null;
    if (data.run && data.run.runId) {
      return {
        runId: data.run.runId,
        sessionId: data.run.sessionId || data.sessionId || null,
        startedAt: data.run.startedAt || data.startedAt || 0,
        done: !!(data.run.done || data.done),
        clientTurnId: data.run.clientTurnId || data.clientTurnId || null,
        pendingQuestions: Array.isArray(data.run.pendingQuestions)
          ? data.run.pendingQuestions
          : [],
        awaitingAnswers: data.run.awaitingAnswers || null,
      };
    }
    if (data.runId) {
      return {
        runId: data.runId,
        sessionId: data.sessionId || null,
        startedAt: data.startedAt || 0,
        done: !!data.done,
        clientTurnId: data.clientTurnId || null,
        pendingQuestions: Array.isArray(data.pendingQuestions)
          ? data.pendingQuestions
          : [],
        awaitingAnswers: data.awaitingAnswers || null,
      };
    }
    return null;
  }

  let pendingRecoverTimer = null;
  let recoverWakeTimer = null;

  function stopPendingRecoverTimer() {
    if (pendingRecoverTimer) {
      clearInterval(pendingRecoverTimer);
      pendingRecoverTimer = null;
    }
  }

  function clearPendingReattach() {
    state.pendingReattach = null;
    stopPendingRecoverTimer();
  }

  function armPendingReattach({ sessionId, clientTurnId, startedAt, turnGen }) {
    state.pendingReattach = {
      sessionId: sessionId || null,
      clientTurnId: clientTurnId || null,
      startedAt: startedAt || Date.now(),
      turnGen: turnGen || state.turnGen,
      attempts: 0,
    };
    if (sessionId) state.liveSessionIds.add(sessionId);
    const msg = isPageHidden()
      ? "Connection paused — will resume when you come back…"
      : "Connection lost — retrying…";
    setRunning(true, msg);
    showReconnectStatus(msg, "info");
    if (!pendingRecoverTimer) {
      pendingRecoverTimer = setInterval(() => {
        if (state.pendingReattach && !isPageHidden()) void recoverPendingTurn();
      }, 5000);
    }
  }

  function scheduleRecoverOnForeground() {
    if (isPageHidden()) return;
    if (recoverWakeTimer) clearTimeout(recoverWakeTimer);
    recoverWakeTimer = setTimeout(() => {
      recoverWakeTimer = null;
      void recoverPendingTurn();
    }, 200);
  }

  function bindForegroundResume() {
    if (bindForegroundResume.bound) return;
    bindForegroundResume.bound = true;
    const onWake = () => {
      scheduleRecoverOnForeground();
      if (state.setupReady) void checkForAppUpdate();
    };
    document.addEventListener("visibilitychange", onWake);
    window.addEventListener("pageshow", onWake);
    window.addEventListener("online", onWake);
    window.addEventListener("focus", onWake);
    document.addEventListener("resume", onWake);
  }

  async function lookupRun({ sessionId, clientTurnId, includeDone = false } = {}) {
    try {
      if (clientTurnId) {
        const byTurn = normalizeRun(
          await api(`/api/runs?clientTurnId=${encodeURIComponent(clientTurnId)}`)
        );
        if (byTurn) return byTurn;
      }
      if (sessionId) {
        const q = new URLSearchParams({ sessionId });
        if (includeDone) q.set("includeDone", "1");
        return normalizeRun(await api(`/api/runs?${q}`));
      }
    } catch {
      /* ignore */
    }
    return null;
  }

  async function fetchActiveRun(sessionId, opts = {}) {
    if (!sessionId && !opts.clientTurnId) return null;
    return lookupRun({
      sessionId,
      clientTurnId: opts.clientTurnId,
      includeDone: !!opts.includeDone,
    });
  }

  async function recoverPendingTurn() {
    if (isPageHidden() || state.recoverInFlight || !state.setupReady) return;
    if (state.attachingRunId) return;
    const pending = state.pendingReattach;
    if (
      !pending &&
      state.running &&
      state.liveShell &&
      state.abortController &&
      !state.abortController.signal.aborted
    ) {
      return;
    }
    if (!pending && !state.activeSessionId) return;

    state.recoverInFlight = true;
    try {
      const sid = pending?.sessionId || state.activeSessionId;
      const run = await lookupRun({
        sessionId: sid,
        clientTurnId: pending?.clientTurnId,
        includeDone: true,
      });

      if (run?.runId && !run.done) {
        const sessionId = run.sessionId || sid;
        if (sessionId && state.activeSessionId && sessionId !== state.activeSessionId) {
          state.liveSessionIds.add(sessionId);
          return;
        }
        if (state.attachingRunId === run.runId) return;
        const shell = state.liveShell || reuseOrAppendAssistantShell();
        if (!state.liveShell) state.liveShell = shell;
        const turnGen = nextTurnGen();
        if (pending) {
          state.pendingReattach = { ...pending, sessionId, turnGen };
        }
        setRunning(true, "Reconnecting…");
        showReconnectStatus("Reconnecting…", "info");
        applyPendingQuestions(shell, run);
        const onSession = (id) => applyStreamSession(id, shell);
        try {
          const first = await attachToRun(run.runId, { shell, sessionId, onSession });
          let sawDone = first.sawDone;
          let aborted = first.aborted;
          if (!sawDone && !aborted) {
            const rec = await tryReconnectRun({
              runId: run.runId,
              sessionId,
              clientTurnId: pending?.clientTurnId || run.clientTurnId,
              shell,
              onSession,
            });
            sawDone = rec.ok;
            aborted = rec.aborted;
            if (rec.deferred) return;
            if (rec.finished) {
              clearPendingReattach();
              if (turnGen === state.turnGen) {
                await openSession(rec.sessionId || sessionId, { forceReload: true });
              }
              return;
            }
          }
          if (aborted) {
            // Stop already cleared pending; session switch should keep it.
            return;
          }
          if (sawDone || turnGen === state.turnGen) {
            clearPendingReattach();
            if (turnGen === state.turnGen) await finishTurn(sessionId);
          }
        } catch (err) {
          if (err.name === "AbortError") return;
          if (isPageHidden()) return;
          appendShellWarning(shell, networkErrorMessage(err));
        }
        return;
      }

      if (!pending) return;

      pending.attempts = (pending.attempts || 0) + 1;
      const age = Date.now() - (pending.startedAt || 0);
      const sessionToLoad = (run && run.sessionId) || sid;

      if (!sessionToLoad) {
        if (age < 60000) return;
        clearPendingReattach();
        await finishTurn(null);
        return;
      }

      if (age < 15000 && !run?.done) return;

      await refreshSessions();
      const sess = state.sessions.find((s) => s.id === sessionToLoad);
      const updated = sess?.updatedAt ? Date.parse(sess.updatedAt) : 0;
      const serverWorked = !!run?.done || updated >= (pending.startedAt || 0) - 2000;

      if (!serverWorked && age < 15000) return;

      clearPendingReattach();
      if (state.running || state.abortController) {
        nextTurnGen();
        state.abortController = null;
        state.liveShell = null;
        state.attachingRunId = null;
        state.runId = null;
        setRunning(false);
        hideReconnectStatus();
      }

      if (serverWorked) {
        await openSession(sessionToLoad, { forceReload: true });
        return;
      }

      const shell = state.liveShell;
      if (shell) {
        appendShellWarning(
          shell,
          "Connection lost. If Grok never started, send the message again."
        );
      }
      await finishTurn(sessionToLoad);
    } finally {
      state.recoverInFlight = false;
    }
  }

  async function readSseStream(res, shell, onSession, onGrokActivity) {
    if (!res || !res.body) return false;
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let sawDone = false;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let sep;
        while ((sep = buffer.indexOf("\n\n")) >= 0) {
          const raw = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          const ev = handleSseBlock(raw, shell, onSession, onGrokActivity);
          if (ev === "done") sawDone = true;
        }
      }
      if (buffer.trim()) {
        const ev = handleSseBlock(buffer, shell, onSession, onGrokActivity);
        if (ev === "done") sawDone = true;
      }
    } finally {
      flushAssistantMarkdown(shell);
    }
    return sawDone;
  }

  async function attachToRun(runId, opts = {}) {
    const runKey = String(runId || "");
    if (!runKey) return { attached: false, sawDone: false };
    if (state.abortController?.signal?.aborted) {
      return { attached: false, sawDone: false, aborted: true };
    }
    if (state.attachingRunId === runKey) {
      return { attached: false, sawDone: false };
    }

    const sessionId = opts.sessionId || state.activeSessionId;
    let shell = opts.shell;
    const viewingThis =
      !sessionId || !state.activeSessionId || sessionId === state.activeSessionId;

    if (!shell || (shell.el && !shell.el.isConnected)) {
      if (viewingThis) {
        const empty = els.messages.querySelector(".empty-state");
        if (empty) empty.remove();
        shell = reuseOrAppendAssistantShell();
        shell.sessionId = sessionId;
      } else if (!shell) {
        shell = {
          el: null,
          toolsEl: null,
          bodyEl: null,
          text: "",
          toolMap: new Map(),
          sessionId,
        };
      }
    }

    state.attachingRunId = runKey;
    state.runId = runKey;
    state.liveShell = shell;
    state.streamSessionId = sessionId || null;
    setRunning(true, "Reconnecting…");
    showReconnectStatus("Reconnecting…", "info");

    const ac = ensureAbortController();

    try {
      const res = await fetch(apiUrl(`/api/chat/runs/${encodeURIComponent(runKey)}`), {
        signal: ac.signal,
      });
      if (!res.ok || !res.body) {
        return { attached: false, sawDone: false };
      }
      showReconnectStatus("Live — reattached", "ok");
      setRunning(true, "Live — reattached");
      const sawDone = await readSseStream(
        res,
        shell,
        opts.onSession,
        opts.onGrokActivity
      );
      return { attached: true, sawDone };
    } catch (err) {
      if (err.name === "AbortError" || ac.signal.aborted) {
        return { attached: true, sawDone: false, aborted: true };
      }
      throw err;
    } finally {
      if (state.attachingRunId === runKey) state.attachingRunId = null;
    }
  }

  async function tryReconnectRun({
    runId,
    sessionId,
    clientTurnId,
    shell,
    onSession,
    onGrokActivity,
  }) {
    if (isPageHidden()) return { ok: false, deferred: true };
    const delays = [800, 1600, 2800];
    for (let i = 0; i < delays.length; i++) {
      if (state.abortController?.signal?.aborted) {
        return { ok: false, aborted: true };
      }
      if (isPageHidden()) return { ok: false, deferred: true };
      showReconnectStatus(`Reconnecting… (${i + 1}/3)`, "info");
      setRunning(true, `Reconnecting… (${i + 1}/3)`);
      try {
        await sleep(delays[i], state.abortController?.signal);
      } catch (err) {
        if (err.name === "AbortError") return { ok: false, aborted: true };
      }
      if (isPageHidden()) return { ok: false, deferred: true };

      const found = await lookupRun({
        sessionId,
        clientTurnId,
        includeDone: true,
      });
      if (found?.done) {
        return { ok: false, finished: true, sessionId: found.sessionId || sessionId };
      }
      let id = found?.runId || runId;
      if (!id) continue;

      try {
        const result = await attachToRun(id, {
          shell,
          sessionId: found?.sessionId || sessionId,
          onSession,
          onGrokActivity,
        });
        if (result.aborted) return { ok: false, aborted: true };
        if (result.sawDone) return { ok: true };
        if (result.attached) runId = id;
      } catch (err) {
        if (err.name === "AbortError") return { ok: false, aborted: true };
        if (isPageHidden()) return { ok: false, deferred: true };
      }
    }
    if (isPageHidden()) return { ok: false, deferred: true };
    if (sessionId || clientTurnId) return { ok: false, deferred: true };
    return { ok: false, aborted: false };
  }

  async function maybeAttachActiveRun(sessionId) {
    if (!sessionId || state.attachingRunId) return;
    if (state.running && !state.pendingReattach) return;
    const active = await fetchActiveRun(sessionId);
    if (!active?.runId) return;
    if (state.running || state.activeSessionId !== sessionId) return;

    const empty = els.messages.querySelector(".empty-state");
    if (empty) empty.remove();
    const shell = reuseOrAppendAssistantShell();
    shell.sessionId = sessionId;
    state.liveShell = shell;
    state.streamSessionId = sessionId;
    state.runId = active.runId;

    const turnGen = nextTurnGen();
    const onSession = (sid) => applyStreamSession(sid, shell);

    setRunning(true, active.awaitingAnswers ? "Waiting for your choice…" : "Reconnecting…");
    showReconnectStatus(
      active.awaitingAnswers ? "Waiting for your choice…" : "Reconnecting…",
      "info"
    );
    if (active.awaitingAnswers) state.awaitingAnswers = true;
    applyPendingQuestions(shell, active);

    let deferred = false;
    try {
      const first = await attachToRun(active.runId, {
        shell,
        sessionId,
        onSession,
      });
      if (first.sawDone) clearPendingReattach();
      if (!first.sawDone && !first.aborted) {
        const rec = await tryReconnectRun({
          runId: active.runId,
          sessionId,
          clientTurnId: state.pendingReattach?.clientTurnId,
          shell,
          onSession,
        });
        if (rec.ok || rec.finished) clearPendingReattach();
        if (rec.deferred) deferred = true;
      }
    } catch (err) {
      if (err.name !== "AbortError") {
        appendShellWarning(shell, networkErrorMessage(err));
      }
    } finally {
      if (deferred) {
        if (sessionId) state.liveSessionIds.add(sessionId);
      } else if (turnGen === state.turnGen) {
        await finishTurn(sessionId);
      } else if (sessionId) {
        state.liveSessionIds.add(sessionId);
        void refreshLiveRuns();
      }
    }
  }

  function applyStreamSession(sid, shell) {
    if (!sid) return;
    if (shell && state.liveShell && state.liveShell !== shell) return;
    if (shell && !state.liveShell && !state.running) {
      state.liveSessionIds.add(sid);
      return;
    }
    state.streamSessionId = sid;
    if (shell) shell.sessionId = sid;
    state.liveSessionIds.add(sid);
    const viewingStream =
      (!shell || state.liveShell === shell) &&
      (state.draftMode || !state.activeSessionId || state.activeSessionId === sid);
    if (!viewingStream) return;
    setActiveSessionId(sid);
    state.draftMode = false;
    if (els.sessionIdHint) els.sessionIdHint.textContent = sid.slice(0, 8) + "…";
  }

  function usageTone(pct) {
    const n = Number(pct);
    if (!Number.isFinite(n)) return "unknown";
    if (n >= 99.5) return "out";
    if (n >= 80) return "warn";
    return "ok";
  }

  function formatResetAt(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    if (!Number.isFinite(d.getTime())) return "";
    return d.toLocaleString(undefined, {
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  }

  function formatTokenCount(n) {
    const v = Number(n) || 0;
    if (v >= 1_000_000) {
      const m = v / 1_000_000;
      return (m >= 10 ? Math.round(m) : m.toFixed(1).replace(/\.0$/, "")) + "M";
    }
    if (v >= 1000) return `${Math.round(v / 1000)}k`;
    return String(v);
  }

  function setUsagePie(percent, tone) {
    if (els.usagePieFill) {
      const used = Math.max(0, Math.min(100, Number(percent) || 0));
      els.usagePieFill.setAttribute("stroke-dasharray", `${used} ${100 - used}`);
    }
    if (els.usageBtn) {
      els.usageBtn.classList.remove("ok", "warn", "out", "unknown");
      els.usageBtn.classList.add(tone || "unknown");
    }
  }

  function renderUsagePopover(data) {
    if (!els.usagePopBody) return;
    const weekly = data && data.weekly;
    const session = data && data.session;
    const parts = [];

    if (weekly) {
      const used = Math.round(weekly.usedPercent);
      const left = Math.max(0, Math.round(weekly.remainingPercent));
      const tone = usageTone(weekly.usedPercent);
      const reset = formatResetAt(weekly.resetsAt);
      parts.push(`
        <section class="usage-section">
          <div class="usage-section-title">Weekly</div>
          <div class="usage-section-sub">${
            tone === "out"
              ? "You're out of weekly usage."
              : `You've used ${used}% · ${left}% remaining`
          }</div>
          <div class="usage-bar ${tone}"><span style="width:${Math.max(0, Math.min(100, weekly.usedPercent))}%"></span></div>
          <div class="usage-section-meta">${reset ? `Resets ${reset}` : "Resets weekly"}</div>
          ${
            weekly.products && weekly.products.length
              ? `<ul class="usage-products">${weekly.products
                  .map(
                    (p) =>
                      `<li><span>${escapeHtml(p.label)}</span><span>${Math.round(
                        p.usedPercent
                      )}%</span></li>`
                  )
                  .join("")}</ul>`
              : ""
          }
        </section>`);
    } else {
      parts.push(`
        <section class="usage-section">
          <div class="usage-section-title">Weekly</div>
          <p class="usage-muted">${
            data && data.weeklyError
              ? "Couldn't load weekly usage right now."
              : "Weekly usage isn't available yet."
          }</p>
        </section>`);
    }

    if (session) {
      const pct = Math.round(session.usedPercent);
      const used = formatTokenCount(session.tokensUsed);
      const total = formatTokenCount(session.tokensTotal);
      parts.push(`
        <section class="usage-section">
          <div class="usage-section-title">This session</div>
          <div class="usage-section-sub">${used} / ${total} tokens (${pct}%)</div>
          <div class="usage-bar ${usageTone(session.usedPercent)}"><span style="width:${Math.max(
            0,
            Math.min(100, session.usedPercent)
          )}%"></span></div>
          <div class="usage-section-meta">Context window for this chat — Grok doesn't use 5-hour sessions.</div>
        </section>`);
    } else {
      parts.push(`
        <section class="usage-section">
          <div class="usage-section-title">This session</div>
          <p class="usage-muted">Open a chat to see how much of the context window is used.</p>
        </section>`);
    }

    els.usagePopBody.innerHTML = parts.join("");
  }

  async function refreshUsage() {
    if (!els.usageBtn) return;
    try {
      const q = state.activeSessionId
        ? `?sessionId=${encodeURIComponent(state.activeSessionId)}`
        : "";
      const data = await api(`/api/usage${q}`);
      state.usage = data;
      const weekly = data && data.weekly;
      setUsagePie(weekly ? weekly.usedPercent : 0, weekly ? usageTone(weekly.usedPercent) : "unknown");
      if (els.usageBtn) {
        els.usageBtn.title = weekly
          ? `Weekly usage ${Math.round(weekly.usedPercent)}% used`
          : "Usage";
      }
      if (els.usagePopover && !els.usagePopover.classList.contains("hidden")) {
        renderUsagePopover(data);
      }
    } catch {
      setUsagePie(0, "unknown");
    }
  }

  function setUsagePopoverOpen(open) {
    if (!els.usagePopover || !els.usageBtn) return;
    els.usagePopover.classList.toggle("hidden", !open);
    els.usageBtn.setAttribute("aria-expanded", open ? "true" : "false");
    if (open) {
      renderUsagePopover(state.usage || {});
      refreshUsage();
    }
  }

  async function finishTurn(sessionId) {
    clearPendingReattach();
    hideReconnectStatus();
    state.awaitingAnswers = false;
    setRunning(false);
    if (sessionId) state.liveSessionIds.delete(sessionId);
    state.runId = null;
    state.abortController = null;
    state.liveShell = null;
    state.streamSessionId = null;
    state.attachingRunId = null;
    await refreshSessions();
    if (sessionId && state.activeSessionId === sessionId) {
      const s = state.sessions.find((x) => x.id === sessionId);
      if (s) setActiveMeta(s);
    }
    renderSessionList();
    unlockPrompt({ focus: true });
    refreshUsage();
    drainPromptQueue();
  }

  function handleSseBlock(raw, shell, onSession, onGrokActivity) {
    let event = "message";
    const dataParts = [];
    for (const rawLine of raw.split("\n")) {
      const line = rawLine.replace(/\r$/, "");
      if (!line || line.startsWith(":")) continue;
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) {
        let val = line.slice(5);
        if (val.startsWith(" ")) val = val.slice(1);
        dataParts.push(val);
      }
    }
    const dataLine = dataParts.join("\n");
    if (!dataLine) return event;

    let data;
    try {
      data = JSON.parse(dataLine);
    } catch {
      return event;
    }

    switch (event) {
      case "start":
        if (data.sessionId && typeof onSession === "function") onSession(data.sessionId);
        break;
      case "session":
        if (data.sessionId && typeof onSession === "function") onSession(data.sessionId);
        break;
      case "run":
        if (data.runId) state.runId = data.runId;
        break;
      case "awaiting_answers":
        state.awaitingAnswers = true;
        if (els.runningText) els.runningText.textContent = "Waiting for your choice…";
        break;
      case "status":
        if (data.message && (!shell || state.liveShell === shell)) {
          els.runningText.textContent = data.message;
        }
        if (typeof onGrokActivity === "function" && data.pid) onGrokActivity();
        break;
      case "grok":
        if (typeof onGrokActivity === "function") onGrokActivity();
        handleGrokEvent(data, shell);
        break;
      case "error":
        if (shell) appendShellWarning(shell, data.message || "Error");
        break;
      case "done":
        if (data.sessionId && typeof onSession === "function") onSession(data.sessionId);
        if (!data.ok && shell) {
          const warning = formatDoneWarning(data);
          if (warning) {
            if (shell.text) shell.text += "\n\n" + warning;
            else shell.text = warning;
          }
        }
        flushAssistantMarkdown(shell);
        break;
      default:
        break;
    }
    return event;
  }

  function handleGrokEvent(evt, shell) {
    const type = evt.type;
    const viewing = !shell || state.liveShell === shell;
    if (type === "text") {
      updateAssistantText(shell, evt.data || "");
      if (viewing) els.runningText.textContent = "Writing…";
    } else if (type === "thought") {
      const chunk = evt.data != null ? String(evt.data) : "";
      appendThought(shell, chunk);
      if (viewing) {
        const snippet = chunk.replace(/\s+/g, " ").trim();
        if (snippet) {
          const short = snippet.length > 48 ? snippet.slice(0, 48) + "…" : snippet;
          els.runningText.textContent = `Thinking… ${short}`;
        } else {
          els.runningText.textContent = "Thinking…";
        }
      }
    } else if (type === "tool_call" || type === "tool_call_update") {
      upsertTool(shell, evt);
      if (viewing) {
        const ask = extractAskFromSrc(evt);
        if (ask) {
          els.runningText.textContent = "Waiting for your choice…";
        } else {
          const info = describeTool(evt);
          const label = [info.kind, info.detail].filter(Boolean).join(" · ");
          els.runningText.textContent =
            info.status === "done"
              ? `${label || "Tool"} done`
              : label || "Using tools…";
        }
      }
      if (isMediaToolName((evt && (evt.toolName || evt.name)) || describeTool(evt).rawName)) {
        const media = mediaPathsFrom(evt);
        if (media.length) showGeneratedMedia(shell, media);
        else if (String(evt.status || "").toLowerCase() === "completed" || formatToolStatus(evt.status) === "done") {
          void refreshSessionMedia(shell);
        }
      }
    } else if (type === "error") {
      updateAssistantText(shell, `\n⚠️ ${evt.message || "error"}\n`);
      flushAssistantMarkdown(shell);
    } else if (type === "end") {
      const reason = String(evt.stopReason || evt.stop_reason || "").toLowerCase();
      if (viewing) els.runningText.textContent = "Finishing…";
      if (shell && shell.toolUsed) void refreshSessionMedia(shell);
      if (reason === "cancelled" || reason === "max_tokens") {
        const note =
          reason === "cancelled"
            ? "⚠️ Turn cancelled."
            : "⚠️ Stopped at the token limit.";
        appendShellWarning(shell, note.replace(/^⚠️\s*/, ""));
        if (reason === "cancelled") {
          shell.cancelledNote = true;
          expireQuestionCards(shell);
        }
      }
    }
  }

  async function stopRun() {
    expireQuestionCards(state.liveShell);
    const pending = state.pendingReattach;
    let runId = state.runId;
    let sessionId = state.streamSessionId || state.activeSessionId || pending?.sessionId;
    const clientTurnId = pending?.clientTurnId;
    clearPendingReattach();
    if (!runId && !sessionId && !clientTurnId) {
      try {
        await sleep(150);
      } catch {
        /* ignore */
      }
      runId = state.runId;
      sessionId = state.streamSessionId || state.activeSessionId;
    }
    if (runId || sessionId || clientTurnId) {
      try {
        await api("/api/chat/cancel", {
          method: "POST",
          body: JSON.stringify({ runId, sessionId, clientTurnId }),
        });
      } catch {
        /* ignore */
      }
    }
    if (state.abortController) {
      try {
        state.abortController.abort();
      } catch {
        /* ignore */
      }
    }
    if (!state.sendInFlight) {
      await finishTurn(sessionId);
    }
  }

  // ---------- Voice dictation (Grok Speech-to-Text) ----------
  function liveVoiceSupported() {
    return !!(
      window.isSecureContext &&
      navigator.mediaDevices &&
      typeof navigator.mediaDevices.getUserMedia === "function" &&
      (window.AudioContext || window.webkitAudioContext)
    );
  }

  function voiceFileSupported() {
    return !!(els.fileVoice && typeof FileReader !== "undefined");
  }

  function voiceDictationSupported() {
    return liveVoiceSupported() || voiceFileSupported();
  }

  function formatVoiceClock(ms) {
    const total = Math.max(0, Math.floor(ms / 1000));
    const m = Math.floor(total / 60);
    const s = total % 60;
    return `${m}:${String(s).padStart(2, "0")}`;
  }

  function updateVoiceUi() {
    const phase = state.voice.phase;
    const btn = els.btnMic;
    const strip = els.voiceStrip;
    const label = els.voiceStripText;
    if (!btn) return;
    btn.classList.toggle("hidden", !voiceDictationSupported());
    btn.classList.toggle("recording", phase === "recording");
    btn.classList.toggle("transcribing", phase === "transcribing");
    btn.setAttribute("aria-pressed", phase === "recording" ? "true" : "false");
    btn.disabled = phase === "transcribing" || !state.setupReady;
    if (phase === "recording") {
      btn.title = "Stop dictation";
      btn.setAttribute("aria-label", "Stop dictation");
    } else if (phase === "transcribing") {
      btn.title = "Transcribing…";
      btn.setAttribute("aria-label", "Transcribing");
    } else if (liveVoiceSupported()) {
      btn.title = "Dictate with Grok";
      btn.setAttribute("aria-label", "Dictate");
    } else {
      btn.title = "Transcribe a voice memo or audio file";
      btn.setAttribute("aria-label", "Transcribe audio");
    }
    if (strip) {
      strip.classList.toggle("hidden", phase === "idle");
      strip.classList.toggle("transcribing", phase === "transcribing");
    }
    if (label) {
      if (phase === "recording") {
        const elapsed = Date.now() - (state.voice.startedAt || Date.now());
        label.textContent = `Listening ${formatVoiceClock(elapsed)} · words appear as you speak · Esc cancels`;
      } else if (phase === "transcribing") {
        label.textContent = "Finishing transcript…";
      }
    }
    if (els.prompt && phase !== "idle") {
      els.prompt.placeholder =
        phase === "recording" ? "Listening…" : "Transcribing…";
    } else if (els.prompt && !state.running) {
      els.prompt.placeholder = "Type a message or / for commands…";
    }
  }

  function insertTranscript(text) {
    const t = String(text || "").trim();
    if (!t || !els.prompt) return;
    if (typeof state.voice.insertStart === "number") {
      updateVoiceDraft(t);
      return;
    }
    const el = els.prompt;
    const cur = el.value || "";
    const start = typeof el.selectionStart === "number" ? el.selectionStart : cur.length;
    const end = typeof el.selectionEnd === "number" ? el.selectionEnd : cur.length;
    state.voice.insertStart = start;
    state.voice.insertEnd = end;
    updateVoiceDraft(t);
  }

  function updateVoiceDraft(text) {
    if (!els.prompt) return;
    const el = els.prompt;
    const t = String(text || "").replace(/\s+/g, " ").trim();
    state.voice.liveText = t;
    if (typeof state.voice.insertStart !== "number") {
      const caret =
        typeof el.selectionStart === "number" ? el.selectionStart : (el.value || "").length;
      state.voice.insertStart = caret;
      state.voice.insertEnd = caret;
    }
    const start = state.voice.insertStart;
    const end =
      typeof state.voice.insertEnd === "number" ? state.voice.insertEnd : start;
    const before = el.value.slice(0, start);
    const after = el.value.slice(end);
    const spaceBefore = t && before && !/\s$/.test(before) ? " " : "";
    const spaceAfter = t && after && !/^\s/.test(after) ? " " : "";
    const piece = spaceBefore + t + spaceAfter;
    el.value = before + piece + after;
    state.voice.insertEnd = start + piece.length;
    const caret = start + (spaceBefore + t).length;
    try {
      el.selectionStart = el.selectionEnd = caret;
    } catch {
      /* ignore */
    }
    autoResizePrompt();
    scrollPromptToFollowVoice();
    unlockPrompt({ focus: true });
  }

  function scrollPromptToFollowVoice() {
    const el = els.prompt;
    if (!el) return;
    const pin = () => {
      try {
        el.scrollTop = el.scrollHeight;
      } catch {
        /* ignore */
      }
    };
    pin();
    requestAnimationFrame(pin);
  }

  function revertVoiceDraft() {
    if (!els.prompt || typeof state.voice.insertStart !== "number") return;
    const el = els.prompt;
    const start = state.voice.insertStart;
    const end =
      typeof state.voice.insertEnd === "number" ? state.voice.insertEnd : start;
    el.value = el.value.slice(0, start) + el.value.slice(end);
    try {
      el.selectionStart = el.selectionEnd = start;
    } catch {
      /* ignore */
    }
    state.voice.insertStart = null;
    state.voice.insertEnd = null;
    state.voice.liveText = "";
    autoResizePrompt();
  }

  function clearVoiceInsert() {
    state.voice.insertStart = null;
    state.voice.insertEnd = null;
    state.voice.liveText = "";
  }

  function downsampleVoice(float32, inputRate, targetRate) {
    if (!float32 || !float32.length) return new Float32Array(0);
    if (!inputRate || inputRate === targetRate) return float32;
    const ratio = inputRate / targetRate;
    const outLen = Math.max(1, Math.round(float32.length / ratio));
    const out = new Float32Array(outLen);
    for (let i = 0; i < outLen; i++) {
      const src = i * ratio;
      const i0 = Math.floor(src);
      const i1 = Math.min(i0 + 1, float32.length - 1);
      const t = src - i0;
      out[i] = float32[i0] * (1 - t) + float32[i1] * t;
    }
    return out;
  }

  function encodeWavPcm16(float32, sampleRate) {
    const n = float32.length;
    const buffer = new ArrayBuffer(44 + n * 2);
    const view = new DataView(buffer);
    const writeStr = (offset, str) => {
      for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
    };
    writeStr(0, "RIFF");
    view.setUint32(4, 36 + n * 2, true);
    writeStr(8, "WAVE");
    writeStr(12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeStr(36, "data");
    view.setUint32(40, n * 2, true);
    let offset = 44;
    for (let i = 0; i < n; i++) {
      const s = Math.max(-1, Math.min(1, float32[i]));
      view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      offset += 2;
    }
    return new Blob([buffer], { type: "audio/wav" });
  }

  async function blobToBase64(blob) {
    const buf = await blob.arrayBuffer();
    const bytes = new Uint8Array(buf);
    const chunk = 0x8000;
    let binary = "";
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
  }

  function stopVoiceTracks() {
    const v = state.voice;
    if (v.timer) {
      clearInterval(v.timer);
      v.timer = null;
    }
    if (v.poll) {
      clearInterval(v.poll);
      v.poll = null;
    }
    try {
      if (v.processor) v.processor.disconnect();
    } catch {
      /* ignore */
    }
    try {
      if (v.worklet) v.worklet.disconnect();
    } catch {
      /* ignore */
    }
    try {
      if (v.source) v.source.disconnect();
    } catch {
      /* ignore */
    }
    try {
      if (v.mute) v.mute.disconnect();
    } catch {
      /* ignore */
    }
    if (v.stream) {
      for (const track of v.stream.getTracks()) {
        try {
          track.stop();
        } catch {
          /* ignore */
        }
      }
    }
    const ctx = v.ctx;
    v.processor = null;
    v.worklet = null;
    v.source = null;
    v.mute = null;
    v.stream = null;
    v.ctx = null;
    if (ctx && ctx.state !== "closed") {
      try {
        ctx.close();
      } catch {
        /* ignore */
      }
    }
  }

  function closeVoiceEvents() {
    const es = state.voice.events;
    state.voice.events = null;
    if (es) {
      try {
        es.close();
      } catch {
        /* ignore */
      }
    }
  }

  function collectVoiceSamples() {
    const chunks = state.voice.chunks || [];
    let total = 0;
    for (const c of chunks) total += c.length;
    const merged = new Float32Array(total);
    let offset = 0;
    for (const c of chunks) {
      merged.set(c, offset);
      offset += c.length;
    }
    return downsampleVoice(merged, state.voice.sampleRate, VOICE_TARGET_RATE);
  }

  function floatToPcm16Base64(float32) {
    const bytes = new Uint8Array(float32.length * 2);
    const view = new DataView(bytes.buffer);
    for (let i = 0; i < float32.length; i++) {
      const s = Math.max(-1, Math.min(1, float32[i]));
      view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    }
    const chunk = 0x8000;
    let binary = "";
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
  }

  function enqueueVoicePcm(float32) {
    if (!float32 || !float32.length || !state.voice.sessionId) return;
    const pcm = floatToPcm16Base64(float32);
    const sessionId = state.voice.sessionId;
    state.voice.pcmSent = (state.voice.pcmSent || 0) + 1;
    state.voice.sendChain = state.voice.sendChain
      .then(async () => {
        const body = JSON.stringify({ sessionId, pcm });
        try {
          await api("/api/stt/audio", { method: "POST", body });
        } catch {
          await api("/api/stt/audio", { method: "POST", body });
        }
      })
      .catch(() => {});
  }

  function flushVoicePcm({ force = false } = {}) {
    const pending = state.voice.pcmPending || [];
    if (!pending.length) return;
    if (!force && state.voice.pcmCount < 1600) return;
    let total = 0;
    for (const c of pending) total += c.length;
    const merged = new Float32Array(total);
    let offset = 0;
    for (const c of pending) {
      merged.set(c, offset);
      offset += c.length;
    }
    state.voice.pcmPending = [];
    state.voice.pcmCount = 0;
    enqueueVoicePcm(merged);
  }

  function attachVoiceEvents(sessionId) {
    closeVoiceEvents();
    const es = new EventSource(
      apiUrl(`/api/stt/live?sessionId=${encodeURIComponent(sessionId)}`)
    );
    state.voice.events = es;
    const onPartial = (ev) => {
      if (state.voice.sessionId !== sessionId) return;
      if (state.voice.phase === "idle") return;
      let data = null;
      try {
        data = JSON.parse(ev.data);
      } catch {
        return;
      }
      const text = data && data.text ? String(data.text) : "";
      if (text) updateVoiceDraft(text);
    };
    es.addEventListener("partial", onPartial);
    es.addEventListener("done", (ev) => {
      onPartial(ev);
      closeVoiceEvents();
    });
    es.addEventListener("fail", (ev) => {
      let msg = "";
      try {
        const data = JSON.parse(ev.data);
        msg = data && data.error ? String(data.error) : "";
      } catch {
        msg = "";
      }
      if (msg) setStatus(false, msg);
    });
    es.onerror = () => {
      if (state.voice.phase !== "recording") closeVoiceEvents();
    };
  }

  function startVoiceStatusPoll(sessionId) {
    if (state.voice.poll) {
      clearInterval(state.voice.poll);
      state.voice.poll = null;
    }
    state.voice.poll = setInterval(() => {
      if (state.voice.phase !== "recording" || state.voice.sessionId !== sessionId) return;
      void api(`/api/stt/status?sessionId=${encodeURIComponent(sessionId)}`)
        .then((data) => {
          if (state.voice.sessionId !== sessionId) return;
          if (data && data.text) updateVoiceDraft(String(data.text));
        })
        .catch(() => {});
    }, 350);
  }

  function handleCapturedPcm(float32, inputRate) {
    if (state.voice.phase !== "recording") return;
    const copy = float32 instanceof Float32Array ? new Float32Array(float32) : new Float32Array(float32);
    if (!state.voice.chunks) state.voice.chunks = [];
    state.voice.chunks.push(copy);
    const down = downsampleVoice(copy, inputRate || VOICE_TARGET_RATE, VOICE_TARGET_RATE);
    if (!down.length) return;
    state.voice.pcmPending.push(down);
    state.voice.pcmCount += down.length;
    if (state.voice.pcmCount >= 1600) flushVoicePcm();
  }

  async function attachPcmTap(ctx, source) {
    const inputRate = ctx.sampleRate || VOICE_TARGET_RATE;
    if (ctx.audioWorklet && typeof ctx.audioWorklet.addModule === "function") {
      try {
        await ctx.audioWorklet.addModule("pcm-tap-worklet.js");
        const node = new AudioWorkletNode(ctx, "pcm-tap");
        node.port.onmessage = (ev) => handleCapturedPcm(ev.data, inputRate);
        const mute = ctx.createGain();
        mute.gain.value = 0.0001;
        source.connect(node);
        node.connect(mute);
        mute.connect(ctx.destination);
        return { worklet: node, processor: null, mute };
      } catch {
        /* iOS / older engines fall back */
      }
    }
    const processor = ctx.createScriptProcessor(4096, 1, 1);
    const mute = ctx.createGain();
    mute.gain.value = 0.0001;
    processor.onaudioprocess = (e) => {
      handleCapturedPcm(e.inputBuffer.getChannelData(0), e.inputBuffer.sampleRate || inputRate);
    };
    source.connect(processor);
    processor.connect(mute);
    mute.connect(ctx.destination);
    return { worklet: null, processor, mute };
  }

  async function startLiveVoiceSession() {
    const started = await api("/api/stt/start", {
      method: "POST",
      body: "{}",
    });
    const sessionId = started && started.sessionId ? String(started.sessionId) : "";
    if (!sessionId) throw new Error("Could not start voice");
    state.voice.sessionId = sessionId;
    state.voice.sendChain = Promise.resolve();
    attachVoiceEvents(sessionId);
    return sessionId;
  }

  function voiceFileMime(file) {
    const t = String((file && file.type) || "")
      .split(";")[0]
      .trim()
      .toLowerCase();
    if (t === "video/mp4") return "audio/mp4";
    if (t === "audio/x-m4a" || t === "audio/mp4a-latm") return "audio/m4a";
    if (t) return t;
    const name = String((file && file.name) || "").toLowerCase();
    if (name.endsWith(".mp3")) return "audio/mpeg";
    if (name.endsWith(".wav")) return "audio/wav";
    if (name.endsWith(".m4a")) return "audio/m4a";
    if (name.endsWith(".aac")) return "audio/aac";
    if (name.endsWith(".mp4")) return "audio/mp4";
    if (name.endsWith(".webm")) return "audio/webm";
    if (name.endsWith(".ogg")) return "audio/ogg";
    return "audio/m4a";
  }

  function startFileVoice() {
    if (!els.fileVoice) {
      setStatus(false, "Voice input is not available in this browser");
      return;
    }
    if (/Android/i.test(navigator.userAgent || "")) {
      els.fileVoice.setAttribute("capture", "user");
    } else {
      els.fileVoice.removeAttribute("capture");
    }
    els.fileVoice.value = "";
    els.fileVoice.click();
  }

  async function transcribeVoiceFile(file) {
    if (!file) return;
    if (!state.setupReady) {
      setStatus(false, "Sign in required");
      showSetupGate();
      return;
    }
    if (file.size > VOICE_MAX_FILE_BYTES) {
      setStatus(false, "Audio is too long");
      return;
    }
    if (state.voice.phase !== "idle") return;
    state.voice.phase = "transcribing";
    updateVoiceUi();
    try {
      const audio = await blobToBase64(file);
      const result = await api("/api/stt", {
        method: "POST",
        body: JSON.stringify({
          audio,
          mimeType: voiceFileMime(file),
          language: "en",
        }),
      });
      const text = result && result.text ? String(result.text).trim() : "";
      if (text) insertTranscript(text);
      else setStatus(false, "Didn't catch that — try again");
    } catch (err) {
      setStatus(false, (err && err.message) || "Transcription failed");
    } finally {
      state.voice.phase = "idle";
      updateVoiceUi();
    }
  }

  async function startVoice() {
    if (!state.setupReady) {
      setStatus(false, "Sign in required");
      showSetupGate();
      return;
    }
    if (state.voice.phase !== "idle") return;
    if (!liveVoiceSupported()) {
      if (voiceFileSupported()) {
        startFileVoice();
        return;
      }
      setStatus(false, "Voice input needs a secure window (desktop app or localhost)");
      return;
    }

    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          channelCount: 1,
        },
      });
    } catch (err) {
      if (voiceFileSupported()) {
        startFileVoice();
        return;
      }
      const name = err && err.name;
      if (name === "NotAllowedError" || name === "PermissionDeniedError") {
        setStatus(false, "Microphone permission denied");
      } else if (name === "NotFoundError") {
        setStatus(false, "No microphone found");
      } else {
        setStatus(false, (err && err.message) || "Could not open microphone");
      }
      return;
    }

    try {
      await startLiveVoiceSession();
    } catch (err) {
      for (const track of stream.getTracks()) {
        try {
          track.stop();
        } catch {
          /* ignore */
        }
      }
      if (voiceFileSupported()) {
        startFileVoice();
        return;
      }
      setStatus(false, (err && err.message) || "Could not start live transcription");
      return;
    }

    const AC = window.AudioContext || window.webkitAudioContext;
    const ctx = new AC();
    try {
      if (ctx.state === "suspended") await ctx.resume();
    } catch {
      /* ignore */
    }
    const source = ctx.createMediaStreamSource(stream);
    const chunks = [];
    state.voice.pcmPending = [];
    state.voice.pcmCount = 0;
    state.voice.pcmSent = 0;
    state.voice.chunks = chunks;
    const tap = await attachPcmTap(ctx, source);

    if (els.prompt) {
      const caret =
        typeof els.prompt.selectionStart === "number"
          ? els.prompt.selectionStart
          : els.prompt.value.length;
      state.voice.insertStart = caret;
      state.voice.insertEnd = caret;
      state.voice.liveText = "";
    }

    state.voice.phase = "recording";
    state.voice.startedAt = Date.now();
    state.voice.stream = stream;
    state.voice.ctx = ctx;
    state.voice.source = source;
    state.voice.processor = tap.processor;
    state.voice.worklet = tap.worklet;
    state.voice.mute = tap.mute;
    state.voice.sampleRate = ctx.sampleRate || VOICE_TARGET_RATE;
    startVoiceStatusPoll(state.voice.sessionId);
    setTimeout(() => {
      if (state.voice.phase === "recording" && !state.voice.pcmSent) {
        setStatus(false, "Mic is open but no audio reached Grok — try again, or check the microphone");
      }
    }, 1800);
    state.voice.timer = setInterval(() => {
      updateVoiceUi();
      const elapsed = (Date.now() - state.voice.startedAt) / 1000;
      if (elapsed >= VOICE_MAX_SECONDS) {
        void stopVoice({ transcribe: true });
      }
    }, 250);
    updateVoiceUi();
  }

  async function stopVoice({ transcribe = true } = {}) {
    if (state.voice.phase !== "recording") return;
    flushVoicePcm({ force: true });
    const samples = collectVoiceSamples();
    const sessionId = state.voice.sessionId;
    stopVoiceTracks();
    closeVoiceEvents();
    state.voice.chunks = [];
    state.voice.pcmPending = [];
    state.voice.pcmCount = 0;

    if (!transcribe) {
      if (sessionId) {
        try {
          await api("/api/stt/stop", {
            method: "POST",
            body: JSON.stringify({ sessionId, cancel: true }),
          });
        } catch {
          /* ignore */
        }
      }
      revertVoiceDraft();
      state.voice.sessionId = null;
      state.voice.phase = "idle";
      updateVoiceUi();
      return;
    }

    state.voice.phase = "transcribing";
    updateVoiceUi();
    let finalText = state.voice.liveText || "";
    try {
      if (state.voice.sendChain) await state.voice.sendChain.catch(() => {});
      if (sessionId) {
        const result = await api("/api/stt/stop", {
          method: "POST",
          body: JSON.stringify({ sessionId }),
        });
        if (result && result.text) finalText = String(result.text).trim();
      }
      if (!finalText && samples.length) {
        const wav = encodeWavPcm16(samples, VOICE_TARGET_RATE);
        const audio = await blobToBase64(wav);
        const result = await api("/api/stt", {
          method: "POST",
          body: JSON.stringify({
            audio,
            mimeType: "audio/wav",
            language: "en",
          }),
        });
        if (result && result.text) finalText = String(result.text).trim();
      }
      if (finalText) insertTranscript(finalText);
      else if (!state.voice.liveText) {
        setStatus(false, "Didn't catch that — try again");
      }
    } catch (err) {
      if (!state.voice.liveText) {
        setStatus(false, (err && err.message) || "Transcription failed");
      }
    } finally {
      state.voice.sessionId = null;
      clearVoiceInsert();
      state.voice.phase = "idle";
      updateVoiceUi();
    }
  }

  async function toggleVoice() {
    if (state.voice.phase === "transcribing") return;
    if (state.voice.phase === "recording") {
      await stopVoice({ transcribe: true });
      return;
    }
    await startVoice();
  }

  // ---------- Prompt box ----------
  function autoResizePrompt() {
    const el = els.prompt;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 180) + "px";
    updateSendEnabled();
  }

  els.prompt.addEventListener("input", () => {
    autoResizePrompt();
    renderSlashMenu();
  });

  function promptHasOwnSelection() {
    const el = els.prompt;
    if (!el || document.activeElement !== el) return false;
    return typeof el.selectionStart === "number" && el.selectionStart !== el.selectionEnd;
  }

  function selectionIsInside(sel, node) {
    if (!sel || !node || !sel.rangeCount) return false;
    try {
      return node.contains(sel.anchorNode) && node.contains(sel.focusNode);
    } catch {
      return false;
    }
  }

  function getSelectedTranscriptText() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return "";
    const text = String(sel.toString() || "");
    if (!text) return "";
    if (els.prompt && selectionIsInside(sel, els.prompt)) return "";
    if (els.messages && !selectionIsInside(sel, els.messages)) {
      // Allow a selection that starts in a message and ends in padding/parent.
      const anchorIn = els.messages.contains(sel.anchorNode);
      const focusIn = els.messages.contains(sel.focusNode);
      if (!anchorIn && !focusIn) return "";
    }
    return text;
  }

  async function copyTextToClipboard(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      try {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.setAttribute("readonly", "");
        ta.style.position = "fixed";
        ta.style.left = "-9999px";
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand("copy");
        ta.remove();
        return ok;
      } catch {
        return false;
      }
    }
  }

  // Clicking the transcript (or typing while it has focus) should land in the
  // composer — same as a normal chat app. Do not steal focus after a drag-select
  // so Ctrl+C / right-click Copy can use the highlighted text.
  let transcriptPointer = null;
  if (els.messages) {
    els.messages.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      transcriptPointer = { x: e.clientX, y: e.clientY };
    });
    els.messages.addEventListener("click", (e) => {
      if (e.target.closest("a, button, input, textarea, select")) return;
      const dragged =
        transcriptPointer &&
        (Math.abs(e.clientX - transcriptPointer.x) > 4 ||
          Math.abs(e.clientY - transcriptPointer.y) > 4);
      transcriptPointer = null;
      if (dragged || getSelectedTranscriptText()) {
        try {
          els.messages.focus({ preventScroll: true });
        } catch {
          els.messages.focus();
        }
        return;
      }
      unlockPrompt({ focus: true });
    });
  }
  document.addEventListener("copy", (e) => {
    if (promptHasOwnSelection()) return;
    const text = getSelectedTranscriptText();
    if (!text || !e.clipboardData) return;
    e.clipboardData.setData("text/plain", text);
    e.preventDefault();
  });
  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && (e.key === "c" || e.key === "C")) {
      if (promptHasOwnSelection()) return;
      const text = getSelectedTranscriptText();
      if (!text) return;
      e.preventDefault();
      void copyTextToClipboard(text);
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === "Tab" || e.key === "Escape") return;
    const tag = (e.target && e.target.tagName) || "";
    if (/^[1-9]$/.test(e.key)) {
      const inOther =
        tag === "INPUT" &&
        e.target &&
        e.target.classList &&
        e.target.classList.contains("question-other-input");
      if (!inOther) {
        const focusedCard =
          e.target && e.target.closest ? e.target.closest(".question-card") : null;
        const rec =
          (focusedCard && focusedCard._askRec) ||
          (promptLooksIdle() ? latestPendingQuestionRec() : null);
        if (rec && rec.mode === "pending") {
          e.preventDefault();
          selectQuestionOptionByIndex(rec, Number(e.key) - 1);
          return;
        }
      }
    }
    if (tag === "TEXTAREA" || tag === "INPUT" || tag === "SELECT") return;
    if (e.target && e.target.isContentEditable) return;
    if (
      e.target &&
      e.target.closest &&
      e.target.closest(
        "#sidebar, .modal, .context-menu, #setup-gate, #folder-picker-backdrop, #account-popover, #slash-menu"
      )
    ) {
      return;
    }
    if (els.prompt.disabled) els.prompt.disabled = false;
    if (document.activeElement !== els.prompt) {
      unlockPrompt({ focus: true });
    }
  });

  els.prompt.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && state.voice.phase === "recording") {
      e.preventDefault();
      void stopVoice({ transcribe: false });
      return;
    }
    if (e.key === "Escape" && slashMenuIsOpen()) {
      e.preventDefault();
      closeSlashMenu();
      return;
    }
    if (e.key === "Escape" && state.running) {
      e.preventDefault();
      void stopRun();
      return;
    }
    if (slashMenuIsOpen() && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
      e.preventDefault();
      moveSlashHighlight(e.key === "ArrowDown" ? 1 : -1);
      return;
    }
    if (slashMenuIsOpen() && e.key === "Tab") {
      e.preventDefault();
      applySlashSelection();
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      if (slashMenuIsOpen() && applySlashSelection()) {
        e.preventDefault();
        return;
      }
      e.preventDefault();
      if ((e.ctrlKey || e.metaKey) && state.running) {
        sendPrompt({ sendNow: true });
      } else {
        sendPrompt();
      }
    }
  });

  // Paste images from clipboard (screenshots, Copy Image)
  els.prompt.addEventListener("paste", (e) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    const imageFiles = [];
    for (const item of items) {
      if (item.type.startsWith("image/")) {
        const f = item.getAsFile();
        if (f) imageFiles.push(f);
      }
    }
    if (imageFiles.length) {
      e.preventDefault();
      addImageFiles(imageFiles);
    }
  });

  if (els.btnMic) {
    els.btnMic.addEventListener("click", () => {
      void toggleVoice();
    });
  }
  if (els.fileVoice) {
    els.fileVoice.addEventListener("change", () => {
      const file = els.fileVoice.files && els.fileVoice.files[0];
      els.fileVoice.value = "";
      if (file) void transcribeVoiceFile(file);
    });
  }

  if (els.btnAttach && els.fileAttach) {
    els.btnAttach.addEventListener("click", () => {
      els.fileAttach.click();
    });
    els.fileAttach.addEventListener("change", () => {
      addImageFiles(els.fileAttach.files);
      els.fileAttach.value = "";
    });
  }

  // Drag-and-drop images onto the composer
  const composerEl = document.querySelector(".composer");
  if (composerEl) {
    composerEl.addEventListener("dragover", (e) => {
      if ([...e.dataTransfer.types].includes("Files")) {
        e.preventDefault();
        composerEl.classList.add("drag-over");
      }
    });
    composerEl.addEventListener("dragleave", () => {
      composerEl.classList.remove("drag-over");
    });
    composerEl.addEventListener("drop", (e) => {
      composerEl.classList.remove("drag-over");
      if (!e.dataTransfer?.files?.length) return;
      e.preventDefault();
      addImageFiles(e.dataTransfer.files);
    });
  }

  if (els.usageBtn) {
    els.usageBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const open = els.usagePopover && els.usagePopover.classList.contains("hidden");
      setUsagePopoverOpen(open);
    });
  }
  if (els.usagePopClose) {
    els.usagePopClose.addEventListener("click", () => setUsagePopoverOpen(false));
  }
  document.addEventListener("click", (e) => {
    if (!els.usagePopover || els.usagePopover.classList.contains("hidden")) return;
    const wrap = e.target.closest && e.target.closest(".usage-wrap");
    if (!wrap) setUsagePopoverOpen(false);
  });
  document.addEventListener("click", (e) => {
    if (!slashMenuIsOpen()) return;
    const inMenu = e.target.closest && e.target.closest("#slash-menu");
    const inPrompt = els.prompt && (e.target === els.prompt || els.prompt.contains(e.target));
    if (!inMenu && !inPrompt) closeSlashMenu();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") setUsagePopoverOpen(false);
  });

  els.btnSend.addEventListener("click", sendPrompt);
  els.btnStop.addEventListener("click", stopRun);
  if (els.sessionBannerDismiss) {
    els.sessionBannerDismiss.addEventListener("click", () => hideReconnectStatus());
  }
  els.btnNew.addEventListener("click", onNewSessionClick);
  els.btnRefresh.addEventListener("click", refreshSessions);

  // ---------- Session select / bulk / context menu ----------
  if (els.btnSelectMode) {
    els.btnSelectMode.addEventListener("click", () => {
      setSelectMode(!state.selectMode);
    });
  }
  if (els.btnBulkCancel) {
    els.btnBulkCancel.addEventListener("click", () => setSelectMode(false));
  }
  if (els.btnBulkArchive) {
    els.btnBulkArchive.addEventListener("click", () => {
      runBulkAction("archive", selectedIdsSnapshot());
    });
  }
  if (els.btnBulkDelete) {
    els.btnBulkDelete.addEventListener("click", () => {
      runBulkAction("delete", selectedIdsSnapshot());
    });
  }

  if (els.contextMenu) {
    els.contextMenu.addEventListener("click", (e) => {
      const item = e.target.closest("[data-action]");
      if (!item) return;
      const action = item.getAttribute("data-action");
      const id = state.contextSessionId;
      hideContextMenu();
      if (!id) return;
      if (action === "rename") {
        startRename(id);
      } else if (action === "archive") {
        runBulkAction("archive", idsForContextAction(id));
      } else if (action === "delete") {
        runBulkAction("delete", idsForContextAction(id));
      } else if (action === "select") {
        state.selectMode = true;
        state.selectedIds.add(id);
        state.lastClickedSessionId = id;
        updateSelectModeUI();
        renderSessionList();
      }
    });
  }

  document.addEventListener("click", (e) => {
    if (!els.contextMenu || els.contextMenu.classList.contains("hidden")) return;
    if (!els.contextMenu.contains(e.target)) hideContextMenu();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (els.contextMenu && !els.contextMenu.classList.contains("hidden")) {
        hideContextMenu();
        return;
      }
      if (state.renamingSessionId) {
        cancelRename();
        return;
      }
      if (state.selectMode) {
        setSelectMode(false);
      }
    }
  });
  window.addEventListener("blur", hideContextMenu);
  window.addEventListener("resize", hideContextMenu);
  if (els.sessionList) {
    els.sessionList.addEventListener("scroll", hideContextMenu, { passive: true });
  }

  // Desktop: native Windows/macOS folder dialog (Electron). Non-Electron keeps free-text.
  if (isElectron()) {
    els.cwdInput.readOnly = true;
    els.cwdInput.addEventListener("click", browseFolderDesktop);
    if (els.btnCwdBrowse) {
      els.btnCwdBrowse.addEventListener("click", (e) => {
        e.preventDefault();
        browseFolderDesktop();
      });
    }
  } else {
    els.cwdInput.readOnly = false;
    els.cwdInput.placeholder = "Working directory path";
    if (els.btnCwdBrowse) {
      els.btnCwdBrowse.title = "Type a path when not running in the desktop app";
      els.btnCwdBrowse.addEventListener("click", (e) => {
        e.preventDefault();
        els.cwdInput.focus();
        els.cwdInput.select();
      });
    }
    // Free-text path: commit on blur/Enter so folder changes start a new chat
    let cwdEditSnapshot = getCwd();
    els.cwdInput.addEventListener("focus", () => {
      cwdEditSnapshot = getCwd();
    });
    els.cwdInput.addEventListener("blur", () => {
      const next = getCwd();
      if (next && !cwdsEqual(next, cwdEditSnapshot)) {
        changeWorkingFolder(next);
      }
      cwdEditSnapshot = getCwd();
    });
    els.cwdInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        els.cwdInput.blur();
      }
    });
  }

  if (els.folderPickerCancel) {
    els.folderPickerCancel.addEventListener("click", closeMobileFolderPicker);
  }
  if (els.folderPickerBackdrop) {
    els.folderPickerBackdrop.addEventListener("click", (e) => {
      if (e.target === els.folderPickerBackdrop) closeMobileFolderPicker();
    });
  }

  let lastRemoteInfo = null;
  let remoteLanSaving = false;

  function canShowLanToggle() {
    return (isElectron() || isLoopbackPage()) && !isPhoneUi();
  }

  function remoteUrlIsCopyable(info) {
    if (!info || info.canCopyPhoneUrl === false) return false;
    const url = String(info.phoneUrl || "").trim();
    if (!url || !/^https?:\/\//i.test(url)) return false;
    if (/<your-tailscale-ip>|192\.168…|192\.168\.\.\./i.test(url)) return false;
    return true;
  }

  function applyRemoteInfo(info) {
    lastRemoteInfo = info || null;
    ingestSeenFolders(info);
    const urlEl = document.getElementById("remote-url");
    const noteEl = document.getElementById("remote-bind-note");
    const statusEl = document.getElementById("remote-status");
    const copyBtn = document.getElementById("btn-copy-url");
    const lanRow = document.getElementById("remote-lan-row");
    const lanCheck = document.getElementById("remote-allow-lan");
    const rotateBtn = document.getElementById("btn-rotate-token");
    const canCopy = remoteUrlIsCopyable(info);

    if (urlEl) {
      if (canCopy) {
        urlEl.textContent = info.phoneUrl;
      } else if (info && info.allowLan) {
        urlEl.textContent =
          "LAN is on — waiting for a reachable address. Stay on this trusted network, or connect Tailscale.";
      } else {
        urlEl.textContent =
          "No phone URL. Connect Tailscale on this PC (required unless you enable Allow LAN), then reopen this dialog.";
      }
    }

    if (copyBtn) {
      copyBtn.disabled = !canCopy;
      copyBtn.textContent = canCopy ? "Copy phone URL" : "No phone URL to copy";
    }

    if (noteEl) {
      const parts = [];
      if (info && info.bindNote) parts.push(info.bindNote);
      if (info && info.tailscaleIp) {
        parts.push(`This PC Tailscale IP: ${info.tailscaleIp}`);
      } else if (info && !info.allowLan) {
        parts.push("Tailscale IP not detected — open Tailscale on this PC.");
      }
      noteEl.textContent = parts.join(" ");
    }

    if (statusEl) {
      if (info && info.httpsPhone) {
        statusEl.textContent =
          "HTTPS Tailscale URL — live mic works in iPhone Chrome/Safari. Re-copy this URL if the phone still has an old http://100… link.";
      } else if (info && info.tailscaleIp) {
        statusEl.textContent =
          "While this app is open, the phone can reach it over Tailscale (loopback + Tailscale). Live mic needs the HTTPS phone URL.";
      } else if (info && info.allowLan) {
        statusEl.textContent =
          "LAN access is on. Devices on this trusted network can reach the app — cafe/public Wi‑Fi can too.";
      } else {
        statusEl.textContent =
          "Default access is this PC (loopback) plus Tailscale. Tailscale isn’t reporting an IP yet — connect it on this PC.";
      }
    }

    if (lanRow) lanRow.classList.toggle("hidden", !canShowLanToggle());
    if (rotateBtn) rotateBtn.classList.toggle("hidden", !canShowLanToggle());
    if (lanCheck && !remoteLanSaving) lanCheck.checked = !!(info && info.allowLan);
  }

  async function loadRemoteInfo() {
    const urlEl = document.getElementById("remote-url");
    try {
      const info = await api("/api/remote");
      applyRemoteInfo(info);
      return info;
    } catch (err) {
      lastRemoteInfo = null;
      if (urlEl) urlEl.textContent = `Could not load remote info: ${err.message}`;
      const copyBtn = document.getElementById("btn-copy-url");
      if (copyBtn) {
        copyBtn.disabled = true;
        copyBtn.textContent = "No phone URL to copy";
      }
      return null;
    }
  }

  if (els.btnAccount) {
    els.btnAccount.addEventListener("click", (e) => {
      e.stopPropagation();
      const open = els.accountPopover && els.accountPopover.classList.contains("hidden");
      setAccountPopoverOpen(open);
    });
  }
  if (els.btnAccountLoginX) {
    els.btnAccountLoginX.addEventListener("click", () => {
      if (isPhoneUi()) {
        if (els.accountPopHint) {
          els.accountPopHint.textContent = "Start sign-in on the PC, then Recheck here.";
        }
        return;
      }
      startSignIn({ method: "x" });
    });
  }
  if (els.btnAccountLoginEmail) {
    els.btnAccountLoginEmail.addEventListener("click", () => {
      if (isPhoneUi()) {
        if (els.accountPopHint) {
          els.accountPopHint.textContent = "Start sign-in on the PC, then Recheck here.";
        }
        return;
      }
      startSignIn({ method: "email" });
    });
  }
  if (els.btnAccountLogout) {
    els.btnAccountLogout.addEventListener("click", () => {
      logoutAccount();
    });
  }
  document.addEventListener("click", (e) => {
    if (!els.accountPopover || els.accountPopover.classList.contains("hidden")) return;
    if (e.target.closest && e.target.closest(".account-wrap")) return;
    setAccountPopoverOpen(false);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && els.accountPopover && !els.accountPopover.classList.contains("hidden")) {
      setAccountPopoverOpen(false);
    }
  });

  els.btnRemote.addEventListener("click", async () => {
    els.modalBackdrop.classList.remove("hidden");
    await loadRemoteInfo();
  });
  els.modalClose.addEventListener("click", () => {
    els.modalBackdrop.classList.add("hidden");
  });
  els.modalBackdrop.addEventListener("click", (e) => {
    if (e.target === els.modalBackdrop) els.modalBackdrop.classList.add("hidden");
  });

  if (els.btnUpdate) {
    els.btnUpdate.addEventListener("click", () => openUpdateModal());
  }
  if (els.updateCancel) {
    els.updateCancel.addEventListener("click", () => closeUpdateModal());
  }
  if (els.updateConfirm) {
    els.updateConfirm.addEventListener("click", () => applyAppUpdateFromUi());
  }
  if (els.updateBackdrop) {
    els.updateBackdrop.addEventListener("click", (e) => {
      if (e.target === els.updateBackdrop && !state.updateApplying) closeUpdateModal();
    });
  }

  const btnCopy = document.getElementById("btn-copy-url");
  if (btnCopy) {
    btnCopy.addEventListener("click", async () => {
      if (!remoteUrlIsCopyable(lastRemoteInfo)) return;
      const text = String(lastRemoteInfo.phoneUrl || "").trim();
      if (!text) return;
      try {
        await navigator.clipboard.writeText(text);
        btnCopy.textContent = "Copied!";
        setTimeout(() => {
          btnCopy.textContent = remoteUrlIsCopyable(lastRemoteInfo)
            ? "Copy phone URL"
            : "No phone URL to copy";
        }, 1500);
      } catch {
        btnCopy.textContent = "Select the URL and copy manually";
      }
    });
  }

  const btnRotate = document.getElementById("btn-rotate-token");
  if (btnRotate) {
    btnRotate.addEventListener("click", async () => {
      if (!confirm("Existing phone tabs will need the new URL.")) return;
      try {
        const info = await api("/api/remote/rotate", { method: "POST" });
        applyRemoteInfo(info);
        const statusEl = document.getElementById("remote-status");
        if (statusEl) statusEl.textContent = "Phone access rotated. Copy the new URL.";
      } catch {
        if (isPhoneUi()) btnRotate.classList.add("hidden");
      }
    });
  }

  const lanCheck = document.getElementById("remote-allow-lan");
  if (lanCheck) {
    lanCheck.addEventListener("change", async () => {
      const next = !!lanCheck.checked;
      const prev = !!(lastRemoteInfo && lastRemoteInfo.allowLan);
      remoteLanSaving = true;
      try {
        const info = await api("/api/remote/settings", {
          method: "POST",
          body: JSON.stringify({ allowLan: next }),
        });
        applyRemoteInfo(info);
      } catch {
        lanCheck.checked = prev;
      } finally {
        remoteLanSaving = false;
      }
    });
  }

  els.sidebarToggle.addEventListener("click", () => {
    document.body.classList.toggle("sidebar-open");
  });

  const scrim = document.getElementById("sidebar-scrim");
  if (scrim) {
    scrim.addEventListener("click", () => {
      document.body.classList.remove("sidebar-open");
    });
  }

  // ---------- Account bubble (sidebar footer) ----------
  function accountInitialsFrom(auth) {
    const email = String((auth && auth.email) || "").trim();
    const name = String((auth && auth.firstName) || "").trim();
    if (name && /\s/.test(name)) {
      const parts = name.split(/\s+/).filter(Boolean);
      const a = parts[0] && parts[0][0];
      const b = parts[1] && parts[1][0];
      if (a) return (a + (b || "")).toUpperCase();
    }
    if (email.includes("@")) {
      const local = email.split("@")[0].replace(/[^a-zA-Z0-9]/g, "");
      if (local.length >= 2) return local.slice(0, 2).toUpperCase();
      if (local.length === 1) return (local + (name[0] || "")).toUpperCase();
    }
    if (name.length >= 2) {
      const caps = name.match(/[A-Z]/g);
      if (caps && caps.length >= 2) return (caps[0] + caps[1]).toUpperCase();
      return name.slice(0, 2).toUpperCase();
    }
    if (name) return name[0].toUpperCase();
    return "?";
  }

  function accountDisplayName(auth) {
    const name = String((auth && auth.firstName) || "").trim();
    if (name) return name;
    const email = String((auth && auth.email) || "").trim();
    if (email.includes("@")) return email.split("@")[0];
    if (email) return email;
    return "Grok account";
  }

  function setAccountPopoverOpen(open) {
    if (!els.accountPopover || !els.btnAccount) return;
    els.accountPopover.classList.toggle("hidden", !open);
    els.accountPopover.setAttribute("aria-hidden", open ? "false" : "true");
    els.btnAccount.setAttribute("aria-expanded", open ? "true" : "false");
    if (els.accountPopHint && !open) els.accountPopHint.textContent = "";
    if (open && isPhoneUi() && els.accountPopHint) {
      const auth = (state.setup && state.setup.auth) || {};
      const signedIn = !!(state.setup && (state.setup.ready || auth.valid));
      els.accountPopHint.textContent = signedIn
        ? "Switch accounts on the PC running Grok Desktop."
        : "Finish sign-in on the PC running Grok Desktop, then Recheck here.";
    }
  }

  function updateAccountUi(setup) {
    const auth = (setup && setup.auth) || {};
    const signedIn = !!(setup && (setup.ready || auth.valid));
    const initials = signedIn ? accountInitialsFrom(auth) : "?";
    if (els.accountInitials) els.accountInitials.textContent = initials;
    if (els.accountPopAvatar) els.accountPopAvatar.textContent = initials;
    if (els.btnAccount) {
      els.btnAccount.classList.toggle("unsigned", !signedIn);
      const label = signedIn
        ? `${accountDisplayName(auth)}${auth.email ? ` (${auth.email})` : ""}`
        : "Account — sign in";
      els.btnAccount.title = label;
      els.btnAccount.setAttribute("aria-label", signedIn ? `Account: ${label}` : "Account");
    }
    if (els.accountPopName) {
      els.accountPopName.textContent = signedIn ? accountDisplayName(auth) : "Not signed in";
    }
    if (els.accountPopEmail) {
      els.accountPopEmail.textContent = signedIn ? auth.email || "" : "";
    }
    if (els.btnAccountLogout) {
      els.btnAccountLogout.disabled = !signedIn;
      els.btnAccountLogout.classList.toggle("hidden", !signedIn);
      const sep = els.btnAccountLogout.previousElementSibling;
      if (sep && sep.classList.contains("context-menu-sep")) {
        sep.classList.toggle("hidden", !signedIn);
      }
    }
    const phoneLock = isPhoneUi();
    if (els.btnAccountLoginX) {
      els.btnAccountLoginX.textContent = signedIn ? "Switch to X account" : "Sign in with X";
      els.btnAccountLoginX.disabled = phoneLock;
    }
    if (els.btnAccountLoginEmail) {
      els.btnAccountLoginEmail.textContent = signedIn
        ? "Switch to email account"
        : "Sign in with email";
      els.btnAccountLoginEmail.disabled = phoneLock;
    }
    if (phoneLock && els.accountPopHint) {
      els.accountPopHint.textContent = signedIn
        ? "Switch accounts on the PC running Grok Desktop."
        : "Finish sign-in on the PC running Grok Desktop, then Recheck here.";
    }
  }

  async function logoutAccount() {
    setAccountPopoverOpen(false);
    if (isPhoneUi()) {
      if (els.accountPopHint) {
        els.accountPopHint.textContent = "Sign out on the PC running Grok Desktop.";
      }
      setAccountPopoverOpen(true);
      return;
    }
    if (state.running) {
      try {
        await api("/api/chat/cancel", {
          method: "POST",
          body: JSON.stringify({ runId: state.runId }),
        });
      } catch {
        /* ignore */
      }
    }
    if (els.accountPopHint) els.accountPopHint.textContent = "Signing out…";
    try {
      await api("/api/auth/logout", { method: "POST", body: "{}" });
    } catch (err) {
      const msg = isPhoneUi()
        ? "Log out on the PC running Grok Desktop."
        : err.message || "Logout failed";
      if (els.accountPopHint) els.accountPopHint.textContent = msg;
      setStatus(false, msg);
      setAccountPopoverOpen(true);
      return;
    }
    state.setupReady = false;
    state.setup = {
      ready: false,
      installed: true,
      auth: { present: false, valid: false, reason: "missing", email: null, firstName: null },
      login: { running: false },
    };
    if (state.voice.phase === "recording") {
      void stopVoice({ transcribe: false });
    }
    updateAccountUi(state.setup);
    updateVoiceUi();
    setStatus(false, "Signed out");
    await checkSetupAndBoot({ force: true });
  }

  // ---------- Setup gate (Install CLI / Sign in) ----------
  /**
   * Prefer /api/setup. If the running desktop process is older than the static UI
   * (no /api/setup yet → 404 "Not found"), fall back to /api/health so phone access
   * keeps working until the PC app is fully restarted.
   */
  async function fetchSetupStatus() {
    try {
      return await api("/api/setup");
    } catch (err) {
      const msg = String(err && err.message ? err.message : err);
      try {
        const health = await api("/api/health");
        return synthesizeSetupFromHealth(health, {
          setupError: msg,
          setupEndpointMissing: /not\s*found/i.test(msg) || /\b404\b/.test(msg),
        });
      } catch (healthErr) {
        const hmsg = String(
          healthErr && healthErr.message ? healthErr.message : healthErr
        );
        const looksMissing = /not\s*found/i.test(msg) || /\b404\b/.test(msg);
        throw new Error(looksMissing ? hmsg || msg || "Offline" : msg || hmsg || "Offline");
      }
    }
  }

  /**
   * Map /api/health into the setup-gate shape used by renderSetupGate.
   * New servers include ready/installed/authenticated; old ones only have ok/remote.
   */
  function synthesizeSetupFromHealth(health, meta = {}) {
    if (!health || health.ok === false) {
      return {
        ready: false,
        error: meta.setupError || "Health check failed",
        installed: false,
        auth: { present: false, valid: false, reason: "unknown", email: null, firstName: null },
        login: { running: false },
      };
    }

    // New health payload (post setup-gate): honor explicit flags
    if (typeof health.ready === "boolean") {
      return {
        ready: !!health.ready,
        installed: health.installed !== false,
        grokBin: health.grokBin || null,
        grokHome: health.grokHome || null,
        platform: health.platform || null,
        auth: {
          present: !!(health.authenticated || health.authEmail || health.ready),
          valid: !!(health.authenticated || health.ready),
          reason: health.authenticated || health.ready ? "ok" : "missing",
          email: health.authEmail || null,
          firstName: health.authFirstName || null,
        },
        login: { running: false },
        fromHealth: true,
      };
    }

    // Legacy server: no /api/setup and no ready flags — previous behavior was
    // "health ok ⇒ app works". Don't block mobile behind a broken gate.
    return {
      ready: true,
      installed: true,
      grokBin: health.grokBin || null,
      grokHome: health.grokHome || null,
      platform: health.platform || null,
      auth: {
        present: true,
        valid: true,
        reason: "ok",
        email: health.authEmail || null,
        firstName: health.authFirstName || null,
      },
      login: { running: false },
      fromHealth: true,
      legacyServer: true,
    };
  }

  function stopLoginPoll() {
    if (state.loginPollTimer) {
      clearInterval(state.loginPollTimer);
      state.loginPollTimer = null;
    }
  }

  function hideSetupGate() {
    if (!els.setupGate) return;
    els.setupGate.classList.add("hidden");
    els.setupGate.setAttribute("aria-busy", "false");
    els.setupGate.setAttribute("aria-hidden", "true");
  }

  function showSetupGate() {
    if (!els.setupGate) return;
    els.setupGate.classList.remove("hidden");
    els.setupGate.setAttribute("aria-busy", "true");
    els.setupGate.setAttribute("aria-hidden", "false");
  }

  function setSetupChrome({ title, message, detailsHtml, installCmd, hint, hintDocsUrl, actions }) {
    if (els.setupTitle) els.setupTitle.textContent = title || "";
    if (els.setupMessage) els.setupMessage.textContent = message || "";
    if (els.setupDetails) {
      if (detailsHtml) {
        els.setupDetails.innerHTML = detailsHtml;
        els.setupDetails.classList.remove("hidden");
      } else {
        els.setupDetails.innerHTML = "";
        els.setupDetails.classList.add("hidden");
      }
    }
    if (els.setupInstallCmd) {
      if (installCmd) {
        els.setupInstallCmd.textContent = installCmd;
        els.setupInstallCmd.classList.remove("hidden");
      } else {
        els.setupInstallCmd.textContent = "";
        els.setupInstallCmd.classList.add("hidden");
      }
    }
    if (els.setupHint) {
      els.setupHint.replaceChildren();
      if (hintDocsUrl) {
        els.setupHint.append("Docs: ");
        const a = document.createElement("a");
        a.href = String(hintDocsUrl);
        a.target = "_blank";
        a.rel = "noopener";
        a.textContent = String(hintDocsUrl);
        els.setupHint.appendChild(a);
      } else {
        els.setupHint.textContent = hint || "";
      }
    }
    if (els.setupActions) {
      els.setupActions.innerHTML = "";
      for (const a of actions || []) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = a.primary ? "btn-primary" : "btn-secondary";
        btn.textContent = a.label;
        if (a.disabled) btn.disabled = true;
        if (a.id) btn.id = a.id;
        if (a.onClick) btn.addEventListener("click", a.onClick);
        els.setupActions.appendChild(btn);
      }
    }
  }

  function authReasonLabel(reason) {
    switch (reason) {
      case "missing":
        return "No auth file yet";
      case "empty":
        return "Auth file is empty";
      case "invalid_json":
      case "invalid_shape":
        return "Auth file is unreadable";
      case "no_credentials":
        return "Auth file has no credentials";
      case "expired":
        return "Session expired — sign in again";
      case "unreadable":
        return "Could not read auth file";
      case "ok":
        return "Signed in";
      default:
        return reason || "Unknown";
    }
  }

  function renderSetupGate(setup) {
    state.setup = setup;
    updateAccountUi(setup);
    showSetupGate();

    if (!setup || setup.error) {
      setSetupChrome({
        title: "Can’t reach Grok Desktop",
        message:
          (setup && setup.error) ||
          "The app backend didn’t respond. Restart Grok Desktop and try again.",
        hint:
          setup?.hintExtra ||
          "Fully quit Grok Desktop on the PC, relaunch it, then reload this page. Use the phone URL from 📱.",
        actions: [
          {
            label: "Retry",
            primary: true,
            onClick: () => checkSetupAndBoot({ force: true }),
          },
        ],
      });
      setStatus(false, "Offline");
      return;
    }

    if (setup.ready) {
      state.setupReady = true;
      hideSetupGate();
      stopLoginPoll();
      updateAccountUi(setup);
      return;
    }

    state.setupReady = false;

    if (!setup.installed) {
      const isWin = (setup.platform || "").startsWith("win");
      const cmd =
        (isWin ? setup.install?.windows : setup.install?.unix) ||
        setup.install?.unix ||
        "curl -fsSL https://x.ai/cli/install.sh | bash";
      const docs = setup.install?.docsUrl || "https://x.ai/cli";
      setSetupChrome({
        title: "Install Grok CLI",
        message:
          "Grok Desktop needs the Grok CLI on this machine. Install it, then click Recheck.",
        detailsHtml: setup.grokHome
          ? `Expected install location includes <code>${escapeHtml(
              pathJoinHint(setup.grokHome, "bin")
            )}</code> or <code>grok</code> on your PATH.`
          : "",
        installCmd: cmd,
        hintDocsUrl: docs,
        actions: [
          {
            label: "Copy install command",
            primary: false,
            onClick: async () => {
              try {
                await navigator.clipboard.writeText(cmd);
                if (els.setupHint) {
                  els.setupHint.textContent = "Install command copied — paste it in a terminal.";
                }
              } catch {
                if (els.setupHint) {
                  els.setupHint.textContent = "Select the command above and copy it manually.";
                }
              }
            },
          },
          {
            label: "Open install docs",
            primary: false,
            onClick: () => {
              window.open(docs, "_blank", "noopener");
            },
          },
          {
            label: "Recheck",
            primary: true,
            onClick: () => checkSetupAndBoot({ force: true }),
          },
        ],
      });
      setStatus(false, "Install Grok CLI");
      return;
    }

    // Installed but not signed in
    const login = setup.login || {};
    const emailHint = setup.auth?.email
      ? `Last account: ${setup.auth.email}`
      : authReasonLabel(setup.auth?.reason);

    if (login.running) {
      const method = login.method || state.loginMethod;
      const methodHint =
        method === "email"
          ? "In the browser, choose Sign in with email and enter your Grok email and password."
          : "In the browser, choose Sign in with X (your X / Twitter account).";
      const phone = isPhoneUi();
      const runningActions = [
        {
          label: "Signing in…",
          primary: true,
          disabled: true,
        },
        {
          label: "I’ve signed in — Recheck",
          primary: false,
          onClick: () => checkSetupAndBoot({ force: true }),
        },
      ];
      if (!phone) {
        runningActions.push({
          label: "Cancel",
          primary: false,
          onClick: async () => {
            try {
              await api("/api/auth/login/cancel", { method: "POST", body: "{}" });
            } catch {
              /* ignore */
            }
            stopLoginPoll();
            await checkSetupAndBoot({ force: true });
          },
        });
      }
      setSetupChrome({
        title: method === "email" ? "Sign in with email" : "Sign in with X",
        message: phone
          ? "Complete sign-in in the browser on the PC running Grok Desktop. This screen will unlock when auth is ready — or tap Recheck."
          : "Complete sign-in in the browser window that opened on this computer. This screen will unlock automatically when auth is ready.",
        detailsHtml: `<div>${escapeHtml(emailHint)}</div><div style="margin-top:6px">${escapeHtml(
          methodHint
        )}</div>`,
        hint: phone
          ? "You’re on a phone — finish sign-in on the PC running Grok Desktop."
          : "If no browser opened, run grok login --oauth in a terminal.",
        actions: runningActions,
      });
      setStatus(null, "Signing in…");
      if (!state.loginPollTimer) startLoginPoll();
      return;
    }

    const failed =
      login.finishedAt &&
      login.exitCode !== 0 &&
      login.exitCode !== null &&
      !setup.auth?.valid;

    if (isPhoneUi()) {
      setSetupChrome({
        title: "Sign in on the PC",
        message:
          "Finish sign-in on the PC running Grok Desktop, then tap Recheck. The phone cannot start Grok sign-in.",
        detailsHtml: `<div>${escapeHtml(emailHint)}</div>${
          failed && login.error
            ? `<div style="margin-top:6px;color:var(--danger)">${escapeHtml(login.error)}</div>`
            : ""
        }`,
        hint: "Use Sign in with X or Sign in with email in the desktop app. OAuth opens on the PC.",
        actions: [
          {
            label: "Recheck",
            primary: true,
            onClick: () => checkSetupAndBoot({ force: true }),
          },
        ],
      });
      setStatus(false, "Sign in on the PC");
      return;
    }

    setSetupChrome({
      title: "Sign in to Grok",
      message: failed
        ? "Sign-in didn’t finish. Try again — pick X or email, matching the Grok account you use."
        : "You’re not signed in yet. Use X or email/password, depending on your Grok account.",
      detailsHtml: `<div>${escapeHtml(emailHint)}</div>${
        failed && login.error
          ? `<div style="margin-top:6px;color:var(--danger)">${escapeHtml(login.error)}</div>`
          : ""
      }`,
      hint: "Opens the Grok sign-in page (grok login --oauth). Choose X or email there.",
      actions: [
        {
          label: "Sign in with X",
          primary: true,
          id: "btn-setup-login-x",
          onClick: () => startSignIn({ method: "x" }),
        },
        {
          label: "Sign in with email",
          primary: false,
          id: "btn-setup-login-email",
          onClick: () => startSignIn({ method: "email" }),
        },
        {
          label: "Recheck",
          primary: false,
          onClick: () => checkSetupAndBoot({ force: true }),
        },
      ],
    });
    setStatus(false, "Sign in required");
  }

  /** Lightweight path join for display only (avoid Node path in renderer). */
  function pathJoinHint(home, ...parts) {
    const sep = (home || "").includes("\\") ? "\\" : "/";
    return [home, ...parts].filter(Boolean).join(sep);
  }

  function startLoginPoll() {
    stopLoginPoll();
    state.loginPollTimer = setInterval(async () => {
      try {
        const setup = await fetchSetupStatus();
        if (setup.ready) {
          stopLoginPoll();
          state.setupReady = true;
          hideSetupGate();
          setStatus(true, setup.auth?.email ? `Signed in as ${setup.auth.email}` : "Connected");
          updateAccountUi(setup);
          await continueBootAfterSetup(setup);
          return;
        }
        // Re-render so UI reflects login exit / still running
        renderSetupGate(setup);
        if (!setup.login?.running && !setup.ready) {
          // Login process ended without valid auth — stop hammering; user can retry
          stopLoginPoll();
        }
      } catch {
        /* keep polling briefly during transient errors */
      }
    }, 1500);
  }

  async function startSignIn({ method = "x", replace = false } = {}) {
    const useEmail = method === "email";
    state.loginMethod = useEmail ? "email" : "x";
    setAccountPopoverOpen(false);
    const title = useEmail ? "Sign in with email" : "Sign in with X";
    const phoneSignInHint = "Start sign-in on the PC, then Recheck here.";
    if (isPhoneUi()) {
      showSetupGate();
      setSetupChrome({
        title: "Sign in on the PC",
        message: phoneSignInHint,
        actions: [
          {
            label: "Recheck",
            primary: true,
            onClick: () => checkSetupAndBoot({ force: true }),
          },
        ],
        hint: "The phone cannot start Grok sign-in. OAuth opens on the PC running Grok Desktop.",
      });
      setStatus(false, "Sign in on the PC");
      return;
    }
    const startingHint = useEmail
      ? "Starting sign-in… in the browser, choose Sign in with email."
      : "Starting sign-in… in the browser, choose Sign in with X.";
    try {
      if (replace && state.setupReady) {
        try {
          await api("/api/auth/logout", { method: "POST", body: "{}" });
        } catch {
          /* still try to start login */
        }
        state.setupReady = false;
      }
      showSetupGate();
      setSetupChrome({
        title,
        message: startingHint,
        actions: [{ label: "Starting…", primary: true, disabled: true }],
        hint: isMobileViewport()
          ? "Finish in the browser on the PC running Grok Desktop."
          : "",
      });
      await api("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ oauth: true, method: state.loginMethod }),
      });
      const setup = await fetchSetupStatus();
      renderSetupGate(setup);
      if (!setup.ready) startLoginPoll();
      else {
        state.setupReady = true;
        hideSetupGate();
        updateAccountUi(setup);
        await continueBootAfterSetup(setup);
      }
    } catch (err) {
      const raw = String((err && err.message) || "");
      const forbidden = /loopback|not allowed|only on the pc|LOOPBACK_ONLY|\b403\b/i.test(raw);
      if (isPhoneUi() || forbidden) {
        setSetupChrome({
          title: "Sign in on the PC",
          message: "Start sign-in on the PC, then Recheck here.",
          hint: "The phone cannot start Grok sign-in. Use Sign in with X or email in the desktop app.",
          actions: [
            {
              label: "Recheck",
              primary: true,
              onClick: () => checkSetupAndBoot({ force: true }),
            },
          ],
        });
        setStatus(false, "Sign in on the PC");
        return;
      }
      setSetupChrome({
        title,
        message: raw || "Could not start login.",
        hint: "You can also run grok login --oauth in a terminal, then Recheck. If this just updated, fully quit and relaunch Grok Desktop on the PC.",
        actions: [
          {
            label: "Try again",
            primary: true,
            onClick: () => startSignIn({ method: state.loginMethod || "x" }),
          },
          {
            label: useEmail ? "Sign in with X instead" : "Sign in with email instead",
            primary: false,
            onClick: () => startSignIn({ method: useEmail ? "x" : "email" }),
          },
          {
            label: "Recheck",
            primary: false,
            onClick: () => checkSetupAndBoot({ force: true }),
          },
        ],
      });
      setStatus(false, "Sign-in failed");
    }
  }

  let bootContinued = false;
  let sessionRefreshTimer = null;

  async function continueBootAfterSetup(setup) {
    updateVoiceUi();
    if (bootContinued) {
      // Already booted once — just refresh after late login
      try {
        const { models } = await api("/api/models");
        populateModels(models || []);
      } catch {
        /* ignore */
      }
      await refreshSessions();
      if (setup?.auth?.email) {
        setStatus(true, `Signed in as ${setup.auth.email}`);
      } else {
        setStatus(true, "Connected");
      }
      updateAccountUi(setup || state.setup);
      refreshUsage();
      applyDesktopOnlyComposerChrome();
      refreshSeenFolders();
      return;
    }
    bootContinued = true;

    try {
      const health = await api("/api/health");
      if (!getCwd() && health.cwd) setCwd(health.cwd);
      if (health.authEmail) {
        setStatus(true, `Signed in as ${health.authEmail}`);
      } else {
        setStatus(true, "Connected");
      }
      if (setup) updateAccountUi(setup);
    } catch (err) {
      setStatus(false, err.message || "Offline");
    }

    try {
      const { models } = await api("/api/models");
      populateModels(models || []);
    } catch {
      populateModels([]);
    }

    await refreshSessions();
    if (!getCwd()) setCwd(rememberedCwd() || guessDefaultCwd());
    applyDesktopOnlyComposerChrome();
    refreshSeenFolders();

    if (state.pendingSidechat) {
      applySidechatChrome();
      const init = state.pendingSidechat;
      if (init.cwd) setCwd(init.cwd);
      if (init.model) setModelValue(init.model);
      if (init.effort) setEffortValue(init.effort);
      startNewSession({
        cwd: init.cwd || rememberedCwd() || undefined,
        preserveLast: true,
      });
      if (els.chatTitle) els.chatTitle.textContent = "Side chat";
      state.pendingForkFrom = init.parentSessionId || null;
      if (init.prompt) {
        els.prompt.value = init.prompt;
        autoResizePrompt();
        unlockPrompt({ focus: true });
        refreshUsage();
        setTimeout(() => {
          void sendPrompt();
        }, 40);
      } else {
        unlockPrompt({ focus: true });
        refreshUsage();
      }
    } else {
      const lastId = readLastSessionId();
      const found = lastId && state.sessions.some((s) => s.id === lastId);
      if (found) {
        await openSession(lastId);
      } else {
        startNewSession({ preserveLast: !!(lastId && state.sessions.length === 0) });
      }
      unlockPrompt({ focus: true });
      refreshUsage();
    }

    bindForegroundResume();

    if (!sessionRefreshTimer) {
      sessionRefreshTimer = setInterval(() => {
        if (!state.setupReady) return;
        if (!state.running) refreshSessions();
        else void refreshLiveRuns();
      }, 30000);
    }
    if (!state.usageTimer) {
      state.usageTimer = setInterval(() => {
        if (state.setupReady) refreshUsage();
      }, 90000);
    }
    startUpdatePolling();
  }

  const UPDATE_POLL_MS = 30 * 60 * 1000;

  function updateSummaryText(info) {
    if (!info) return "";
    if (info.summary) return info.summary;
    if (info.latest && info.latest.subject) return info.latest.subject;
    return "New commits are waiting on GitHub.";
  }

  function renderUpdateButton(info) {
    state.appUpdate = info || null;
    if (!els.btnUpdate) return;
    const show = !!(info && info.available && !info.applying);
    els.btnUpdate.classList.toggle("hidden", !show);
    if (show && info.behind > 1) {
      els.btnUpdate.textContent = `Update available (${info.behind})`;
    } else if (show) {
      els.btnUpdate.textContent = "Update available";
    }
  }

  async function checkForAppUpdate({ force = false } = {}) {
    const now = Date.now();
    if (
      !force &&
      state.lastUpdateCheckAt &&
      now - state.lastUpdateCheckAt < UPDATE_POLL_MS
    ) {
      return state.appUpdate;
    }
    try {
      const info = await api(force ? "/api/update?refresh=1" : "/api/update");
      state.lastUpdateCheckAt = Date.now();
      renderUpdateButton(info);
      return info;
    } catch {
      if (!force) renderUpdateButton(null);
      return null;
    }
  }

  function startUpdatePolling() {
    void checkForAppUpdate();
    if (!state.updateTimer) {
      state.updateTimer = setInterval(() => {
        if (state.setupReady) void checkForAppUpdate();
      }, UPDATE_POLL_MS);
    }
  }

  function setUpdateProgress(text) {
    if (!els.updateProgress) return;
    if (!text) {
      els.updateProgress.classList.add("hidden");
      els.updateProgress.textContent = "";
      return;
    }
    els.updateProgress.classList.remove("hidden");
    els.updateProgress.textContent = text;
  }

  async function openUpdateModal() {
    if (!els.updateBackdrop) {
      els.updateBackdrop = document.getElementById("update-backdrop");
    }
    if (!els.updateCommit) els.updateCommit = document.getElementById("update-commit");
    if (!els.updateTitle) els.updateTitle = document.getElementById("update-title");
    if (!els.updateNote) els.updateNote = document.getElementById("update-note");
    if (!els.updateConfirm) els.updateConfirm = document.getElementById("update-confirm");
    if (!els.updateCancel) els.updateCancel = document.getElementById("update-cancel");
    if (!els.updateBackdrop) return;

    if (els.updateCommit) els.updateCommit.textContent = "Checking GitHub…";
    if (els.updateTitle) els.updateTitle.textContent = "Update available";
    if (els.updateNote) {
      els.updateNote.textContent =
        "This pulls the latest code, installs dependencies if needed, and restarts Grok Desktop.";
    }
    setUpdateProgress("");
    state.updateApplying = false;
    if (els.updateConfirm) {
      els.updateConfirm.disabled = true;
      els.updateConfirm.textContent = "Checking…";
    }
    if (els.updateCancel) els.updateCancel.disabled = false;
    els.updateBackdrop.classList.remove("hidden");

    const info = (await checkForAppUpdate({ force: true })) || state.appUpdate;
    if (!info || !info.available) {
      if (els.updateTitle) els.updateTitle.textContent = "You're up to date";
      if (els.updateCommit) {
        els.updateCommit.textContent =
          (info && info.current && info.current.subject) ||
          "No newer commit on GitHub.";
      }
      if (els.updateNote) {
        els.updateNote.textContent =
          info && info.error
            ? info.error
            : "This checkout already matches GitHub. If the app still looks old, quit and relaunch Grok Desktop.";
      }
      if (els.updateConfirm) {
        els.updateConfirm.disabled = true;
        els.updateConfirm.textContent = "Update and restart";
      }
      return;
    }
    if (els.updateCommit) els.updateCommit.textContent = updateSummaryText(info);
    if (els.updateTitle) {
      els.updateTitle.textContent =
        info.behind > 1 ? `Update available (${info.behind} commits)` : "Update available";
    }
    if (isPhoneUi()) {
      if (els.updateNote) {
        els.updateNote.textContent = "Update and restart on the PC, then reload Safari.";
      }
      if (els.updateConfirm) {
        els.updateConfirm.disabled = true;
        els.updateConfirm.textContent = "Update on the PC";
      }
      if (els.updateCancel) els.updateCancel.disabled = false;
      return;
    }
    if (els.updateNote) {
      els.updateNote.textContent = state.running
        ? "This pulls the latest code, installs dependencies if needed, and restarts Grok Desktop. The chat that is running now will stop."
        : "This pulls the latest code, installs dependencies if needed, and restarts Grok Desktop. In-progress chats will stop.";
    }
    if (els.updateConfirm) {
      els.updateConfirm.disabled = false;
      els.updateConfirm.textContent = "Update and restart";
    }
    if (els.updateCancel) els.updateCancel.disabled = false;
  }

  function closeUpdateModal() {
    if (state.updateApplying) return;
    if (els.updateBackdrop) els.updateBackdrop.classList.add("hidden");
  }

  async function applyAppUpdateFromUi() {
    if (state.updateApplying) return;
    if (isPhoneUi()) {
      setUpdateProgress("Update and restart on the PC, then reload Safari.");
      if (els.updateConfirm) {
        els.updateConfirm.disabled = true;
        els.updateConfirm.textContent = "Update on the PC";
      }
      return;
    }
    state.updateApplying = true;
    if (els.updateConfirm) {
      els.updateConfirm.disabled = true;
      els.updateConfirm.textContent = "Updating…";
    }
    if (els.updateCancel) els.updateCancel.disabled = true;
    setUpdateProgress("Pulling the latest code from GitHub…");
    try {
      const result = await api("/api/update", {
        method: "POST",
        body: "{}",
      });
      if (result.alreadyCurrent) {
        setUpdateProgress("Already up to date.");
        renderUpdateButton({ ...result, available: false });
        state.updateApplying = false;
        if (els.updateCancel) els.updateCancel.disabled = false;
        return;
      }
      if (result.restarting) {
        setUpdateProgress(
          "Restarting Grok Desktop on this PC. If you’re on a phone, wait a few seconds then reload."
        );
        renderUpdateButton(null);
        return;
      }
      setUpdateProgress(
        "Code updated. Quit Grok Desktop and relaunch it (or restart the server) to load the new files."
      );
      renderUpdateButton({ ...result, available: false });
      state.updateApplying = false;
      if (els.updateCancel) {
        els.updateCancel.disabled = false;
        els.updateCancel.textContent = "Close";
      }
    } catch (err) {
      const raw = String((err && err.message) || "");
      const forbidden = /loopback|not allowed|only on the pc|LOOPBACK_ONLY|\b403\b/i.test(raw);
      setUpdateProgress(
        forbidden || isPhoneUi()
          ? "Update and restart on the PC, then reload Safari."
          : raw || "Update failed."
      );
      state.updateApplying = false;
      if (els.updateConfirm) {
        els.updateConfirm.disabled = forbidden || isPhoneUi();
        els.updateConfirm.textContent = forbidden || isPhoneUi() ? "Update on the PC" : "Try again";
      }
      if (els.updateCancel) els.updateCancel.disabled = false;
    }
  }

  async function checkSetupAndBoot({ force = false } = {}) {
    showSetupGate();
    setSetupChrome({
      title: "Checking Grok…",
      message: "Looking for the Grok CLI and your sign-in…",
      actions: [],
      hint: "",
    });
    setStatus(null, "Checking…");

    try {
      const setup = await fetchSetupStatus();
      state.setup = setup;
      if (setup.ready) {
        state.setupReady = true;
        hideSetupGate();
        stopLoginPoll();
        updateAccountUi(setup);
        updateVoiceUi();
        await continueBootAfterSetup(setup);
        return setup;
      }
      renderSetupGate(setup);
      return setup;
    } catch (err) {
      const detail = err.message || "Offline";
      renderSetupGate({
        error: detail,
        ready: false,
        hintExtra:
          "If you just updated the app, fully quit Grok Desktop on the PC and relaunch (double-click Start Grok Desktop), then reload this page.",
      });
      return null;
    }
  }

  // ---------- Boot ----------
  async function boot() {
    readTokenFromUrl();
    try {
      state.pendingSidechat = await readSidechatInit();
    } catch {
      state.pendingSidechat = null;
    }
    if (state.pendingSidechat) applySidechatChrome();
    if (isMobileViewport()) {
      document.body.classList.add("is-mobile");
      // Ensure help modal never blocks the chat on first paint
      els.modalBackdrop.classList.add("hidden");
    }
    applyDesktopOnlyComposerChrome();
    updateVoiceUi();
    await checkSetupAndBoot();
  }

  boot();
})();
