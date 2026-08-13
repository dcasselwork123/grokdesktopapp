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
    attachStrip: $("#attach-strip"),
    prompt: $("#prompt"),
    messages: $("#messages"),
    chatTitle: $("#chat-title"),
    chatProject: $("#chat-project"),
    modelSelect: $("#model-select"),
    effortSlider: $("#effort-slider"),
    effortValue: $("#effort-value"),
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
    usage: null,
    usageTimer: null,
    token: null,
    draftMode: true, // true until first message of a new chat
    attachments: [], // { id, name, mimeType, dataUrl }
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
  };

  // Preferred left→right order for the effort slider (unknown ids sort last)
  const EFFORT_ORDER = ["low", "medium", "high", "xhigh", "max"];

  const MAX_ATTACHMENTS = 8;
  // Keep attachments small so vision is fast and uploads stay reliable
  const MAX_IMAGE_EDGE = 1280;
  const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
  const LAST_SESSION_KEY = "grok_desktop_last_session";
  const LAST_CWD_KEY = "grok_desktop_last_cwd";
  const MD_DEBOUNCE_MS = 64;

  function isMobileViewport() {
    return window.matchMedia("(max-width: 800px)").matches;
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
    persistLastSession(state.activeSessionId);
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

  function readLastCwd() {
    try {
      return (localStorage.getItem(LAST_CWD_KEY) || "").trim();
    } catch {
      return "";
    }
  }

  function setCwd(cwd) {
    const value = (cwd || "").trim();
    els.cwdInput.value = value;
    els.cwdInput.title = value || "Choose working folder";
    if (value) persistLastCwd(value);
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
    const t = u.searchParams.get("token");
    if (t) {
      state.token = t;
      try {
        sessionStorage.setItem("grok_desktop_token", t);
        localStorage.setItem("grok_desktop_token", t);
      } catch {
        /* ignore */
      }
      // Clean token out of the address bar (cookie now carries auth for assets/API).
      try {
        u.searchParams.delete("token");
        const clean = u.pathname + (u.searchParams.toString() ? `?${u.searchParams}` : "") + u.hash;
        window.history.replaceState({}, "", clean || "/");
      } catch {
        /* ignore */
      }
    } else {
      try {
        state.token =
          sessionStorage.getItem("grok_desktop_token") ||
          localStorage.getItem("grok_desktop_token");
      } catch {
        state.token = null;
      }
    }
  }

  function apiUrl(path) {
    const u = new URL(path, window.location.origin);
    if (state.token) u.searchParams.set("token", state.token);
    return u.toString();
  }

  async function api(path, opts = {}) {
    const headers = { ...(opts.headers || {}) };
    if (state.token) headers["X-Grok-Token"] = state.token;
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
  function populateModels(models) {
    state.models = models;
    els.modelSelect.innerHTML = "";
    for (const m of models) {
      const opt = document.createElement("option");
      opt.value = m.id;
      opt.textContent = m.name || m.id;
      els.modelSelect.appendChild(opt);
    }
    if (models[0]) {
      els.modelSelect.value = models[0].id;
      populateEfforts(models[0]);
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

  els.modelSelect.addEventListener("change", () => {
    const m = state.models.find((x) => x.id === els.modelSelect.value);
    populateEfforts(m);
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
  function renderMarkdown(text) {
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
    els.btnSend.disabled = state.running || (!hasText && !hasImg);
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
    spawn_subagent: "Subagent",
    todo_write: "Todos",
  };

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
      <div class="body"></div>`;
    els.messages.appendChild(wrap);
    scrollToBottom();
    const shell = {
      el: wrap,
      toolsEl: wrap.querySelector(".tools"),
      bodyEl: wrap.querySelector(".body"),
      thoughtWrap: wrap.querySelector(".thought-block"),
      thoughtToggle: wrap.querySelector(".thought-toggle"),
      thoughtBody: wrap.querySelector(".thought-body"),
      thoughtPreview: wrap.querySelector(".thought-preview"),
      text: "",
      thought: "",
      toolMap: new Map(),
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
    shell.bodyEl.innerHTML = renderMarkdown(shell.text);
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

  function upsertTool(shell, src) {
    if (!shell || !shouldRenderShell(shell) || !shell.toolsEl) return;
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
    scrollToBottom();
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
    els.prompt.disabled = on;
    if (els.btnAttach) els.btnAttach.disabled = on;
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
    if (!state.running && els.prompt.disabled) els.prompt.disabled = false;
    if (els.btnAttach && !state.running) els.btnAttach.disabled = false;
    updateSendEnabled();
    if (focus && !state.running) {
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
      els.chatTitle.textContent = "New session";
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
      const opt = [...els.modelSelect.options].find((o) => o.value === session.model);
      if (opt) {
        els.modelSelect.value = session.model;
        const m = state.models.find((x) => x.id === session.model);
        populateEfforts(m);
      }
    }
    if (session.effort) {
      setEffortValue(session.effort);
    }
  }

  async function openSession(id) {
    if (state.selectMode) {
      toggleSessionSelected(id);
      return;
    }
    const sameLive =
      state.running && state.streamSessionId === id && state.liveShell;
    if (!sameLive && (state.running || state.abortController)) {
      detachLiveTurn();
    }
    setActiveSessionId(id);
    state.draftMode = false;
    expandProjectForSession(id);
    clearAttachments();
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
            if (m.text) {
              shell.text = m.text;
              shell.bodyEl.innerHTML = renderMarkdown(m.text);
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
      div.innerHTML = `<h1>Couldn't load session</h1><p>${escapeHtml(err.message)}</p>`;
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
    showEmptyState();
    renderSessionList();
    document.body.classList.remove("sidebar-open");
    unlockPrompt({ focus: true });
    refreshUsage();
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

  /** Local slash commands (TUI-style). Returns true if handled. */
  function handleSlashCommand(text) {
    const raw = text.trim();
    if (!raw.startsWith("/")) return false;
    const cmd = raw.split(/\s+/)[0].toLowerCase();
    if (cmd === "/clear" || cmd === "/new") {
      els.prompt.value = "";
      autoResizePrompt();
      clearAttachments();
      startNewSession({ cwd: rememberedCwd() || undefined });
      return true;
    }
    return false;
  }

  // ---------- Send prompt (SSE) ----------
  async function sendPrompt() {
    const text = els.prompt.value.trim();
    const pendingImages = state.attachments.slice();
    if (state.running) return;
    if (!state.setupReady) {
      setStatus(false, "Sign in required");
      showSetupGate();
      if (state.setup) renderSetupGate(state.setup);
      else checkSetupAndBoot({ force: true });
      return;
    }
    if (!text && !pendingImages.length) return;

    if (text && handleSlashCommand(text)) return;

    const model = els.modelSelect.value || "grok-4.5";
    const effort = getEffortValue();
    const cwd = getCwd() || undefined;
    const active = getActiveSession();
    // Folder changed after opening a session → never resume that session
    const cwdMismatch = !!(active && cwd && active.cwd && !cwdsEqual(cwd, active.cwd));
    if (cwdMismatch) {
      setActiveSessionId(null);
      state.draftMode = true;
    }
    const isNew = state.draftMode || !state.activeSessionId || cwdMismatch;

    appendUserMessage(
      text,
      pendingImages.map((a) => a.dataUrl)
    );
    els.prompt.value = "";
    clearAttachments();
    autoResizePrompt();
    els.btnSend.disabled = true;

    const shell = appendAssistantShell();
    const turnGen = nextTurnGen();
    setRunning(true, pendingImages.length ? "Uploading image…" : "Thinking…");

    const body = {
      prompt: text,
      model,
      effort,
      newSession: isNew,
    };
    if (!isNew) body.sessionId = state.activeSessionId;
    if (cwd) body.cwd = cwd;
    if (pendingImages.length) {
      body.images = pendingImages.map((a) => ({
        data: a.dataUrl,
        mimeType: a.mimeType,
        name: a.name,
      }));
    }

    const headers = { "Content-Type": "application/json" };
    if (state.token) headers["X-Grok-Token"] = state.token;

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
    let streamStarted = false;

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
      sawDone = await readSseStream(res, shell, onSession, onGrokActivity);

      if (!sawDone && !ac.signal.aborted && (state.runId || gotSessionId)) {
        const rec = await tryReconnectRun({
          runId: state.runId,
          sessionId: gotSessionId,
          shell,
          onSession,
          onGrokActivity,
        });
        sawDone = rec.ok;
        aborted = rec.aborted;
        if (!sawDone && !aborted) {
          appendShellWarning(
            shell,
            "Connection lost — could not reconnect to the live turn."
          );
        }
      } else if (ac.signal.aborted) {
        aborted = true;
      }
    } catch (err) {
      if (err.name === "AbortError" || ac.signal.aborted) {
        aborted = true;
      } else if (streamStarted || state.runId) {
        const rec = await tryReconnectRun({
          runId: state.runId,
          sessionId: gotSessionId,
          shell,
          onSession,
          onGrokActivity,
        });
        sawDone = rec.ok;
        aborted = rec.aborted;
        if (!sawDone && !aborted) {
          appendShellWarning(shell, err.message || String(err));
        }
      } else {
        appendShellWarning(shell, err.message || String(err));
      }
    } finally {
      clearInterval(heartbeat);
      if (turnGen === state.turnGen) {
        await finishTurn(gotSessionId);
      } else if (gotSessionId) {
        state.liveSessionIds.add(gotSessionId);
        void refreshLiveRuns();
      }
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
          bodyEl,
          text: "",
          thought: "",
          toolMap: new Map(),
          sessionId: state.activeSessionId,
        };
        ensureThoughtUi(shell);
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
  }

  async function fetchActiveRun(sessionId) {
    if (!sessionId) return null;
    try {
      const data = await api(`/api/runs?sessionId=${encodeURIComponent(sessionId)}`);
      if (!data || data.run === null) return null;
      if (data.runId) return data;
      if (data.run && data.run.runId) return data.run;
      return null;
    } catch {
      return null;
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
    const headers = {};
    if (state.token) headers["X-Grok-Token"] = state.token;

    try {
      const res = await fetch(apiUrl(`/api/chat/runs/${encodeURIComponent(runKey)}`), {
        headers,
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
    shell,
    onSession,
    onGrokActivity,
  }) {
    const delays = [1000, 2000, 3000];
    for (let i = 0; i < delays.length; i++) {
      if (state.abortController?.signal?.aborted) {
        return { ok: false, aborted: true };
      }
      showReconnectStatus(`Reconnecting… (${i + 1}/3)`, "info");
      setRunning(true, `Reconnecting… (${i + 1}/3)`);
      try {
        await sleep(delays[i], state.abortController?.signal);
      } catch (err) {
        if (err.name === "AbortError") return { ok: false, aborted: true };
      }

      let id = runId;
      if (sessionId) {
        const active = await fetchActiveRun(sessionId);
        if (active?.runId) id = active.runId;
      }
      if (!id) continue;

      try {
        const result = await attachToRun(id, {
          shell,
          sessionId,
          onSession,
          onGrokActivity,
        });
        if (result.aborted) return { ok: false, aborted: true };
        if (result.sawDone) return { ok: true };
        if (result.attached) runId = id;
      } catch (err) {
        if (err.name === "AbortError") return { ok: false, aborted: true };
      }
    }
    return { ok: false, aborted: false };
  }

  async function maybeAttachActiveRun(sessionId) {
    if (!sessionId || state.running) return;
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

    setRunning(true, "Reconnecting…");
    showReconnectStatus("Reconnecting…", "info");

    try {
      const first = await attachToRun(active.runId, {
        shell,
        sessionId,
        onSession,
      });
      if (!first.sawDone && !first.aborted) {
        await tryReconnectRun({
          runId: active.runId,
          sessionId,
          shell,
          onSession,
        });
      }
    } catch (err) {
      if (err.name !== "AbortError") {
        appendShellWarning(shell, err.message || "Reconnect failed");
      }
    } finally {
      if (turnGen === state.turnGen) {
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
    hideReconnectStatus();
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
        const info = describeTool(evt);
        const label = [info.kind, info.detail].filter(Boolean).join(" · ");
        els.runningText.textContent =
          info.status === "done"
            ? `${label || "Tool"} done`
            : label || "Using tools…";
      }
    } else if (type === "error") {
      updateAssistantText(shell, `\n⚠️ ${evt.message || "error"}\n`);
      flushAssistantMarkdown(shell);
    } else if (type === "end") {
      const reason = String(evt.stopReason || evt.stop_reason || "").toLowerCase();
      if (viewing) els.runningText.textContent = "Finishing…";
      if (reason === "cancelled" || reason === "max_tokens") {
        const note =
          reason === "cancelled"
            ? "⚠️ Turn cancelled."
            : "⚠️ Stopped at the token limit.";
        appendShellWarning(shell, note.replace(/^⚠️\s*/, ""));
      }
    }
  }

  async function stopRun() {
    if (state.abortController) {
      try {
        state.abortController.abort();
      } catch {
        /* ignore */
      }
    }
    if (!state.runId) return;
    try {
      await api("/api/chat/cancel", {
        method: "POST",
        body: JSON.stringify({ runId: state.runId }),
      });
    } catch {
      /* ignore */
    }
  }

  // ---------- Prompt box ----------
  function autoResizePrompt() {
    const el = els.prompt;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 180) + "px";
    updateSendEnabled();
  }

  els.prompt.addEventListener("input", autoResizePrompt);

  // Clicking the transcript (or typing while it has focus) should land in the
  // composer — same as a normal chat app. Folder is never a prerequisite.
  if (els.messages) {
    els.messages.addEventListener("click", (e) => {
      if (e.target.closest("a, button, input, textarea, select")) return;
      unlockPrompt({ focus: true });
    });
  }
  document.addEventListener("keydown", (e) => {
    if (state.running) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === "Tab" || e.key === "Escape") return;
    const tag = (e.target && e.target.tagName) || "";
    if (tag === "TEXTAREA" || tag === "INPUT" || tag === "SELECT") return;
    if (e.target && e.target.isContentEditable) return;
    if (
      e.target &&
      e.target.closest &&
      e.target.closest("#sidebar, .modal, .context-menu, #setup-gate, #folder-picker-backdrop")
    ) {
      return;
    }
    if (els.prompt.disabled) els.prompt.disabled = false;
    if (document.activeElement !== els.prompt) {
      unlockPrompt({ focus: true });
    }
  });

  els.prompt.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendPrompt();
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

  if (els.btnAttach && els.fileAttach) {
    els.btnAttach.addEventListener("click", () => {
      if (state.running) return;
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

  async function loadRemoteInfo() {
    const urlEl = document.getElementById("remote-url");
    const noteEl = document.getElementById("remote-bind-note");
    const statusEl = document.getElementById("remote-status");
    try {
      const info = await api("/api/remote");
      if (urlEl) urlEl.textContent = info.phoneUrl || "Unavailable";
      if (noteEl) {
        noteEl.textContent = [
          info.bindNote,
          info.tailscaleIp
            ? `This PC Tailscale IP: ${info.tailscaleIp}`
            : "Tailscale IP not detected — open Tailscale on this PC.",
        ]
          .filter(Boolean)
          .join(" ");
      }
      if (statusEl) {
        statusEl.textContent = info.tailscaleIp
          ? "While this app is open, every session is reachable over Tailscale."
          : "App is listening, but Tailscale isn’t reporting an IP yet — connect Tailscale on this PC.";
      }
      return info;
    } catch (err) {
      if (urlEl) urlEl.textContent = `Could not load remote info: ${err.message}`;
      return null;
    }
  }

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

  const btnCopy = document.getElementById("btn-copy-url");
  if (btnCopy) {
    btnCopy.addEventListener("click", async () => {
      const urlEl = document.getElementById("remote-url");
      const text = urlEl?.textContent?.trim() || "";
      if (!text || text.startsWith("Detecting") || text.startsWith("Could not")) return;
      try {
        await navigator.clipboard.writeText(text);
        btnCopy.textContent = "Copied!";
        setTimeout(() => {
          btnCopy.textContent = "Copy phone URL";
        }, 1500);
      } catch {
        btnCopy.textContent = "Select the URL and copy manually";
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
        auth: { present: false, valid: false, reason: "unknown", email: null },
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

  function setSetupChrome({ title, message, detailsHtml, installCmd, hint, actions }) {
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
      els.setupHint.innerHTML = hint || "";
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
    showSetupGate();

    if (!setup || setup.error) {
      setSetupChrome({
        title: "Can’t reach Grok Desktop",
        message:
          (setup && setup.error) ||
          "The app backend didn’t respond. Restart Grok Desktop and try again.",
        hint:
          setup?.hintExtra ||
          "Fully quit Grok Desktop on the PC, relaunch it, then reload this page. Use the phone URL from 📱 (includes <code>?token=…</code>).",
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
        hint: `Docs: <a href="${escapeHtml(docs)}" target="_blank" rel="noopener">${escapeHtml(
          docs
        )}</a>`,
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
      setSetupChrome({
        title: "Sign in with Grok",
        message:
          "Complete sign-in in the browser window that opened on this computer. This screen will unlock automatically when auth is ready.",
        detailsHtml: `<div>${escapeHtml(emailHint)}</div>`,
        hint: isMobileViewport()
          ? "You’re on a phone — finish OAuth on the PC running Grok Desktop."
          : "If no browser opened, run <code>grok login</code> in a terminal.",
        actions: [
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
          {
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
          },
        ],
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

    setSetupChrome({
      title: "Sign in with Grok",
      message: failed
        ? "Sign-in didn’t finish. Try again — this opens the same OAuth browser flow as the CLI."
        : "You’re not signed in yet. Use your Grok account (same as the CLI).",
      detailsHtml: `<div>${escapeHtml(emailHint)}</div>${
        failed && login.error
          ? `<div style="margin-top:6px;color:var(--danger)">${escapeHtml(login.error)}</div>`
          : ""
      }`,
      hint: isMobileViewport()
        ? "Sign-in runs on the PC hosting this app; your phone only triggers it."
        : "Uses <code>grok login --oauth</code> under the hood.",
      actions: [
        {
          label: "Sign in with Grok",
          primary: true,
          id: "btn-setup-login",
          onClick: () => startSignIn(),
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

  async function startSignIn() {
    try {
      setSetupChrome({
        title: "Sign in with Grok",
        message: "Starting OAuth… a browser window should open on this computer.",
        actions: [{ label: "Starting…", primary: true, disabled: true }],
        hint: "",
      });
      await api("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ oauth: true }),
      });
      const setup = await fetchSetupStatus();
      renderSetupGate(setup);
      if (!setup.ready) startLoginPoll();
      else {
        state.setupReady = true;
        hideSetupGate();
        await continueBootAfterSetup(setup);
      }
    } catch (err) {
      setSetupChrome({
        title: "Sign in with Grok",
        message: err.message || "Could not start login.",
        hint: "You can also run <code>grok login</code> in a terminal, then Recheck. If this just updated, fully quit and relaunch Grok Desktop on the PC.",
        actions: [
          {
            label: "Try again",
            primary: true,
            onClick: () => startSignIn(),
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
    const lastId = readLastSessionId();
    const found = lastId && state.sessions.some((s) => s.id === lastId);
    if (found) {
      await openSession(lastId);
    } else {
      startNewSession({ preserveLast: !!(lastId && state.sessions.length === 0) });
    }
    unlockPrompt({ focus: true });
    refreshUsage();

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
    if (isMobileViewport()) {
      document.body.classList.add("is-mobile");
      // Ensure help modal never blocks the chat on first paint
      els.modalBackdrop.classList.add("hidden");
    }
    await checkSetupAndBoot();
  }

  boot();
})();
