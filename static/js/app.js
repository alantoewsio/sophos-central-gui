(() => {
  const TITLES = {
    dashboard: "Dashboard",
    operations: "Operations View",
    firewalls: "Firewalls",
    groups: "Firewall Groups",
    tenants: "Tenants",
    licenses: "Licenses",
  };

  let activeFirewallsSubtab = "firewalls";

  const UI_STATE_KEY = "sophos-central-ui-v1";
  const THEME_STORAGE_KEY = "sophos-central-theme";

  function isDarkThemeActive() {
    return document.documentElement.getAttribute("data-theme") === "dark";
  }

  function syncUserMenuThemeButton() {
    const btn = document.getElementById("user-menu-theme");
    if (!btn) return;
    const dark = isDarkThemeActive();
    const moon = btn.querySelector(".user-menu__theme-icon--moon");
    const sun = btn.querySelector(".user-menu__theme-icon--sun");
    if (moon && sun) {
      if (dark) {
        moon.setAttribute("hidden", "");
        sun.removeAttribute("hidden");
      } else {
        sun.setAttribute("hidden", "");
        moon.removeAttribute("hidden");
      }
    }
    btn.setAttribute("aria-label", dark ? "Switch to light mode" : "Switch to dark mode");
    btn.setAttribute("title", dark ? "Light mode" : "Dark mode");
  }

  function applyColorTheme(mode) {
    const dark = mode === "dark";
    if (dark) document.documentElement.setAttribute("data-theme", "dark");
    else document.documentElement.removeAttribute("data-theme");
    try {
      localStorage.setItem(THEME_STORAGE_KEY, dark ? "dark" : "light");
    } catch {
      /* ignore */
    }
    syncUserMenuThemeButton();
    refreshFwMapBaseTilesForTheme();
  }

  function toggleColorTheme() {
    applyColorTheme(isDarkThemeActive() ? "light" : "dark");
  }

  function readUiState() {
    try {
      const raw = sessionStorage.getItem(UI_STATE_KEY);
      if (!raw) return null;
      const o = JSON.parse(raw);
      return o && typeof o === "object" ? o : null;
    } catch {
      return null;
    }
  }

  function writeUiState(state) {
    try {
      sessionStorage.setItem(UI_STATE_KEY, JSON.stringify(state));
    } catch {
      /* ignore quota / private mode */
    }
  }

  let persistTimer = null;
  let operationsUiServerTimer = null;

  async function persistOperationsUiToServer() {
    try {
      const ops = collectUiState().operations;
      await apiRequestJson("/api/me/operations-ui", {
        method: "PATCH",
        body: JSON.stringify(ops),
      });
    } catch {
      /* ignore */
    }
  }

  function schedulePersistUiState() {
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      persistTimer = null;
      writeUiState(collectUiState());
    }, 60);
    if (operationsUiServerTimer) clearTimeout(operationsUiServerTimer);
    operationsUiServerTimer = setTimeout(() => {
      operationsUiServerTimer = null;
      void persistOperationsUiToServer();
    }, 600);
  }

  function getActiveTabName() {
    const btn = document.querySelector(".app-nav .tabs__tab.is-active[data-tab]");
    const id = btn?.dataset?.tab;
    return id && TITLES[id] ? id : "dashboard";
  }

  window.addEventListener("beforeunload", () => {
    const state = collectUiState();
    writeUiState(state);
    try {
      fetch("/api/me/operations-ui", {
        method: "PATCH",
        body: JSON.stringify(state.operations),
        credentials: "same-origin",
        keepalive: true,
        headers: { "Content-Type": "application/json" },
      });
    } catch {
      /* ignore */
    }
  });

  function escapeHtml(s) {
    if (s == null) return "";
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function escapeAttr(s) {
    if (s == null) return "";
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/"/g, "&quot;")
      .replace(/</g, "&lt;");
  }

  function parseJsonArray(raw) {
    if (!raw) return [];
    try {
      const v = JSON.parse(raw);
      return Array.isArray(v) ? v : [];
    } catch {
      return [];
    }
  }

  function parseGeoCoord(v) {
    if (v == null) return null;
    const s = String(v).trim();
    if (!s) return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  }

  function yesNo(v) {
    if (v === 1 || v === true || v === "1") return "Yes";
    if (v === 0 || v === false || v === "0") return "No";
    return "—";
  }

  function fmtDate(s) {
    if (!s) return "—";
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? escapeHtml(s) : escapeHtml(d.toLocaleString());
  }

  function parseFirewallIsoMs(s) {
    if (s == null) return null;
    const raw = String(s).trim();
    if (!raw) return null;
    const t = Date.parse(raw);
    return Number.isNaN(t) ? null : t;
  }

  function syncPreciseTimeForTitle(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? String(iso) : d.toLocaleString();
  }

  /**
   * @param {string|number|Date} iso
   * @param {boolean} [extendedMonthsYears] When true, ages ≥30 days use months; ≥365 days use years (groups Updated at).
   * @param {boolean} [shortMonthLabel] When true with extendedMonthsYears, months render as "mth" / "mths".
   */
  function formatSyncLastRelative(iso, extendedMonthsYears, shortMonthLabel) {
    if (!iso) return "—";
    const d = new Date(iso);
    const t = d.getTime();
    if (Number.isNaN(t)) return "—";
    const ageSec = Math.floor((Date.now() - t) / 1000);
    if (ageSec < 60) return "Just now";
    if (ageSec < 3600) {
      const m = Math.floor(ageSec / 60);
      return m === 1 ? "1 min ago" : `${m} mins ago`;
    }
    if (ageSec < 86400) {
      const h = Math.floor(ageSec / 3600);
      return h === 1 ? "1 hr ago" : `${h} hrs ago`;
    }
    const days = Math.floor(ageSec / 86400);
    if (!extendedMonthsYears) {
      return `${days} day${days === 1 ? "" : "s"} ago`;
    }
    if (days < 30) {
      return `${days} day${days === 1 ? "" : "s"} ago`;
    }
    if (days < 365) {
      const months = Math.max(1, Math.floor(days / 30));
      if (shortMonthLabel) {
        return months === 1 ? "1 mth ago" : `${months} mths ago`;
      }
      return `${months} month${months === 1 ? "" : "s"} ago`;
    }
    const years = Math.max(1, Math.floor(days / 365));
    return `${years} year${years === 1 ? "" : "s"} ago`;
  }

  function formatStateChangeRelative(iso) {
    return formatSyncLastRelative(iso, true, true);
  }

  const CRED_ID_TYPE_BAR_ORDER = ["tenant", "partner", "organization", "unknown"];

  function credentialIdTypeBarLabel(raw) {
    const k = String(raw || "").trim().toLowerCase();
    if (!k || k === "unknown") return "Unknown";
    return k.charAt(0).toUpperCase() + k.slice(1);
  }

  function formatCredentialCountsByIdType(byType) {
    if (!byType || typeof byType !== "object") return "—";
    const entries = Object.entries(byType).filter(([, n]) => Number(n) > 0);
    if (!entries.length) return "No credentials";
    const rank = (type) => {
      const i = CRED_ID_TYPE_BAR_ORDER.indexOf(String(type).toLowerCase());
      return i === -1 ? CRED_ID_TYPE_BAR_ORDER.length : i;
    };
    entries.sort((a, b) => {
      const d = rank(a[0]) - rank(b[0]);
      if (d !== 0) return d;
      return String(a[0]).localeCompare(String(b[0]), undefined, { sensitivity: "base" });
    });
    return entries.map(([t, n]) => `${credentialIdTypeBarLabel(t)} ${Number(n)}`).join(" · ");
  }

  function updateAppSyncCredCountsFromPayload(data) {
    const el = document.getElementById("app-sync-cred-counts");
    if (!el) return;
    const byType = data?.credential_counts_by_id_type;
    el.textContent = formatCredentialCountsByIdType(byType ?? {});
  }

  /** From /api/sync/status when the browser is not driving progress (e.g. scheduler). */
  let lastServerSyncActivity = {
    busy: false,
    credential_name: null,
    credential_id: null,
    sync_kind: null,
  };
  /** { name: string, current: number, total: number } while this tab runs a sync (sync-all or one cred). */
  let appSyncLocalProgress = null;

  const FW_TAG_DEFAULT_NEW_HOURS = 168;
  const FW_TAG_DEFAULT_UPD_HOURS = 48;
  const DEFAULT_SESSION_IDLE_MINUTES = 60;
  const fwTagUiSettings = {
    fw_new_max_age_hours: FW_TAG_DEFAULT_NEW_HOURS,
    fw_updated_max_age_hours: FW_TAG_DEFAULT_UPD_HOURS,
    session_idle_timeout_minutes: DEFAULT_SESSION_IDLE_MINUTES,
  };

  let appSyncStatusTimer = null;
  let appSyncRelativeMinuteTimer = null;
  let lastKnownSuccessfulDataSync = null;
  let syncStatusSampleCount = 0;
  let onSuccessfulDataSyncTimestampChange = null;
  let silentDataRefreshInFlight = false;

  function updateAppSyncBarRelativeDisplay() {
    const el = document.getElementById("app-sync-status-value");
    if (!el) return;
    const ts = lastKnownSuccessfulDataSync;
    if (!ts) {
      el.textContent = "—";
      el.removeAttribute("title");
      return;
    }
    const d = new Date(ts);
    if (Number.isNaN(d.getTime())) {
      el.textContent = "—";
      el.removeAttribute("title");
      return;
    }
    el.textContent = formatSyncLastRelative(ts);
    const precise = syncPreciseTimeForTitle(ts);
    if (precise) el.setAttribute("title", precise);
  }

  function renderAppSyncProgressLine() {
    const el = document.getElementById("app-sync-progress");
    if (!el) return;
    if (appSyncLocalProgress) {
      const { name, current, total } = appSyncLocalProgress;
      const label = name != null && String(name).trim() !== "" ? String(name).trim() : "Credential";
      const counter = total > 1 ? ` (${current} of ${total})` : "";
      const kind = appSyncLocalProgress.syncKind === "incremental" ? "incremental" : "full";
      const kindSuffix = kind === "incremental" ? " (incremental)" : " (full)";
      el.textContent = `Syncing ${label}${kindSuffix}${counter}`;
      el.hidden = false;
      return;
    }
    if (lastServerSyncActivity.busy && lastServerSyncActivity.credential_name) {
      const sk = lastServerSyncActivity.sync_kind;
      const suffix = sk === "incremental" ? " (incremental)" : sk === "full" ? " (full)" : "";
      el.textContent = `Syncing ${lastServerSyncActivity.credential_name}${suffix}`;
      el.hidden = false;
      return;
    }
    if (lastServerSyncActivity.busy) {
      el.textContent = "Syncing…";
      el.hidden = false;
      return;
    }
    el.textContent = "";
    el.hidden = true;
  }

  function applyAppSyncBarBusyUi() {
    const bar = document.getElementById("app-sync-status-bar");
    const spin = document.getElementById("app-sync-status-spinner");
    const btn = document.getElementById("app-sync-bar-sync-btn");
    const busy = appSyncLocalProgress != null || lastServerSyncActivity.busy === true;
    if (bar) bar.setAttribute("aria-busy", busy ? "true" : "false");
    if (spin) {
      spin.hidden = !busy;
      spin.setAttribute("aria-hidden", busy ? "false" : "true");
    }
    if (btn) btn.disabled = Boolean(busy);
    renderAppSyncProgressLine();
  }

  function setAppSyncBarBusy(busy) {
    if (!busy) {
      appSyncLocalProgress = null;
    }
    applyAppSyncBarBusyUi();
  }

  function applyAppSyncBarSyncButtonVisibility() {
    const btn = document.getElementById("app-sync-bar-sync-btn");
    if (btn) btn.hidden = !isAdmin();
  }

  async function refreshAppSyncStatusBar() {
    const el = document.getElementById("app-sync-status-value");
    if (!el) return;
    try {
      const r = await fetch("/api/sync/status", { credentials: "same-origin", cache: "no-store" });
      if (r.status === 401) {
        handleSessionExpired("Session expired. Sign in again.");
        return;
      }
      if (!r.ok) {
        lastKnownSuccessfulDataSync = null;
        el.textContent = "—";
        el.removeAttribute("title");
        updateAppSyncCredCountsFromPayload(null);
        lastServerSyncActivity = {
          busy: false,
          credential_name: null,
          credential_id: null,
          sync_kind: null,
        };
        applyAppSyncBarBusyUi();
        return;
      }
      const data = await r.json();
      updateAppSyncCredCountsFromPayload(data);
      lastServerSyncActivity = {
        busy: Boolean(data?.sync_busy),
        credential_name:
          data?.sync_credential_name != null && String(data.sync_credential_name).trim() !== ""
            ? String(data.sync_credential_name).trim()
            : null,
        credential_id:
          data?.sync_credential_id != null && String(data.sync_credential_id).trim() !== ""
            ? String(data.sync_credential_id).trim()
            : null,
        sync_kind:
          data?.sync_kind != null && String(data.sync_kind).trim() !== ""
            ? String(data.sync_kind).trim()
            : null,
      };
      applyAppSyncBarBusyUi();
      const ts = data?.last_successful_data_sync ?? null;
      syncStatusSampleCount += 1;
      if (syncStatusSampleCount === 1) {
        lastKnownSuccessfulDataSync = ts;
        updateAppSyncBarRelativeDisplay();
        return;
      }
      if (ts !== lastKnownSuccessfulDataSync) {
        const fn = onSuccessfulDataSyncTimestampChange;
        if (typeof fn === "function") fn(ts, lastKnownSuccessfulDataSync);
      }
      lastKnownSuccessfulDataSync = ts;
      updateAppSyncBarRelativeDisplay();
    } catch {
      lastKnownSuccessfulDataSync = null;
      el.textContent = "—";
      el.removeAttribute("title");
      updateAppSyncCredCountsFromPayload(null);
      lastServerSyncActivity = {
        busy: false,
        credential_name: null,
        credential_id: null,
        sync_kind: null,
      };
      applyAppSyncBarBusyUi();
    }
  }

  function startAppSyncStatusPolling() {
    if (appSyncStatusTimer != null) {
      clearInterval(appSyncStatusTimer);
      appSyncStatusTimer = null;
    }
    if (appSyncRelativeMinuteTimer != null) {
      clearInterval(appSyncRelativeMinuteTimer);
      appSyncRelativeMinuteTimer = null;
    }
    refreshAppSyncStatusBar();
    appSyncStatusTimer = window.setInterval(refreshAppSyncStatusBar, 15000);
    appSyncRelativeMinuteTimer = window.setInterval(() => {
      updateAppSyncBarRelativeDisplay();
    }, 60000);
  }

  function stopAppSyncStatusPolling() {
    if (appSyncStatusTimer != null) {
      clearInterval(appSyncStatusTimer);
      appSyncStatusTimer = null;
    }
    if (appSyncRelativeMinuteTimer != null) {
      clearInterval(appSyncRelativeMinuteTimer);
      appSyncRelativeMinuteTimer = null;
    }
    lastKnownSuccessfulDataSync = null;
    syncStatusSampleCount = 0;
    lastServerSyncActivity = {
      busy: false,
      credential_name: null,
      credential_id: null,
      sync_kind: null,
    };
    appSyncLocalProgress = null;
    setAppSyncBarBusy(false);
    const el = document.getElementById("app-sync-status-value");
    if (el) {
      el.textContent = "—";
      el.removeAttribute("title");
    }
    const credEl = document.getElementById("app-sync-cred-counts");
    if (credEl) credEl.textContent = "—";
    const progEl = document.getElementById("app-sync-progress");
    if (progEl) {
      progEl.textContent = "";
      progEl.hidden = true;
    }
  }

  function severityClass(severity) {
    const sev = (severity || "").toLowerCase();
    let cls = "sev-low";
    if (sev.includes("high") || sev.includes("critical")) cls = "sev-high";
    else if (sev.includes("medium")) cls = "sev-medium";
    return cls;
  }

  function severityTier(severity) {
    const sev = (severity || "").toLowerCase();
    if (sev.includes("high") || sev.includes("critical")) return "high";
    if (sev.includes("medium")) return "medium";
    return "low";
  }

  /** Inline SVG for dashboard alert severity (table + facet labels). */
  function severityIconSvgHtml(severity) {
    const tier = severityTier(severity);
    if (tier === "high") {
      return `<svg class="alert-sev-icon alert-sev-icon--high" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/></svg>`;
    }
    if (tier === "medium") {
      return `<svg class="alert-sev-icon alert-sev-icon--medium" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2V9h2v6z"/></svg>`;
    }
    return `<svg class="alert-sev-icon alert-sev-icon--low" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z"/></svg>`;
  }

  function formatJsonish(raw) {
    if (raw == null || raw === "") return "—";
    const s = String(raw);
    try {
      const v = JSON.parse(s);
      if (typeof v === "object" && v !== null) {
        return escapeHtml(JSON.stringify(v, null, 2));
      }
      return escapeHtml(JSON.stringify(v));
    } catch {
      return escapeHtml(s);
    }
  }

  let currentSessionUser = null;

  let sessionIdleMs = 0;
  let lastUserActivityAt = 0;
  let lastKeepaliveSentAt = 0;
  let sessionIdleWatchdogTimer = null;
  let sessionIdleListenersBound = false;
  const SESSION_IDLE_ACTIVITY_EVENTS = ["pointerdown", "keydown", "scroll", "touchstart", "wheel"];

  function stopSessionIdleWatch() {
    if (sessionIdleWatchdogTimer != null) {
      clearInterval(sessionIdleWatchdogTimer);
      sessionIdleWatchdogTimer = null;
    }
    sessionIdleMs = 0;
  }

  function onSessionUserActivity() {
    lastUserActivityAt = Date.now();
    maybeSendSessionKeepalive();
  }

  function maybeSendSessionKeepalive() {
    if (!currentSessionUser || sessionIdleMs <= 0) return;
    const now = Date.now();
    if (now - lastKeepaliveSentAt < 45000) return;
    lastKeepaliveSentAt = now;
    fetch("/api/auth/activity", { method: "POST", credentials: "same-origin", cache: "no-store" }).then((r) => {
      if (r.status === 401) handleSessionExpired("Signed out due to inactivity.");
    });
  }

  function startSessionIdleWatch() {
    stopSessionIdleWatch();
    const mins = Number(fwTagUiSettings.session_idle_timeout_minutes);
    const m = Number.isFinite(mins) && mins >= 0 ? Math.min(525600, Math.floor(mins)) : DEFAULT_SESSION_IDLE_MINUTES;
    sessionIdleMs = m * 60 * 1000;
    if (!currentSessionUser || sessionIdleMs <= 0) return;
    lastUserActivityAt = Date.now();
    lastKeepaliveSentAt = 0;
    if (!sessionIdleListenersBound) {
      SESSION_IDLE_ACTIVITY_EVENTS.forEach((ev) => {
        document.addEventListener(ev, onSessionUserActivity, { passive: true, capture: true });
      });
      sessionIdleListenersBound = true;
    }
    sessionIdleWatchdogTimer = window.setInterval(() => {
      if (!currentSessionUser || sessionIdleMs <= 0) return;
      if (Date.now() - lastUserActivityAt >= sessionIdleMs) {
        handleSessionExpired("Signed out due to inactivity.");
      }
    }, 10000);
  }

  function restartSessionIdleWatchIfAuthenticated() {
    stopSessionIdleWatch();
    startSessionIdleWatch();
  }

  function isAdmin() {
    return currentSessionUser?.role === "admin";
  }

  function handleSessionExpired(message) {
    stopSessionIdleWatch();
    stopOperationsAutoRefresh();
    stopAppSyncStatusPolling();
    currentSessionUser = null;
    const btnUser = document.getElementById("btn-user-menu");
    if (btnUser) btnUser.hidden = true;
    closeUserDropdown();
    closeProfileModal();
    closeSettingsModal();
    const uf = document.getElementById("user-form-dialog");
    if (uf && !uf.hidden) {
      uf.hidden = true;
      uf.setAttribute("aria-hidden", "true");
    }
    const uep = document.getElementById("user-edit-profile-dialog");
    if (uep && !uep.hidden) {
      uep.hidden = true;
      uep.setAttribute("aria-hidden", "true");
    }
    showLoginGate(message || "Session expired. Sign in again.");
  }

  async function loadJson(url) {
    const r = await fetch(url, { credentials: "same-origin" });
    if (r.status === 401) {
      handleSessionExpired();
      throw new Error("Unauthorized");
    }
    if (!r.ok) throw new Error(r.statusText);
    return r.json();
  }

  async function apiRequestJson(url, options = {}) {
    const skipAuthRedirectOn401 = Boolean(options.skipAuthRedirectOn401);
    const { skipAuthRedirectOn401: _s, ...fetchOptions } = options;
    const headers = { "Content-Type": "application/json", ...(fetchOptions.headers || {}) };
    const r = await fetch(url, { ...fetchOptions, headers, credentials: "same-origin" });
    if (r.status === 401 && !skipAuthRedirectOn401) {
      handleSessionExpired();
      const err = new Error("Unauthorized");
      err.status = 401;
      throw err;
    }
    if (!r.ok) {
      let msg = r.statusText;
      try {
        const j = await r.json();
        if (j.detail !== undefined) {
          msg = typeof j.detail === "string" ? j.detail : JSON.stringify(j.detail);
        }
      } catch {
        /* ignore */
      }
      const err = new Error(msg);
      err.status = r.status;
      throw err;
    }
    const ct = r.headers.get("content-type") || "";
    if (!ct.includes("application/json")) return null;
    const text = await r.text();
    return text ? JSON.parse(text) : null;
  }

  function appRoleDisplay(role) {
    if (role === "admin") return "Administrator";
    if (role === "user") return "User";
    return role ? String(role) : "—";
  }

  function applySessionUserToChrome() {
    const u = currentSessionUser;
    const nameEl = document.getElementById("user-menu-display-name");
    const roleEl = document.getElementById("user-menu-role-line");
    if (nameEl) {
      const fn = u?.full_name != null ? String(u.full_name).trim() : "";
      nameEl.textContent = fn || (u?.username ? String(u.username) : "—");
    }
    if (roleEl) {
      roleEl.textContent = u ? appRoleDisplay(u.role) : "";
    }
    if (typeof applyFwApproveButtonVisibility === "function") applyFwApproveButtonVisibility();
    applyAppSyncBarSyncButtonVisibility();
  }

  function revealAuthenticatedChrome() {
    const overlay = document.getElementById("auth-overlay");
    if (overlay) {
      overlay.classList.remove("auth-overlay--anim");
      overlay.hidden = true;
      overlay.setAttribute("aria-hidden", "true");
    }
    const btnUser = document.getElementById("btn-user-menu");
    if (btnUser) btnUser.hidden = false;
    applySessionUserToChrome();
  }

  function triggerAuthIntro() {
    const overlay = document.getElementById("auth-overlay");
    if (!overlay || overlay.hidden) return;
    overlay.classList.remove("auth-overlay--anim");
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        overlay.classList.add("auth-overlay--anim");
      });
    });
  }

  function scheduleAuthGateFocus() {
    const reduce =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const delay = reduce ? 0 : 560;
    window.setTimeout(() => {
      const o = document.getElementById("auth-overlay");
      if (!o || o.hidden) return;
      const setup = document.getElementById("auth-setup-block");
      const login = document.getElementById("auth-login-block");
      if (setup && !setup.hidden) {
        document.getElementById("auth-setup-password")?.focus();
      } else if (login && !login.hidden) {
        document.getElementById("auth-login-username")?.focus();
      }
    }, delay);
  }

  function showSetupGate() {
    const overlay = document.getElementById("auth-overlay");
    const title = document.getElementById("auth-overlay-title");
    const sub = document.getElementById("auth-overlay-subtitle");
    const setup = document.getElementById("auth-setup-block");
    const login = document.getElementById("auth-login-block");
    if (!overlay || !setup || !login) return;
    if (title) title.textContent = "Set administrator password";
    if (sub) {
      sub.textContent = "";
      sub.hidden = true;
    }
    setup.hidden = false;
    login.hidden = true;
    overlay.hidden = false;
    overlay.setAttribute("aria-hidden", "false");
    const st = document.getElementById("auth-setup-status");
    if (st) {
      st.textContent = "";
      st.classList.remove("is-error", "is-ok");
    }
    document.getElementById("auth-setup-form")?.reset();
    triggerAuthIntro();
    scheduleAuthGateFocus();
  }

  function showLoginGate(prefillMessage) {
    const overlay = document.getElementById("auth-overlay");
    const title = document.getElementById("auth-overlay-title");
    const sub = document.getElementById("auth-overlay-subtitle");
    const setup = document.getElementById("auth-setup-block");
    const login = document.getElementById("auth-login-block");
    if (!overlay || !setup || !login) return;
    if (title) title.textContent = "Sign in to SFOS Central Management Portal";
    if (sub) {
      sub.textContent = "Use your local account credentials.";
      sub.hidden = false;
    }
    setup.hidden = true;
    login.hidden = false;
    overlay.hidden = false;
    overlay.setAttribute("aria-hidden", "false");
    const lst = document.getElementById("auth-login-status");
    if (lst) {
      lst.textContent = prefillMessage || "";
      lst.classList.toggle("is-error", Boolean(prefillMessage));
      lst.classList.remove("is-ok");
    }
    document.getElementById("auth-login-form")?.reset();
    triggerAuthIntro();
    scheduleAuthGateFocus();
  }

  async function bootAuth() {
    try {
      const r = await fetch("/api/auth/status", {
        credentials: "same-origin",
        cache: "no-store",
      });
      const st = await r.json();
      if (st.needs_admin_password_setup === true) {
        showSetupGate();
        return;
      }
      if (!st.authenticated) {
        showLoginGate();
        return;
      }
      currentSessionUser = st.user;
      revealAuthenticatedChrome();
      await init();
      startAppSyncStatusPolling();
    } catch (e) {
      console.error(e);
      showLoginGate("Could not reach the server.");
    }
  }

  function initAuthForms() {
    document.getElementById("auth-setup-form")?.addEventListener("submit", async (e) => {
      e.preventDefault();
      const p1 = document.getElementById("auth-setup-password")?.value || "";
      const p2 = document.getElementById("auth-setup-password-confirm")?.value || "";
      const st = document.getElementById("auth-setup-status");
      if (p1 !== p2) {
        if (st) {
          st.textContent = "Passwords do not match.";
          st.classList.add("is-error");
          st.classList.remove("is-ok");
        }
        return;
      }
      try {
        const res = await apiRequestJson("/api/auth/setup-admin-password", {
          method: "POST",
          body: JSON.stringify({ password: p1, password_confirm: p2 }),
        });
        currentSessionUser = res?.user;
        revealAuthenticatedChrome();
        await init();
        startAppSyncStatusPolling();
      } catch (err) {
        if (st) {
          st.textContent = err.message || "Could not save password.";
          st.classList.add("is-error");
          st.classList.remove("is-ok");
        }
      }
    });

    document.getElementById("auth-login-form")?.addEventListener("submit", async (e) => {
      e.preventDefault();
      const username = document.getElementById("auth-login-username")?.value?.trim() || "";
      const password = document.getElementById("auth-login-password")?.value || "";
      const st = document.getElementById("auth-login-status");
      try {
        const res = await apiRequestJson("/api/auth/login", {
          method: "POST",
          body: JSON.stringify({ username, password }),
          skipAuthRedirectOn401: true,
        });
        currentSessionUser = res?.user;
        revealAuthenticatedChrome();
        if (st) {
          st.textContent = "";
          st.classList.remove("is-error");
        }
        await init();
        startAppSyncStatusPolling();
      } catch (err) {
        const msg = err.message || "";
        if (
          msg.includes("administrator password first") ||
          msg.includes("Initial setup") ||
          msg.toLowerCase().includes("initial setup")
        ) {
          showSetupGate();
          const sst = document.getElementById("auth-setup-status");
          if (sst) {
            sst.textContent =
              "This installation still needs an administrator password. Enter and confirm it below.";
            sst.classList.add("is-ok");
            sst.classList.remove("is-error");
          }
          return;
        }
        if (st) {
          st.textContent = msg || "Sign-in failed.";
          st.classList.add("is-error");
        }
      }
    });
  }

  let userDropdownOpen = false;

  function closeUserDropdown() {
    const dd = document.getElementById("user-menu-dropdown");
    const trig = document.getElementById("btn-user-menu");
    if (dd) dd.hidden = true;
    if (trig) trig.setAttribute("aria-expanded", "false");
    userDropdownOpen = false;
  }

  function toggleUserDropdown() {
    const dd = document.getElementById("user-menu-dropdown");
    const trig = document.getElementById("btn-user-menu");
    if (!dd || !trig) return;
    const next = dd.hidden;
    dd.hidden = !next;
    trig.setAttribute("aria-expanded", next ? "true" : "false");
    userDropdownOpen = next;
  }

  function initUserMenu() {
    const trig = document.getElementById("btn-user-menu");
    trig?.addEventListener("click", (ev) => {
      ev.stopPropagation();
      toggleUserDropdown();
    });
    document.getElementById("user-menu-dropdown")?.addEventListener("click", (ev) => {
      ev.stopPropagation();
    });
    document.getElementById("user-menu-profile")?.addEventListener("click", () => {
      closeUserDropdown();
      openProfileModal("profile");
    });
    document.getElementById("user-menu-change-password")?.addEventListener("click", () => {
      closeUserDropdown();
      openProfileModal("password");
    });
    document.getElementById("user-menu-login-central")?.addEventListener("click", () => {
      closeUserDropdown();
    });
    document.getElementById("user-menu-login-partner")?.addEventListener("click", (ev) => {
      ev.preventDefault();
      window.open(
        "https://central.sophos.com/manage/partner",
        "SophosPartnerDashboard",
        "noopener,noreferrer",
      );
      closeUserDropdown();
    });
    document.getElementById("user-menu-theme")?.addEventListener("click", (ev) => {
      ev.stopPropagation();
      toggleColorTheme();
    });
    syncUserMenuThemeButton();
    document.getElementById("user-menu-logout")?.addEventListener("click", async () => {
      closeUserDropdown();
      try {
        await fetch("/api/auth/logout", { method: "POST", credentials: "same-origin" });
      } catch {
        /* still show login */
      }
      currentSessionUser = null;
      stopSessionIdleWatch();
      stopAppSyncStatusPolling();
      const btnUser = document.getElementById("btn-user-menu");
      if (btnUser) btnUser.hidden = true;
      showLoginGate();
    });
    document.addEventListener("click", () => {
      if (userDropdownOpen) closeUserDropdown();
    });
  }

  let profileFocusBefore = null;

  function setProfileModalSection(section) {
    const s = section === "password" ? "password" : "profile";
    document.querySelectorAll("#profile-nav .settings-nav__item").forEach((btn) => {
      const on = btn.dataset.profileSection === s;
      btn.classList.toggle("is-active", on);
      if (on) btn.setAttribute("aria-current", "page");
      else btn.removeAttribute("aria-current");
    });
    document.querySelectorAll("[data-profile-panel]").forEach((p) => {
      const on = p.dataset.profilePanel === s;
      p.classList.toggle("is-active", on);
      p.hidden = !on;
    });
  }

  function openProfileModal(section) {
    const m = document.getElementById("profile-modal");
    if (!m) return;
    profileFocusBefore = document.activeElement;
    m.hidden = false;
    m.setAttribute("aria-hidden", "false");
    document.body.style.overflow = "hidden";
    const sec = section === "password" ? "password" : "profile";
    setProfileModalSection(sec);
    const stPw = document.getElementById("profile-password-status");
    if (stPw) {
      stPw.textContent = "";
      stPw.classList.remove("is-error", "is-ok");
    }
    const stDet = document.getElementById("profile-details-status");
    if (stDet) {
      stDet.textContent = "";
      stDet.classList.remove("is-error", "is-ok");
    }
    document.getElementById("profile-password-form")?.reset();
    if (currentSessionUser) {
      const fnDisp = document.getElementById("profile-full-name-display");
      const un = document.getElementById("profile-username-readonly");
      const em = document.getElementById("profile-email");
      const mob = document.getElementById("profile-mobile");
      if (fnDisp) {
        const n = currentSessionUser.full_name != null ? String(currentSessionUser.full_name).trim() : "";
        fnDisp.textContent = n || "—";
        fnDisp.classList.toggle("muted", !n);
      }
      if (un) un.value = currentSessionUser.username != null ? String(currentSessionUser.username) : "";
      if (em) em.value = currentSessionUser.email != null ? String(currentSessionUser.email).trim() : "";
      if (mob) mob.value = currentSessionUser.mobile != null ? String(currentSessionUser.mobile).trim() : "";
    }
    if (sec === "password") {
      document.getElementById("profile-current-password")?.focus();
    } else {
      document.getElementById("profile-email")?.focus();
    }
  }

  function closeProfileModal() {
    const m = document.getElementById("profile-modal");
    if (!m || m.hidden) return;
    m.hidden = true;
    m.setAttribute("aria-hidden", "true");
    document.body.style.overflow = "";
    if (profileFocusBefore && typeof profileFocusBefore.focus === "function") profileFocusBefore.focus();
    profileFocusBefore = null;
  }

  function initProfileModal() {
    document.getElementById("profile-modal-close")?.addEventListener("click", closeProfileModal);
    document.querySelector("#profile-modal .settings-modal__backdrop")?.addEventListener("click", closeProfileModal);
    document.querySelectorAll("#profile-nav .settings-nav__item").forEach((btn) => {
      btn.addEventListener("click", () => {
        const s = btn.dataset.profileSection;
        if (s) setProfileModalSection(s);
        if (s === "password") {
          document.getElementById("profile-current-password")?.focus();
        } else {
          document.getElementById("profile-email")?.focus();
        }
      });
    });
    document.getElementById("profile-details-form")?.addEventListener("submit", async (e) => {
      e.preventDefault();
      const st = document.getElementById("profile-details-status");
      const email = document.getElementById("profile-email")?.value?.trim() ?? "";
      const mobile = document.getElementById("profile-mobile")?.value?.trim() ?? "";
      const sub = document.getElementById("profile-details-submit");
      if (sub) sub.disabled = true;
      try {
        const res = await apiRequestJson("/api/auth/profile", {
          method: "PATCH",
          body: JSON.stringify({ email, mobile }),
        });
        if (res?.user) {
          currentSessionUser = res.user;
          applySessionUserToChrome();
        }
        if (st) {
          st.textContent = "Profile saved.";
          st.classList.remove("is-error");
          st.classList.add("is-ok");
        }
      } catch (err) {
        if (st) {
          st.textContent = err.message || "Could not save profile.";
          st.classList.add("is-error");
          st.classList.remove("is-ok");
        }
      } finally {
        if (sub) sub.disabled = false;
      }
    });
    document.getElementById("profile-password-form")?.addEventListener("submit", async (e) => {
      e.preventDefault();
      const cur = document.getElementById("profile-current-password")?.value || "";
      const n1 = document.getElementById("profile-new-password")?.value || "";
      const n2 = document.getElementById("profile-new-password-confirm")?.value || "";
      const st = document.getElementById("profile-password-status");
      if (n1 !== n2) {
        if (st) {
          st.textContent = "New passwords do not match.";
          st.classList.add("is-error");
        }
        return;
      }
      try {
        await apiRequestJson("/api/auth/change-password", {
          method: "POST",
          body: JSON.stringify({
            current_password: cur,
            new_password: n1,
            new_password_confirm: n2,
          }),
        });
        if (st) {
          st.textContent = "Password updated.";
          st.classList.remove("is-error");
          st.classList.add("is-ok");
        }
        document.getElementById("profile-password-form")?.reset();
      } catch (err) {
        if (st) {
          st.textContent = err.message || "Could not update password.";
          st.classList.add("is-error");
          st.classList.remove("is-ok");
        }
      }
    });
  }

  function applySettingsNavForRole() {
    const admin = isAdmin();
    document.querySelectorAll("#settings-nav .settings-nav__item[data-requires-admin='true']").forEach((el) => {
      el.hidden = !admin;
    });
    const actions = document.getElementById("settings-users-actions");
    const wrap = document.getElementById("settings-users-wrap");
    if (actions) actions.hidden = !admin;
    if (wrap) wrap.classList.toggle("settings-user-readonly", !admin);
  }

  function openUserFormDialog() {
    const d = document.getElementById("user-form-dialog");
    if (!d) return;
    document.getElementById("user-form")?.reset();
    const st = document.getElementById("user-form-status");
    if (st) {
      st.textContent = "";
      st.classList.remove("is-error", "is-ok");
    }
    d.hidden = false;
    d.setAttribute("aria-hidden", "false");
    document.getElementById("user-form-username")?.focus();
  }

  function closeUserFormDialog() {
    const d = document.getElementById("user-form-dialog");
    if (!d || d.hidden) return;
    d.hidden = true;
    d.setAttribute("aria-hidden", "true");
  }

  /* ---------- Settings modal ---------- */
  let settingsFocusBeforeOpen = null;

  function openSettingsModal() {
    const m = document.getElementById("settings-modal");
    if (!m) return;
    settingsFocusBeforeOpen = document.activeElement;
    m.hidden = false;
    m.setAttribute("aria-hidden", "false");
    document.body.style.overflow = "hidden";
    const filter = document.getElementById("settings-nav-filter");
    if (filter) filter.value = "";
    document.querySelectorAll("#settings-modal [data-settings-section]").forEach((btn) => {
      btn.hidden = false;
    });
    applySettingsNavForRole();
    filterSettingsNav();
    filter?.focus();
  }

  function closeCredentialFormDialog() {
    const d = document.getElementById("credential-form-dialog");
    if (!d || d.hidden) return;
    d.hidden = true;
    d.setAttribute("aria-hidden", "true");
  }

  function closeUserEditProfileDialog() {
    const d = document.getElementById("user-edit-profile-dialog");
    if (!d || d.hidden) return;
    d.hidden = true;
    d.setAttribute("aria-hidden", "true");
  }

  function closeSettingsModal() {
    const m = document.getElementById("settings-modal");
    if (!m || m.hidden) return;
    closeCredentialFormDialog();
    closeUserFormDialog();
    closeUserEditProfileDialog();
    m.hidden = true;
    m.setAttribute("aria-hidden", "true");
    document.body.style.overflow = "";
    if (settingsFocusBeforeOpen && typeof settingsFocusBeforeOpen.focus === "function") {
      settingsFocusBeforeOpen.focus();
    }
    settingsFocusBeforeOpen = null;
  }

  async function loadUiSettings() {
    try {
      const j = await loadJson("/api/settings/ui");
      const n = Number(j?.fw_new_max_age_hours);
      const u = Number(j?.fw_updated_max_age_hours);
      const sid = Number(j?.session_idle_timeout_minutes);
      if (Number.isFinite(n) && n >= 1) {
        fwTagUiSettings.fw_new_max_age_hours = Math.min(8760, Math.floor(n));
      }
      if (Number.isFinite(u) && u >= 1) {
        fwTagUiSettings.fw_updated_max_age_hours = Math.min(8760, Math.floor(u));
      }
      if (Number.isFinite(sid) && sid >= 0) {
        fwTagUiSettings.session_idle_timeout_minutes = Math.min(525600, Math.floor(sid));
      }
      restartSessionIdleWatchIfAuthenticated();
    } catch {
      /* keep in-memory defaults */
    }
  }

  async function loadSettingsGeneral() {
    await loadUiSettings();
    const newIn = document.getElementById("settings-general-new-hours");
    const updIn = document.getElementById("settings-general-upd-hours");
    const idleIn = document.getElementById("settings-general-session-idle");
    if (newIn) newIn.value = String(fwTagUiSettings.fw_new_max_age_hours);
    if (updIn) updIn.value = String(fwTagUiSettings.fw_updated_max_age_hours);
    if (idleIn) idleIn.value = String(fwTagUiSettings.session_idle_timeout_minutes);
  }

  function setSettingsSection(section) {
    let s = section;
    if ((s === "credentials" || s === "sync") && !isAdmin()) {
      s = "users";
    }
    document.querySelectorAll("#settings-modal [data-settings-section]").forEach((btn) => {
      const on = btn.dataset.settingsSection === s;
      btn.classList.toggle("is-active", on);
      if (on) btn.setAttribute("aria-current", "page");
      else btn.removeAttribute("aria-current");
    });
    document.querySelectorAll("#settings-modal .settings-panel").forEach((p) => {
      const on = p.dataset.settingsPanel === s;
      p.classList.toggle("is-active", on);
      p.hidden = !on;
    });
    if (s === "general") {
      loadSettingsGeneral().catch(console.error);
    }
    if (s === "credentials") {
      loadSettingsCredentials().catch(console.error);
    }
    if (s === "sync") {
      loadSettingsSync().catch(console.error);
    }
    if (s === "users") {
      loadSettingsUsers().catch(console.error);
    }
  }

  const SETTINGS_SECTION_EXTRA_SEARCH_ROOTS = {
    users: ["#user-form-dialog", "#user-edit-profile-dialog"],
    credentials: ["#credential-form-dialog"],
  };

  function settingsSectionSearchBlob(section) {
    if (!section) return "";
    const parts = [];
    const panel = document.querySelector(`#settings-modal .settings-panel[data-settings-panel="${section}"]`);
    if (panel) {
      const heading = panel.querySelector(".settings-panel__heading");
      if (heading) parts.push(heading.textContent);
      panel.querySelectorAll(".settings-form__label").forEach((el) => parts.push(el.textContent));
      panel.querySelectorAll(".settings-about__term").forEach((el) => parts.push(el.textContent));
      panel.querySelectorAll("thead th").forEach((el) => parts.push(el.textContent));
    }
    const extras = SETTINGS_SECTION_EXTRA_SEARCH_ROOTS[section];
    if (extras) {
      for (const sel of extras) {
        const root = document.querySelector(sel);
        if (!root) continue;
        root.querySelectorAll(".settings-subdialog__title, .settings-form__label").forEach((el) =>
          parts.push(el.textContent),
        );
      }
    }
    return parts.join(" ").replace(/\s+/g, " ").trim().toLowerCase();
  }

  function filterSettingsNav() {
    const q = (document.getElementById("settings-nav-filter")?.value || "").trim().toLowerCase();
    document.querySelectorAll("#settings-nav .settings-nav__item").forEach((btn) => {
      const section = btn.dataset.settingsSection;
      const navText = (btn.querySelector("span")?.textContent || "").toLowerCase();
      const blob = settingsSectionSearchBlob(section);
      const match = q === "" || navText.includes(q) || blob.includes(q);
      const needsAdmin = btn.dataset.requiresAdmin === "true";
      btn.hidden = !match || (needsAdmin && !isAdmin());
    });
    const aboutBtn = document.getElementById("settings-nav-about");
    if (aboutBtn) {
      const section = aboutBtn.dataset.settingsSection;
      const navText = (aboutBtn.querySelector("span")?.textContent || "").toLowerCase();
      const blob = settingsSectionSearchBlob(section);
      const match = q === "" || navText.includes(q) || blob.includes(q);
      aboutBtn.hidden = !match;
    }
  }

  const CRED_ROW_ICONS = {
    test: '<svg class="settings-cred-icon-btn__svg" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M17.65 6.35A7.958 7.958 0 0 0 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08A5.99 5.99 0 0 1 12 18c-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/></svg>',
    edit: '<svg class="settings-cred-icon-btn__svg" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34c-.39-.39-1.02-.39-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg>',
    del: '<svg class="settings-cred-icon-btn__svg" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>',
    sync: '<svg class="settings-cred-icon-btn__svg" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M12 4V1L8 5l4 4V6c3.31 0 6 2.69 6 6 0 1.01-.25 1.97-.7 2.8l1.46 1.46C19.54 15.03 20 13.57 20 12c0-4.42-3.58-8-8-8zm0 14c-3.31 0-6-2.69-6-6 0-1.01.25-1.97.7-2.8L5.24 7.74C4.46 8.97 4 10.43 4 12c0 4.42 3.58 8 8 8v3l4-4-4-4v3z"/></svg>',
    clipboard:
      '<svg class="settings-cred-icon-btn__svg" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/></svg>',
  };

  const USER_ROW_ICONS = {
    role: '<svg class="settings-cred-icon-btn__svg" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/></svg>',
    edit: CRED_ROW_ICONS.edit,
    key: '<svg class="settings-cred-icon-btn__svg" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M12.65 10A5.99 5.99 0 0 0 7 6c-3.31 0-6 2.69-6 6 0 1.66.68 3.15 1.76 4.24l1.42-1.42A3.96 3.96 0 0 1 3 12c0-2.21 1.79-4 4-4 1.38 0 2.6.7 3.31 1.76L12 11h5V6l-1.79 1.79C14.55 6.67 12.83 6 11 6a7 7 0 0 0 0 14c3.87 0 7-3.13 7-7h-2c0 2.76-2.24 5-5 5s-5-2.24-5-5 2.24-5 5-5c1.13 0 2.17.39 3.02 1.02L12.65 10z"/></svg>',
    del: CRED_ROW_ICONS.del,
  };

  function cellTextOrDash(val) {
    const t = val != null ? String(val).trim() : "";
    return t ? escapeHtml(t) : "—";
  }

  async function loadSettingsUsers() {
    const rows = await loadJson("/api/settings/users");
    const tbody = document.getElementById("settings-users-body");
    if (!tbody) return;
    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="7" class="muted">No users.</td></tr>';
      return;
    }
    const adminUi = isAdmin();
    tbody.innerHTML = rows
      .map((row) => {
        const id = escapeHtml(row.id);
        const actions = adminUi
          ? `<td class="settings-cred-actions settings-user-actions-cell">
          <div class="settings-cred-actions">
            <button type="button" class="settings-cred-icon-btn user-role-btn" data-id="${id}" title="Change role" aria-label="Change role">${USER_ROW_ICONS.role}</button>
            <button type="button" class="settings-cred-icon-btn user-profile-btn" data-id="${id}" title="Edit name and contact" aria-label="Edit name and contact">${USER_ROW_ICONS.edit}</button>
            <button type="button" class="settings-cred-icon-btn user-password-btn" data-id="${id}" title="Set password" aria-label="Set password">${USER_ROW_ICONS.key}</button>
            <button type="button" class="settings-cred-icon-btn settings-cred-icon-btn--danger user-delete-btn" data-id="${id}" title="Delete user" aria-label="Delete user">${USER_ROW_ICONS.del}</button>
          </div>
        </td>`
          : `<td class="settings-user-actions-cell"></td>`;
        return `<tr data-user-id="${id}">
          <td><strong>${escapeHtml(row.username)}</strong></td>
          <td>${cellTextOrDash(row.full_name)}</td>
          <td>${cellTextOrDash(row.email)}</td>
          <td>${cellTextOrDash(row.mobile)}</td>
          <td class="settings-user-cell--role">${escapeHtml(row.role)}</td>
          <td class="muted">${fmtDate(row.updated_at)}</td>
          ${actions}
        </tr>`;
      })
      .join("");
  }

  let _appNotifIdSeq = 0;

  function getNotificationsFlyoutListEl() {
    return document.getElementById("notifications-flyout-list");
  }

  function updateNotificationsBadge() {
    const list = getNotificationsFlyoutListEl();
    const badge = document.getElementById("notifications-badge");
    const n = list ? list.querySelectorAll(".app-notification").length : 0;
    if (!badge) return;
    if (n > 0) {
      badge.hidden = false;
      badge.removeAttribute("aria-hidden");
      badge.setAttribute("aria-label", `${n} unacknowledged notification${n === 1 ? "" : "s"}`);
    } else {
      badge.hidden = true;
      badge.setAttribute("aria-hidden", "true");
      badge.removeAttribute("aria-label");
    }
  }

  function updateNotificationsEmptyState() {
    const list = getNotificationsFlyoutListEl();
    const empty = document.getElementById("notifications-flyout-empty");
    if (!list || !empty) return;
    const n = list.querySelectorAll(".app-notification").length;
    empty.hidden = n > 0;
  }

  function removeAppNotification(elOrId) {
    const el = typeof elOrId === "string" ? document.getElementById(elOrId) : elOrId;
    el?.remove();
    updateNotificationsBadge();
    updateNotificationsEmptyState();
  }

  function addAppNotification(variant, title, detailText) {
    const list = getNotificationsFlyoutListEl();
    if (!list) return null;
    const id = `app-notif-${++_appNotifIdSeq}`;
    const el = document.createElement("div");
    el.id = id;
    const v = variant === "success" || variant === "info" ? variant : "error";
    el.className = `app-notification app-notification--${v}`;
    el.setAttribute("role", "listitem");
    const t = title != null && String(title).trim() !== "" ? String(title) : "Notice";
    const msg = escapeHtml(detailText != null && String(detailText) !== "" ? String(detailText) : "");
    const closeSvg =
      '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>';
    el.innerHTML = `<div class="app-notification__body">
      <p class="app-notification__title">${escapeHtml(t)}</p>
      <p class="app-notification__msg">${msg}</p>
    </div><button type="button" class="app-notification__close" aria-label="Dismiss notification" title="Dismiss">${closeSvg}</button>`;
    el.querySelector(".app-notification__close")?.addEventListener("click", () => removeAppNotification(id));
    list.prepend(el);
    updateNotificationsBadge();
    updateNotificationsEmptyState();
    return id;
  }

  /** In-app notification in the right-hand panel (replaces blocking browser alerts for routine feedback). */
  function notifyAppUser(title, message, variant = "error") {
    const v = variant === "success" || variant === "info" ? variant : "error";
    addAppNotification(v, title || "Notice", message == null ? "" : String(message));
  }

  function showCredentialRowTestToast(success, detailText, opts) {
    const title =
      opts && opts.title != null && opts.title !== ""
        ? opts.title
        : success
          ? "Connection OK"
          : "Test failed";
    const body =
      detailText != null && String(detailText) !== ""
        ? String(detailText)
        : success
          ? "Verified with Sophos Central."
          : "Unknown error";
    addAppNotification(success ? "success" : "error", title, body);
  }

  function initNotificationsFlyout() {
    const toggle = document.getElementById("btn-notifications-toggle");
    const backdrop = document.getElementById("notifications-flyout-backdrop");
    const panel = document.getElementById("notifications-flyout");
    const closeBtn = document.getElementById("btn-notifications-close");
    if (!toggle || !backdrop || !panel) return;

    updateNotificationsEmptyState();

    function setOpen(open) {
      toggle.setAttribute("aria-expanded", open ? "true" : "false");
      backdrop.classList.toggle("is-open", open);
      panel.classList.toggle("is-open", open);
      backdrop.setAttribute("aria-hidden", open ? "false" : "true");
      panel.setAttribute("aria-hidden", open ? "false" : "true");
      if (open) {
        closeBtn?.focus({ preventScroll: true });
      }
    }

    function isOpen() {
      return panel.classList.contains("is-open");
    }

    toggle.addEventListener("click", () => setOpen(!isOpen()));
    backdrop.addEventListener("click", () => setOpen(false));
    closeBtn?.addEventListener("click", () => setOpen(false));
    panel.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && isOpen()) {
        e.stopPropagation();
        setOpen(false);
        toggle.focus();
      }
    });
  }

  async function loadSettingsCredentials() {
    const rows = await loadJson("/api/settings/credentials");
    const tbody = document.getElementById("settings-credentials-body");
    if (!tbody) return;
    if (!rows.length) {
      tbody.innerHTML =
        '<tr><td colspan="5" class="muted">No credentials yet. Use <strong>Add credential</strong> to verify and store a Central API client.</td></tr>';
      return;
    }
    tbody.innerHTML = rows
      .map((row) => {
        const id = escapeHtml(row.id);
        const cidRaw = row.client_id != null && String(row.client_id) !== "" ? String(row.client_id) : "";
        const whoRaw =
          row.whoami != null && row.whoami.id != null && String(row.whoami.id) !== ""
            ? String(row.whoami.id)
            : "";
        const titleClient = cidRaw ? ` title="${escapeHtml(cidRaw)}"` : "";
        const copyBtn = whoRaw
          ? `<button type="button" class="settings-cred-icon-btn settings-cred-copy-btn cred-copy-central" data-clipboard-text="${escapeAttr(whoRaw)}" title="Copy Central ID" aria-label="Copy Central ID">${CRED_ROW_ICONS.clipboard}</button>`
          : "";
        const centralCell = whoRaw
          ? `<td class="settings-cred-central-cell"><div class="settings-cred-central-cell__inner"><span class="settings-cred-central-cell__text fw-col-code" title="${escapeHtml(whoRaw)}">${escapeHtml(whoRaw)}</span>${copyBtn}</div></td>`
          : `<td class="settings-cred-central-cell"><div class="settings-cred-central-cell__inner"><span class="settings-cred-central-cell__text fw-col-code muted">—</span></div></td>`;
        return `<tr data-credential-id="${id}">
          <td><strong>${escapeHtml(row.name)}</strong></td>
          <td class="fw-col-code settings-cred-client-cell settings-cred-truncate"${titleClient}>${escapeHtml(cidRaw || "—")}</td>
          <td>${escapeHtml(row.id_type || "—")}</td>
          ${centralCell}
          <td class="settings-cred-actions">
            <button type="button" class="settings-cred-icon-btn cred-retest" data-id="${id}" title="Test connection" aria-label="Test connection">${CRED_ROW_ICONS.test}</button>
            <button type="button" class="settings-cred-icon-btn cred-rename" data-id="${id}" title="Edit name" aria-label="Edit name">${CRED_ROW_ICONS.edit}</button>
            <button type="button" class="settings-cred-icon-btn settings-cred-icon-btn--danger cred-delete" data-id="${id}" title="Delete" aria-label="Delete credential">${CRED_ROW_ICONS.del}</button>
          </td>
        </tr>`;
      })
      .join("");
  }

  const SYNC_INTERVAL_OPTIONS = [
    { value: "10m", label: "10 mins" },
    { value: "15m", label: "15 mins" },
    { value: "30m", label: "30 mins" },
    { value: "hourly", label: "Hourly" },
    { value: "3h", label: "3 hrs" },
    { value: "6h", label: "6 hrs" },
    { value: "12h", label: "12 hrs" },
    { value: "daily", label: "Daily" },
    { value: "none", label: "None" },
  ];

  const SYNC_INTERVAL_ALLOWED = new Set(SYNC_INTERVAL_OPTIONS.map((o) => o.value));

  function normalizeCredentialSyncInterval(raw) {
    const v = raw != null && String(raw).trim() !== "" ? String(raw).trim() : "12h";
    return SYNC_INTERVAL_ALLOWED.has(v) ? v : "12h";
  }

  function syncIntervalSelectHtml(credentialId, selected) {
    const sel = normalizeCredentialSyncInterval(selected);
    const eid = escapeAttr(credentialId);
    const opts = SYNC_INTERVAL_OPTIONS.map(
      (o) =>
        `<option value="${escapeHtml(o.value)}"${o.value === sel ? " selected" : ""}>${escapeHtml(o.label)}</option>`
    ).join("");
    return `<select class="settings-sync-interval-select" data-credential-id="${eid}" aria-label="Full sync interval for this credential">${opts}</select>`;
  }

  const INCREMENTAL_SYNC_INTERVAL_OPTIONS = [
    { value: "1m", label: "1 min" },
    { value: "2m", label: "2 mins" },
    { value: "3m", label: "3 mins" },
    { value: "4m", label: "4 mins" },
    { value: "5m", label: "5 mins" },
    { value: "10m", label: "10 mins" },
    { value: "15m", label: "15 mins" },
    { value: "30m", label: "30 mins" },
    { value: "60m", label: "60 mins" },
    { value: "none", label: "None" },
  ];

  const INCREMENTAL_SYNC_INTERVAL_ALLOWED = new Set(
    INCREMENTAL_SYNC_INTERVAL_OPTIONS.map((o) => o.value)
  );

  function normalizeCredentialIncrementalSyncInterval(raw) {
    const v = raw != null && String(raw).trim() !== "" ? String(raw).trim() : "15m";
    return INCREMENTAL_SYNC_INTERVAL_ALLOWED.has(v) ? v : "15m";
  }

  function incrementalSyncIntervalSelectHtml(credentialId, selected) {
    const sel = normalizeCredentialIncrementalSyncInterval(selected);
    const eid = escapeAttr(credentialId);
    const opts = INCREMENTAL_SYNC_INTERVAL_OPTIONS.map(
      (o) =>
        `<option value="${escapeHtml(o.value)}"${o.value === sel ? " selected" : ""}>${escapeHtml(o.label)}</option>`
    ).join("");
    return `<select class="settings-inc-sync-interval-select" data-credential-id="${eid}" aria-label="Incremental sync interval for this credential">${opts}</select>`;
  }

  function settingsSyncNextHintHtml(nextInfo) {
    const nextTitle = nextInfo.title ? escapeAttr(nextInfo.title) : "";
    const nextText = escapeHtml(nextInfo.text);
    if (nextTitle) {
      return `<div class="settings-sync-next-hint settings-sync-relative muted" title="${nextTitle}">${nextText}</div>`;
    }
    return `<div class="settings-sync-next-hint settings-sync-relative muted">${nextText}</div>`;
  }

  function settingsSyncFullIntervalStackHtml(row) {
    const iv = normalizeCredentialSyncInterval(row.sync_interval);
    const next = formatSyncNextRelative(row.next_scheduled_sync_at, iv);
    return `<div class="settings-sync-interval-stack">${syncIntervalSelectHtml(row.id, row.sync_interval)}${settingsSyncNextHintHtml(next)}</div>`;
  }

  function settingsSyncIncrementalIntervalStackHtml(row) {
    const ij = normalizeCredentialIncrementalSyncInterval(row.incremental_sync_interval);
    const nxi = formatSyncNextRelative(row.next_scheduled_incremental_sync_at, ij);
    return `<div class="settings-sync-interval-stack">${incrementalSyncIntervalSelectHtml(row.id, row.incremental_sync_interval)}${settingsSyncNextHintHtml(nxi)}</div>`;
  }

  function formatSyncNextRelative(nextIso, intervalNorm) {
    if (intervalNorm === "none") return { text: "—", title: "" };
    if (!nextIso) {
      return {
        text: "Pending",
        title: "No successful sync yet. After the first sync, the next scheduled time appears here.",
      };
    }
    const d = new Date(nextIso);
    const t = d.getTime();
    if (Number.isNaN(t)) return { text: "—", title: "" };
    const deltaSec = Math.floor((t - Date.now()) / 1000);
    const precise = syncPreciseTimeForTitle(nextIso);
    if (deltaSec <= 0) {
      return { text: "Due now", title: precise };
    }
    if (deltaSec < 60) return { text: "Soon", title: precise };
    if (deltaSec < 3600) {
      const m = Math.floor(deltaSec / 60);
      return { text: m === 1 ? "in 1 min" : `in ${m} mins`, title: precise };
    }
    if (deltaSec < 86400) {
      const h = Math.floor(deltaSec / 3600);
      return { text: h === 1 ? "in 1 hr" : `in ${h} hrs`, title: precise };
    }
    const days = Math.floor(deltaSec / 86400);
    return { text: `in ${days} day${days === 1 ? "" : "s"}`, title: precise };
  }

  async function loadSettingsSync() {
    const rows = await loadJson("/api/settings/credentials");
    const tbody = document.getElementById("settings-sync-body");
    if (!tbody) return;
    if (!rows.length) {
      tbody.innerHTML =
        '<tr><td colspan="6" class="muted">No credentials yet. Add credentials under <strong>Central credentials</strong>.</td></tr>';
      return;
    }
    tbody.innerHTML = rows
      .map((row) => {
        const name = escapeHtml(row.name);
        const idAttr = escapeAttr(row.id);
        const lastTitle = row.last_sync ? escapeAttr(syncPreciseTimeForTitle(row.last_sync)) : "";
        const lastText = escapeHtml(formatSyncLastRelative(row.last_sync));
        const lastCell = row.last_sync
          ? `<span class="settings-sync-relative" title="${lastTitle}">${lastText}</span>`
          : `<span class="settings-sync-relative">${lastText}</span>`;

        const liRaw = row.last_incremental_sync;
        const liTitle = liRaw ? escapeAttr(syncPreciseTimeForTitle(liRaw)) : "";
        const liText = escapeHtml(formatSyncLastRelative(liRaw));
        const lastIncrCell = liRaw
          ? `<span class="settings-sync-relative" title="${liTitle}">${liText}</span>`
          : `<span class="settings-sync-relative">${liText}</span>`;

        return `<tr data-credential-id="${idAttr}">
          <td><strong>${name}</strong></td>
          <td>${settingsSyncFullIntervalStackHtml(row)}</td>
          <td>${settingsSyncIncrementalIntervalStackHtml(row)}</td>
          <td>${lastCell}</td>
          <td>${lastIncrCell}</td>
          <td class="settings-cred-actions">
            <span role="button" tabindex="0" class="settings-cred-icon-btn cred-sync-now" data-id="${idAttr}" title="Full sync now" aria-label="Full sync now">${CRED_ROW_ICONS.sync}</span>
          </td>
        </tr>`;
      })
      .join("");
    tbody.querySelectorAll(".settings-sync-interval-select").forEach((el) => {
      el.dataset.lastValue = el.value;
    });
    tbody.querySelectorAll(".settings-inc-sync-interval-select").forEach((el) => {
      el.dataset.lastValue = el.value;
    });
  }

  function refreshSettingsSyncIfVisible() {
    const panel = document.getElementById("settings-panel-sync");
    if (panel?.classList.contains("is-active")) {
      loadSettingsSync().catch(console.error);
    }
  }

  async function runAppSyncBarSyncAll() {
    if (!isAdmin()) return;
    const btn = document.getElementById("app-sync-bar-sync-btn");
    if (!btn || btn.disabled || btn.hidden) return;
    appSyncLocalProgress = { name: "Preparing…", current: 0, total: 1, syncKind: "full" };
    applyAppSyncBarBusyUi();
    try {
      const rows = await loadJson("/api/settings/credentials");
      if (!rows.length) {
        showCredentialRowTestToast(false, "No credentials to full sync.", { title: "Full sync" });
        return;
      }
      const toSync = rows.filter((r) => r && r.id);
      const total = toSync.length;
      if (!total) {
        showCredentialRowTestToast(false, "No credentials to full sync.", { title: "Full sync" });
        return;
      }
      const firstNm =
        toSync[0].name != null && String(toSync[0].name).trim() !== ""
          ? String(toSync[0].name).trim()
          : toSync[0].id;
      appSyncLocalProgress = {
        name: total === 1 ? firstNm : "Credentials",
        current: 0,
        total,
        syncKind: "full",
      };
      applyAppSyncBarBusyUi();
      const errors = [];
      for (let i = 0; i < toSync.length; i += 1) {
        const row = toSync[i];
        const id = row.id;
        const nm = row.name != null && String(row.name).trim() !== "" ? String(row.name).trim() : id;
        appSyncLocalProgress = { name: nm, current: i + 1, total, syncKind: "full" };
        applyAppSyncBarBusyUi();
        try {
          await apiRequestJson(`/api/settings/credentials/${encodeURIComponent(id)}/sync-now`, {
            method: "POST",
          });
        } catch (e) {
          errors.push(`${nm}: ${e.message || "failed"}`);
        }
      }
      await refreshAppSyncStatusBar();
      refreshSettingsSyncIfVisible();
      if (errors.length) {
        const detail =
          errors.slice(0, 3).join(" ") + (errors.length > 3 ? " …" : "");
        showCredentialRowTestToast(false, detail, { title: "Some full syncs failed" });
      } else {
        showCredentialRowTestToast(
          true,
          `Full synced ${total} credential${total === 1 ? "" : "s"}.`,
          { title: "Full sync complete" }
        );
      }
    } catch (e) {
      showCredentialRowTestToast(false, e.message || "Could not full sync.", { title: "Full sync failed" });
    } finally {
      setAppSyncBarBusy(false);
    }
  }

  function initAppSyncStatusBar() {
    document.getElementById("app-sync-bar-sync-btn")?.addEventListener("click", () => {
      void runAppSyncBarSyncAll();
    });
  }

  function openCredentialFormDialog() {
    const d = document.getElementById("credential-form-dialog");
    if (!d) return;
    document.getElementById("credential-form")?.reset();
    const st = document.getElementById("credential-form-status");
    if (st) {
      st.textContent = "";
      st.classList.remove("is-error", "is-ok");
    }
    d.hidden = false;
    d.setAttribute("aria-hidden", "false");
    document.getElementById("cred-form-name")?.focus();
  }

  function initSettingsModal() {
    document.getElementById("btn-settings")?.addEventListener("click", () => {
      openSettingsModal();
      setSettingsSection("users");
    });
    document.getElementById("settings-modal-close")?.addEventListener("click", closeSettingsModal);
    document
      .querySelector("#settings-modal .settings-modal__backdrop")
      ?.addEventListener("click", closeSettingsModal);

    document.getElementById("settings-nav-filter")?.addEventListener("input", filterSettingsNav);

    document.querySelectorAll("#settings-modal [data-settings-section]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const s = btn.dataset.settingsSection;
        if (s) setSettingsSection(s);
      });
    });

    document.getElementById("settings-general-form")?.addEventListener("submit", async (e) => {
      e.preventDefault();
      const newIn = document.getElementById("settings-general-new-hours");
      const updIn = document.getElementById("settings-general-upd-hours");
      const idleIn = document.getElementById("settings-general-session-idle");
      const st = document.getElementById("settings-general-status");
      const n = Math.floor(Number(newIn?.value));
      const u = Math.floor(Number(updIn?.value));
      const sid = Math.floor(Number(idleIn?.value));
      if (!Number.isFinite(n) || n < 1 || n > 8760 || !Number.isFinite(u) || u < 1 || u > 8760) {
        if (st) {
          st.textContent = "Enter hours between 1 and 8760 for both fields.";
          st.classList.add("is-error");
          st.classList.remove("is-ok");
        }
        return;
      }
      if (!Number.isFinite(sid) || sid < 0 || sid > 525600) {
        if (st) {
          st.textContent = "Session idle timeout must be between 0 and 525600 minutes.";
          st.classList.add("is-error");
          st.classList.remove("is-ok");
        }
        return;
      }
      const saveBtn = document.getElementById("settings-general-save");
      if (saveBtn) saveBtn.disabled = true;
      if (st) {
        st.textContent = "Saving…";
        st.classList.remove("is-error", "is-ok");
      }
      try {
        const res = await apiRequestJson("/api/settings/ui", {
          method: "PATCH",
          body: JSON.stringify({
            fw_new_max_age_hours: n,
            fw_updated_max_age_hours: u,
            session_idle_timeout_minutes: sid,
          }),
        });
        fwTagUiSettings.fw_new_max_age_hours = res.fw_new_max_age_hours;
        fwTagUiSettings.fw_updated_max_age_hours = res.fw_updated_max_age_hours;
        fwTagUiSettings.session_idle_timeout_minutes = res.session_idle_timeout_minutes;
        restartSessionIdleWatchIfAuthenticated();
        if (st) {
          st.textContent = "Saved.";
          st.classList.add("is-ok");
          st.classList.remove("is-error");
        }
        applyFirewallRecencyTags(fwPrepared);
        fwController.render();
        applyListRecencyTags(grPrepared, {
          createdKey: "created_at",
          stateKey: "updated_at",
          lastSyncKey: "last_sync",
          clientKey: "client_id",
        });
        applyTenantRecencyTags(tnPrepared);
        grController.render();
        tnController.render();
        loadDashboardAlerts({ reset: true }).catch(console.error);
      } catch (err) {
        if (st) {
          st.textContent = err.message || "Could not save.";
          st.classList.add("is-error");
          st.classList.remove("is-ok");
        }
      } finally {
        if (saveBtn) saveBtn.disabled = false;
      }
    });

    document.getElementById("btn-add-credential")?.addEventListener("click", openCredentialFormDialog);
    document.getElementById("credential-form-close")?.addEventListener("click", closeCredentialFormDialog);
    document
      .querySelector("#credential-form-dialog .settings-subdialog__backdrop")
      ?.addEventListener("click", closeCredentialFormDialog);

    document.getElementById("cred-form-test")?.addEventListener("click", async () => {
      const clientId = document.getElementById("cred-form-client-id")?.value?.trim() || "";
      const secret = document.getElementById("cred-form-client-secret")?.value || "";
      const st = document.getElementById("credential-form-status");
      if (!clientId || !secret) {
        if (st) {
          st.textContent = "Enter client ID and secret to test.";
          st.classList.add("is-error");
          st.classList.remove("is-ok");
        }
        return;
      }
      const testBtn = document.getElementById("cred-form-test");
      const submitBtn = document.getElementById("cred-form-submit");
      testBtn.disabled = true;
      submitBtn.disabled = true;
      if (st) {
        st.textContent = "Testing…";
        st.classList.remove("is-error", "is-ok");
      }
      try {
        const res = await apiRequestJson("/api/settings/credentials/test", {
          method: "POST",
          body: JSON.stringify({ client_id: clientId, client_secret: secret }),
        });
        if (st) {
          st.textContent = `Connected. ID type: ${res.id_type || "—"}. Central ID: ${res.whoami?.id ?? "—"}`;
          st.classList.add("is-ok");
          st.classList.remove("is-error");
        }
      } catch (e) {
        if (st) {
          st.textContent = e.message || "Test failed.";
          st.classList.add("is-error");
          st.classList.remove("is-ok");
        }
      } finally {
        testBtn.disabled = false;
        submitBtn.disabled = false;
      }
    });

    document.getElementById("credential-form")?.addEventListener("submit", async (e) => {
      e.preventDefault();
      const name = document.getElementById("cred-form-name")?.value?.trim() || "";
      const clientId = document.getElementById("cred-form-client-id")?.value?.trim() || "";
      const secret = document.getElementById("cred-form-client-secret")?.value || "";
      const st = document.getElementById("credential-form-status");
      if (!name || !clientId || !secret) {
        if (st) {
          st.textContent = "All fields are required to add a credential.";
          st.classList.add("is-error");
          st.classList.remove("is-ok");
        }
        return;
      }
      const testBtn = document.getElementById("cred-form-test");
      const submitBtn = document.getElementById("cred-form-submit");
      testBtn.disabled = true;
      submitBtn.disabled = true;
      if (st) {
        st.textContent = "Verifying with Central and saving…";
        st.classList.remove("is-error", "is-ok");
      }
      try {
        await apiRequestJson("/api/settings/credentials", {
          method: "POST",
          body: JSON.stringify({ name, client_id: clientId, client_secret: secret }),
        });
        closeCredentialFormDialog();
        await loadSettingsCredentials();
        refreshSettingsSyncIfVisible();
      } catch (err) {
        if (st) {
          st.textContent = err.message || "Could not save credential.";
          st.classList.add("is-error");
        }
      } finally {
        testBtn.disabled = false;
        submitBtn.disabled = false;
      }
    });

    document.getElementById("settings-credentials-body")?.addEventListener("click", async (e) => {
      const retest = e.target.closest("button.cred-retest");
      if (retest) {
        const id = retest.getAttribute("data-id");
        if (!id) return;
        retest.disabled = true;
        try {
          const res = await apiRequestJson(`/api/settings/credentials/${encodeURIComponent(id)}/test`, {
            method: "POST",
          });
          const c = res?.credential;
          const detail =
            c != null
              ? `ID type: ${c.id_type || "—"}. Central ID: ${c.whoami?.id ?? "—"}`
              : "Verified with Sophos Central.";
          showCredentialRowTestToast(true, detail);
          await loadSettingsCredentials();
        } catch (err) {
          showCredentialRowTestToast(false, err.message || "Test failed.");
        } finally {
          retest.disabled = false;
        }
        return;
      }
      const copyCentral = e.target.closest("button.cred-copy-central");
      if (copyCentral) {
        const text = copyCentral.getAttribute("data-clipboard-text");
        if (text == null || text === "") return;
        (async () => {
          try {
            await navigator.clipboard.writeText(text);
            showCredentialRowTestToast(true, "Central ID copied to clipboard.", { title: "Copied" });
          } catch {
            showCredentialRowTestToast(false, "Could not copy to clipboard.", { title: "Copy failed" });
          }
        })();
        return;
      }
      const rename = e.target.closest("button.cred-rename");
      if (rename) {
        const id = rename.getAttribute("data-id");
        if (!id) return;
        const currentRow = rename.closest("tr");
        const currentName = currentRow?.querySelector("strong")?.textContent || "";
        const next = window.prompt("Credential display name", currentName);
        if (next == null) return;
        const trimmed = next.trim();
        if (!trimmed) return;
        try {
          await apiRequestJson(`/api/settings/credentials/${encodeURIComponent(id)}`, {
            method: "PATCH",
            body: JSON.stringify({ name: trimmed }),
          });
          await loadSettingsCredentials();
          refreshSettingsSyncIfVisible();
        } catch (err) {
          notifyAppUser("Rename failed", err.message || "Rename failed.", "error");
        }
        return;
      }
      const del = e.target.closest("button.cred-delete");
      if (del) {
        const id = del.getAttribute("data-id");
        if (!id) return;
        if (
          !window.confirm(
            "Remove this credential from the app? The client secret will be deleted from local storage."
          )
        )
          return;
        try {
          await apiRequestJson(`/api/settings/credentials/${encodeURIComponent(id)}`, {
            method: "DELETE",
          });
          await loadSettingsCredentials();
          refreshSettingsSyncIfVisible();
        } catch (err) {
          notifyAppUser("Delete failed", err.message || "Delete failed.", "error");
        }
      }
    });

    document.getElementById("settings-sync-body")?.addEventListener("change", async (e) => {
      const sel = e.target.closest(".settings-sync-interval-select");
      if (!sel) return;
      const id = sel.getAttribute("data-credential-id");
      if (!id) return;
      const prev = sel.dataset.lastValue != null ? sel.dataset.lastValue : normalizeCredentialSyncInterval(null);
      const value = sel.value;
      try {
        await apiRequestJson(`/api/settings/credentials/${encodeURIComponent(id)}/sync-interval`, {
          method: "PATCH",
          body: JSON.stringify({ sync_interval: value }),
        });
        sel.dataset.lastValue = value;
      } catch (err) {
        sel.value = prev;
        showCredentialRowTestToast(false, err.message || "Could not save sync interval.", {
          title: "Save failed",
        });
      }
    });

    document.getElementById("settings-sync-body")?.addEventListener("change", async (e) => {
      const sel = e.target.closest(".settings-inc-sync-interval-select");
      if (!sel) return;
      const id = sel.getAttribute("data-credential-id");
      if (!id) return;
      const prev =
        sel.dataset.lastValue != null
          ? sel.dataset.lastValue
          : normalizeCredentialIncrementalSyncInterval(null);
      const value = sel.value;
      try {
        await apiRequestJson(
          `/api/settings/credentials/${encodeURIComponent(id)}/incremental-sync-interval`,
          {
            method: "PATCH",
            body: JSON.stringify({ incremental_sync_interval: value }),
          }
        );
        sel.dataset.lastValue = value;
      } catch (err) {
        sel.value = prev;
        showCredentialRowTestToast(false, err.message || "Could not save incremental interval.", {
          title: "Save failed",
        });
      }
    });

    document.getElementById("settings-sync-body")?.addEventListener("keydown", (e) => {
      const el = e.target.closest(".cred-sync-now");
      if (!el || el.getAttribute("aria-disabled") === "true") return;
      if (e.key !== "Enter" && e.key !== " ") return;
      e.preventDefault();
      el.click();
    });

    document.getElementById("settings-sync-body")?.addEventListener("click", async (e) => {
      const btn = e.target.closest(".cred-sync-now");
      if (!btn || btn.getAttribute("aria-disabled") === "true") return;
      const id = btn.getAttribute("data-id");
      if (!id) return;
      const tr = btn.closest("tr[data-credential-id]");
      const nameCell = tr?.querySelector("td strong");
      const credName =
        nameCell && nameCell.textContent != null && String(nameCell.textContent).trim() !== ""
          ? String(nameCell.textContent).trim()
          : id;
      btn.setAttribute("aria-disabled", "true");
      appSyncLocalProgress = { name: credName, current: 1, total: 1, syncKind: "full" };
      applyAppSyncBarBusyUi();
      try {
        const res = await apiRequestJson(`/api/settings/credentials/${encodeURIComponent(id)}/sync-now`, {
          method: "POST",
        });
        const c = res?.credential;
        const who = c?.whoami?.id != null ? String(c.whoami.id) : "";
        const detail = who ? `Central ID ${who} refreshed.` : "Profile metadata refreshed.";
        showCredentialRowTestToast(true, detail, { title: "Full sync complete" });
        await loadSettingsSync();
        refreshAppSyncStatusBar();
      } catch (err) {
        showCredentialRowTestToast(false, err.message || "Full sync failed.", { title: "Full sync failed" });
      } finally {
        appSyncLocalProgress = null;
        applyAppSyncBarBusyUi();
        btn.removeAttribute("aria-disabled");
      }
    });

    document.getElementById("btn-add-user")?.addEventListener("click", openUserFormDialog);
    document.getElementById("user-form-close")?.addEventListener("click", closeUserFormDialog);
    document
      .querySelector("#user-form-dialog .settings-subdialog__backdrop")
      ?.addEventListener("click", closeUserFormDialog);

    document.getElementById("user-form")?.addEventListener("submit", async (e) => {
      e.preventDefault();
      const username = document.getElementById("user-form-username")?.value?.trim() || "";
      const password = document.getElementById("user-form-password")?.value || "";
      const role = document.getElementById("user-form-role")?.value || "user";
      const full_name = document.getElementById("user-form-full-name")?.value?.trim() || "";
      const email = document.getElementById("user-form-email")?.value?.trim() || "";
      const mobile = document.getElementById("user-form-mobile")?.value?.trim() || "";
      const st = document.getElementById("user-form-status");
      if (!username || !password) {
        if (st) {
          st.textContent = "Username and password are required.";
          st.classList.add("is-error");
        }
        return;
      }
      const sub = document.getElementById("user-form-submit");
      sub.disabled = true;
      const payload = { username, password, role };
      if (full_name) payload.full_name = full_name;
      if (email) payload.email = email;
      if (mobile) payload.mobile = mobile;
      try {
        await apiRequestJson("/api/settings/users", {
          method: "POST",
          body: JSON.stringify(payload),
        });
        closeUserFormDialog();
        await loadSettingsUsers();
      } catch (err) {
        if (st) {
          st.textContent = err.message || "Could not create user.";
          st.classList.add("is-error");
        }
      } finally {
        sub.disabled = false;
      }
    });

    function openUserEditProfileDialogFromRow(tr, userId) {
      const d = document.getElementById("user-edit-profile-dialog");
      if (!d) return;
      const cells = tr?.querySelectorAll("td");
      const readCell = (i) => {
        const raw = cells?.[i]?.textContent?.trim() || "";
        return raw === "—" ? "" : raw;
      };
      document.getElementById("user-edit-profile-id").value = userId;
      document.getElementById("user-edit-profile-full-name").value = readCell(1);
      document.getElementById("user-edit-profile-email").value = readCell(2);
      document.getElementById("user-edit-profile-mobile").value = readCell(3);
      const st = document.getElementById("user-edit-profile-status");
      if (st) {
        st.textContent = "";
        st.classList.remove("is-error", "is-ok");
      }
      d.hidden = false;
      d.setAttribute("aria-hidden", "false");
      document.getElementById("user-edit-profile-full-name")?.focus();
    }

    document.getElementById("user-edit-profile-close")?.addEventListener("click", closeUserEditProfileDialog);
    document
      .querySelector("#user-edit-profile-dialog .settings-subdialog__backdrop")
      ?.addEventListener("click", closeUserEditProfileDialog);

    document.getElementById("user-edit-profile-form")?.addEventListener("submit", async (e) => {
      e.preventDefault();
      const id = document.getElementById("user-edit-profile-id")?.value?.trim() || "";
      const full_name = document.getElementById("user-edit-profile-full-name")?.value?.trim() ?? "";
      const email = document.getElementById("user-edit-profile-email")?.value?.trim() ?? "";
      const mobile = document.getElementById("user-edit-profile-mobile")?.value?.trim() ?? "";
      const st = document.getElementById("user-edit-profile-status");
      const sub = document.getElementById("user-edit-profile-submit");
      if (!id) return;
      if (sub) sub.disabled = true;
      try {
        const updated = await apiRequestJson(`/api/settings/users/${encodeURIComponent(id)}`, {
          method: "PATCH",
          body: JSON.stringify({ full_name, email, mobile }),
        });
        if (updated && updated.id === currentSessionUser?.id) {
          currentSessionUser = { ...currentSessionUser, ...updated };
          applySessionUserToChrome();
        }
        closeUserEditProfileDialog();
        await loadSettingsUsers();
      } catch (err) {
        if (st) {
          st.textContent = err.message || "Could not save.";
          st.classList.add("is-error");
        }
      } finally {
        if (sub) sub.disabled = false;
      }
    });

    document.getElementById("settings-users-body")?.addEventListener("click", async (e) => {
      const profileBtn = e.target.closest("button.user-profile-btn");
      if (profileBtn) {
        const id = profileBtn.getAttribute("data-id");
        if (!id) return;
        const row = profileBtn.closest("tr");
        openUserEditProfileDialogFromRow(row, id);
        return;
      }
      const roleBtn = e.target.closest("button.user-role-btn");
      if (roleBtn) {
        const id = roleBtn.getAttribute("data-id");
        if (!id) return;
        const row = roleBtn.closest("tr");
        const current = row?.querySelector(".settings-user-cell--role")?.textContent?.trim() || "user";
        const choice = window.prompt(`Role for this user: type "admin" or "user"`, current);
        if (choice == null) return;
        const r = choice.trim().toLowerCase();
        if (r !== "admin" && r !== "user") {
          notifyAppUser("Invalid role", 'Role must be "admin" or "user".', "error");
          return;
        }
        try {
          await apiRequestJson(`/api/settings/users/${encodeURIComponent(id)}`, {
            method: "PATCH",
            body: JSON.stringify({ role: r }),
          });
          await loadSettingsUsers();
          if (id === currentSessionUser?.id) {
            currentSessionUser = { ...currentSessionUser, role: r };
            applySettingsNavForRole();
            applySessionUserToChrome();
          }
        } catch (err) {
          notifyAppUser("Could not update role", err.message || "Could not update role.", "error");
        }
        return;
      }
      const pwBtn = e.target.closest("button.user-password-btn");
      if (pwBtn) {
        const id = pwBtn.getAttribute("data-id");
        if (!id) return;
        const pw = window.prompt("New password (min. 10 characters)");
        if (pw == null) return;
        if (pw.length < 10) {
          notifyAppUser("Password too short", "Password must be at least 10 characters.", "error");
          return;
        }
        try {
          await apiRequestJson(`/api/settings/users/${encodeURIComponent(id)}`, {
            method: "PATCH",
            body: JSON.stringify({ password: pw }),
          });
          await loadSettingsUsers();
        } catch (err) {
          notifyAppUser("Could not set password", err.message || "Could not set password.", "error");
        }
        return;
      }
      const delBtn = e.target.closest("button.user-delete-btn");
      if (delBtn) {
        const id = delBtn.getAttribute("data-id");
        if (!id) return;
        if (!window.confirm("Remove this user? They will no longer be able to sign in.")) return;
        try {
          await apiRequestJson(`/api/settings/users/${encodeURIComponent(id)}`, {
            method: "DELETE",
          });
          if (id === currentSessionUser?.id) {
            currentSessionUser = null;
            const btnUser = document.getElementById("btn-user-menu");
            if (btnUser) btnUser.hidden = true;
            showLoginGate();
            return;
          }
          await loadSettingsUsers();
        } catch (err) {
          notifyAppUser("Delete failed", err.message || "Delete failed.", "error");
        }
      }
    });
  }

  /* ---------- Tabs ---------- */
  const pageTitle = document.getElementById("page-title");
  const mainTabButtons = document.querySelectorAll(".app-nav .tabs__tab[data-tab]");
  const panels = document.querySelectorAll(".panel");

  function setFirewallsSubtab(sub, persist = true) {
    const raw = sub != null ? String(sub).trim() : "";
    const next = raw === "groups" ? "groups" : "firewalls";
    activeFirewallsSubtab = next;
    document.querySelectorAll(".fw-panel-tabs__tab").forEach((btn) => {
      const id = btn.getAttribute("data-fw-subtab");
      const on = id === next;
      btn.classList.toggle("is-active", on);
      btn.setAttribute("aria-selected", on ? "true" : "false");
    });
    const subFw = document.getElementById("fw-subpanel-firewalls");
    const subGr = document.getElementById("fw-subpanel-groups");
    if (subFw) subFw.hidden = next !== "firewalls";
    if (subGr) subGr.hidden = next !== "groups";
    const fwPanel = document.getElementById("panel-firewalls");
    if (fwPanel && !fwPanel.hidden) {
      pageTitle.textContent = next === "groups" ? TITLES.groups : TITLES.firewalls;
    }
    if (persist) schedulePersistUiState();
    if (next === "firewalls") {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          refreshFwMapMarkers();
        });
      });
    } else {
      invalidateFwMapSizes();
      requestAnimationFrame(() => {
        try {
          grController.render();
        } catch {
          /* grController not ready */
        }
      });
    }
  }

  function invalidateFwMapSizes() {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (dashFwMap) dashFwMap.invalidateSize({ animate: false });
        if (panelFwMap) panelFwMap.invalidateSize({ animate: false });
        if (fwLocPickMap) fwLocPickMap.invalidateSize({ animate: false });
        fwMapSyncMarkerLayers(dashFwMap, dashFwEdgeLayer, dashFwClusterLayer, dashFwLayer);
        fwMapSyncMarkerLayers(panelFwMap, panelFwEdgeLayer, panelFwClusterLayer, panelFwLayer);
      });
    });
  }

  function activateTab(name, persist = true) {
    mainTabButtons.forEach((btn) => {
      const on = btn.dataset.tab === name;
      btn.classList.toggle("is-active", on);
      btn.setAttribute("aria-selected", on ? "true" : "false");
    });
    panels.forEach((p) => {
      const on = p.dataset.panel === name;
      p.classList.toggle("is-active", on);
      p.hidden = !on;
    });
    if (name !== "firewalls") {
      pageTitle.textContent = TITLES[name] || name;
    }
    const opsTitleCount = document.getElementById("page-title-ops-count");
    if (opsTitleCount) {
      opsTitleCount.hidden = name !== "operations";
      if (name !== "operations") opsTitleCount.textContent = "";
    }
    if (persist) schedulePersistUiState();
    hideFwMapHoverPortalNow();
    if (name === "operations") {
      startOperationsAutoRefresh();
      renderOperationsView();
    } else stopOperationsAutoRefresh();
    if (name === "firewalls") {
      setFirewallsSubtab(activeFirewallsSubtab, false);
    }
    const lazyFwMapInit =
      (name === "dashboard" && !dashFwMap) || (name === "firewalls" && !panelFwMap);
    if (lazyFwMapInit) {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          refreshFwMapMarkers();
        });
      });
    } else if (name !== "firewalls") {
      invalidateFwMapSizes();
    }
  }

  mainTabButtons.forEach((btn) => {
    btn.addEventListener("click", () => activateTab(btn.dataset.tab, true));
  });

  document.querySelector(".fw-panel-tabs")?.addEventListener("click", (e) => {
    const btn = e.target.closest(".fw-panel-tabs__tab");
    if (!btn) return;
    const sub = btn.getAttribute("data-fw-subtab");
    if (sub !== "firewalls" && sub !== "groups") return;
    e.preventDefault();
    setFirewallsSubtab(sub, true);
  });

  /** Context-sensitive help: static pages under /static/help/ */
  function helpDocUrl(fileWithOptionalHash) {
    return new URL(`/static/help/${fileWithOptionalHash}`, window.location.origin).href;
  }

  function visibleEl(id) {
    const el = document.getElementById(id);
    return el && !el.hidden ? el : null;
  }

  function resolveHelpTarget() {
    if (visibleEl("user-edit-profile-dialog")) return "modal-edit-user-profile.html";
    if (visibleEl("user-form-dialog")) return "modal-add-user.html";
    if (visibleEl("credential-form-dialog")) return "modal-central-credential.html";
    const exportPop = visibleEl("table-export-popover");
    if (exportPop) return "modal-export-table.html";
        if (visibleEl("fw-cols-modal")) return "modal-table-columns.html#firewalls";
    if (visibleEl("gr-cols-modal")) return "modal-table-columns.html#groups";
    if (visibleEl("tn-cols-modal")) return "modal-table-columns.html#tenants";
    if (visibleEl("lc-cols-modal")) return "modal-table-columns.html#licenses";
    if (visibleEl("gr-create-group-modal")) return "modal-create-firewall-group.html";
    if (visibleEl("fw-firmware-batch-modal")) return "modal-firmware.html#batch";
    if (visibleEl("fw-delete-local-modal")) return "modal-delete-local.html";
    if (visibleEl("gr-delete-groups-modal")) return "page-groups.html";
    if (visibleEl("fw-location-modal")) return "modal-firewall-location.html";
    const profileModal = visibleEl("profile-modal");
    if (profileModal) {
      const sec =
        profileModal.querySelector(".settings-nav__item.is-active[data-profile-section]")?.getAttribute(
          "data-profile-section",
        ) || "profile";
      return sec === "password" ? "account-password.html" : "account-profile.html";
    }
    const settingsModal = visibleEl("settings-modal");
    if (settingsModal) {
      const sec =
        settingsModal.querySelector(".settings-nav__item.is-active[data-settings-section]")?.getAttribute(
          "data-settings-section",
        ) || "users";
      const map = {
        general: "settings-general.html",
        users: "settings-users.html",
        credentials: "settings-credentials.html",
        sync: "settings-sync.html",
        about: "settings-about.html",
      };
      return map[sec] || "settings-users.html";
    }
    if (visibleEl("fw-detail-flyout")) return "flyout-firewall-detail.html";
    if (visibleEl("alert-flyout")) return "flyout-alert.html";
    if (visibleEl("license-flyout")) return "flyout-license.html";
    const authOverlay = visibleEl("auth-overlay");
    if (authOverlay) return "sign-in.html";
    const activeTabBtn = document.querySelector(".app-nav .tabs__tab.is-active[data-tab]");
    const tab = activeTabBtn?.getAttribute("data-tab") || "dashboard";
    if (tab === "firewalls") {
      return activeFirewallsSubtab === "groups" ? "page-groups.html" : "page-firewalls.html";
    }
    const pages = {
      dashboard: "page-dashboard.html",
      firewalls: "page-firewalls.html",
      tenants: "page-tenants.html",
      licenses: "page-licenses.html",
    };
    return pages[tab] || "page-dashboard.html";
  }

  function openContextHelpDoc() {
    window.open(helpDocUrl(resolveHelpTarget()), "_blank", "noopener,noreferrer");
  }

  const helpMenuEl = document.getElementById("help-menu");
  const helpMenuPageBtn = document.getElementById("help-menu-page");
  let helpMenuOpenTrigger = null;

  function closeHelpMenu() {
    if (!helpMenuEl || helpMenuEl.hasAttribute("hidden")) return;
    helpMenuEl.setAttribute("hidden", "");
    document.querySelectorAll(".help-menu-trigger[aria-expanded='true']").forEach((el) => {
      el.setAttribute("aria-expanded", "false");
    });
    helpMenuOpenTrigger = null;
  }

  function positionHelpMenu(anchor) {
    if (!helpMenuEl) return;
    const pad = 6;
    const margin = 8;
    helpMenuEl.removeAttribute("hidden");
    const mw = helpMenuEl.offsetWidth;
    const mh = helpMenuEl.offsetHeight;
    const rect = anchor.getBoundingClientRect();
    let left = rect.right - mw;
    left = Math.max(margin, Math.min(left, window.innerWidth - mw - margin));
    let top = rect.bottom + pad;
    if (top + mh > window.innerHeight - margin) {
      top = rect.top - mh - pad;
    }
    top = Math.max(margin, Math.min(top, window.innerHeight - mh - margin));
    helpMenuEl.style.left = `${Math.round(left)}px`;
    helpMenuEl.style.top = `${Math.round(top)}px`;
  }

  function toggleHelpMenu(anchor) {
    if (!helpMenuEl) return;
    const wasOpen = !helpMenuEl.hasAttribute("hidden") && helpMenuOpenTrigger === anchor;
    closeHelpMenu();
    if (wasOpen) return;
    helpMenuOpenTrigger = anchor;
    anchor.setAttribute("aria-expanded", "true");
    positionHelpMenu(anchor);
  }

  (function initHelpMenu() {
    if (!helpMenuEl) return;
    document.querySelectorAll(".help-menu-trigger").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        toggleHelpMenu(btn);
      });
    });
    helpMenuPageBtn?.addEventListener("click", () => {
      openContextHelpDoc();
      closeHelpMenu();
    });
    document.getElementById("help-menu-bug")?.addEventListener("click", () => {
      closeHelpMenu();
    });
    document.addEventListener("click", (e) => {
      if (helpMenuEl.hasAttribute("hidden")) return;
      const t = e.target;
      if (helpMenuEl.contains(t)) return;
      if (t.closest?.(".help-menu-trigger")) return;
      closeHelpMenu();
    });
    document.addEventListener(
      "keydown",
      (e) => {
        if (e.key !== "Escape") return;
        if (helpMenuEl.hasAttribute("hidden")) return;
        closeHelpMenu();
        e.preventDefault();
        e.stopPropagation();
      },
      true,
    );
    window.addEventListener("resize", closeHelpMenu);
  })();

  const appShell = document.getElementById("app-shell");
  const sidebarToggle = document.getElementById("app-sidebar-toggle");
  const SIDEBAR_COLLAPSED_LS = "sophos-central-sidebar-collapsed";

  function syncSidebarToggleFromDom() {
    if (!sidebarToggle || !appShell) return;
    const collapsed = appShell.classList.contains("app-shell--nav-collapsed");
    sidebarToggle.setAttribute("aria-expanded", collapsed ? "false" : "true");
    sidebarToggle.setAttribute("aria-label", collapsed ? "Expand navigation" : "Collapse navigation");
    sidebarToggle.setAttribute("title", collapsed ? "Expand navigation" : "Collapse navigation");
  }

  sidebarToggle?.addEventListener("click", () => {
    if (!appShell) return;
    const next = !appShell.classList.contains("app-shell--nav-collapsed");
    appShell.classList.toggle("app-shell--nav-collapsed", next);
    try {
      if (next) localStorage.setItem(SIDEBAR_COLLAPSED_LS, "1");
      else localStorage.removeItem(SIDEBAR_COLLAPSED_LS);
    } catch {
      /* ignore */
    }
    syncSidebarToggleFromDom();
    invalidateFwMapSizes();
  });

  syncSidebarToggleFromDom();

  function filtersToggleButtonForAside(aside) {
    const drawer = aside?.querySelector(".filters__drawer");
    const id = drawer?.id;
    if (!id) return null;
    return document.querySelector(`[aria-controls="${id}"]`);
  }

  function setFiltersPanelCollapsed(aside, collapsed) {
    if (!aside) return;
    const drawer = aside.querySelector(".filters__drawer");
    const btn = filtersToggleButtonForAside(aside);
    aside.classList.toggle("filters--collapsed", collapsed);
    if (btn) btn.setAttribute("aria-expanded", collapsed ? "false" : "true");
    if (drawer) {
      if (collapsed) drawer.setAttribute("hidden", "");
      else drawer.removeAttribute("hidden");
    }
  }

  /** Expands the firewalls facet drawer unless the user has it collapsed (filter links respect that). */
  function expandFirewallFiltersPanel() {
    const aside = document.querySelector("#fw-subpanel-firewalls .filters");
    if (!aside || aside.classList.contains("filters--collapsed")) return;
    setFiltersPanelCollapsed(aside, false);
  }

  /** Expands the groups facet drawer unless the user has it collapsed. */
  function expandGroupFiltersPanel() {
    const aside = document.querySelector("#fw-subpanel-groups .filters");
    if (!aside || aside.classList.contains("filters--collapsed")) return;
    setFiltersPanelCollapsed(aside, false);
  }

  function expandDashboardFiltersPanel() {
    setFiltersPanelCollapsed(document.querySelector("#panel-dashboard .filters"), false);
  }

  function initCollapsibleFilterPanels() {
    document.querySelectorAll(".filters").forEach((aside) => {
      const drawer = aside.querySelector(".filters__drawer");
      const btn = filtersToggleButtonForAside(aside);
      if (!drawer || !btn) return;
      btn.addEventListener("click", () => {
        const isCollapsed = aside.classList.contains("filters--collapsed");
        setFiltersPanelCollapsed(aside, !isCollapsed);
        schedulePersistUiState();
      });
    });
  }

  /* ---------- Generic table controller (lazy / infinite scroll) ---------- */
  function lazyIntersectionRootForTbody(tbody) {
    if (!tbody) return null;
    let el = tbody.parentElement;
    while (el && el !== document.body) {
      const st = window.getComputedStyle(el);
      const oy = st.overflowY;
      if (
        (oy === "auto" || oy === "scroll" || oy === "overlay") &&
        el.scrollHeight > el.clientHeight + 1
      ) {
        return el;
      }
      el = el.parentElement;
    }
    return null;
  }

  function createTableController(cfg) {
    const {
      getFilteredRows,
      tbody,
      countEl,
      rangeEl,
      pageSizeEl,
      prevBtn,
      nextBtn,
      searchInput,
      selectAllInput,
      sortHeaders,
      sortDelegateRoot,
      renderRow,
      getRowSearchText,
      afterRender,
      onSelectionChange,
      initialSort,
    } = cfg;

    let defaultSortKey = null;
    let defaultSortDir = 1;
    if (initialSort && typeof initialSort === "object") {
      if (initialSort.sortKey != null && String(initialSort.sortKey).trim() !== "") {
        defaultSortKey = String(initialSort.sortKey);
      }
      if (
        typeof initialSort.sortDir === "number" &&
        (initialSort.sortDir === 1 || initialSort.sortDir === -1)
      ) {
        defaultSortDir = initialSort.sortDir;
      }
    }
    let sortKey = defaultSortKey;
    let sortDir = defaultSortDir;
    let visibleCount = 0;
    let selected = new Set();
    let lazyIo = null;
    let lazyAppending = false;

    function disconnectLazyIo() {
      if (lazyIo) {
        lazyIo.disconnect();
        lazyIo = null;
      }
    }

    function getSortHeaderElements() {
      if (sortDelegateRoot) {
        return sortDelegateRoot.querySelectorAll("thead th[data-sort]");
      }
      return sortHeaders;
    }

    function updateSortUi() {
      getSortHeaderElements().forEach((th) => {
        th.classList.remove("sorted-asc", "sorted-desc");
        const k = th.dataset.sort;
        if (k && k === sortKey) {
          th.classList.add(sortDir === 1 ? "sorted-asc" : "sorted-desc");
        }
      });
    }

    function applySortKey(k) {
      if (!k) return;
      if (sortKey === k) sortDir = -sortDir;
      else {
        sortKey = k;
        sortDir = 1;
      }
      render(true);
    }

    function compare(a, b, key) {
      const va = a[key];
      const vb = b[key];
      const na = Number(va);
      const nb = Number(vb);
      if (!Number.isNaN(na) && !Number.isNaN(nb) && va !== "" && vb !== "") {
        return na === nb ? 0 : na < nb ? -1 : 1;
      }
      const sa = va == null ? "" : String(va).toLowerCase();
      const sb = vb == null ? "" : String(vb).toLowerCase();
      return sa === sb ? 0 : sa < sb ? -1 : 1;
    }

    function sortedRows(list) {
      if (!sortKey) return list.slice();
      const out = list.slice();
      out.sort((a, b) => sortDir * compare(a, b, sortKey));
      return out;
    }

    function searchFiltered(list) {
      const q = (searchInput?.value || "").trim().toLowerCase();
      if (!q) return list;
      return list.filter((row) => getRowSearchText(row).includes(q));
    }

    function chunkSize() {
      if (!pageSizeEl) return 50;
      return Math.max(1, parseInt(pageSizeEl.value, 10) || 50);
    }

    function getSortedPipeline() {
      const base = getFilteredRows();
      const searched = searchFiltered(base);
      const sorted = sortedRows(searched);
      return { sorted, total: sorted.length };
    }

    function updateLazyFooter(total, loaded) {
      if (countEl) {
        countEl.textContent =
          total === 0 ? "0 items" : `${loaded} of ${total} items`;
      }
      if (rangeEl) {
        if (total === 0) rangeEl.textContent = "";
        else if (loaded >= total) rangeEl.textContent = "All rows loaded";
        else rangeEl.textContent = "Scroll for more";
      }
      if (prevBtn) prevBtn.disabled = true;
      if (nextBtn) nextBtn.disabled = true;
    }

    function connectLazyIo() {
      disconnectLazyIo();
      const { sorted, total } = getSortedPipeline();
      if (visibleCount >= total || total === 0) return;
      const lastTr = tbody.querySelector("tr:last-of-type");
      if (!lastTr) return;
      const root = lazyIntersectionRootForTbody(tbody);
      lazyIo = new IntersectionObserver(
        (entries) => {
          for (const ent of entries) {
            if (ent.isIntersecting) appendMore();
          }
        },
        { root, rootMargin: "120px", threshold: 0.01 }
      );
      lazyIo.observe(lastTr);
    }

    function appendMore() {
      if (lazyAppending) return;
      const { sorted, total } = getSortedPipeline();
      if (visibleCount >= total) {
        disconnectLazyIo();
        updateLazyFooter(total, visibleCount);
        return;
      }
      lazyAppending = true;
      try {
        disconnectLazyIo();
        const prev = visibleCount;
        visibleCount = Math.min(visibleCount + chunkSize(), total);
        const html = sorted
          .slice(prev, visibleCount)
          .map((row) => renderRow(row, selected))
          .join("");
        tbody.insertAdjacentHTML("beforeend", html);
        syncSelectAll();
        updateSortUi();
        updateLazyFooter(total, visibleCount);
        schedulePersistUiState();
        if (typeof afterRender === "function") afterRender();
      } finally {
        lazyAppending = false;
      }
      connectLazyIo();
    }

    function render(reset) {
      disconnectLazyIo();
      const { sorted, total } = getSortedPipeline();
      if (reset) {
        visibleCount = Math.min(chunkSize(), total);
        tbody.innerHTML = sorted
          .slice(0, visibleCount)
          .map((row) => renderRow(row, selected))
          .join("");
      } else if (visibleCount > total) {
        visibleCount = total;
        tbody.innerHTML = sorted
          .slice(0, visibleCount)
          .map((row) => renderRow(row, selected))
          .join("");
      }
      syncSelectAll();
      updateSortUi();
      updateLazyFooter(total, Math.min(visibleCount, total));
      schedulePersistUiState();
      if (typeof afterRender === "function") afterRender();
      connectLazyIo();
    }

    function syncSelectAll() {
      if (!selectAllInput) return;
      const { sorted, total } = getSortedPipeline();
      const loaded = Math.min(visibleCount, total);
      const slice = sorted.slice(0, loaded);
      const ids = slice.map((r) => r._id).filter(Boolean);
      const allOn = ids.length > 0 && ids.every((id) => selected.has(id));
      selectAllInput.indeterminate =
        ids.some((id) => selected.has(id)) && !allOn;
      selectAllInput.checked = allOn;
    }

    tbody.addEventListener("change", (e) => {
      const cb = e.target;
      if (!(cb instanceof HTMLInputElement) || !cb.classList.contains("row-check")) return;
      const id = cb.dataset.id;
      if (id == null) return;
      if (cb.checked) selected.add(id);
      else selected.delete(id);
      syncSelectAll();
      if (typeof onSelectionChange === "function") onSelectionChange();
    });

    if (sortDelegateRoot) {
      sortDelegateRoot.addEventListener("click", (e) => {
        const th = e.target.closest("thead th[data-sort]");
        if (!th || !sortDelegateRoot.contains(th)) return;
        applySortKey(th.dataset.sort);
      });
    } else {
      sortHeaders.forEach((th) => {
        th.addEventListener("click", () => applySortKey(th.dataset.sort));
      });
    }

    if (searchInput) {
      searchInput.addEventListener("input", () => {
        render(true);
      });
    }

    if (pageSizeEl) {
      pageSizeEl.addEventListener("change", () => {
        render(true);
      });
    }

    if (prevBtn) {
      prevBtn.addEventListener("click", () => {
        render(true);
      });
    }

    if (nextBtn) {
      nextBtn.addEventListener("click", () => {
        appendMore();
      });
    }

    if (selectAllInput) {
      selectAllInput.addEventListener("change", () => {
        const { sorted, total } = getSortedPipeline();
        const loaded = Math.min(visibleCount, total);
        const slice = sorted.slice(0, loaded);
        slice.forEach((r) => {
          if (r._id == null) return;
          if (selectAllInput.checked) selected.add(r._id);
          else selected.delete(r._id);
        });
        tbody.querySelectorAll("input.row-check").forEach((cb) => {
          const id = cb.dataset.id;
          if (!id) return;
          cb.checked = selected.has(id);
        });
        syncSelectAll();
        schedulePersistUiState();
        if (typeof onSelectionChange === "function") onSelectionChange();
      });
    }

    function restoreVisibleSlice(target) {
      const { sorted, total } = getSortedPipeline();
      const chunk = chunkSize();
      const want = Math.floor(Number(target));
      const lo = total === 0 ? 0 : Math.min(chunk, total);
      const hi = total;
      const t =
        !Number.isFinite(want) || want <= 0
          ? lo
          : Math.min(Math.max(want, lo), hi);
      visibleCount = t;
      disconnectLazyIo();
      tbody.innerHTML = sorted
        .slice(0, visibleCount)
        .map((row) => renderRow(row, selected))
        .join("");
      syncSelectAll();
      updateSortUi();
      updateLazyFooter(total, Math.min(visibleCount, total));
      schedulePersistUiState();
      if (typeof afterRender === "function") afterRender();
      connectLazyIo();
    }

    return {
      render: () => render(true),
      getVisibleCount: () => visibleCount,
      restoreVisibleSlice,
      getSortKey: () => sortKey,
      getTableState: () => ({ sortKey, sortDir }),
      setTableState: (s) => {
        if (!s || typeof s !== "object") return;
        if ("sortKey" in s) {
          sortKey = s.sortKey == null || s.sortKey === "" ? null : s.sortKey;
        }
        if (typeof s.sortDir === "number" && (s.sortDir === 1 || s.sortDir === -1)) {
          sortDir = s.sortDir;
        }
      },
      resetPage: () => {
        render(true);
      },
      resetSort: () => {
        sortKey = defaultSortKey;
        sortDir = defaultSortDir;
      },
      clearSelection: () => {
        selected.clear();
        if (selectAllInput) {
          selectAllInput.checked = false;
          selectAllInput.indeterminate = false;
        }
        if (typeof onSelectionChange === "function") onSelectionChange();
      },
      getSelectedIds: () => [...selected],
      getFullFilteredRows: () => {
        const { sorted } = getSortedPipeline();
        return sorted;
      },
    };
  }

  /* ---------- Dashboard alerts (lazy / server pages) + flyout ---------- */
  const daState = { pageSize: 25, total: 0 };
  let daAlertsNextPage = 1;
  let daAlertsLoading = false;
  let daAlertsIo = null;

  function disconnectDaAlertsIo() {
    if (daAlertsIo) {
      daAlertsIo.disconnect();
      daAlertsIo = null;
    }
  }

  function connectDaAlertsIo() {
    disconnectDaAlertsIo();
    const tbody = document.getElementById("dashboard-alerts-body");
    if (!tbody || daAlertsLoading) return;
    const total = daState.total || 0;
    const loaded = tbody.querySelectorAll("tr.alert-row").length;
    if (total === 0 || loaded >= total) return;
    const last = tbody.querySelector("tr.alert-row:last-of-type");
    if (!last) return;
    const root = lazyIntersectionRootForTbody(tbody);
    daAlertsIo = new IntersectionObserver(
      (entries) => {
        for (const ent of entries) {
          if (!ent.isIntersecting || daAlertsLoading) continue;
          const tb = document.getElementById("dashboard-alerts-body");
          const n = tb ? tb.querySelectorAll("tr.alert-row").length : 0;
          if (n < (daState.total || 0)) {
            loadDashboardAlerts({ reset: false }).catch(console.error);
          }
        }
      },
      { root, rootMargin: "160px", threshold: 0.01 }
    );
    daAlertsIo.observe(last);
  }
  let lastDashboardStats = null;
  /** Matches a tenants dashboard billing segment when that filter was applied from the card. */
  let tnDashBilling = null;
  /** "Active" | "Expired" from subscription state; "Expiring" = dashboard opened End date (Past 30 + Next 90). */
  let lcDashState = null;
  const daFilterState = {
    tenant_name: new Set(),
    firewall_hostname: new Set(),
  };
  /** Empty set = all severities; otherwise OR of selected levels (high / medium / low). */
  const daSeverityLevels = new Set();
  /** ``all`` | ``hour`` | ``today`` | ``week`` | ``month`` | ``older`` | ``custom`` */
  let daRaisedPreset = "all";
  const daRaisedCustomStored = { from: "", to: "" };
  let daFacets = { tenant_names: [], firewall_hostnames: [] };

  function appendDashboardSeverityParams(params) {
    if (daSeverityLevels.size === 0 || daSeverityLevels.size >= 3) return;
    daSeverityLevels.forEach((x) => params.append("severity", x));
  }

  function startOfLocalWeekMonday(d) {
    const x = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
    const day = (x.getDay() + 6) % 7;
    x.setDate(x.getDate() - day);
    return x;
  }

  function startOfLocalMonth(d) {
    return new Date(d.getFullYear(), d.getMonth(), 1, 0, 0, 0, 0);
  }

  function toIsoUtc(d) {
    return d.toISOString();
  }

  function getDashboardRaisedBoundsForApi() {
    if (daRaisedPreset === "all") return null;
    const now = new Date();
    if (daRaisedPreset === "hour") {
      const start = new Date(now);
      start.setMinutes(0, 0, 0);
      return { from: toIsoUtc(start), to: toIsoUtc(now) };
    }
    if (daRaisedPreset === "today") {
      const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
      return { from: toIsoUtc(start), to: toIsoUtc(now) };
    }
    if (daRaisedPreset === "week") {
      const start = startOfLocalWeekMonday(now);
      return { from: toIsoUtc(start), to: toIsoUtc(now) };
    }
    if (daRaisedPreset === "month") {
      const start = startOfLocalMonth(now);
      return { from: toIsoUtc(start), to: toIsoUtc(now) };
    }
    if (daRaisedPreset === "older") {
      const end = new Date(now);
      end.setMonth(end.getMonth() - 1);
      const start = new Date(Date.UTC(2000, 0, 1, 0, 0, 0));
      return { from: toIsoUtc(start), to: toIsoUtc(end) };
    }
    if (daRaisedPreset === "custom") {
      const fromEl = document.getElementById("da-raised-custom-from");
      const toEl = document.getElementById("da-raised-custom-to");
      const fromRaw = (fromEl && fromEl.value) || "";
      const toRaw = (toEl && toEl.value) || "";
      let fromMs;
      let toMs;
      if (fromRaw) fromMs = new Date(fromRaw).getTime();
      else fromMs = Date.UTC(2000, 0, 1, 0, 0, 0);
      if (toRaw) toMs = new Date(toRaw).getTime();
      else toMs = Date.now();
      return { from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString() };
    }
    return null;
  }

  function appendDashboardRaisedParams(params) {
    const b = getDashboardRaisedBoundsForApi();
    if (!b) return;
    params.set("raised_from", b.from);
    params.set("raised_to", b.to);
  }

  function appendDashboardAlertApiParams(params) {
    appendDashboardSeverityParams(params);
    appendDashboardRaisedParams(params);
  }

  function dashboardAlertsFacetsQuerySuffix() {
    const p = new URLSearchParams();
    appendDashboardAlertApiParams(p);
    const s = p.toString();
    return s ? `?${s}` : "";
  }

  function syncDashboardRaisedQuickActive() {
    const root = document.getElementById("da-raised-quick-filters");
    if (!root) return;
    root.querySelectorAll("[data-da-raised-quick]").forEach((btn) => {
      const v = btn.getAttribute("data-da-raised-quick");
      btn.classList.toggle("is-active", v === daRaisedPreset);
    });
  }

  function setDashboardRaisedPreset(preset) {
    daRaisedPreset = preset;
    syncDashboardRaisedQuickActive();
  }

  function dashboardAlertAllowedAck(a) {
    const aa = Array.isArray(a.allowed_actions) ? a.allowed_actions : [];
    return aa.some((x) => String(x).toLowerCase() === "acknowledge");
  }

  function syncDaAlertSelectAllCheckbox() {
    const sa = document.getElementById("da-alert-select-all");
    const tbody = document.getElementById("dashboard-alerts-body");
    if (!sa || !tbody) return;
    const boxes = [
      ...tbody.querySelectorAll("tr.alert-row input.da-alert-row-check:not(:disabled)"),
    ];
    const n = boxes.length;
    const checked = boxes.filter((b) => b.checked).length;
    sa.checked = n > 0 && checked === n;
    sa.indeterminate = checked > 0 && checked < n;
  }

  function updateDashboardAckButtonState() {
    const btn = document.getElementById("da-ack-btn");
    const tbody = document.getElementById("dashboard-alerts-body");
    if (!btn || !tbody) return;
    const selected = tbody.querySelectorAll("tr.alert-row input.da-alert-row-check:checked");
    btn.disabled = selected.length === 0;
    syncDaAlertSelectAllCheckbox();
  }

  function findDashboardAlertRowById(alertId) {
    const tb = document.getElementById("dashboard-alerts-body");
    if (!tb || !alertId) return null;
    for (const tr of tb.querySelectorAll("tr.alert-row")) {
      if (tr.getAttribute("data-alert-id") === alertId) return tr;
    }
    return null;
  }

  function summarizeDashboardAlertRow(tr) {
    const cells = tr.querySelectorAll("td");
    const sev = cells[1]?.querySelector(".alert-sev-cell__text")?.textContent?.trim() || "—";
    const tenant = cells[2]?.textContent?.replace(/\s+/g, " ").trim() || "—";
    const fw = cells[3]?.textContent?.replace(/\s+/g, " ").trim() || "—";
    const descEl = cells[4]?.querySelector(".alert-row__desc-text");
    const desc = (descEl?.textContent || cells[4]?.textContent || "—").replace(/\s+/g, " ").trim() || "—";
    const raised = cells[5]?.textContent?.replace(/\s+/g, " ").trim() || "—";
    return { severity: sev, tenant, firewall: fw, description: desc, raised };
  }

  function truncateNotifyDetail(s, maxLen) {
    const t = String(s || "");
    if (t.length <= maxLen) return t;
    return `${t.slice(0, Math.max(0, maxLen - 1))}…`;
  }

  function buildAcknowledgeResultMessage(res, idToSummary) {
    const ack = (res && res.acknowledged) || [];
    const errs = (res && res.errors) || [];
    const lines = [];
    if (ack.length) {
      lines.push(`Acknowledged ${ack.length} alert(s) in Sophos Central.`);
      lines.push("");
      ack.forEach((entry, idx) => {
        const aid = entry && entry.id != null ? String(entry.id) : "";
        const s = aid ? idToSummary.get(aid) : null;
        if (s) {
          const desc = truncateNotifyDetail(s.description, 220);
          lines.push(
            `${idx + 1}) [${s.severity}] ${s.tenant} · ${s.firewall} — ${desc} (${s.raised})`
          );
        } else {
          lines.push(`${idx + 1}) Alert id: ${aid || "—"}`);
        }
      });
    }
    if (errs.length) {
      if (lines.length) lines.push("");
      lines.push(`${errs.length} not acknowledged:`);
      errs.slice(0, 12).forEach((e, idx) => {
        const id = e && e.id != null ? String(e.id) : "—";
        const det = e && e.detail != null ? String(e.detail) : "Error";
        const s = idToSummary.get(id);
        const hint = s ? ` — was: ${truncateNotifyDetail(s.description, 100)}` : "";
        lines.push(`  ${idx + 1}. ${id}: ${det}${hint}`);
      });
      if (errs.length > 12) lines.push(`  … and ${errs.length - 12} more`);
    }
    const syncBad = (res && res.credential_syncs) || [];
    const syncFailed = syncBad.filter((x) => x && !x.ok);
    if (syncFailed.length) {
      lines.push("");
      lines.push("Post-acknowledge sync:");
      syncFailed.slice(0, 5).forEach((s) => {
        lines.push(`  ${s.credential_id || "?"}: ${s.error || "failed"}`);
      });
      if (syncFailed.length > 5) lines.push(`  … and ${syncFailed.length - 5} more`);
    }
    return lines.join("\n");
  }

  async function acknowledgeSelectedDashboardAlerts() {
    const tbody = document.getElementById("dashboard-alerts-body");
    const btn = document.getElementById("da-ack-btn");
    if (!tbody || !btn || btn.disabled) return;
    const ids = [...tbody.querySelectorAll("tr.alert-row input.da-alert-row-check:checked")]
      .map((cb) => cb.closest("tr.alert-row")?.getAttribute("data-alert-id"))
      .filter(Boolean);
    if (!ids.length) return;
    const idToSummary = new Map();
    for (const id of ids) {
      const tr = findDashboardAlertRowById(id);
      if (tr) idToSummary.set(id, summarizeDashboardAlertRow(tr));
    }
    btn.disabled = true;
    try {
      const res = await apiRequestJson("/api/alerts/acknowledge", {
        method: "POST",
        body: JSON.stringify({ ids }),
      });
      const nOk = (res && res.acknowledged && res.acknowledged.length) || 0;
      const nErr = (res && res.errors && res.errors.length) || 0;
      const body = buildAcknowledgeResultMessage(res, idToSummary);
      if (nErr === 0 && nOk > 0) {
        showCredentialRowTestToast(true, body, { title: "Acknowledge" });
      } else if (nErr > 0) {
        showCredentialRowTestToast(false, body, { title: "Acknowledge" });
      } else {
        showCredentialRowTestToast(false, body || "No alerts were acknowledged.", { title: "Acknowledge" });
      }
      await loadDashboardAlerts({ reset: true });
    } catch (err) {
      showCredentialRowTestToast(false, err.message || "Request failed.", { title: "Acknowledge" });
    } finally {
      updateDashboardAckButtonState();
    }
  }

  function hydrateDashboardFromSaved(d) {
    if (!d || typeof d !== "object") return;
    daSeverityLevels.clear();
    if (Array.isArray(d.severity_levels)) {
      d.severity_levels.forEach((x) => {
        const s = String(x).toLowerCase();
        if (s === "high" || s === "medium" || s === "low") daSeverityLevels.add(s);
      });
    } else if (typeof d.severity === "string") {
      const s = d.severity.toLowerCase();
      if (s === "high" || s === "medium" || s === "low") daSeverityLevels.add(s);
    }
    if (typeof d.raised_preset === "string") {
      const rp = d.raised_preset;
      if (["all", "hour", "today", "week", "month", "older", "custom"].includes(rp)) daRaisedPreset = rp;
    }
    const sel = document.getElementById("da-page-size");
    if (typeof d.pageSize === "number") {
      const ps = Math.max(1, d.pageSize);
      daState.pageSize = ps;
      if (sel && [...sel.options].some((o) => o.value === String(ps))) {
        sel.value = String(ps);
      }
    }
    daFilterState.tenant_name.clear();
    daFilterState.firewall_hostname.clear();
    (Array.isArray(d.tenant_names) ? d.tenant_names : []).forEach((v) =>
      daFilterState.tenant_name.add(String(v))
    );
    (Array.isArray(d.firewall_hostnames) ? d.firewall_hostnames : []).forEach((v) =>
      daFilterState.firewall_hostname.add(String(v))
    );
    if (typeof d.filtersExpanded === "boolean") {
      const aside = document.querySelector("#panel-dashboard .filters");
      if (aside) setFiltersPanelCollapsed(aside, !d.filtersExpanded);
    }
    const daSearchEl = document.getElementById("da-search");
    if (daSearchEl && typeof d.search === "string") daSearchEl.value = d.search;
    if (typeof d.raised_custom_from === "string") daRaisedCustomStored.from = d.raised_custom_from;
    if (typeof d.raised_custom_to === "string") daRaisedCustomStored.to = d.raised_custom_to;
    refreshDashboardTenantMultiselect();
  }

  function getDashboardAlertsSearchQuery() {
    const el = document.getElementById("da-search");
    return (el?.value || "").trim();
  }

  function dashboardFacetFilterCount() {
    let n = daFilterState.firewall_hostname.size;
    const sevN = daSeverityLevels.size;
    if (sevN > 0 && sevN < 3) n += sevN;
    if (daRaisedPreset !== "all") n += 1;
    return n;
  }

  function updateDashboardFiltersChrome() {
    const wrap = document.getElementById("da-filters-head-actions");
    const countEl = document.getElementById("da-facet-count");
    const resetBtn = document.getElementById("da-facet-reset");
    if (!wrap || !countEl || !resetBtn) return;
    const n = dashboardFacetFilterCount();
    resetBtn.hidden = n === 0;
    if (n === 0) {
      wrap.hidden = true;
      countEl.textContent = "";
      return;
    }
    wrap.hidden = false;
    countEl.innerHTML = `<span class="filters__facet-count-num">${n}</span> applied`;
  }

  function resetDashboardFacetFilters() {
    daFilterState.firewall_hostname.clear();
    daSeverityLevels.clear();
    daRaisedPreset = "all";
    daRaisedCustomStored.from = "";
    daRaisedCustomStored.to = "";
    syncDashboardRaisedQuickActive();
    syncDashboardAlertFilterCheckboxes();
    setFiltersPanelCollapsed(document.querySelector("#panel-dashboard .filters"), true);
    loadDashboardAlertFacets()
      .then(() => {
        buildDashboardAlertFilters();
        return loadDashboardAlerts({ reset: true });
      })
      .catch(console.error);
  }

  function dashboardTenantMultiselectOptionNames() {
    const fromFacets = Array.isArray(daFacets.tenant_names) ? daFacets.tenant_names.map(String) : [];
    const merged = new Set(fromFacets);
    daFilterState.tenant_name.forEach((t) => merged.add(String(t)));
    return [...merged].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
  }

  function updateDashboardTenantMultiselectSummary() {
    const sumEl = document.getElementById("da-tenant-ms-summary");
    const clearBtn = document.getElementById("da-tenant-ms-clear");
    if (!sumEl) return;
    const n = daFilterState.tenant_name.size;
    if (n === 0) {
      sumEl.textContent = "All tenants";
      if (clearBtn) clearBtn.hidden = true;
      return;
    }
    if (clearBtn) clearBtn.hidden = false;
    if (n === 1) {
      const one = [...daFilterState.tenant_name][0];
      sumEl.textContent = one.length > 42 ? `${one.slice(0, 39)}…` : one;
      return;
    }
    sumEl.textContent = `${n} tenants`;
  }

  function applyDashboardTenantMultiselectSearch() {
    const inp = document.getElementById("da-tenant-ms-search");
    const list = document.getElementById("da-tenant-ms-list");
    if (!inp || !list) return;
    const q = (inp.value || "").trim().toLowerCase();
    // Inline display overrides .da-tenant-ms__opt { display:flex } (see applyFwFacetListSearchInput).
    list.querySelectorAll(".da-tenant-ms__opt").forEach((row) => {
      const t = (row.getAttribute("data-tenant-label") || "").toLowerCase();
      row.style.display = !q || t.includes(q) ? "" : "none";
    });
  }

  function refreshDashboardTenantMultiselect() {
    const list = document.getElementById("da-tenant-ms-list");
    if (!list) return;
    const names = dashboardTenantMultiselectOptionNames();
    const maxOpts = 200;
    const slice = names.slice(0, maxOpts);
    list.innerHTML = slice
      .map(
        (name) => `
      <label class="da-tenant-ms__opt" data-tenant-label="${escapeAttr(name)}">
        <input type="checkbox" class="da-tenant-ms__cb" value="${escapeAttr(name)}" />
        <span class="da-tenant-ms__opt-text">${escapeHtml(name)}</span>
      </label>`
      )
      .join("");
    if (names.length > maxOpts) {
      list.insertAdjacentHTML(
        "beforeend",
        `<p class="da-tenant-ms__cap muted">Showing first ${maxOpts} of ${names.length} tenants. Refine filters to narrow the list.</p>`
      );
    }
    list.querySelectorAll(".da-tenant-ms__cb").forEach((cb) => {
      cb.checked = daFilterState.tenant_name.has(cb.value);
      cb.addEventListener("change", () => {
        if (cb.checked) daFilterState.tenant_name.add(cb.value);
        else daFilterState.tenant_name.delete(cb.value);
        updateDashboardTenantMultiselectSummary();
        schedulePersistUiState();
        loadDashboardAlerts({ reset: true }).catch(console.error);
      });
    });
    updateDashboardTenantMultiselectSummary();
    applyDashboardTenantMultiselectSearch();
  }

  function setDashboardTenantMultiselectOpen(open) {
    const panel = document.getElementById("da-tenant-ms-panel");
    const trig = document.getElementById("da-tenant-ms-trigger");
    if (!panel || !trig) return;
    panel.hidden = !open;
    trig.setAttribute("aria-expanded", open ? "true" : "false");
    trig.classList.toggle("is-open", open);
    if (open) {
      const s = document.getElementById("da-tenant-ms-search");
      if (s) {
        s.value = "";
        applyDashboardTenantMultiselectSearch();
        queueMicrotask(() => s.focus());
      }
    }
  }

  function initDashboardTenantMultiselect() {
    const root = document.getElementById("da-tenant-ms");
    const trig = document.getElementById("da-tenant-ms-trigger");
    const panel = document.getElementById("da-tenant-ms-panel");
    const clearBtn = document.getElementById("da-tenant-ms-clear");
    const searchInp = document.getElementById("da-tenant-ms-search");
    if (!root || !trig || !panel) return;

    trig.addEventListener("click", (e) => {
      e.stopPropagation();
      setDashboardTenantMultiselectOpen(panel.hidden);
    });

    clearBtn?.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (daFilterState.tenant_name.size === 0) return;
      daFilterState.tenant_name.clear();
      refreshDashboardTenantMultiselect();
      setDashboardTenantMultiselectOpen(false);
      schedulePersistUiState();
      loadDashboardAlerts({ reset: true }).catch(console.error);
    });

    searchInp?.addEventListener("input", () => applyDashboardTenantMultiselectSearch());
    searchInp?.addEventListener("search", () => applyDashboardTenantMultiselectSearch());

    searchInp?.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setDashboardTenantMultiselectOpen(false);
        trig.focus();
      }
    });

    document.addEventListener(
      "pointerdown",
      (e) => {
        if (panel.hidden) return;
        if (e.target.closest("#da-tenant-ms")) return;
        setDashboardTenantMultiselectOpen(false);
      },
      true
    );

    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      if (panel.hidden) return;
      setDashboardTenantMultiselectOpen(false);
      trig.focus();
    });
  }

  async function loadDashboardAlertFacets() {
    daFacets = await loadJson(`/api/alerts/facets${dashboardAlertsFacetsQuerySuffix()}`);
  }

  function syncDashboardAlertFilterCheckboxes() {
    const host = document.getElementById("da-filters");
    if (!host) return;
    host.querySelectorAll('input[type="checkbox"][data-cat]').forEach((cb) => {
      const cat = cb.dataset.cat;
      const st = daFilterState[cat];
      if (!st) return;
      cb.checked = st.has(cb.value);
    });
    host.querySelectorAll('input[type="checkbox"][data-da-severity]').forEach((cb) => {
      const v = (cb.getAttribute("data-da-severity") || "").toLowerCase();
      cb.checked = daSeverityLevels.has(v);
    });
    host.querySelectorAll('input[type="radio"][name="da-raised-preset"]').forEach((rb) => {
      rb.checked = rb.value === daRaisedPreset;
    });
    const customWrap = host.querySelector("[data-da-raised-custom-wrap]");
    if (customWrap) customWrap.hidden = daRaisedPreset !== "custom";
  }

  function buildDashboardAlertFilters() {
    const host = document.getElementById("da-filters");
    if (!host) return;
    const sevOpts = [
      { v: "high", label: "High" },
      { v: "medium", label: "Medium" },
      { v: "low", label: "Low" },
    ];
    const severityBody = sevOpts
      .map(
        (o) => `
        <label class="filter-opt filter-opt--severity">
          <input type="checkbox" data-da-severity="${escapeHtml(o.v)}" value="${escapeHtml(o.v)}" />
          <span class="filter-opt__severity-icon">${severityIconSvgHtml(o.v)}</span>
          <span>${escapeHtml(o.label)}</span>
        </label>`
      )
      .join("");

    const raisedPresets = [
      { v: "all", label: "Any time" },
      { v: "hour", label: "This hour" },
      { v: "today", label: "Today" },
      { v: "week", label: "This week" },
      { v: "month", label: "This month" },
      { v: "older", label: ">1 month ago" },
      { v: "custom", label: "Custom" },
    ];
    const raisedRadios = raisedPresets
      .map(
        (p) => `
        <label class="filter-opt filter-opt--radio">
          <input type="radio" name="da-raised-preset" value="${escapeHtml(p.v)}" />
          <span>${escapeHtml(p.label)}</span>
        </label>`
      )
      .join("");
    const customHidden = daRaisedPreset !== "custom";
    const customBlock = `
      <div class="da-raised-custom-wrap" data-da-raised-custom-wrap="" ${customHidden ? "hidden" : ""}>
        <label class="da-raised-custom-field">
          <span class="da-raised-custom-label">From</span>
          <input type="datetime-local" id="da-raised-custom-from" class="da-raised-custom-input" step="1" autocomplete="off" aria-label="Raised from date and time" />
        </label>
        <label class="da-raised-custom-field">
          <span class="da-raised-custom-label">To</span>
          <input type="datetime-local" id="da-raised-custom-to" class="da-raised-custom-input" step="1" autocomplete="off" aria-label="Raised to date and time" />
        </label>
        <p class="da-raised-custom-hint muted">Leave blank to use Jan 1, 2000 (from) or now (to).</p>
      </div>`;

    const groups = [
      { key: "severity_facet", label: "Severity", body: severityBody, wrapKey: "severity_facet" },
      { key: "raised_facet", label: "Date raised", body: raisedRadios + customBlock, wrapKey: "raised_facet" },
      { key: "firewall_hostname", label: "Firewall", optsKey: "firewall_hostnames" },
    ];
    const optsByKey = {
      firewall_hostnames: Array.isArray(daFacets.firewall_hostnames)
        ? daFacets.firewall_hostnames
        : [],
    };

    let idx = 0;
    const parts = groups.map((g) => {
      if (g.optsKey) {
        const opts = (optsByKey[g.optsKey] || []).slice(0, 120);
        const open = idx < 2 ? "is-open" : "";
        idx += 1;
        const optsHtml = opts
          .map(
            (o) => `
          <label class="filter-opt">
            <input type="checkbox" data-cat="${escapeHtml(g.key)}" value="${escapeHtml(o)}" />
            <span>${escapeHtml(o)}</span>
          </label>`
          )
          .join("");
        return `
        <div class="filter-group ${open}" data-cat-wrap="${escapeHtml(g.key)}">
          <button type="button" class="filter-group__head" aria-expanded="${open === "is-open"}">
            <span>${escapeHtml(g.label)}</span>
            <span class="filter-group__chev">▼</span>
          </button>
          <div class="filter-group__body">${optsHtml}</div>
        </div>`;
      }
      const open = idx < 2 ? "is-open" : "";
      idx += 1;
      return `
        <div class="filter-group ${open}" data-cat-wrap="${escapeHtml(g.wrapKey)}">
          <button type="button" class="filter-group__head" aria-expanded="${open === "is-open"}">
            <span>${escapeHtml(g.label)}</span>
            <span class="filter-group__chev">▼</span>
          </button>
          <div class="filter-group__body">${g.body}</div>
        </div>`;
    });

    host.innerHTML = parts.join("");

    host.querySelectorAll(".filter-group__head").forEach((btn) => {
      btn.addEventListener("click", () => {
        const grp = btn.closest(".filter-group");
        grp.classList.toggle("is-open");
        btn.setAttribute("aria-expanded", grp.classList.contains("is-open"));
      });
    });

    host.querySelectorAll('input[type="checkbox"][data-cat]').forEach((cb) => {
      cb.addEventListener("change", () => {
        const cat = cb.dataset.cat;
        const st = daFilterState[cat];
        if (!st) return;
        if (cb.checked) st.add(cb.value);
        else st.delete(cb.value);
        loadDashboardAlerts({ reset: true }).catch(console.error);
      });
    });

    host.querySelectorAll('input[type="checkbox"][data-da-severity]').forEach((cb) => {
      cb.addEventListener("change", () => {
        const v = (cb.getAttribute("data-da-severity") || "").toLowerCase();
        if (!v) return;
        if (cb.checked) daSeverityLevels.add(v);
        else daSeverityLevels.delete(v);
        if (daSeverityLevels.size >= 3) daSeverityLevels.clear();
        loadDashboardAlertFacets()
          .then(() => {
            buildDashboardAlertFilters();
            updateDashboardAlertsHeading();
            syncDashboardAlertStatActive();
            schedulePersistUiState();
            return loadDashboardAlerts({ reset: true });
          })
          .catch(console.error);
      });
    });

    host.querySelectorAll('input[type="radio"][name="da-raised-preset"]').forEach((rb) => {
      rb.addEventListener("change", () => {
        if (!rb.checked) return;
        daRaisedPreset = rb.value;
        syncDashboardRaisedQuickActive();
        schedulePersistUiState();
        const cw = host.querySelector("[data-da-raised-custom-wrap]");
        if (cw) cw.hidden = daRaisedPreset !== "custom";
        loadDashboardAlertFacets()
          .then(() => {
            buildDashboardAlertFilters();
            return loadDashboardAlerts({ reset: true });
          })
          .catch(console.error);
      });
    });

    host.querySelectorAll("#da-raised-custom-from, #da-raised-custom-to").forEach((inp) => {
      inp.addEventListener("change", () => {
        daRaisedCustomStored.from = document.getElementById("da-raised-custom-from")?.value ?? "";
        daRaisedCustomStored.to = document.getElementById("da-raised-custom-to")?.value ?? "";
        schedulePersistUiState();
        if (daRaisedPreset !== "custom") return;
        loadDashboardAlerts({ reset: true }).catch(console.error);
      });
    });

    if (daRaisedPreset === "custom") {
      const cf = document.getElementById("da-raised-custom-from");
      const ct = document.getElementById("da-raised-custom-to");
      if (cf) cf.value = daRaisedCustomStored.from;
      if (ct) ct.value = daRaisedCustomStored.to;
    }

    syncDashboardAlertFilterCheckboxes();
    syncDashboardRaisedQuickActive();
    updateDashboardFiltersChrome();
    refreshDashboardTenantMultiselect();
  }

  function updateDashboardAlertsHeading() {
    const el = document.getElementById("dashboard-alerts-heading");
    if (!el) return;
    const levels = [...daSeverityLevels].sort();
    if (levels.length === 0) {
      el.textContent = "Alerts";
      return;
    }
    if (levels.length === 1) {
      const u = levels[0].charAt(0).toUpperCase() + levels[0].slice(1);
      el.textContent = `Alerts — ${u} severity`;
      return;
    }
    const parts = levels.map((x) => x.charAt(0).toUpperCase() + x.slice(1));
    el.textContent = `Alerts — ${parts.join(", ")}`;
  }

  function syncDashboardAlertStatActive() {
    const root = document.getElementById("dashboard-stats");
    if (!root) return;
    root.querySelectorAll("[data-alert-severity]").forEach((el) => {
      const sev = el.dataset.alertSeverity;
      let on = false;
      if (sev === "all") on = daSeverityLevels.size === 0;
      else if (sev === "high" || sev === "medium" || sev === "low")
        on = daSeverityLevels.size === 1 && daSeverityLevels.has(sev);
      el.classList.toggle("is-active", on);
    });
  }

  async function loadDashboardAlerts(opts = {}) {
    const reset = opts.reset !== false;
    const tbody = document.getElementById("dashboard-alerts-body");
    const pageSizeEl = document.getElementById("da-page-size");
    const hintEl = document.getElementById("da-lazy-hint");
    if (!tbody) return;
    if (daAlertsLoading) return;

    daState.pageSize = Math.max(1, parseInt(pageSizeEl?.value, 10) || 25);

    if (reset) {
      disconnectDaAlertsIo();
      tbody.innerHTML = "";
      daAlertsNextPage = 1;
    }

    const loadedBefore = tbody.querySelectorAll("tr.alert-row").length;
    if (!reset && daState.total > 0 && loadedBefore >= daState.total) {
      connectDaAlertsIo();
      return;
    }

    daAlertsLoading = true;
    if (hintEl && !reset) hintEl.textContent = "Loading more…";

    try {
      const params = new URLSearchParams();
      params.set("page", String(daAlertsNextPage));
      params.set("page_size", String(daState.pageSize));
      appendDashboardAlertApiParams(params);
      daFilterState.tenant_name.forEach((v) => params.append("tenant_name", v));
      daFilterState.firewall_hostname.forEach((v) => params.append("firewall_hostname", v));
      const q = getDashboardAlertsSearchQuery();
      if (q) params.set("q", q);
      const data = await loadJson(`/api/alerts?${params.toString()}`);
      if (reset || daAlertsNextPage === 1) {
        daState.total = data.total ?? 0;
      }
      const items = data.items || [];
      const rowsHtml = items
        .map((a) => {
          const cls = severityClass(a.severity);
          const id = escapeHtml(a.id);
          const canAck = dashboardAlertAllowedAck(a);
          const dis = canAck ? "" : " disabled";
          const titleDis = canAck ? "" : ' title="This alert does not allow acknowledge"';
          const ackLabel = canAck ? "Select alert for acknowledge" : "Cannot acknowledge this alert";
          const tn = escapeHtml(a.tenant_name != null && a.tenant_name !== "" ? a.tenant_name : "—");
          const fh = escapeHtml(
            a.firewall_hostname != null && a.firewall_hostname !== "" ? a.firewall_hostname : "—"
          );
          const rp = renderFwRecencyPillHtml(a.recency_tag);
          const descText = escapeHtml(a.description || "—");
          return `<tr class="alert-row" tabindex="0" data-alert-id="${id}" data-can-acknowledge="${canAck ? "1" : "0"}" aria-label="View alert details">
          <td class="data-table__col-check th-check"${titleDis}>
            <input type="checkbox" class="da-alert-row-check"${dis} aria-label="${escapeAttr(ackLabel)}" />
          </td>
          <td class="alert-sev-cell ${cls}"><span class="alert-sev-cell__icon" aria-hidden="true">${severityIconSvgHtml(a.severity)}</span><span class="alert-sev-cell__text">${escapeHtml(a.severity || "—")}</span></td>
          <td class="alert-row__cell--truncate muted" title="${tn}">${tn}</td>
          <td class="alert-row__cell--truncate muted" title="${fh}">${fh}</td>
          <td class="alert-row__desc"><span class="table-recency-inline">${rp}<span class="alert-row__desc-text">${descText}</span></span></td>
          <td class="muted">${fmtDate(a.raised_at)}</td>
        </tr>`;
        })
        .join("");
      tbody.insertAdjacentHTML("beforeend", rowsHtml);
      daAlertsNextPage += 1;

      const total = daState.total;
      const loaded = tbody.querySelectorAll("tr.alert-row").length;
      const countEl = document.getElementById("da-count");
      if (countEl) {
        countEl.textContent = total === 0 ? "0 alerts" : `${loaded} of ${total} alerts`;
      }
      if (hintEl) {
        if (total === 0) hintEl.textContent = "";
        else if (loaded >= total) hintEl.textContent = "All alerts loaded";
        else hintEl.textContent = "Scroll for more";
      }

      updateDashboardAlertsHeading();
      syncDashboardAlertStatActive();
      updateDashboardFiltersChrome();
      updateDashboardAckButtonState();
      schedulePersistUiState();
    } finally {
      daAlertsLoading = false;
      /* Must run after loading flag clears: connectDaAlertsIo bails out while daAlertsLoading is true. */
      connectDaAlertsIo();
    }
  }

  function flyoutDetailRow(label, valueHtml) {
    return `<div class="flyout-dl__row"><dt>${escapeHtml(label)}</dt><dd>${valueHtml}</dd></div>`;
  }

  function firewallFilterHostnameValue(hostname, name) {
    const rawH = hostname != null && String(hostname) !== "" ? String(hostname) : "";
    const rawN = name != null && String(name) !== "" ? String(name) : "";
    return rawH || rawN || "—";
  }

  function formatFirewallDisplay(hostname, name) {
    const filterVal = firewallFilterHostnameValue(hostname, name);
    const h = hostname != null && String(hostname).trim() !== "" ? String(hostname).trim() : "";
    const n = name != null && String(name).trim() !== "" ? String(name).trim() : "";
    if (!h && !n) return null;
    function hostLineHtml(display) {
      if (filterVal === "—") return escapeHtml(display);
      return `<button type="button" class="cell-link flyout-fw__host-link" data-fw-host="${encodeURIComponent(filterVal)}" title="Show in Firewalls">${escapeHtml(display)}</button>`;
    }
    if (h && n && h !== n) {
      return `<div class="flyout-fw"><div class="flyout-fw__line">${hostLineHtml(h)}</div><div class="flyout-fw__line flyout-fw__line--secondary muted">${escapeHtml(n)}</div></div>`;
    }
    return `<div class="flyout-fw"><div class="flyout-fw__line">${hostLineHtml(h || n)}</div></div>`;
  }

  async function openAlertFlyout(alertId) {
    const backdrop = document.getElementById("alert-flyout-backdrop");
    const panel = document.getElementById("alert-flyout");
    const body = document.getElementById("alert-flyout-body");
    body.innerHTML = '<p class="muted">Loading…</p>';
    backdrop.hidden = false;
    panel.hidden = false;
    document.body.style.overflow = "hidden";

    try {
      const d = await loadJson(`/api/alerts/${encodeURIComponent(alertId)}`);
      const desc = escapeHtml(d.description || "—").replace(/\n/g, "<br />");
      const sev = severityClass(d.severity);
      const tenantCell =
        d.tenant_display_name || d.tenant_name
          ? escapeHtml(d.tenant_display_name || d.tenant_name)
          : d.tenant_id
            ? `<span class="muted">No tenant record</span> <code class="flyout-code">${escapeHtml(d.tenant_id)}</code>`
            : "—";
      const fwCell =
        formatFirewallDisplay(d.firewall_hostname, d.firewall_name) ||
        `<pre class="flyout-pre">${formatJsonish(d.managed_agent_json)}</pre>`;
      body.innerHTML = `
        <p class="flyout-lead flyout-lead--alert"><span class="alert-sev-flyout ${sev}" aria-hidden="true">${severityIconSvgHtml(d.severity)}</span><span class="${sev}">${escapeHtml(d.severity || "—")}</span> · ${escapeHtml(d.product || "—")}</p>
        <dl class="flyout-dl">
          ${flyoutDetailRow("Raised", fmtDate(d.raised_at))}
          ${flyoutDetailRow("Category", escapeHtml(d.category || "—"))}
          ${flyoutDetailRow("Type", escapeHtml(d.type || "—"))}
          ${flyoutDetailRow("Description", `<div class="flyout-desc">${desc}</div>`)}
          ${flyoutDetailRow("Tenant", tenantCell)}
          ${flyoutDetailRow("Firewall", fwCell)}
          ${flyoutDetailRow("First sync", fmtDate(d.first_sync))}
          ${flyoutDetailRow("Last sync", fmtDate(d.last_sync))}
          ${flyoutDetailRow("Sync ID", `<code class="flyout-code">${escapeHtml(d.sync_id || "—")}</code>`)}
        </dl>`;
    } catch {
      body.innerHTML = '<p class="sev-high">Could not load this alert.</p>';
    }
  }

  function closeAlertFlyout() {
    document.getElementById("alert-flyout-backdrop").hidden = true;
    document.getElementById("alert-flyout").hidden = true;
    document.body.style.overflow = "";
  }

  function openDashboardFirewallFilterGroup() {
    expandDashboardFiltersPanel();
    const wrap = document.querySelector(
      '#da-filters .filter-group[data-cat-wrap="firewall_hostname"]'
    );
    if (!wrap) return;
    wrap.classList.add("is-open");
    const head = wrap.querySelector(".filter-group__head");
    if (head) head.setAttribute("aria-expanded", "true");
  }

  function goToDashboardAlertsForFirewall(hostnameFilter) {
    if (hostnameFilter == null) return;
    daFilterState.tenant_name.clear();
    daFilterState.firewall_hostname.clear();
    daFilterState.firewall_hostname.add(String(hostnameFilter));
    closeAlertFlyout();
    activateTab("dashboard");
    expandDashboardFiltersPanel();
    openDashboardFirewallFilterGroup();
    loadDashboardAlertFacets()
      .then(() => {
        buildDashboardAlertFilters();
        return loadDashboardAlerts({ reset: true });
      })
      .catch(console.error);
  }

  function initFacetFilterResetControls() {
    document.getElementById("da-facet-reset")?.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      resetDashboardFacetFilters();
    });
    document.getElementById("fw-facet-reset")?.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      resetFirewallFacetFilters();
    });
    document.getElementById("ops-facet-reset")?.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      resetFirewallFacetFilters();
    });
    document.getElementById("tn-facet-reset")?.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      resetTenantFacetFilters();
    });
    document.getElementById("gr-facet-reset")?.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      resetGroupFacetFilters();
    });
    document.getElementById("lc-facet-reset")?.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      resetLicenseFacetFilters();
    });
  }

  function initDashboardAlertsUi() {
    document.getElementById("da-page-size").addEventListener("change", () => {
      loadDashboardAlerts({ reset: true }).catch(console.error);
    });

    document.getElementById("da-search")?.addEventListener("input", () => {
      loadDashboardAlerts({ reset: true }).catch(console.error);
    });

    document.getElementById("dashboard-stats").addEventListener("click", (e) => {
      const t = e.target.closest("[data-dash-action]");
      if (!t) return;
      const act = t.dataset.dashAction;
      if (act === "fw-all") {
        goToFirewallsUnfiltered();
        return;
      }
      if (act === "fw-online") {
        goToFirewallsOnline();
        return;
      }
      if (act === "fw-offline") {
        goToFirewallsOffline();
        return;
      }
      if (act === "fw-suspended") {
        goToFirewallsSuspended();
        return;
      }
      if (act === "fw-pending") {
        goToFirewallsPending();
        return;
      }
      if (act === "tn-all") {
        goToTenantsUnfiltered().catch(console.error);
        return;
      }
      if (act === "tn-billing") {
        const bt = t.dataset.billingType;
        if (bt == null || bt === "") return;
        goToTenantsFilteredByBilling(bt).catch(console.error);
        return;
      }
      if (act === "lic-all") {
        goToLicensesUnfiltered().catch(console.error);
        return;
      }
      if (act === "lc-sub-state") {
        const st = t.dataset.lcSubState;
        if (!st) return;
        goToLicensesFilteredBySubscriptionState(st).catch(console.error);
        return;
      }
      if (act === "lc-end-expiring") {
        goToLicensesDashboardExpiring().catch(console.error);
        return;
      }
      if (act === "alerts-sev") {
        const sev = t.dataset.alertSeverity;
        if (!sev) return;
        daSeverityLevels.clear();
        if (sev !== "all") daSeverityLevels.add(sev);
        loadDashboardAlertFacets()
          .then(() => {
            buildDashboardAlertFilters();
            updateDashboardAlertsHeading();
            syncDashboardAlertStatActive();
            schedulePersistUiState();
            return loadDashboardAlerts({ reset: true });
          })
          .catch(console.error);
      }
    });

    const tbody = document.getElementById("dashboard-alerts-body");
    tbody.addEventListener("change", (e) => {
      const cb = e.target.closest("input.da-alert-row-check");
      if (cb) updateDashboardAckButtonState();
    });
    tbody.addEventListener("click", (e) => {
      if (e.target.closest("input.da-alert-row-check")) return;
      const tr = e.target.closest("tr.alert-row[data-alert-id]");
      if (!tr) return;
      openAlertFlyout(tr.getAttribute("data-alert-id")).catch(console.error);
    });
    tbody.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      if (e.target.closest("input.da-alert-row-check")) return;
      const tr = e.target.closest("tr.alert-row[data-alert-id]");
      if (!tr) return;
      e.preventDefault();
      openAlertFlyout(tr.getAttribute("data-alert-id")).catch(console.error);
    });

    document.getElementById("da-alert-select-all")?.addEventListener("change", (ev) => {
      const on = ev.target.checked;
      const tb = document.getElementById("dashboard-alerts-body");
      if (!tb) return;
      tb.querySelectorAll("tr.alert-row input.da-alert-row-check:not(:disabled)").forEach((cb) => {
        cb.checked = on;
      });
      updateDashboardAckButtonState();
    });

    document.getElementById("da-ack-btn")?.addEventListener("click", () => {
      acknowledgeSelectedDashboardAlerts().catch(console.error);
    });

    document.getElementById("da-raised-quick-filters")?.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-da-raised-quick]");
      if (!btn) return;
      e.preventDefault();
      const preset = btn.getAttribute("data-da-raised-quick");
      if (!preset || !["hour", "today", "week", "month"].includes(preset)) return;
      daRaisedPreset = preset;
      syncDashboardRaisedQuickActive();
      loadDashboardAlertFacets()
        .then(() => {
          buildDashboardAlertFilters();
          updateDashboardFiltersChrome();
          schedulePersistUiState();
          return loadDashboardAlerts({ reset: true });
        })
        .catch(console.error);
    });

    initDashboardTenantMultiselect();

    document.getElementById("alert-flyout-backdrop").addEventListener("click", closeAlertFlyout);
    document.querySelector("#alert-flyout .flyout__close-btn").addEventListener("click", closeAlertFlyout);
    document.getElementById("alert-flyout").addEventListener("click", (e) => {
      const btn = e.target.closest("button.flyout-fw__host-link");
      if (!btn) return;
      e.preventDefault();
      const enc = btn.getAttribute("data-fw-host");
      if (enc == null || enc === "") return;
      try {
        goToFirewallsFilteredByHostname(decodeURIComponent(enc));
      } catch {
        /* ignore malformed data-fw-host */
      }
    });
    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      const uep = document.getElementById("user-edit-profile-dialog");
      if (uep && !uep.hidden) {
        closeUserEditProfileDialog();
        e.preventDefault();
        return;
      }
      const uf = document.getElementById("user-form-dialog");
      if (uf && !uf.hidden) {
        closeUserFormDialog();
        e.preventDefault();
        return;
      }
      const pm = document.getElementById("profile-modal");
      if (pm && !pm.hidden) {
        closeProfileModal();
        e.preventDefault();
        return;
      }
      const cf = document.getElementById("credential-form-dialog");
      if (cf && !cf.hidden) {
        closeCredentialFormDialog();
        e.preventDefault();
        return;
      }
      const sm = document.getElementById("settings-modal");
      if (sm && !sm.hidden) {
        closeSettingsModal();
        e.preventDefault();
        return;
      }
      const licenseFlyout = document.getElementById("license-flyout");
      if (licenseFlyout && !licenseFlyout.hidden) {
        closeLicenseSubscriptionsFlyout();
        e.preventDefault();
        return;
      }
      const panel = document.getElementById("alert-flyout");
      if (!panel.hidden) closeAlertFlyout();
    });
  }

  function refreshDashboardStatCards() {
    if (!lastDashboardStats) return;
    const root = document.getElementById("dashboard-stats");
    if (!root) return;
    root.innerHTML = renderDashboardStats(lastDashboardStats);
  }

  function expandTenantFiltersPanel() {
    setFiltersPanelCollapsed(document.querySelector("#panel-tenants .filters"), false);
  }

  function openTenantBillingFilterGroup() {
    expandTenantFiltersPanel();
    const wrap = document.querySelector('#tenant-filters .filter-group[data-cat-wrap="billing_type"]');
    if (!wrap) return;
    wrap.classList.add("is-open");
    const head = wrap.querySelector(".filter-group__head");
    if (head) head.setAttribute("aria-expanded", "true");
  }

  async function goToTenantsUnfiltered() {
    if (!tnFilterState.billing_type) await loadTenants();
    tnDashBilling = null;
    const host = document.getElementById("tenant-filters");
    for (const st of Object.values(tnFilterState)) {
      if (st && typeof st.clear === "function") st.clear();
    }
    if (host) {
      host.querySelectorAll('input[type="checkbox"][data-cat]').forEach((cb) => {
        cb.checked = false;
      });
    }
    tnController.resetSort();
    tnController.resetPage();
    activateTab("tenants");
    tnController.render();
    updateTenantFiltersChrome();
    schedulePersistUiState();
    refreshDashboardStatCards();
  }

  async function goToTenantsFilteredByBilling(billingType) {
    if (billingType == null || billingType === "") return;
    if (!tnFilterState.billing_type) await loadTenants();
    tnDashBilling = billingType;
    const host = document.getElementById("tenant-filters");
    for (const st of Object.values(tnFilterState)) {
      if (st && typeof st.clear === "function") st.clear();
    }
    if (host) {
      host.querySelectorAll('input[type="checkbox"][data-cat]').forEach((cb) => {
        cb.checked = false;
      });
    }
    const bset = tnFilterState.billing_type;
    if (bset) bset.add(billingType);
    syncTenantFilterCheckboxesFromState();
    openTenantBillingFilterGroup();
    tnController.resetSort();
    tnController.resetPage();
    activateTab("tenants");
    tnController.render();
    updateTenantFiltersChrome();
    schedulePersistUiState();
    refreshDashboardStatCards();
  }

  /** Conic-gradient for dashboard alert severity donut (high → medium → low, clockwise from top). */
  function alertSeverityDonutGradient(ah, am, al) {
    const h = Math.max(0, Number(ah) || 0);
    const m = Math.max(0, Number(am) || 0);
    const l = Math.max(0, Number(al) || 0);
    const t = h + m + l;
    const HIGH = "#c62828";
    const MED = "#0066cc";
    const LOW = "#5c5c5c";
    const NEUTRAL = "#e4e6ea";
    if (t === 0) {
      return `conic-gradient(${NEUTRAL} 0deg 360deg)`;
    }
    const segs = [];
    if (h > 0) segs.push({ n: h, c: HIGH });
    if (m > 0) segs.push({ n: m, c: MED });
    if (l > 0) segs.push({ n: l, c: LOW });
    let cur = 0;
    const parts = segs.map((seg, i) => {
      const isLast = i === segs.length - 1;
      const endDeg = isLast ? 360 : cur + (seg.n / t) * 360;
      const s = `${seg.c} ${cur}deg ${endDeg}deg`;
      cur = endDeg;
      return s;
    });
    return `conic-gradient(${parts.join(", ")})`;
  }

  function alertSeverityDonutAriaLabel(ah, am, al, total) {
    const h = Math.max(0, Number(ah) || 0);
    const m = Math.max(0, Number(am) || 0);
    const l = Math.max(0, Number(al) || 0);
    const n = Math.max(0, Number(total) || 0);
    return `Severity breakdown: ${h} high, ${m} medium, ${l} low of ${n} alerts`;
  }

  const TENANT_BILLING_DONUT_PALETTE = [
    "#0066cc",
    "#c62828",
    "#1a9b4a",
    "#7c3aed",
    "#c05600",
    "#0891b2",
    "#ca8a04",
    "#5c5c5c",
  ];

  function tenantBillingSliceColor(index) {
    return TENANT_BILLING_DONUT_PALETTE[index % TENANT_BILLING_DONUT_PALETTE.length];
  }

  /** Conic-gradient for tenant billing-type donut (slice order matches API facet order). */
  function tenantBillingDonutGradient(facets) {
    const NEUTRAL = "#e4e6ea";
    if (!Array.isArray(facets) || facets.length === 0) {
      return `conic-gradient(${NEUTRAL} 0deg 360deg)`;
    }
    const items = facets.map((b, i) => ({
      n: Math.max(0, Number(b.count) || 0),
      c: tenantBillingSliceColor(i),
    }));
    const positive = items.filter((x) => x.n > 0);
    const t = positive.reduce((a, x) => a + x.n, 0);
    if (t === 0) {
      return `conic-gradient(${NEUTRAL} 0deg 360deg)`;
    }
    let cur = 0;
    const parts = positive.map((seg, i) => {
      const isLast = i === positive.length - 1;
      const endDeg = isLast ? 360 : cur + (seg.n / t) * 360;
      const s = `${seg.c} ${cur}deg ${endDeg}deg`;
      cur = endDeg;
      return s;
    });
    return `conic-gradient(${parts.join(", ")})`;
  }

  function tenantBillingDonutAriaLabel(facets, totalTenants) {
    const n = Math.max(0, Number(totalTenants) || 0);
    if (!Array.isArray(facets) || facets.length === 0) {
      return `No billing type breakdown; ${n} tenants`;
    }
    const parts = facets
      .map((b) => {
        const label = b.billing_type != null && String(b.billing_type) !== "" ? String(b.billing_type) : "—";
        const c = Math.max(0, Number(b.count) || 0);
        return `${label}: ${c}`;
      })
      .join("; ");
    return `Billing breakdown: ${parts} (${n} tenants)`;
  }

  function renderDashboardStats(stats) {
    const fwOn = escapeHtml(String(stats.firewalls_online));
    const ah = stats.alerts_high ?? 0;
    const am = stats.alerts_medium ?? 0;
    const al = stats.alerts_low ?? 0;
    const billingFacets = Array.isArray(stats.tenants_by_billing) ? stats.tenants_by_billing : [];
    const licA = stats.licenses_subscription_active ?? 0;
    const licE = stats.licenses_subscription_expired ?? 0;
    const licX = stats.licenses_subscription_expiring ?? 0;
    const billingSegs = billingFacets
      .map((b, i) => {
        const bt = b.billing_type != null && String(b.billing_type) !== "" ? String(b.billing_type) : "—";
        const cnt = b.count ?? 0;
        const active = tnDashBilling === bt ? " is-active" : "";
        const safeTitle = escapeHtml(bt);
        const swatchColor = tenantBillingSliceColor(i);
        return `<button type="button" class="stat-card__alert-seg${active}" data-dash-action="tn-billing" data-billing-type="${escapeAttr(bt)}" title="Show tenants with billing: ${safeTitle}">
            <span class="stat-card__seg-left">
              <span class="stat-card__seg-swatch stat-card__seg-swatch--billing" style="background:${escapeAttr(swatchColor)};" aria-hidden="true"></span>
              <span class="stat-card__seg-label">${escapeHtml(bt)}</span>
            </span>
            <span class="stat-card__seg-value">${escapeHtml(String(cnt))}</span>
          </button>`;
      })
      .join("");
    const donutBg = alertSeverityDonutGradient(ah, am, al);
    const donutDescText = alertSeverityDonutAriaLabel(ah, am, al, stats.alerts);
    const tenantDonutBg = tenantBillingDonutGradient(billingFacets);
    const tenantDonutDescText = tenantBillingDonutAriaLabel(billingFacets, stats.tenants);
    return `
      <div class="stat-card stat-card--alerts stat-card--dash-compact">
        <button type="button" class="stat-card__main stat-card--alert stat-card__main--alert-donut${daSeverityLevels.size === 0 ? " is-active" : ""}" data-dash-action="alerts-sev" data-alert-severity="all" title="Show all alerts" aria-label="${escapeAttr(`All alerts, ${stats.alerts} total`)}" aria-describedby="dash-alert-donut-desc">
          <div class="stat-card__label">All alerts</div>
          <div class="dash-alert-donut-stack">
            <div class="dash-alert-donut" style="background: ${donutBg};" aria-hidden="true"></div>
            <div class="dash-alert-donut__value">
              <span class="stat-card__value">${escapeHtml(String(stats.alerts))}</span>
            </div>
          </div>
        </button>
        <span id="dash-alert-donut-desc" class="visually-hidden">${escapeHtml(donutDescText)}</span>
        <div class="stat-card__alert-row" role="group" aria-label="Filter alerts by severity">
          <button type="button" class="stat-card__alert-seg${daSeverityLevels.size === 1 && daSeverityLevels.has("low") ? " is-active" : ""}" data-dash-action="alerts-sev" data-alert-severity="low" title="Filter alerts by low / other severity">
            <span class="stat-card__seg-left">
              <span class="stat-card__seg-swatch stat-card__seg-swatch--low" aria-hidden="true"></span>
              <span class="stat-card__seg-label">Low</span>
            </span>
            <span class="stat-card__seg-value">${escapeHtml(String(al))}</span>
          </button>
          <button type="button" class="stat-card__alert-seg${daSeverityLevels.size === 1 && daSeverityLevels.has("medium") ? " is-active" : ""}" data-dash-action="alerts-sev" data-alert-severity="medium" title="Filter alerts by medium severity">
            <span class="stat-card__seg-left">
              <span class="stat-card__seg-swatch stat-card__seg-swatch--medium" aria-hidden="true"></span>
              <span class="stat-card__seg-label">Medium</span>
            </span>
            <span class="stat-card__seg-value">${escapeHtml(String(am))}</span>
          </button>
          <button type="button" class="stat-card__alert-seg${daSeverityLevels.size === 1 && daSeverityLevels.has("high") ? " is-active" : ""}" data-dash-action="alerts-sev" data-alert-severity="high" title="Filter alerts by high severity">
            <span class="stat-card__seg-left">
              <span class="stat-card__seg-swatch stat-card__seg-swatch--high" aria-hidden="true"></span>
              <span class="stat-card__seg-label">High</span>
            </span>
            <span class="stat-card__seg-value">${escapeHtml(String(ah))}</span>
          </button>
        </div>
      </div>
      <div class="stat-card stat-card--fw stat-card--dash-compact">
        <button type="button" class="stat-card__main" data-dash-action="fw-all" title="View all firewalls">
          <div class="stat-card__label">Firewalls</div>
          <div class="stat-card__value">${escapeHtml(String(stats.firewalls))}</div>
        </button>
        <div class="stat-card__alert-row" role="group" aria-label="Filter firewalls by connection status">
          <button type="button" class="stat-card__alert-seg" data-dash-action="fw-online" title="View online firewalls only">
            <span class="stat-card__seg-label">Online</span>
            <span class="stat-card__seg-value">${fwOn}</span>
          </button>
          <button type="button" class="stat-card__alert-seg" data-dash-action="fw-offline" title="View firewalls that are not online (disconnected or suspended)">
            <span class="stat-card__seg-label">Offline</span>
            <span class="stat-card__seg-value">${escapeHtml(String(stats.firewalls_offline ?? 0))}</span>
          </button>
          <button type="button" class="stat-card__alert-seg" data-dash-action="fw-suspended" title="View suspended firewalls">
            <span class="stat-card__seg-label">Suspended</span>
            <span class="stat-card__seg-value">${escapeHtml(String(stats.firewalls_suspended ?? 0))}</span>
          </button>
          <button type="button" class="stat-card__alert-seg" data-dash-action="fw-pending" title="View firewalls pending management approval">
            <span class="stat-card__seg-label">Pending Approval</span>
            <span class="stat-card__seg-value">${escapeHtml(String(stats.firewalls_pending_approval ?? 0))}</span>
          </button>
        </div>
      </div>
      <div class="stat-card stat-card--fw stat-card--tenants-dash stat-card--dash-compact">
        <button type="button" class="stat-card__main stat-card__main--tenant-donut${tnDashBilling == null ? " is-active" : ""}" data-dash-action="tn-all" title="View all tenants" aria-label="${escapeAttr(`Tenants, ${stats.tenants} total`)}" aria-describedby="dash-tenant-donut-desc">
          <div class="stat-card__label">Tenants</div>
          <div class="dash-alert-donut-stack">
            <div class="dash-alert-donut" style="background: ${tenantDonutBg};" aria-hidden="true"></div>
            <div class="dash-alert-donut__value">
              <span class="stat-card__value">${escapeHtml(String(stats.tenants))}</span>
            </div>
          </div>
        </button>
        <span id="dash-tenant-donut-desc" class="visually-hidden">${escapeHtml(tenantDonutDescText)}</span>
        <div class="stat-card__alert-row" role="group" aria-label="Filter tenants by billing type">
          ${billingFacets.length
        ? billingSegs
        : '<span class="stat-card__billing-empty muted">No billing types</span>'
      }
        </div>
      </div>
      <div class="stat-card stat-card--fw stat-card--dash-compact">
        <button type="button" class="stat-card__main" data-dash-action="lic-all" title="View all licenses">
          <div class="stat-card__label">Licenses</div>
          <div class="stat-card__value">${escapeHtml(String(stats.licenses))}</div>
        </button>
        <div class="stat-card__alert-row" role="group" aria-label="Filter licenses by subscription state (details view)">
          <button type="button" class="stat-card__alert-seg${lcDashState === "Active" ? " is-active" : ""}" data-dash-action="lc-sub-state" data-lc-sub-state="Active" title="Details rows with subscription state Active">
            <span class="stat-card__seg-label">Active</span>
            <span class="stat-card__seg-value">${escapeHtml(String(licA))}</span>
          </button>
          <button type="button" class="stat-card__alert-seg${lcDashState === "Expired" ? " is-active" : ""}" data-dash-action="lc-sub-state" data-lc-sub-state="Expired" title="Details rows with subscription state Expired">
            <span class="stat-card__seg-label">Expired</span>
            <span class="stat-card__seg-value">${escapeHtml(String(licE))}</span>
          </button>
          <button type="button" class="stat-card__alert-seg${lcDashState === "Expiring" ? " is-active" : ""}" data-dash-action="lc-end-expiring" title="Details: End date Past 30 days and Next 90 days (matches expiring subscription count)">
            <span class="stat-card__seg-label">Expiring</span>
            <span class="stat-card__seg-value">${escapeHtml(String(licX))}</span>
          </button>
        </div>
      </div>`;
  }

  async function loadDashboard(opts = {}) {
    const preserve = opts.preserve === true;
    const daRowsTarget = preserve
      ? document.querySelectorAll("#dashboard-alerts-body tr.alert-row").length
      : 0;
    const stats = await loadJson("/api/dashboard");
    lastDashboardStats = stats;
    document.getElementById("dashboard-stats").innerHTML = renderDashboardStats(stats);
    await loadDashboardAlertFacets();
    buildDashboardAlertFilters();
    if (preserve && daRowsTarget > 0) {
      await loadDashboardAlerts({ reset: true });
      let guard = 0;
      while (guard++ < 200) {
        const loaded = document.querySelectorAll("#dashboard-alerts-body tr.alert-row").length;
        const total = daState.total || 0;
        if (loaded >= total || loaded >= daRowsTarget) break;
        await loadDashboardAlerts({ reset: false });
      }
    } else {
      await loadDashboardAlerts();
    }
  }

  /* ---------- Firewalls ---------- */
  let fwRaw = [];
  let fwPrepared = [];
  /** IP → { lat, lon } | null (failed lookup). Reused across firewalls sharing the same external IP. */
  const fwGeoipByIp = new Map();
  const fwGeoipInflight = new Set();
  /** Firewall id → { lat, lon } when DB geo is unset; map + flyout use this as a hint only. */
  const fwMapGeoipGuess = new Map();

  /** Stored Sophos/geo DB coordinates, or approximate hint from first external IPv4. */
  function fwRowMapLatLng(row) {
    if (!row) return null;
    if (row.geo_lat != null && row.geo_lon != null) {
      return { lat: row.geo_lat, lon: row.geo_lon };
    }
    const g = fwMapGeoipGuess.get(row._id);
    if (g && Number.isFinite(g.lat) && Number.isFinite(g.lon)) {
      return { lat: g.lat, lon: g.lon };
    }
    return null;
  }

  let dashFwMap = null;
  let panelFwMap = null;
  let dashFwLayer = null;
  let panelFwLayer = null;
  let dashFwEdgeLayer = null;
  let panelFwEdgeLayer = null;
  let dashFwClusterLayer = null;
  let panelFwClusterLayer = null;
  let fwClusterLensMap = null;
  let fwClusterLensHideTimer = null;
  let fwClusterLensViewportListeners = false;
  let fwClusterLensActiveClusterMarker = null;
  let fwClusterLensMainMap = null;
  let fwLocPickMap = null;
  let fwLocPickMarker = null;
  let fwLocEditingId = null;
  let fwLocModalFocusBefore = null;
  let fwLocSuggestTimer = null;
  let fwDetailFlyoutMap = null;
  let fwDetailFlyoutMapMarker = null;
  let fwDetailFlyoutOpenId = null;
  let fwHoverActiveMap = null;
  let fwHoverActiveMarker = null;
  let fwHoverPortalHideTimer = null;
  let fwHoverViewportListeners = false;
  let _lastFwDashMapMarkerSig = "";
  let _lastFwPanelMapMarkerSig = "";
  /** Per-map stack of firewall ids centered before the latest dot-click (session only). */
  let fwDashMapCenterPastIds = [];
  let fwDashMapLastCenteredId = null;
  let fwPanelMapCenterPastIds = [];
  let fwPanelMapLastCenteredId = null;
  /** Distinct `firmware_versions.version` values for the Firmware updates facet. */
  let fwFirmwareVersionCatalog = [];
  const fwFilterState = {};
  /** Set from dashboard quick links; combined with facet filters via AND. */
  let fwLinkMode = null;
  let fwBatchModalRows = [];
  let fwBatchChoiceByFwId = new Map();

  const FW_COL_VISIBILITY_KEY = "sophos-central-fw-columns-v1";
  const FW_COLUMNS = [
    { id: "status", label: "Status", sortKey: "status", thClass: "th-sortable fw-status-col" },
    {
      id: "firmware_upgrade",
      label: "Firmware upgrades",
      sortKey: "firmware_upgrade_count",
      thClass: "th-sortable fw-upgrade-col",
    },
    { id: "alert_count", label: "Alerts", sortKey: "alert_count", thClass: "th-sortable fw-alerts-col" },
    { id: "hostname", label: "Host name", sortKey: "hostname", thClass: "th-sortable th-link-col" },
    { id: "group_name", label: "Group", sortKey: "group_name", thClass: "th-sortable fw-col-group" },
    { id: "serial_number", label: "Serial number", sortKey: "serial_number", thClass: "th-sortable" },
    { id: "model", label: "Model", sortKey: "model", thClass: "th-sortable" },
    { id: "firmware_version", label: "Firmware", sortKey: "firmware_version", thClass: "th-sortable" },
    { id: "connected", label: "Connected", sortKey: "connected", thClass: "th-sortable" },
    { id: "suspended", label: "Suspended", sortKey: "suspended", thClass: "th-sortable" },
    { id: "external_ips", label: "External IPs", sortKey: "external_ips", thClass: "th-sortable" },
    { id: "location", label: "Location", sortKey: "has_location", thClass: "th-sortable" },
    { id: "tenant_name", label: "Tenant", sortKey: "tenant_name", thClass: "th-sortable" },
    { id: "state_changed_at", label: "State changes", sortKey: "state_changed_at", thClass: "th-sortable" },
    { id: "tagsPlain", label: "Tags", sortKey: "tagsPlain", thClass: "th-sortable" },
    { id: "firewall_name", label: "Firewall name", sortKey: "firewall_name", thClass: "th-sortable", defaultVisible: false },
    { id: "tenant_id", label: "Tenant ID", sortKey: "tenant_id", thClass: "th-sortable fw-col-code", defaultVisible: false },
    { id: "managing_status", label: "Managing status", sortKey: "managing_status", thClass: "th-sortable", defaultVisible: false },
    { id: "reporting_status", label: "Reporting status", sortKey: "reporting_status", thClass: "th-sortable", defaultVisible: false },
    { id: "firewall_id", label: "Firewall ID", sortKey: "firewall_id", thClass: "th-sortable fw-col-code", defaultVisible: false },
    {
      id: "capabilities_json",
      label: "Capabilities (JSON)",
      sortKey: "capabilities_sort",
      thClass: "th-sortable",
      defaultVisible: false,
    },
  ];

  function defaultFwColumnVisibility() {
    const o = {};
    FW_COLUMNS.forEach((c) => {
      o[c.id] = c.defaultVisible !== false;
    });
    return o;
  }

  function loadFwColumnVisibility() {
    const d = defaultFwColumnVisibility();
    try {
      const raw = localStorage.getItem(FW_COL_VISIBILITY_KEY);
      if (!raw) return d;
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        FW_COLUMNS.forEach((c) => {
          if (typeof parsed[c.id] === "boolean") d[c.id] = parsed[c.id];
        });
      }
    } catch {
      /* ignore */
    }
    return d;
  }

  let fwColVisible = loadFwColumnVisibility();

  function persistFwColumnVisibility() {
    try {
      localStorage.setItem(FW_COL_VISIBILITY_KEY, JSON.stringify(fwColVisible));
    } catch {
      /* ignore */
    }
  }

  function buildFwThead() {
    const tr = document.getElementById("fw-thead-row");
    if (!tr) return;
    const checkTh = tr.querySelector(".th-check");
    if (!checkTh) return;
    while (tr.lastElementChild && tr.lastElementChild !== checkTh) {
      tr.removeChild(tr.lastElementChild);
    }
    FW_COLUMNS.forEach((col) => {
      if (!fwColVisible[col.id]) return;
      const th = document.createElement("th");
      th.scope = "col";
      if (col.id === "firmware_upgrade") {
        th.innerHTML = `<span class="fw-th-icon-header" title="Firmware upgrades">${firewallFirmwareUpgradeIconSvg()}</span>`;
        th.setAttribute("aria-label", "Firmware upgrades");
      } else if (col.id === "alert_count") {
        th.innerHTML =
          '<span class="fw-th-icon-header fw-th-icon-header--alerts-sync-row">' +
          '<span class="fw-th-icon-header fw-th-icon-header--alerts" title="Alerts">' +
          firewallWarnIconSvg() +
          "</span>" +
          '<span class="fw-th-icon-header fw-th-icon-header--group-sync" title="Group sync status">' +
          firewallGroupSyncIconSvg() +
          "</span>" +
          "</span>";
        th.setAttribute("aria-label", "Alerts and group sync status");
      } else {
        th.textContent = col.label;
      }
      if (col.sortKey) {
        th.dataset.sort = col.sortKey;
        th.className = col.thClass || "th-sortable";
      } else {
        th.className = col.thClass || "";
      }
      tr.appendChild(th);
    });
  }

  function filterFwColumnMenuList() {
    const q = (document.getElementById("fw-cols-filter")?.value || "").trim().toLowerCase();
    const list = document.getElementById("fw-cols-list");
    if (!list) return;
    list.querySelectorAll("li[data-col-label]").forEach((li) => {
      const lab = (li.dataset.colLabel || "").toLowerCase();
      li.hidden = q !== "" && !lab.includes(q);
    });
  }

  function buildFwColumnMenuList() {
    const list = document.getElementById("fw-cols-list");
    if (!list) return;
    list.innerHTML = FW_COLUMNS.map(
      (c) => `
      <li class="toolbar__cols-item" data-col-id="${escapeHtml(c.id)}" data-col-label="${escapeHtml(c.label.toLowerCase())}">
        <label class="toolbar__cols-label">
          <input type="checkbox" data-fw-col="${escapeHtml(c.id)}" ${fwColVisible[c.id] ? "checked" : ""} />
          <span>${escapeHtml(c.label)}</span>
        </label>
      </li>`
    ).join("");
    filterFwColumnMenuList();
  }

  function positionFwColsDropdown() {
    const btn = document.getElementById("fw-cols-trigger");
    const panel = document.getElementById("fw-cols-panel");
    const modal = document.getElementById("fw-cols-modal");
    if (!btn || !panel || !modal || modal.hidden) return;
    panel.style.maxHeight = "";
    const r = btn.getBoundingClientRect();
    const gap = 6;
    const margin = 8;
    const pw = panel.offsetWidth || Math.min(380, window.innerWidth - 2 * margin);
    let left = r.left;
    if (left + pw > window.innerWidth - margin) {
      left = window.innerWidth - margin - pw;
    }
    left = Math.max(margin, left);
    const topBelow = r.bottom + gap;
    panel.style.left = `${left}px`;
    panel.style.top = `${topBelow}px`;
    const after = panel.getBoundingClientRect();
    if (after.bottom > window.innerHeight - margin) {
      const aboveTop = r.top - gap - after.height;
      if (aboveTop >= margin) {
        panel.style.top = `${aboveTop}px`;
      } else {
        panel.style.top = `${margin}px`;
        panel.style.maxHeight = `${Math.max(120, window.innerHeight - 2 * margin)}px`;
      }
    }
  }

  function setFwColumnPanelOpen(open) {
    const modal = document.getElementById("fw-cols-modal");
    const btn = document.getElementById("fw-cols-trigger");
    const panel = document.getElementById("fw-cols-panel");
    if (!modal || !btn) return;
    modal.hidden = !open;
    modal.setAttribute("aria-hidden", open ? "false" : "true");
    btn.setAttribute("aria-expanded", open ? "true" : "false");
    if (!open && panel) {
      panel.style.top = "";
      panel.style.left = "";
      panel.style.maxHeight = "";
    }
    if (open) {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => positionFwColsDropdown());
      });
    }
  }

  function initFwColumnPicker() {
    buildFwColumnMenuList();
    const btn = document.getElementById("fw-cols-trigger");
    const modal = document.getElementById("fw-cols-modal");
    const panel = document.getElementById("fw-cols-panel");
    const filterIn = document.getElementById("fw-cols-filter");
    const list = document.getElementById("fw-cols-list");
    const closeBtn = document.getElementById("fw-cols-close");
    if (!btn || !modal || !panel) return;
    list?.addEventListener("change", (e) => {
      const cb = e.target.closest("input[data-fw-col]");
      if (!cb) return;
      const id = cb.dataset.fwCol;
      if (!id || !Object.prototype.hasOwnProperty.call(fwColVisible, id)) return;
      const col = FW_COLUMNS.find((c) => c.id === id);
      if (col && !cb.checked && fwController.getSortKey() === col.sortKey) {
        fwController.resetSort();
      }
      fwColVisible[id] = cb.checked;
      persistFwColumnVisibility();
      buildFwThead();
      fwController.render();
    });
    function openFwColsModalFromTrigger() {
      const willOpen = modal.hidden;
      setFwColumnPanelOpen(willOpen);
      if (willOpen) {
        buildFwColumnMenuList();
        filterIn?.focus();
      }
    }
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      openFwColsModalFromTrigger();
    });
    btn.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        openFwColsModalFromTrigger();
      }
    });
    filterIn?.addEventListener("input", () => filterFwColumnMenuList());
    closeBtn?.addEventListener("click", () => {
      setFwColumnPanelOpen(false);
      btn.focus();
    });
    modal.querySelector(".fw-cols-modal__backdrop")?.addEventListener("click", () => {
      setFwColumnPanelOpen(false);
      btn.focus();
    });
    document.addEventListener("mousedown", (e) => {
      if (modal.hidden) return;
      if (btn.contains(e.target) || panel.contains(e.target)) return;
      setFwColumnPanelOpen(false);
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !modal.hidden) {
        setFwColumnPanelOpen(false);
        btn.focus();
      }
    });

    function repositionFwColsIfOpen() {
      if (!modal.hidden) positionFwColsDropdown();
    }
    window.addEventListener("resize", repositionFwColsIfOpen);
    window.addEventListener("scroll", repositionFwColsIfOpen, true);
  }

  function firewallWarnIconSvg() {
    return '<svg class="fw-alerts-cell__icon" viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><path fill-rule="evenodd" clip-rule="evenodd" d="M9.401 3.003c1.155-2 4.043-2 5.197 0l7.355 12.748c1.154 2-.577 4.5-2.598 4.5H4.645c-2.022 0-3.752-2.5-2.598-4.5L9.401 3.003ZM12 8.25a.75.75 0 0 1 .75.75v3.75a.75.75 0 0 1-1.5 0V9a.75.75 0 0 1 .75-.75Zm0 8.25a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5Z"/></svg>';
  }

  function firewallGroupSyncIconSvg() {
    return '<svg class="fw-group-sync-cell__icon" viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M12 4V1L8 5l4 4V6c3.31 0 6 2.69 6 6 0 1.01-.25 1.97-.7 2.8l1.46 1.46C19.54 15.03 20 13.57 20 12c0-4.42-3.58-8-8-8zm0 14c-3.31 0-6-2.69-6-6 0-1.01.25-1.97.7-2.8L5.24 7.74C4.46 8.97 4 10.43 4 12c0 4.42 3.58 8 8 8v3l4-4-4-4v3z"/></svg>';
  }

  function firewallFirmwareUpgradeIconSvg() {
    return '<svg class="fw-firmware-upgrade-btn__icon" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M12 4 20 16h-5v6h-6v-6H4l8-12z"/></svg>';
  }

  function firewallStatusIconHealthySvg() {
    return (
      '<svg class="fw-status-icon" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">' +
      '<circle class="fw-status-icon__disc--ok" cx="12" cy="12" r="10"/>' +
      '<path class="fw-status-icon__glyph" d="M16.59 7.58L10 14.17 7.41 11.59 6 13l4 4 8-8-1.41-1.42z"/>' +
      "</svg>"
    );
  }

  function firewallStatusIconSuspendedSvg() {
    return (
      '<svg class="fw-status-icon" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">' +
      '<circle class="fw-status-icon__disc--suspended" cx="12" cy="12" r="10"/>' +
      '<rect class="fw-status-icon__pause" x="8" y="8" width="3" height="8" rx="1"/>' +
      '<rect class="fw-status-icon__pause" x="13" y="8" width="3" height="8" rx="1"/>' +
      "</svg>"
    );
  }

  function firewallStatusIconOfflineSvg() {
    return (
      '<svg class="fw-status-icon" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">' +
      '<circle class="fw-status-icon__disc--bad" cx="12" cy="12" r="10"/>' +
      '<path class="fw-status-icon__cut" fill="none" stroke-width="2" stroke-linecap="round" d="M7 12h4 M13 12h4"/>' +
      "</svg>"
    );
  }

  function firewallStatusIconApprovalSvg() {
    const hg =
      '<path class="fw-status-icon__glyph" d="M6 2v6h.01L6 8.01 10 12l-4 4 .01.01H6V22h12v-5.99h-.01L18 16l-4-4 4-3.99-.01-.01H18V2H6zm10 14.5V20H8v-3.5l4-4 4 4zm-4-5l-4-4V4h8v3.5l-4 4z"/>';
    return (
      '<svg class="fw-status-icon" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">' +
      '<circle class="fw-status-icon__disc--approval" cx="12" cy="12" r="10"/>' +
      `<g transform="translate(12 12) scale(0.4) translate(-12 -12)">${hg}</g>` +
      "</svg>"
    );
  }

  function renderFwFirmwareVersionCardInner(d) {
    const size =
      d.size != null && String(d.size).trim() !== "" ? escapeHtml(String(d.size)) : null;
    const inDb = d.in_database !== false;
    const dlParts = [];
    if (size) dlParts.push(`<dt>Size</dt><dd>${size}</dd>`);
    const dl = dlParts.length
      ? `<dl class="fw-firmware-card__dl">${dlParts.join("")}</dl>`
      : "";

    const newsItems = (d.news || []).map((t) => `<li>${escapeHtml(String(t))}</li>`).join("");
    const bugsItems = (d.bugs || []).map((t) => `<li>${escapeHtml(String(t))}</li>`).join("");

    const newsBlock =
      newsItems !== ""
        ? `<div class="fw-firmware-card__block"><div class="fw-firmware-card__label">Release notes &amp; highlights</div><ul class="fw-firmware-card__list">${newsItems}</ul></div>`
        : "";

    const bugsBlock =
      bugsItems !== ""
        ? `<div class="fw-firmware-card__block"><div class="fw-firmware-card__label">Resolved issues</div><ul class="fw-firmware-card__list">${bugsItems}</ul></div>`
        : "";

    let metaNote = "";
    if (!inDb) {
      metaNote =
        '<p class="muted fw-firmware-card__meta">No row in the local <span class="fw-col-code">firmware_versions</span> table for this version.</p>';
    } else if (!newsItems && !bugsItems && !dl) {
      metaNote =
        '<p class="muted fw-firmware-card__meta">No release notes, resolved issues, or size metadata stored locally for this version.</p>';
    }

    return `${metaNote}${dl}${newsBlock}${bugsBlock}`;
  }

  /** Batch upgrade modal: one tab per unique target version in the collapsible notes region. */
  function renderFwFirmwareBatchNotesBody(vers, details) {
    if (!Array.isArray(vers) || vers.length === 0) {
      return "";
    }
    const tabButtons = vers
      .map((v, idx) => {
        const label = escapeHtml(String(v));
        const vAttr = escapeAttr(String(v));
        const active = idx === 0 ? " is-active" : "";
        const selected = idx === 0 ? "true" : "false";
        return `<button type="button" role="tab" id="fw-batch-fw-tab-${idx}" class="fw-firmware-modal__tab${active}" aria-selected="${selected}" aria-controls="fw-batch-fw-panel-${idx}" tabindex="${idx === 0 ? "0" : "-1"}" data-fw-tab-version="${vAttr}">${label}</button>`;
      })
      .join("");

    const panels = vers
      .map((v, idx) => {
        const d =
          details[idx] ??
          ({ version: v, size: null, bugs: [], news: [], in_database: false });
        const ver = escapeHtml(String(d.version || v || "—"));
        const inner = renderFwFirmwareVersionCardInner(d);
        const hiddenAttr = idx === 0 ? "" : " hidden";
        return `<div role="tabpanel" id="fw-batch-fw-panel-${idx}" class="fw-firmware-modal__tab-panel" aria-labelledby="fw-batch-fw-tab-${idx}"${hiddenAttr}><div class="fw-firmware-card"><h4 class="fw-firmware-card__title">${ver}</h4>${inner}</div></div>`;
      })
      .join("");

    return `<div class="fw-firmware-modal__layout">
      <div class="fw-firmware-modal__tabs" role="tablist" aria-label="Firmware versions (release notes)" aria-orientation="horizontal">${tabButtons}</div>
      <button type="button" class="fw-firmware-modal__notes-toggle" id="fw-batch-notes-toggle" aria-expanded="false" aria-controls="fw-batch-notes-region">
        <span class="fw-firmware-modal__notes-toggle-label">Release notes &amp; details</span>
        <span class="fw-firmware-modal__notes-toggle-chev" aria-hidden="true">▼</span>
      </button>
      <div id="fw-batch-notes-region" class="fw-firmware-modal__notes-region" role="region" aria-labelledby="fw-batch-notes-toggle" hidden>
        <div class="fw-firmware-modal__tab-panels">${panels}</div>
      </div>
    </div>`;
  }

  function findFwFirmwareTabIndexByVersion(scopeRoot, versionStr) {
    const want = String(versionStr ?? "").trim();
    if (!want || !scopeRoot) return -1;
    const tabs = [...scopeRoot.querySelectorAll('.fw-firmware-modal__tabs [role="tab"]')];
    for (let i = 0; i < tabs.length; i++) {
      const tv = (tabs[i].getAttribute("data-fw-tab-version") || tabs[i].textContent || "").trim();
      if (tv === want) return i;
    }
    return -1;
  }

  function setFwFirmwareNotesExpanded(scopeRoot, expanded) {
    if (!scopeRoot) return;
    const toggle = scopeRoot.querySelector(".fw-firmware-modal__notes-toggle");
    const region = scopeRoot.querySelector(".fw-firmware-modal__notes-region");
    if (!toggle || !region) return;
    toggle.setAttribute("aria-expanded", expanded ? "true" : "false");
    toggle.classList.toggle("is-expanded", expanded);
    if (expanded) region.removeAttribute("hidden");
    else region.setAttribute("hidden", "");
  }

  function toggleFwFirmwareNotesCollapse(scopeRoot) {
    if (!scopeRoot) return;
    const region = scopeRoot.querySelector(".fw-firmware-modal__notes-region");
    const expanded = Boolean(region && !region.hasAttribute("hidden"));
    setFwFirmwareNotesExpanded(scopeRoot, !expanded);
  }

  function activateFwBatchFirmwareNotesTab(index) {
    const root = document.getElementById("fw-firmware-batch-notes-root");
    if (!root) return;
    const list = root.querySelector('.fw-firmware-modal__tabs[role="tablist"]');
    if (!list) return;
    const tabs = [...list.querySelectorAll('[role="tab"]')];
    const panels = [...root.querySelectorAll(".fw-firmware-modal__tab-panel")];
    if (!tabs.length || tabs.length !== panels.length) return;
    const i = Math.max(0, Math.min(index, tabs.length - 1));
    tabs.forEach((t, j) => {
      const on = j === i;
      t.classList.toggle("is-active", on);
      t.setAttribute("aria-selected", on ? "true" : "false");
      t.setAttribute("tabindex", on ? "0" : "-1");
    });
    panels.forEach((p, j) => {
      if (j === i) p.removeAttribute("hidden");
      else p.setAttribute("hidden", "");
    });
    setFwFirmwareNotesExpanded(root, true);
  }

  /** Firewalls table: show model prefix before first underscore (full value if none). */
  function fwModelDisplay(s) {
    if (s == null || s === "" || s === "—") return "—";
    const str = String(s);
    const i = str.indexOf("_");
    if (i === -1) return str;
    const head = str.slice(0, i);
    return head !== "" ? head : "—";
  }

  /** Firewalls table: show firmware suffix after last underscore (full value if none). */
  function fwFirmwareDisplay(s) {
    if (s == null || s === "" || s === "—") return "—";
    const str = String(s);
    const i = str.lastIndexOf("_");
    if (i === -1) return str;
    const tail = str.slice(i + 1);
    return tail !== "" ? tail : "—";
  }

  const FW_APPROVAL_PENDING_STATUS_TITLE =
    "Firewall has requested permission to be managed by Sophos Central.";

  function fwRawIsApprovalPending(statusRaw) {
    const s = String(statusRaw ?? "")
      .trim()
      .toLowerCase();
    return s === "approvalpending" || s === "pendingapproval";
  }

  function fwRowConnected(row) {
    return row.connected === 1 || row.connected === true;
  }

  function fwRowSuspended(row) {
    return row.suspended === 1 || row.suspended === true;
  }

  function renderFwRecencyPillHtml(tag) {
    if (!tag) return "";
    if (tag === "new") {
      return '<span class="fw-recency-pill fw-recency-pill--new" title="Recently added" aria-label="NEW">NEW</span>';
    }
    if (tag === "old") {
      return '<span class="fw-recency-pill fw-recency-pill--old" title="Last sync older than peers for this API client" aria-label="OLD">OLD</span>';
    }
    if (tag === "upd") {
      return '<span class="fw-recency-pill fw-recency-pill--upd" title="State changed recently" aria-label="Updated">UPD</span>';
    }
    return "";
  }

  function applyFirewallRecencyTags(rows) {
    const now = Date.now();
    const newMs = (fwTagUiSettings.fw_new_max_age_hours || FW_TAG_DEFAULT_NEW_HOURS) * 3600000;
    const updMs = (fwTagUiSettings.fw_updated_max_age_hours || FW_TAG_DEFAULT_UPD_HOURS) * 3600000;
    const byClient = new Map();
    for (const row of rows) {
      const cid = String(row.client_id ?? "").trim();
      if (!cid) continue;
      if (!byClient.has(cid)) byClient.set(cid, []);
      byClient.get(cid).push(row);
    }
    const maxSyncByClient = new Map();
    for (const [cid, list] of byClient) {
      if (list.length < 2) continue;
      let maxT = null;
      for (const r of list) {
        const t = parseFirewallIsoMs(r.last_sync);
        if (t != null && (maxT === null || t > maxT)) maxT = t;
      }
      if (maxT !== null) maxSyncByClient.set(cid, maxT);
    }
    for (const row of rows) {
      row._statusRecencyTag = null;
      const createdMs = parseFirewallIsoMs(row.created_at);
      const stateMs = parseFirewallIsoMs(row.state_changed_at);
      const isNew =
        createdMs !== null &&
        stateMs !== null &&
        now - createdMs <= newMs &&
        now - stateMs <= newMs;
      if (isNew) {
        row._statusRecencyTag = "new";
        continue;
      }
      const cid = String(row.client_id ?? "").trim();
      let isOld = false;
      if (cid && maxSyncByClient.has(cid)) {
        const maxT = maxSyncByClient.get(cid);
        const myT = parseFirewallIsoMs(row.last_sync);
        if (myT === null || myT < maxT) isOld = true;
      }
      if (isOld) {
        row._statusRecencyTag = "old";
        continue;
      }
      if (stateMs !== null && now - stateMs <= updMs) {
        row._statusRecencyTag = "upd";
      }
    }
  }

  /**
   * Same NEW / UPD / OLD rules and General settings windows as the firewalls grid, for list rows
   * that expose created, state/updated, last_sync, and client_id fields.
   */
  function applyListRecencyTags(rows, fieldMap) {
    if (!Array.isArray(rows) || rows.length === 0) return;
    const { createdKey, stateKey, lastSyncKey, clientKey } = fieldMap;
    const now = Date.now();
    const newMs = (fwTagUiSettings.fw_new_max_age_hours || FW_TAG_DEFAULT_NEW_HOURS) * 3600000;
    const updMs = (fwTagUiSettings.fw_updated_max_age_hours || FW_TAG_DEFAULT_UPD_HOURS) * 3600000;
    const byClient = new Map();
    for (const row of rows) {
      const cid = String(row[clientKey] ?? "").trim();
      if (!cid) continue;
      if (!byClient.has(cid)) byClient.set(cid, []);
      byClient.get(cid).push(row);
    }
    const maxSyncByClient = new Map();
    for (const [cid, list] of byClient) {
      if (list.length < 2) continue;
      let maxT = null;
      for (const r of list) {
        const t = parseFirewallIsoMs(r[lastSyncKey]);
        if (t != null && (maxT === null || t > maxT)) maxT = t;
      }
      if (maxT !== null && cid) maxSyncByClient.set(cid, maxT);
    }
    for (const row of rows) {
      row._recencyTag = null;
      const createdMs = parseFirewallIsoMs(row[createdKey]);
      const stateMs = parseFirewallIsoMs(row[stateKey]);
      const isNew =
        createdMs !== null &&
        stateMs !== null &&
        now - createdMs <= newMs &&
        now - stateMs <= newMs;
      if (isNew) {
        row._recencyTag = "new";
        continue;
      }
      const cid = String(row[clientKey] ?? "").trim();
      let isOld = false;
      if (cid && maxSyncByClient.has(cid)) {
        const maxT = maxSyncByClient.get(cid);
        const myT = parseFirewallIsoMs(row[lastSyncKey]);
        if (myT === null || myT < maxT) isOld = true;
      }
      if (isOld) {
        row._recencyTag = "old";
        continue;
      }
      if (stateMs !== null && now - stateMs <= updMs) {
        row._recencyTag = "upd";
      }
    }
  }

  /** Tenants: NEW from ``first_sync`` only; UPD from ``updated_at``; OLD from ``last_sync`` vs peers. */
  function applyTenantRecencyTags(rows) {
    if (!Array.isArray(rows) || rows.length === 0) return;
    const now = Date.now();
    const newMs = (fwTagUiSettings.fw_new_max_age_hours || FW_TAG_DEFAULT_NEW_HOURS) * 3600000;
    const updMs = (fwTagUiSettings.fw_updated_max_age_hours || FW_TAG_DEFAULT_UPD_HOURS) * 3600000;
    const byClient = new Map();
    for (const row of rows) {
      const cid = String(row.client_id ?? "").trim();
      if (!cid) continue;
      if (!byClient.has(cid)) byClient.set(cid, []);
      byClient.get(cid).push(row);
    }
    const maxSyncByClient = new Map();
    for (const [cid, list] of byClient) {
      if (list.length < 2) continue;
      let maxT = null;
      for (const r of list) {
        const t = parseFirewallIsoMs(r.last_sync);
        if (t != null && (maxT === null || t > maxT)) maxT = t;
      }
      if (maxT !== null && cid) maxSyncByClient.set(cid, maxT);
    }
    for (const row of rows) {
      row._recencyTag = null;
      const firstMs = parseFirewallIsoMs(row.first_sync);
      const updatedMs = parseFirewallIsoMs(row.updated_at);
      if (firstMs !== null && now - firstMs <= newMs) {
        row._recencyTag = "new";
        continue;
      }
      const cid = String(row.client_id ?? "").trim();
      let isOld = false;
      if (cid && maxSyncByClient.has(cid)) {
        const maxT = maxSyncByClient.get(cid);
        const myT = parseFirewallIsoMs(row.last_sync);
        if (myT === null || myT < maxT) isOld = true;
      }
      if (isOld) {
        row._recencyTag = "old";
        continue;
      }
      if (updatedMs !== null && now - updatedMs <= updMs) {
        row._recencyTag = "upd";
      }
    }
  }

  function renderFirewallStatusIconHtml(row) {
    const approvalPending =
      fwRawIsApprovalPending(row.managing_status) || fwRawIsApprovalPending(row.reporting_status);
    if (approvalPending) {
      const t = escapeHtml(FW_APPROVAL_PENDING_STATUS_TITLE);
      return `<span class="fw-status-icon-wrap" title="${t}" aria-label="${t}">${firewallStatusIconApprovalSvg()}</span>`;
    }
    if (!fwRowConnected(row)) {
      const t = escapeHtml("Not connected");
      return `<span class="fw-status-icon-wrap" title="${t}" aria-label="${t}">${firewallStatusIconOfflineSvg()}</span>`;
    }
    if (fwRowSuspended(row)) {
      const t = escapeHtml("Connected, suspended");
      return `<span class="fw-status-icon-wrap" title="${t}" aria-label="${t}">${firewallStatusIconSuspendedSvg()}</span>`;
    }
    const t = escapeHtml("Connected");
    return `<span class="fw-status-icon-wrap" title="${t}" aria-label="${t}">${firewallStatusIconHealthySvg()}</span>`;
  }

  function renderFwDataCell(colId, row, ctx) {
    const { host } = ctx;
    switch (colId) {
      case "status": {
        const pill = renderFwRecencyPillHtml(row._statusRecencyTag);
        const icon = renderFirewallStatusIconHtml(row);
        return `<td class="fw-status-col"><span class="fw-status-col__inner">${pill}${icon}</span></td>`;
      }
      case "firmware_upgrade": {
        const uc = row.firmware_upgrade_count ?? 0;
        if (uc <= 0) return '<td class="fw-upgrade-col"></td>';
        const upTitle =
          uc === 1
            ? "Schedule firmware upgrade"
            : `Schedule firmware upgrade (${uc} versions available)`;
        return `<td class="fw-upgrade-col"><div class="fw-upgrade-col__inner"><button type="button" class="cell-link fw-firmware-upgrade-btn" data-fw-id="${escapeHtml(row._id)}" title="${escapeHtml(upTitle)}" aria-label="${escapeHtml(upTitle)}">${firewallFirmwareUpgradeIconSvg()}</button></div></td>`;
      }
      case "alert_count": {
        const ac = row.alert_count ?? 0;
        const hasSync =
          row.has_group_sync_status === 1 ||
          row.has_group_sync_status === true ||
          row.has_group_sync_status === "1";
        if (ac <= 0 && !hasSync) return '<td class="fw-alerts-col"></td>';
        const syncTitle = "Listed in firewall group sync status (Central)";
        const syncEl = hasSync
          ? `<span class="fw-group-sync-indicator" title="${escapeHtml(syncTitle)}" aria-label="${escapeHtml(syncTitle)}">${firewallGroupSyncIconSvg()}</span>`
          : "";
        if (ac <= 0) {
          return `<td class="fw-alerts-col"><div class="fw-alerts-col__inner">${syncEl}</div></td>`;
        }
        const dashTitle =
          ac === 1
            ? "View 1 alert on Dashboard (filtered by this firewall)"
            : `View ${ac} alerts on Dashboard (filtered by this firewall)`;
        const wi = firewallWarnIconSvg();
        const btn = `<button type="button" class="cell-link fw-alerts-dash-link fw-alerts-cell fw-alerts-cell--has" data-fw-host="${encodeURIComponent(row.hostname)}" title="${escapeHtml(dashTitle)}" aria-label="${escapeHtml(dashTitle)}">${wi}<span class="fw-alerts-count-pill">${escapeHtml(String(ac))}</span></button>`;
        return `<td class="fw-alerts-col"><div class="fw-alerts-col__inner">${btn}${syncEl}</div></td>`;
      }
      case "hostname":
        return `<td><a href="#" class="cell-link" data-id="${escapeHtml(row._id)}">${host}</a></td>`;
      case "group_name":
        return firewallCentralGroupsCellHtml(row);
      case "serial_number":
        return `<td>${escapeHtml(row.serial_number)}</td>`;
      case "model":
        return `<td>${escapeHtml(fwModelDisplay(row.model))}</td>`;
      case "firmware_version":
        return `<td>${escapeHtml(fwFirmwareDisplay(row.firmware_version))}</td>`;
      case "connected":
        return `<td>${escapeHtml(yesNo(row.connected))}</td>`;
      case "suspended":
        return `<td>${escapeHtml(yesNo(row.suspended))}</td>`;
      case "external_ips":
        return `<td>${escapeHtml(row.external_ips)}</td>`;
      case "location": {
        const has = row.has_location === 1;
        const label = has ? "Change" : "Set";
        const title = has ? "Change map location" : "Set map location";
        return `<td><button type="button" class="cell-link fw-loc-btn" data-fw-id="${escapeHtml(row._id)}" title="${escapeHtml(title)}" aria-label="${escapeHtml(title)}">${escapeHtml(label)}</button></td>`;
      }
      case "tenant_name":
        return `<td>${escapeHtml(row.tenant_name)}</td>`;
      case "state_changed_at":
        return `<td class="muted">${fmtDate(row.state_changed_at)}</td>`;
      case "tagsPlain":
        return `<td>${row.tags}</td>`;
      case "firewall_name":
        return `<td>${escapeHtml(row.firewall_name)}</td>`;
      case "tenant_id":
        return `<td class="fw-col-code">${escapeHtml(row.tenant_id)}</td>`;
      case "managing_status":
        return `<td>${escapeHtml(row.managing_status)}</td>`;
      case "reporting_status":
        return `<td>${escapeHtml(row.reporting_status)}</td>`;
      case "firewall_id":
        return `<td class="fw-col-code">${escapeHtml(row.firewall_id)}</td>`;
      case "capabilities_json":
        return `<td class="muted fw-col-capabilities"><pre class="fw-cell-pre">${row.capabilities_display}</pre></td>`;
      default:
        return "<td></td>";
    }
  }

  function groupBreadcrumbCaretSvg() {
    return '<svg class="group-breadcrumb__caret" viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" focusable="false"><path fill="currentColor" d="M10 6 8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z"/></svg>';
  }

  /** Renders Central group path(s): caret separators, each segment links to Groups tab filtered on that group. */
  function firewallCentralGroupsCellHtml(row) {
    const memberships = row.central_group_memberships;
    if (!Array.isArray(memberships) || !memberships.length) return '<td class="fw-col-group"></td>';
    const block = memberships
      .map((m) => {
        const levels = m.levels || [];
        const inner = levels
          .map((lv, i) => {
            const sep =
              i === 0
                ? ""
                : `<span class="group-breadcrumb__sep group-breadcrumb__sep--caret" aria-hidden="true">${groupBreadcrumbCaretSvg()}</span>`;
            const nameRaw = lv.name || "—";
            const gn = escapeHtml(nameRaw);
            const gAttr = escapeAttr(nameRaw);
            const gid = escapeAttr(lv.id);
            const btn = `<button type="button" class="cell-link fw-to-central-group" data-group-id="${gid}" title="Open Groups tab filtered to this group" aria-label="Show group ${gAttr} on Groups tab">${gn}</button>`;
            return `${sep}${btn}`;
          })
          .join("");
        return `<span class="group-breadcrumb">${inner}</span>`;
      })
      .join('<span class="fw-group-breadcrumb-between" aria-hidden="true"> · </span>');
    return `<td class="fw-col-group">${block}</td>`;
  }

  function renderFirewallDataRow(row, selected) {
    const host = escapeHtml(row.hostname);
    const checked = selected.has(row._id) ? " checked" : "";
    const ctx = { host };
    const cells = FW_COLUMNS.filter((c) => fwColVisible[c.id])
      .map((c) => renderFwDataCell(c.id, row, ctx))
      .join("");
    return `<tr>
        <td class="th-check"><input type="checkbox" class="row-check" data-id="${escapeHtml(row._id)}"${checked} /></td>
        ${cells}
      </tr>`;
  }

  function firewallStatusHealthy(row) {
    return row.connected === 1 && row.suspended === 0;
  }

  function prepareFirewall(row) {
    const caps = parseJsonArray(row.capabilities_json);
    const ips = parseJsonArray(row.external_ipv4_addresses_json);
    let first_external_ipv4 = "";
    for (const x of ips) {
      const s = String(x ?? "").trim();
      if (s) {
        first_external_ipv4 = s;
        break;
      }
    }
    const tags = caps.map((c) => `<span class="tag-pill">${escapeHtml(c)}</span>`).join("");
    const healthy = firewallStatusHealthy(row);
    const approvalPending =
      fwRawIsApprovalPending(row.managing_status) || fwRawIsApprovalPending(row.reporting_status);
    const connected = fwRowConnected(row);
    const suspended = fwRowSuspended(row);
    let statusLabel;
    if (approvalPending) statusLabel = "Pending approval";
    else if (!connected) statusLabel = "Offline";
    else if (suspended) statusLabel = "Suspended";
    else statusLabel = "Connected";
    const alertCount = Number(row.alert_count);
    const alert_count = Number.isFinite(alertCount) ? alertCount : 0;
    const rawGss = row.has_group_sync_status;
    const has_group_sync_status =
      rawGss === 1 || rawGss === true || rawGss === "1" ? 1 : 0;
    const rawGssSus = row.group_sync_status_suspended;
    const group_sync_status_suspended =
      rawGssSus === 1 || rawGssSus === true || rawGssSus === "1" ? 1 : 0;
    const upgradeCount = Number(row.firmware_upgrade_count);
    const firmware_upgrade_count = Number.isFinite(upgradeCount) ? upgradeCount : 0;
    const geo_lat = parseGeoCoord(row.geo_latitude);
    const geo_lon = parseGeoCoord(row.geo_longitude);
    const has_location = geo_lat != null && geo_lon != null ? 1 : 0;
    const rawBreadcrumbs = Array.isArray(row.central_group_breadcrumbs)
      ? row.central_group_breadcrumbs
      : [];
    const central_group_memberships = rawBreadcrumbs
      .map((x) => {
        const levels = Array.isArray(x?.levels)
          ? x.levels
              .map((lv) => ({
                id: lv?.id != null ? String(lv.id).trim() : "",
                name: String(lv?.name ?? "").trim() || "—",
              }))
              .filter((lv) => lv.id)
          : [];
        return { levels };
      })
      .filter((m) => m.levels.length > 0);
    const group_name = central_group_memberships
      .map((m) => m.levels.map((l) => l.name).join(" › "))
      .join(" · ");
    const fw_group_facet_values = [];
    for (const m of central_group_memberships) {
      const leaf = m.levels[m.levels.length - 1]?.name;
      if (leaf && !fw_group_facet_values.includes(leaf)) fw_group_facet_values.push(leaf);
    }
    fw_group_facet_values.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
    return {
      _id: row.id,
      id: row.id,
      status: statusLabel,
      statusHealthy: healthy,
      alert_count,
      has_group_sync_status,
      group_sync_status_suspended,
      firmware_upgrade_count,
      hostname: row.hostname || row.name || "—",
      group_name,
      central_group_memberships,
      fw_group_facet_values,
      serial_number: row.serial_number || "—",
      model: row.model || "—",
      firmware_version: row.firmware_version || "—",
      connected: row.connected,
      suspended: row.suspended,
      external_ips: ips.length ? ips.join(", ") : "—",
      first_external_ipv4,
      tenant_name: row.tenant_name || "—",
      created_at: row.created_at || "",
      state_changed_at: row.state_changed_at || "",
      last_sync: row.last_sync || "",
      client_id: row.client_id || "",
      tags: tags || '<span class="muted">—</span>',
      tagsPlain: caps.join(" "),
      firewall_name:
        row.name != null && String(row.name).trim() !== "" ? String(row.name) : "—",
      tenant_id: row.tenant_id || "—",
      managing_status: row.managing_status || "—",
      reporting_status: row.reporting_status || "—",
      firewall_id: row.id || "—",
      capabilities_sort: row.capabilities_json || "",
      capabilities_display: formatJsonish(row.capabilities_json),
      firmware_available_updates: Array.isArray(row.firmware_available_updates)
        ? row.firmware_available_updates.map(String)
        : [],
      geo_lat,
      geo_lon,
      has_location,
      _row: row,
    };
  }

  function fwPreparedRowHasFirmwareUpgrade(row) {
    if (!row) return false;
    const uc = Number(row.firmware_upgrade_count);
    if (Number.isFinite(uc) && uc > 0) return true;
    const avail = row.firmware_available_updates;
    return Array.isArray(avail) && avail.length > 0;
  }

  async function fetchGeoipForIPv4(ip) {
    if (!ip) return null;
    if (fwGeoipByIp.has(ip)) {
      const c = fwGeoipByIp.get(ip);
      return c || null;
    }
    try {
      const data = await loadJson(`/api/geoip?ip=${encodeURIComponent(ip)}`);
      if (!data || !data.ok) {
        fwGeoipByIp.set(ip, null);
        return null;
      }
      const lat = typeof data.latitude === "number" ? data.latitude : parseFloat(data.latitude);
      const lon = typeof data.longitude === "number" ? data.longitude : parseFloat(data.longitude);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
        fwGeoipByIp.set(ip, null);
        return null;
      }
      const val = { lat, lon };
      fwGeoipByIp.set(ip, val);
      return val;
    } catch {
      fwGeoipByIp.set(ip, null);
      return null;
    }
  }

  function scheduleFwGeoipGuesses() {
    let applied = false;
    for (const row of fwPrepared) {
      if (row.has_location === 1 || !row.first_external_ipv4) continue;
      const cached = fwGeoipByIp.get(row.first_external_ipv4);
      if (cached && !fwMapGeoipGuess.has(row._id)) {
        fwMapGeoipGuess.set(row._id, cached);
        applied = true;
      }
    }
    if (applied) {
      refreshFwMapMarkers({ refit: false });
      if (fwDetailFlyoutOpenId) refreshFwDetailFlyoutVisuals();
    }

    for (const row of fwPrepared) {
      if (row.has_location === 1 || !row.first_external_ipv4) continue;
      if (fwMapGeoipGuess.has(row._id)) continue;
      const ip = row.first_external_ipv4;
      if (fwGeoipByIp.has(ip) && fwGeoipByIp.get(ip) == null) continue;
      if (fwGeoipInflight.has(ip)) continue;
      fwGeoipInflight.add(ip);
      fetchGeoipForIPv4(ip).then((res) => {
        fwGeoipInflight.delete(ip);
        if (!res) return;
        let upd = false;
        for (const r of fwPrepared) {
          if (r.has_location === 1) continue;
          if (r.first_external_ipv4 !== ip) continue;
          fwMapGeoipGuess.set(r._id, res);
          upd = true;
        }
        if (upd) {
          refreshFwMapMarkers({ refit: false });
          if (fwDetailFlyoutOpenId) refreshFwDetailFlyoutVisuals();
        }
      });
    }
  }

  function finalizeFwPreparedState() {
    const ids = new Set(fwPrepared.map((r) => r._id));
    for (const id of fwMapGeoipGuess.keys()) {
      if (!ids.has(id)) fwMapGeoipGuess.delete(id);
    }
    for (const r of fwPrepared) {
      if (r.has_location === 1) fwMapGeoipGuess.delete(r._id);
    }
    scheduleFwGeoipGuesses();
  }

  /** Carto Voyager: OSM data, no DEM hillshade; water reads clearly blue (vs. pale Positron/light_all). */
  const FW_MAP_TILE_URL =
    "https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png";
  /** Carto Dark Matter (dark_all): land/water tuned for dark UI. */
  const FW_MAP_TILE_URL_DARK =
    "https://{s}.basemaps.cartocdn.com/rastertiles/dark_all/{z}/{x}/{y}.png";
  const FW_MAP_TILE_ATTR =
    '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>';
  const FW_MAP_TILE_LAYER_BASE = {
    subdomains: "abcd",
    maxZoom: 19,
    noWrap: true,
  };

  function fwMapTileUrlForDocTheme() {
    return isDarkThemeActive() ? FW_MAP_TILE_URL_DARK : FW_MAP_TILE_URL;
  }

  function attachFwBaseTileLayer(map, attribution) {
    const layer = L.tileLayer(fwMapTileUrlForDocTheme(), {
      ...FW_MAP_TILE_LAYER_BASE,
      attribution: attribution === undefined ? FW_MAP_TILE_ATTR : attribution,
    });
    layer.addTo(map);
    map._fwBaseTileLayer = layer;
    return layer;
  }

  function refreshFwMapBaseTilesForTheme() {
    if (typeof L === "undefined") return;
    const url = fwMapTileUrlForDocTheme();
    const maps = [dashFwMap, panelFwMap, fwLocPickMap, fwDetailFlyoutMap, fwClusterLensMap];
    for (const m of maps) {
      const tl = m && m._fwBaseTileLayer;
      if (tl && typeof tl.setUrl === "function") tl.setUrl(url);
    }
  }

  const FW_MAP_H_KEY_DASH = "sophos-central-fw-map-height-dashboard-v1";
  const FW_MAP_H_KEY_PANEL = "sophos-central-fw-map-height-firewalls-v1";
  const FW_MAP_VIEW_KEY_DASH = "sophos-central-fw-map-view-dashboard-v1";
  const FW_MAP_VIEW_KEY_PANEL = "sophos-central-fw-map-view-firewalls-v1";
  const FW_MAP_DEFAULT_H_DASH = 420;
  const FW_MAP_DEFAULT_H_PANEL = 280;
  const FW_MAP_H_MIN = 160;
  const FW_MAP_H_MAX = 720;

  function readFwMapHeightPx(storageKey, defaultPx) {
    try {
      const raw = localStorage.getItem(storageKey);
      if (raw == null) return defaultPx;
      const n = parseInt(raw, 10);
      if (!Number.isFinite(n)) return defaultPx;
      return Math.min(FW_MAP_H_MAX, Math.max(FW_MAP_H_MIN, n));
    } catch {
      return defaultPx;
    }
  }

  function writeFwMapHeightPx(storageKey, px) {
    try {
      localStorage.setItem(storageKey, String(Math.round(px)));
    } catch {
      /* ignore */
    }
  }

  function readFwMapView(storageKey) {
    try {
      const raw = localStorage.getItem(storageKey);
      if (!raw) return null;
      const o = JSON.parse(raw);
      if (!o || typeof o !== "object") return null;
      const lat = Number(o.lat);
      const lng = Number(o.lng);
      const zoom = Number(o.zoom);
      if (!Number.isFinite(lat) || !Number.isFinite(lng) || !Number.isFinite(zoom)) return null;
      if (zoom < 1 || zoom > 22) return null;
      if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
      return { lat, lng, zoom };
    } catch {
      return null;
    }
  }

  function writeFwMapView(storageKey, lat, lng, zoom) {
    try {
      localStorage.setItem(storageKey, JSON.stringify({ lat, lng, zoom }));
    } catch {
      /* ignore */
    }
  }

  function attachFwMapViewPersistence(map, storageKey) {
    if (!map || map._fwViewPersistAttached) return;
    map._fwViewPersistAttached = true;
    let debounceT = null;
    const flush = () => {
      if (map._fwSkipViewSave) return;
      const c = map.getCenter();
      const z = map.getZoom();
      writeFwMapView(storageKey, c.lat, c.lng, z);
    };
    map.on("moveend zoomend", () => {
      clearTimeout(debounceT);
      debounceT = setTimeout(flush, 120);
    });
  }

  function applySavedFwMapViewOrFit(map, storageKey, rowsForFit) {
    if (!map) return;
    map._fwSkipViewSave = true;
    const saved = readFwMapView(storageKey);
    if (saved) {
      map.setView([saved.lat, saved.lng], saved.zoom, { animate: false });
    } else {
      fitFwMapBounds(map, rowsForFit);
    }
    const clearSkip = () => {
      map._fwSkipViewSave = false;
    };
    map.once("moveend", clearSkip);
    map.once("zoomend", clearSkip);
    setTimeout(clearSkip, 400);
  }

  function initFwMapResize(wrapId, mapElId, storageKey, defaultHeightPx) {
    const wrap = document.getElementById(wrapId);
    const mapEl = document.getElementById(mapElId);
    if (!wrap || !mapEl) return;
    const body = wrap.querySelector(".fw-map-section__body");
    if (!body) return;
    if (body.querySelector(`[data-fw-map-resize-for="${mapElId}"]`)) return;

    const h = readFwMapHeightPx(storageKey, defaultHeightPx);
    mapEl.style.height = `${h}px`;

    const handle = document.createElement("div");
    handle.className = "fw-map-resize-handle";
    handle.setAttribute("data-fw-map-resize-for", mapElId);
    handle.setAttribute("role", "separator");
    handle.setAttribute("aria-orientation", "horizontal");
    handle.setAttribute("aria-label", "Resize map height");
    handle.tabIndex = 0;
    mapEl.after(handle);

    function startResize(clientY) {
      const startY = clientY;
      const startH = mapEl.offsetHeight;
      const onMove = (ev) => {
        if (ev.cancelable && ev.type === "touchmove") ev.preventDefault();
        const y = ev.touches ? ev.touches[0].clientY : ev.clientY;
        const dy = y - startY;
        const nh = Math.round(Math.min(FW_MAP_H_MAX, Math.max(FW_MAP_H_MIN, startH + dy)));
        mapEl.style.height = `${nh}px`;
        const m = mapElId === "dash-fw-map" ? dashFwMap : panelFwMap;
        if (m) m.invalidateSize({ animate: false });
      };
      const onUp = () => {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        document.removeEventListener("touchmove", onMove);
        document.removeEventListener("touchend", onUp);
        document.removeEventListener("touchcancel", onUp);
        writeFwMapHeightPx(storageKey, mapEl.offsetHeight);
      };
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
      document.addEventListener("touchmove", onMove, { passive: false });
      document.addEventListener("touchend", onUp);
      document.addEventListener("touchcancel", onUp);
    }

    handle.addEventListener("mousedown", (e) => {
      e.preventDefault();
      startResize(e.clientY);
    });
    handle.addEventListener(
      "touchstart",
      (e) => {
        if (e.touches.length !== 1) return;
        e.preventDefault();
        startResize(e.touches[0].clientY);
      },
      { passive: false }
    );
    handle.addEventListener("keydown", (e) => {
      const step = e.shiftKey ? 40 : 16;
      let next = mapEl.offsetHeight;
      if (e.key === "ArrowUp") next -= step;
      else if (e.key === "ArrowDown") next += step;
      else return;
      e.preventDefault();
      next = Math.round(Math.min(FW_MAP_H_MAX, Math.max(FW_MAP_H_MIN, next)));
      mapEl.style.height = `${next}px`;
      const m = mapElId === "dash-fw-map" ? dashFwMap : panelFwMap;
      if (m) m.invalidateSize({ animate: false });
      writeFwMapHeightPx(storageKey, next);
    });
  }

  function initFwMapHeightsAndResizeHandles() {
    initFwMapResize("dash-fw-map-wrap", "dash-fw-map", FW_MAP_H_KEY_DASH, FW_MAP_DEFAULT_H_DASH);
    initFwMapResize("panel-fw-map-wrap", "panel-fw-map", FW_MAP_H_KEY_PANEL, FW_MAP_DEFAULT_H_PANEL);
  }

  function fwApprovalUiLabel(statusRaw) {
    const s = (statusRaw == null ? "" : String(statusRaw)).toLowerCase();
    if (s.includes("approved")) return "Enabled";
    if (s.includes("pending")) return "Pending approval";
    const t = String(statusRaw || "").trim();
    return t || "—";
  }

  function buildFwMapCardHtml(row, opts) {
    const forFlyout = Boolean(opts && opts.forFlyout);
    const raw = row._row || {};
    const ips = parseJsonArray(raw.external_ipv4_addresses_json);
    const lastIp = ips.length ? escapeHtml(String(ips[0])) : "—";
    const namePill = escapeHtml(row.firewall_name || "—");
    const host = escapeHtml(row.hostname || "—");
    const serial = escapeHtml(row.serial_number || "—");
    const model = escapeHtml(fwModelDisplay(row.model));
    const fwVer = escapeHtml(fwFirmwareDisplay(row.firmware_version));
    const connectedOk = row.connected === 1;
    const connPill = connectedOk
      ? '<span class="fw-map-pill fw-map-pill--ok">Connected</span>'
      : '<span class="fw-map-pill fw-map-pill--bad">Offline</span>';
    let suspBlock = "";
    if (row.suspended === 1 || row.suspended === true) {
      suspBlock =
        '<div class="fw-map-card__row"><span class="fw-map-pill fw-map-pill--danger">Suspended</span></div>';
    }
    const mg = escapeHtml(fwApprovalUiLabel(row.managing_status));
    const rp = escapeHtml(fwApprovalUiLabel(row.reporting_status));
    const tn = escapeHtml(row.tenant_name || "—");
    const nameEditBtn = forFlyout
      ? `<button type="button" class="fw-map-card__name-edit icon-btn" data-fw-flyout-edit-name="1" title="Edit label" aria-label="Edit firewall label">${CRED_ROW_ICONS.edit}</button>`
      : "";
    return `<div class="fw-map-card">
      <div class="fw-map-card__host">${host}</div>
      <div class="fw-map-card__row"><span class="fw-map-pill">${namePill}</span>${nameEditBtn} ${connPill}</div>
      ${suspBlock}
      <div class="fw-map-card__row"><span class="fw-map-card__label">Serial</span><span class="fw-map-card__val">${serial}</span></div>
      <div class="fw-map-card__row"><span class="fw-map-card__label">Model</span><span class="fw-map-card__val">${model}</span></div>
      <div class="fw-map-card__row"><span class="fw-map-card__label">Firmware</span><span class="fw-map-card__val">${fwVer}</span></div>
      <div class="fw-map-card__row"><span class="fw-map-card__label">Last IP</span><span class="fw-map-card__val">${lastIp}</span></div>
      <div class="fw-map-card__row"><span class="fw-map-card__label">Management</span><span class="fw-map-card__val">${mg}</span></div>
      <div class="fw-map-card__row"><span class="fw-map-card__label">Reporting</span><span class="fw-map-card__val">${rp}</span></div>
      <div class="fw-map-card__row"><span class="fw-map-card__label">Tenant</span><span class="fw-map-card__val">${tn}</span></div>
    </div>`;
  }

  function buildFwMapTooltipHtml(row) {
    return buildFwMapCardHtml(row, { forFlyout: false });
  }

  function fwMapBaseOptions() {
    return {
      scrollWheelZoom: true,
      touchZoom: true,
      boxZoom: true,
      doubleClickZoom: true,
      keyboard: true,
      zoomSnap: 0.5,
      zoomDelta: 0.5,
      wheelPxPerZoomLevel: 120,
    };
  }

  function initDashFwMapIfNeeded() {
    if (typeof L === "undefined" || dashFwMap) return;
    const host = document.getElementById("panel-dashboard");
    if (!host || host.hidden) return;
    const el = document.getElementById("dash-fw-map");
    if (!el) return;
    dashFwMap = L.map(el, fwMapBaseOptions());
    attachFwBaseTileLayer(dashFwMap);
    dashFwLayer = L.layerGroup().addTo(dashFwMap);
    dashFwClusterLayer = L.layerGroup().addTo(dashFwMap);
    dashFwEdgeLayer = L.layerGroup().addTo(dashFwMap);
    if (!dashFwMap._fwEdgeHooked) {
      dashFwMap._fwEdgeHooked = true;
      dashFwMap.on("moveend zoomend resize", () => {
        fwMapSyncMarkerLayers(dashFwMap, dashFwEdgeLayer, dashFwClusterLayer, dashFwLayer);
      });
    }
    attachFwMapViewPersistence(dashFwMap, FW_MAP_VIEW_KEY_DASH);
  }

  function initPanelFwMapIfNeeded() {
    if (typeof L === "undefined" || panelFwMap) return;
    const host = document.getElementById("panel-firewalls");
    if (!host || host.hidden) return;
    const subFw = document.getElementById("fw-subpanel-firewalls");
    if (subFw && subFw.hidden) return;
    const el = document.getElementById("panel-fw-map");
    if (!el) return;
    panelFwMap = L.map(el, fwMapBaseOptions());
    attachFwBaseTileLayer(panelFwMap);
    panelFwLayer = L.layerGroup().addTo(panelFwMap);
    panelFwClusterLayer = L.layerGroup().addTo(panelFwMap);
    panelFwEdgeLayer = L.layerGroup().addTo(panelFwMap);
    if (!panelFwMap._fwEdgeHooked) {
      panelFwMap._fwEdgeHooked = true;
      panelFwMap.on("moveend zoomend resize", () => {
        fwMapSyncMarkerLayers(panelFwMap, panelFwEdgeLayer, panelFwClusterLayer, panelFwLayer);
      });
    }
    attachFwMapViewPersistence(panelFwMap, FW_MAP_VIEW_KEY_PANEL);
  }

  function collectFwMapLatLngsFromRows(rows) {
    const out = [];
    rows.forEach((row) => {
      const ll = fwRowMapLatLng(row);
      if (ll) out.push([ll.lat, ll.lon]);
    });
    return out;
  }

  function fwMapMarkerDataSignature(rows) {
    if (!rows || rows.length === 0) return "0";
    return `${rows.length}\u0001${rows
      .map((r) => {
        const ll = fwRowMapLatLng(r);
        return [
          String(r.firewall_id ?? r._id ?? ""),
          ll ? String(ll.lat) : "",
          ll ? String(ll.lon) : "",
          String(r.connected ?? ""),
          String(r.suspended ?? ""),
        ].join("\u0002");
      })
      .join("\u0001")}`;
  }

  function fwMapMarkerIconForRow(row) {
    const conn = row.connected === 1;
    const susp = row.suspended === 1 || row.suspended === true;
    let color = "#1565c0";
    if (!conn) color = "#6b7280";
    else if (susp) color = "#ef6c00";
    return L.divIcon({
      className: "fw-map-pin",
      html: `<span class="fw-map-pin__dot" style="background-color:${color}"></span>`,
      iconSize: [22, 22],
      iconAnchor: [11, 11],
    });
  }

  /**
   * Smallest u>0 where ray from (cx,cy) toward (tx,ty) hits the padded map rectangle.
   * (cx,cy) is the view center; works when the target screen point is inside or outside the rect.
   */
  function fwMapCenterRayEdgeHit(cx, cy, tx, ty, xmin, ymin, xmax, ymax) {
    const dx = tx - cx;
    const dy = ty - cy;
    if (Math.abs(dx) < 1e-9 && Math.abs(dy) < 1e-9) return null;
    const hits = [];
    const pushV = (xfix, u) => {
      if (u <= 1e-9 || !Number.isFinite(u)) return;
      const yv = cy + u * dy;
      if (yv >= ymin && yv <= ymax) hits.push({ u, x: xfix, y: yv });
    };
    const pushH = (yfix, u) => {
      if (u <= 1e-9 || !Number.isFinite(u)) return;
      const xv = cx + u * dx;
      if (xv >= xmin && xv <= xmax) hits.push({ u, x: xv, y: yfix });
    };
    if (Math.abs(dx) > 1e-12) {
      pushV(xmin, (xmin - cx) / dx);
      pushV(xmax, (xmax - cx) / dx);
    }
    if (Math.abs(dy) > 1e-12) {
      pushH(ymin, (ymin - cy) / dy);
      pushH(ymax, (ymax - cy) / dy);
    }
    if (!hits.length) return null;
    hits.sort((a, b) => a.u - b.u);
    return { x: hits[0].x, y: hits[0].y };
  }

  function fwMapHitToSide(ex, ey, xmin, ymin, xmax, ymax) {
    const dTop = Math.abs(ey - ymin);
    const dBot = Math.abs(ey - ymax);
    const dLeft = Math.abs(ex - xmin);
    const dRight = Math.abs(ex - xmax);
    const m = Math.min(dTop, dBot, dLeft, dRight);
    if (m === dTop) return { side: "top", coord: ex };
    if (m === dBot) return { side: "bottom", coord: ex };
    if (m === dLeft) return { side: "left", coord: ey };
    return { side: "right", coord: ey };
  }

  const FW_MAP_EDGE_GAP_PX = 22;
  /** Center-to-center distance (px) below which on-screen markers merge into one cluster. */
  const FW_MAP_CLUSTER_MERGE_PX = 22;
  /** Half of on-screen dot footprint (18px dot + 2px border), in px from marker anchor. */
  const FW_MAP_DOT_RADIUS_PX = 11;
  const FW_MAP_CLUSTER_MIN_DIAM_PX = 38;
  const FW_MAP_LENS_SIZE_PX = 260;
  const FW_MAP_LENS_MIN_PAIR_SEP_PX = 28;
  /** Padding for lens fitBounds: large enough that pins stay inside the circular clip (square map is masked to a circle). */
  const FW_MAP_LENS_PAD_PX = 56;
  const FW_CLUSTER_LENS_ID = "fw-map-cluster-lens";
  /** Delay before hiding hover card / lens so pointer can cross gaps or reach the card without tearing down UI. */
  const FW_MAP_HOVER_PORTAL_HIDE_MS = 220;
  const FW_MAP_CLUSTER_LENS_HIDE_MS = 240;

  function fwMapPartitionIntoPixelClusters(items, mergePx) {
    const n = items.length;
    if (n <= 1) return items.length ? [items] : [];
    const parent = Array.from({ length: n }, (_, i) => i);
    function find(i) {
      if (parent[i] !== i) parent[i] = find(parent[i]);
      return parent[i];
    }
    function union(a, b) {
      const ra = find(a);
      const rb = find(b);
      if (ra !== rb) parent[rb] = ra;
    }
    const thr2 = mergePx * mergePx;
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const dx = items[i].pt.x - items[j].pt.x;
        const dy = items[i].pt.y - items[j].pt.y;
        if (dx * dx + dy * dy <= thr2) union(i, j);
      }
    }
    const byRoot = new Map();
    for (let i = 0; i < n; i++) {
      const r = find(i);
      if (!byRoot.has(r)) byRoot.set(r, []);
      byRoot.get(r).push(items[i]);
    }
    return [...byRoot.values()];
  }

  function fwMapClusterDivIcon(count, diamPx) {
    const d = Math.max(FW_MAP_CLUSTER_MIN_DIAM_PX, Math.round(diamPx));
    const fs = d < 42 ? 13 : d < 52 ? 14 : 16;
    return L.divIcon({
      className: "fw-map-cluster-pin",
      html: `<div class="fw-map-cluster" style="width:${d}px;height:${d}px"><span class="fw-map-cluster__count" style="font-size:${fs}px">${escapeHtml(String(count))}</span></div>`,
      iconSize: [d, d],
      iconAnchor: [d / 2, d / 2],
    });
  }

  function fwMapDistributeEdgeSlots(slots, side, xmin, ymin, xmax, ymax) {
    if (!slots.length) return;
    const minC = side === "top" || side === "bottom" ? xmin : ymin;
    const maxC = side === "top" || side === "bottom" ? xmax : ymax;
    slots.sort((a, b) => a.coord - b.coord);
    for (let i = 1; i < slots.length; i++) {
      if (slots[i].coord < slots[i - 1].coord + FW_MAP_EDGE_GAP_PX) {
        slots[i].coord = slots[i - 1].coord + FW_MAP_EDGE_GAP_PX;
      }
    }
    const overflow = slots[slots.length - 1].coord - maxC;
    if (overflow > 0) {
      for (const s of slots) s.coord -= overflow;
    }
    const under = minC - slots[0].coord;
    if (under > 0) {
      for (const s of slots) s.coord += under;
    }
    for (const s of slots) {
      s.coord = Math.min(maxC, Math.max(minC, s.coord));
    }
    for (let i = 1; i < slots.length; i++) {
      if (slots[i].coord < slots[i - 1].coord + FW_MAP_EDGE_GAP_PX) {
        slots[i].coord = Math.min(maxC, slots[i - 1].coord + FW_MAP_EDGE_GAP_PX);
      }
    }
  }

  function fwMapEdgeIconForRow(row, rotationDeg) {
    const conn = row.connected === 1;
    const susp = row.suspended === 1 || row.suspended === true;
    let color = "#1565c0";
    if (!conn) color = "#6b7280";
    else if (susp) color = "#ef6c00";
    const rot = Number.isFinite(rotationDeg) ? rotationDeg : 0;
    return L.divIcon({
      className: "fw-map-edge-pin",
      html: `<div class="fw-map-edge" style="transform:rotate(${rot}deg)"><span class="fw-map-edge__dot" style="background-color:${color}"></span><span class="fw-map-edge__arrow" style="border-bottom-color:${color}"></span></div>`,
      iconSize: [28, 30],
      iconAnchor: [14, 15],
    });
  }

  function fwMapSyncMarkerLayers(map, edgeLayer, clusterLayer, markerLayer) {
    if (typeof L === "undefined" || !map || !edgeLayer || !clusterLayer || !markerLayer) return;
    edgeLayer.clearLayers();
    clusterLayer.clearLayers();
    const sz = map.getSize();
    if (!sz || sz.x < 32 || sz.y < 32) return;
    const bounds = map.getBounds();
    const pad = 14;
    const xmin = pad;
    const ymin = pad;
    const xmax = sz.x - pad;
    const ymax = sz.y - pad;
    const cx = sz.x / 2;
    const cy = sz.y / 2;

    const visibleItems = [];
    markerLayer.eachLayer((layer) => {
      if (!(layer instanceof L.Marker) || !layer.fwRow) return;
      const row = layer.fwRow;
      const rowLl = fwRowMapLatLng(row);
      if (!rowLl) return;
      const ll = L.latLng(rowLl.lat, rowLl.lon);
      const t = map.latLngToContainerPoint(ll);
      const inGeo = bounds.contains(ll);
      const tIn = t.x >= xmin && t.x <= xmax && t.y >= ymin && t.y <= ymax;
      const onMainView = inGeo && tIn;
      layer.setOpacity(0);
      layer.options.interactive = false;
      if (onMainView) visibleItems.push({ marker: layer, row, ll, pt: { x: t.x, y: t.y } });
    });

    const groups =
      visibleItems.length > 0
        ? fwMapPartitionIntoPixelClusters(visibleItems, FW_MAP_CLUSTER_MERGE_PX)
        : [];

    for (const group of groups) {
      if (group.length === 1) {
        group[0].marker.setOpacity(1);
        group[0].marker.options.interactive = true;
        continue;
      }
      let sumX = 0;
      let sumY = 0;
      for (const g of group) {
        sumX += g.pt.x;
        sumY += g.pt.y;
      }
      const n = group.length;
      const cpx = sumX / n;
      const cpy = sumY / n;
      let maxR = 0;
      for (const g of group) {
        const dx = g.pt.x - cpx;
        const dy = g.pt.y - cpy;
        const d = Math.sqrt(dx * dx + dy * dy) + FW_MAP_DOT_RADIUS_PX;
        if (d > maxR) maxR = d;
      }
      const diam = Math.max(FW_MAP_CLUSTER_MIN_DIAM_PX, Math.ceil(2 * maxR + 6));
      const clusterLl = map.containerPointToLatLng(L.point(cpx, cpy));
      const icon = fwMapClusterDivIcon(n, diam);
      const cm = L.marker(clusterLl, { icon, interactive: true, zIndexOffset: 500 });
      cm.fwClusterGroup = group;
      cm.fwParentMap = map;
      cm.addTo(clusterLayer);
      attachFwMapClusterHoverLens(map, cm, group);
      attachFwMapClusterClickFit(map, cm, group);
    }

    const candidates = [];
    markerLayer.eachLayer((layer) => {
      if (!(layer instanceof L.Marker) || !layer.fwRow) return;
      const row = layer.fwRow;
      const rowLl = fwRowMapLatLng(row);
      if (!rowLl) return;
      const ll = L.latLng(rowLl.lat, rowLl.lon);
      const t = map.latLngToContainerPoint(ll);
      const inGeo = bounds.contains(ll);
      const tIn = t.x >= xmin && t.x <= xmax && t.y >= ymin && t.y <= ymax;
      if (inGeo && tIn) return;
      candidates.push({ row, t });
    });

    const raw = [];
    for (const { row, t } of candidates) {
      const exit = fwMapCenterRayEdgeHit(cx, cy, t.x, t.y, xmin, ymin, xmax, ymax);
      if (!exit) continue;
      const ex = Math.min(xmax, Math.max(xmin, exit.x));
      const ey = Math.min(ymax, Math.max(ymin, exit.y));
      const { side, coord } = fwMapHitToSide(ex, ey, xmin, ymin, xmax, ymax);
      raw.push({ row, t, side, coord });
    }

    const sides = { top: [], right: [], bottom: [], left: [] };
    for (const r of raw) {
      sides[r.side].push({ coord: r.coord, row: r.row, t: r.t });
    }
    for (const side of ["top", "right", "bottom", "left"]) {
      fwMapDistributeEdgeSlots(sides[side], side, xmin, ymin, xmax, ymax);
    }

    const placed = [];
    for (const side of ["top", "right", "bottom", "left"]) {
      for (const sl of sides[side]) {
        let ex;
        let ey;
        if (side === "top") {
          ex = sl.coord;
          ey = ymin;
        } else if (side === "bottom") {
          ex = sl.coord;
          ey = ymax;
        } else if (side === "left") {
          ex = xmin;
          ey = sl.coord;
        } else {
          ex = xmax;
          ey = sl.coord;
        }
        placed.push({ row: sl.row, t: sl.t, ex, ey });
      }
    }

    for (const { row, t, ex, ey } of placed) {
      const rotDeg = (Math.atan2(t.y - ey, t.x - ex) * 180) / Math.PI + 90;
      const icon = fwMapEdgeIconForRow(row, rotDeg);
      const ll = map.containerPointToLatLng(L.point(ex, ey));
      const em = L.marker(ll, { icon, interactive: true, zIndexOffset: 800 });
      em.fwRow = row;
      em.addTo(edgeLayer);
      attachFwMapMarkerHoverCard(map, em, buildFwMapTooltipHtml(row));
      attachFwMapMarkerClickToCenter(map, em);
    }
  }

  function fitFwMapBounds(map, rowsForBounds) {
    if (!map || typeof L === "undefined") return;
    const rows = rowsForBounds === undefined ? fwPrepared : rowsForBounds;
    const pts = collectFwMapLatLngsFromRows(rows);
    if (pts.length === 0) {
      map.setView([20, 0], 2, { animate: false });
      return;
    }
    if (pts.length === 1) {
      map.setView(pts[0], 6, { animate: false });
      return;
    }
    const bounds = L.latLngBounds(pts);
    const sw = bounds.getSouthWest();
    const ne = bounds.getNorthEast();
    let latSpan = Math.abs(ne.lat - sw.lat);
    let lngSpan = Math.abs(ne.lng - sw.lng);
    const eps = 1e-8;
    if (latSpan < eps && lngSpan < eps) {
      map.setView([sw.lat, sw.lng], 6, { animate: false });
      return;
    }
    const minDeg = 0.12;
    if (latSpan < minDeg || lngSpan < minDeg) {
      const c = bounds.getCenter();
      const halfLat = Math.max(latSpan / 2, minDeg / 2);
      const halfLng = Math.max(lngSpan / 2, minDeg / 2);
      const padded = L.latLngBounds(
        [c.lat - halfLat, c.lng - halfLng],
        [c.lat + halfLat, c.lng + halfLng]
      );
      map.fitBounds(padded, { padding: [64, 64], maxZoom: 8, animate: false });
      return;
    }
    map.fitBounds(bounds, { padding: [64, 64], maxZoom: 8, animate: false });
  }

  function fwMapMinLayerPointPairDist(lensMap, latlngs) {
    if (latlngs.length < 2) return Infinity;
    const pts = latlngs.map((ll) => lensMap.latLngToLayerPoint(L.latLng(ll)));
    let minD = Infinity;
    for (let i = 0; i < pts.length; i++) {
      for (let j = i + 1; j < pts.length; j++) {
        const d = pts[i].distanceTo(pts[j]);
        if (d < minD) minD = d;
      }
    }
    return minD;
  }

  function ensureFwClusterLensPortal() {
    let el = document.getElementById(FW_CLUSTER_LENS_ID);
    if (!el) {
      el = document.createElement("div");
      el.id = FW_CLUSTER_LENS_ID;
      el.className = "fw-map-cluster-lens";
      el.hidden = true;
      el.setAttribute("role", "img");
      el.setAttribute("aria-label", "Magnified map cluster");
      el.innerHTML = `<div class="fw-map-cluster-lens__stack">
          <div class="fw-map-cluster-lens__clip"><div class="fw-map-cluster-lens__mapEl"></div></div>
          <div class="fw-map-cluster-lens__cards" hidden></div>
        </div>`;
      document.body.appendChild(el);
      el.addEventListener("mouseenter", () => {
        if (fwClusterLensHideTimer) {
          clearTimeout(fwClusterLensHideTimer);
          fwClusterLensHideTimer = null;
        }
      });
      el.addEventListener("mouseleave", (ev) => {
        const rt = ev.relatedTarget;
        if (rt && typeof rt.closest === "function" && rt.closest("#fw-map-hover-portal")) {
          return;
        }
        scheduleHideFwClusterLens();
      });
    }
    return el;
  }

  function removeFwClusterLensViewportListeners() {
    if (!fwClusterLensViewportListeners) return;
    fwClusterLensViewportListeners = false;
    window.removeEventListener("scroll", repositionFwClusterLens, true);
    window.removeEventListener("resize", repositionFwClusterLens);
  }

  function repositionFwClusterLens() {
    const portal = document.getElementById(FW_CLUSTER_LENS_ID);
    if (!portal || portal.hidden || !fwClusterLensActiveClusterMarker) return;
    const icon = fwClusterLensActiveClusterMarker._icon;
    if (!icon) return;
    const ir = icon.getBoundingClientRect();
    const pw = portal.offsetWidth || FW_MAP_LENS_SIZE_PX;
    const ph = portal.offsetHeight || FW_MAP_LENS_SIZE_PX;
    let left = ir.left + ir.width / 2 - pw / 2;
    let top = ir.bottom + 10;
    const pad = 8;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    if (top + ph > vh - pad) top = ir.top - ph - 10;
    if (left < pad) left = pad;
    if (left + pw > vw - pad) left = Math.max(pad, vw - pad - pw);
    if (top < pad) top = pad;
    portal.style.left = `${Math.round(left)}px`;
    portal.style.top = `${Math.round(top)}px`;
  }

  function addFwClusterLensViewportListeners() {
    if (fwClusterLensViewportListeners) return;
    fwClusterLensViewportListeners = true;
    window.addEventListener("scroll", repositionFwClusterLens, true);
    window.addEventListener("resize", repositionFwClusterLens);
  }

  function hideFwClusterLensNow() {
    if (fwClusterLensHideTimer) {
      clearTimeout(fwClusterLensHideTimer);
      fwClusterLensHideTimer = null;
    }
    removeFwClusterLensViewportListeners();
    if (fwClusterLensMainMap) {
      fwClusterLensMainMap.off("move zoom", repositionFwClusterLens);
      fwClusterLensMainMap = null;
    }
    if (fwHoverActiveMap && fwClusterLensMap && fwHoverActiveMap === fwClusterLensMap) {
      hideFwMapHoverPortalNow(false);
    }
    if (fwClusterLensMap) {
      try {
        fwClusterLensMap.remove();
      } catch {
        /* ignore */
      }
      fwClusterLensMap = null;
    }
    const el = document.getElementById(FW_CLUSTER_LENS_ID);
    if (el) {
      el.hidden = true;
      el.classList.remove("fw-map-cluster-lens--with-cards");
      const mapEl = el.querySelector(".fw-map-cluster-lens__mapEl");
      if (mapEl) mapEl.innerHTML = "";
      const cardsEl = el.querySelector(".fw-map-cluster-lens__cards");
      if (cardsEl) {
        cardsEl.hidden = true;
        cardsEl.innerHTML = "";
      }
    }
    fwClusterLensActiveClusterMarker = null;
  }

  function scheduleHideFwClusterLens() {
    if (fwClusterLensHideTimer) clearTimeout(fwClusterLensHideTimer);
    fwClusterLensHideTimer = setTimeout(() => {
      fwClusterLensHideTimer = null;
      hideFwClusterLensNow();
    }, FW_MAP_CLUSTER_LENS_HIDE_MS);
  }

  function fwClusterGroupHasDuplicateLatLng(group) {
    const eps = 1e-7;
    for (let i = 0; i < group.length; i++) {
      const a = group[i].row;
      const aLl = fwRowMapLatLng(a);
      if (!aLl) continue;
      for (let j = i + 1; j < group.length; j++) {
        const b = group[j].row;
        const bLl = fwRowMapLatLng(b);
        if (!bLl) continue;
        if (
          Math.abs(aLl.lat - bLl.lat) < eps &&
          Math.abs(aLl.lon - bLl.lon) < eps
        ) {
          return true;
        }
      }
    }
    return false;
  }

  function fwMainMapAtMaximumZoom(mainMap) {
    if (!mainMap || typeof mainMap.getMaxZoom !== "function" || typeof mainMap.getZoom !== "function") {
      return false;
    }
    const zMax = mainMap.getMaxZoom();
    if (typeof zMax !== "number" || !Number.isFinite(zMax)) return false;
    return mainMap.getZoom() >= zMax - 1e-6;
  }

  function showFwClusterLens(mainMap, clusterMarker, group) {
    hideFwMapHoverPortalNow();
    const portal = ensureFwClusterLensPortal();
    const mapEl = portal.querySelector(".fw-map-cluster-lens__mapEl");
    const cardsEl = portal.querySelector(".fw-map-cluster-lens__cards");
    if (!mapEl) return;
    fwClusterLensActiveClusterMarker = clusterMarker;
    portal.hidden = false;
    portal.classList.remove("fw-map-cluster-lens--with-cards");
    if (cardsEl) {
      cardsEl.hidden = true;
      cardsEl.innerHTML = "";
    }
    fwClusterLensMap = L.map(mapEl, {
      attributionControl: false,
      zoomControl: false,
      scrollWheelZoom: false,
      dragging: false,
      doubleClickZoom: false,
      boxZoom: false,
      keyboard: false,
      touchZoom: false,
      zoomSnap: 0.25,
      zoomDelta: 0.25,
    });
    attachFwBaseTileLayer(fwClusterLensMap, "");
    const latlngs = group.map((g) => {
      const ll = fwRowMapLatLng(g.row);
      return ll ? L.latLng(ll.lat, ll.lon) : null;
    });
    if (latlngs.some((x) => x == null)) {
      hideFwClusterLensNow();
      return;
    }
    const bounds = L.latLngBounds(latlngs);
    const geoCenter = bounds.getCenter();
    for (let i = 0; i < group.length; i++) {
      const row = group[i].row;
      const icon = fwMapMarkerIconForRow(row);
      const lm = L.marker(latlngs[i], { icon, interactive: true, zIndexOffset: 600 }).addTo(
        fwClusterLensMap
      );
      lm.fwRow = row;
    }
    fwClusterLensMap.fitBounds(bounds, {
      padding: [FW_MAP_LENS_PAD_PX, FW_MAP_LENS_PAD_PX],
      animate: false,
      maxZoom: 18,
    });
    fwClusterLensMap.invalidateSize(false);
    let z = fwClusterLensMap.getZoom();
    for (let step = 0; step < 16; step++) {
      const d = fwMapMinLayerPointPairDist(fwClusterLensMap, latlngs);
      if (d >= FW_MAP_LENS_MIN_PAIR_SEP_PX || z >= 18) break;
      z += 0.25;
      fwClusterLensMap.setZoomAround(geoCenter, z, { animate: false });
    }
    fwClusterLensMap.fitBounds(bounds, {
      padding: [FW_MAP_LENS_PAD_PX, FW_MAP_LENS_PAD_PX],
      animate: false,
      maxZoom: fwClusterLensMap.getZoom(),
    });
    fwClusterLensMap.invalidateSize(false);

    const minDist =
      latlngs.length >= 2 ? fwMapMinLayerPointPairDist(fwClusterLensMap, latlngs) : Infinity;
    const hasDup = fwClusterGroupHasDuplicateLatLng(group);
    const stillOverlap =
      latlngs.length >= 2 &&
      (minDist < FW_MAP_LENS_MIN_PAIR_SEP_PX || !Number.isFinite(minDist));
    const mainAtMax = fwMainMapAtMaximumZoom(mainMap);
    const showCardStrip =
      group.length > 1 && cardsEl && (hasDup || stillOverlap || mainAtMax);
    if (showCardStrip) {
      portal.classList.add("fw-map-cluster-lens--with-cards");
      cardsEl.hidden = false;
      cardsEl.innerHTML = group
        .map(
          (g) =>
            `<div class="fw-map-cluster-lens__card-slot">${buildFwMapTooltipHtml(g.row)}</div>`
        )
        .join("");
      portal.setAttribute(
        "aria-label",
        `Magnified map cluster, ${group.length} firewalls — details below map`
      );
    } else {
      portal.setAttribute("aria-label", "Magnified map cluster");
      fwClusterLensMap.eachLayer((layer) => {
        if (layer instanceof L.Marker && layer.fwRow) {
          attachFwMapLensMarkerHoverCard(
            fwClusterLensMap,
            layer,
            buildFwMapTooltipHtml(layer.fwRow)
          );
        }
      });
    }

    fwClusterLensMainMap = mainMap;
    mainMap.on("move zoom", repositionFwClusterLens);
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        repositionFwClusterLens();
      });
    });
    addFwClusterLensViewportListeners();
  }

  function attachFwMapClusterHoverLens(mainMap, clusterMarker, group) {
    clusterMarker.on("mouseover", () => {
      if (fwClusterLensHideTimer) {
        clearTimeout(fwClusterLensHideTimer);
        fwClusterLensHideTimer = null;
      }
      showFwClusterLens(mainMap, clusterMarker, group);
    });
    clusterMarker.on("mouseout", () => {
      scheduleHideFwClusterLens();
    });
  }

  function attachFwMapClusterClickFit(mainMap, clusterMarker, group) {
    clusterMarker.on("click", (ev) => {
      if (ev && ev.originalEvent) {
        L.DomEvent.stopPropagation(ev.originalEvent);
      }
      hideFwClusterLensNow();
      hideFwMapHoverPortalNow();
      const latlngs = group
        .map((g) => {
          const ll = fwRowMapLatLng(g.row);
          return ll ? L.latLng(ll.lat, ll.lon) : null;
        })
        .filter((x) => x != null);
      if (!latlngs.length) return;
      mainMap.fitBounds(L.latLngBounds(latlngs), { padding: [72, 72], maxZoom: 14, animate: true });
    });
  }

  const FW_HOVER_PORTAL_ID = "fw-map-hover-portal";

  function ensureFwMapHoverPortal() {
    let el = document.getElementById(FW_HOVER_PORTAL_ID);
    if (!el) {
      el = document.createElement("div");
      el.id = FW_HOVER_PORTAL_ID;
      el.className = "fw-map-hover-portal";
      el.hidden = true;
      el.setAttribute("role", "tooltip");
      document.body.appendChild(el);
    }
    return el;
  }

  function wireFwMapHoverPortalOnce() {
    const portal = ensureFwMapHoverPortal();
    if (portal.dataset.fwHoverWired === "1") return;
    portal.dataset.fwHoverWired = "1";
    portal.addEventListener("mouseenter", () => {
      if (fwHoverPortalHideTimer) {
        clearTimeout(fwHoverPortalHideTimer);
        fwHoverPortalHideTimer = null;
      }
      if (fwClusterLensHideTimer) {
        clearTimeout(fwClusterLensHideTimer);
        fwClusterLensHideTimer = null;
      }
    });
    portal.addEventListener("mouseleave", () => {
      scheduleHideFwMapHoverPortal();
    });
  }

  function repositionFwMapHoverPortal(map, marker, portalEl) {
    const icon = marker._icon;
    if (!icon || !portalEl) return;
    const ir = icon.getBoundingClientRect();
    let w = portalEl.offsetWidth;
    let h = portalEl.offsetHeight;
    if (w < 16) w = 300;
    if (h < 16) h = 160;
    let left = ir.left + ir.width / 2 - w / 2;
    let top = ir.top - h - 10;
    const pad = 8;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    if (left < pad) left = pad;
    if (left + w > vw - pad) left = Math.max(pad, vw - pad - w);
    if (top < pad) top = ir.bottom + 12;
    if (top + h > vh - pad) top = Math.max(pad, vh - pad - h);
    portalEl.style.left = `${Math.round(left)}px`;
    portalEl.style.top = `${Math.round(top)}px`;
  }

  /** Leaflet sometimes has not created `marker._icon` yet on first mouseover; retry until it exists. */
  function queueFwMapHoverPortalPosition(map, marker, portalEl) {
    let attempts = 0;
    const maxAttempts = 45;
    const tick = () => {
      if (!portalEl.isConnected || !marker._map) return;
      const icon = marker._icon;
      if (icon) {
        repositionFwMapHoverPortal(map, marker, portalEl);
        return;
      }
      attempts += 1;
      if (attempts < maxAttempts) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  function repositionActiveFwMapPortal() {
    const portal = document.getElementById(FW_HOVER_PORTAL_ID);
    if (!portal || portal.hidden || !fwHoverActiveMap || !fwHoverActiveMarker) return;
    repositionFwMapHoverPortal(fwHoverActiveMap, fwHoverActiveMarker, portal);
  }

  function addFwMapHoverViewportListeners() {
    if (fwHoverViewportListeners) return;
    fwHoverViewportListeners = true;
    window.addEventListener("scroll", repositionActiveFwMapPortal, true);
    window.addEventListener("resize", repositionActiveFwMapPortal);
  }

  function removeFwMapHoverViewportListeners() {
    if (!fwHoverViewportListeners) return;
    fwHoverViewportListeners = false;
    window.removeEventListener("scroll", repositionActiveFwMapPortal, true);
    window.removeEventListener("resize", repositionActiveFwMapPortal);
  }

  function hideFwMapHoverPortalNow(closeClusterLens = true) {
    if (closeClusterLens) {
      hideFwClusterLensNow();
    } else {
      if (fwHoverPortalHideTimer) {
        clearTimeout(fwHoverPortalHideTimer);
        fwHoverPortalHideTimer = null;
      }
      removeFwMapHoverViewportListeners();
      if (fwHoverActiveMap) {
        fwHoverActiveMap.off("move zoom", repositionActiveFwMapPortal);
      }
      fwHoverActiveMap = null;
      fwHoverActiveMarker = null;
      const elOnly = document.getElementById(FW_HOVER_PORTAL_ID);
      if (elOnly) {
        elOnly.hidden = true;
        elOnly.innerHTML = "";
      }
      return;
    }
    if (fwHoverPortalHideTimer) {
      clearTimeout(fwHoverPortalHideTimer);
      fwHoverPortalHideTimer = null;
    }
    removeFwMapHoverViewportListeners();
    if (fwHoverActiveMap) {
      fwHoverActiveMap.off("move zoom", repositionActiveFwMapPortal);
    }
    fwHoverActiveMap = null;
    fwHoverActiveMarker = null;
    const el = document.getElementById(FW_HOVER_PORTAL_ID);
    if (el) {
      el.hidden = true;
      el.innerHTML = "";
    }
  }

  function scheduleHideFwMapHoverPortal() {
    if (fwHoverPortalHideTimer) clearTimeout(fwHoverPortalHideTimer);
    fwHoverPortalHideTimer = setTimeout(() => {
      fwHoverPortalHideTimer = null;
      const fromLensMap = fwHoverActiveMap && fwHoverActiveMap === fwClusterLensMap;
      hideFwMapHoverPortalNow(!fromLensMap);
    }, FW_MAP_HOVER_PORTAL_HIDE_MS);
  }

  function attachFwMapMarkerHoverCard(map, marker, html) {
    wireFwMapHoverPortalOnce();
    marker.on("mouseover", () => {
      hideFwClusterLensNow();
      if (fwHoverPortalHideTimer) {
        clearTimeout(fwHoverPortalHideTimer);
        fwHoverPortalHideTimer = null;
      }
      if (fwHoverActiveMap) {
        fwHoverActiveMap.off("move zoom", repositionActiveFwMapPortal);
      }
      fwHoverActiveMap = map;
      fwHoverActiveMarker = marker;
      map.on("move zoom", repositionActiveFwMapPortal);
      addFwMapHoverViewportListeners();
      const portal = ensureFwMapHoverPortal();
      portal.innerHTML = html;
      portal.hidden = false;
      queueFwMapHoverPortalPosition(map, marker, portal);
    });
    marker.on("mouseout", () => {
      scheduleHideFwMapHoverPortal();
    });
  }

  /** Hover card for pins inside the cluster magnifier; keeps the lens open (unlike main-map markers). */
  function attachFwMapLensMarkerHoverCard(map, marker, html) {
    wireFwMapHoverPortalOnce();
    marker.on("mouseover", () => {
      if (fwHoverPortalHideTimer) {
        clearTimeout(fwHoverPortalHideTimer);
        fwHoverPortalHideTimer = null;
      }
      if (fwHoverActiveMap) {
        fwHoverActiveMap.off("move zoom", repositionActiveFwMapPortal);
      }
      fwHoverActiveMap = map;
      fwHoverActiveMarker = marker;
      map.on("move zoom", repositionActiveFwMapPortal);
      addFwMapHoverViewportListeners();
      const portal = ensureFwMapHoverPortal();
      portal.innerHTML = html;
      portal.hidden = false;
      queueFwMapHoverPortalPosition(map, marker, portal);
    });
    marker.on("mouseout", () => {
      scheduleHideFwMapHoverPortal();
    });
  }

  function fwMapStableRowId(row) {
    if (!row) return null;
    const id = row._id ?? row.firewall_id;
    return id != null && id !== "" ? String(id) : null;
  }

  function findFwRowByIdForDashMap(fwId) {
    if (!fwId) return null;
    const k = String(fwId);
    return fwPrepared.find((x) => String(x._id ?? x.firewall_id) === k) || null;
  }

  function findFwRowByIdForPanelMap(fwId) {
    if (!fwId) return null;
    const k = String(fwId);
    const panelRows =
      typeof fwController !== "undefined" && fwController?.getFullFilteredRows
        ? fwController.getFullFilteredRows()
        : fwPrepared;
    const hit = panelRows.find((x) => String(x._id ?? x.firewall_id) === k);
    if (hit) return hit;
    return fwPrepared.find((x) => String(x._id ?? x.firewall_id) === k) || null;
  }

  function updateFwMapBackNavUi() {
    const dashBtn = document.getElementById("dash-fw-map-back");
    const panelBtn = document.getElementById("panel-fw-map-back");
    if (dashBtn) {
      const has = fwDashMapCenterPastIds.length > 0;
      dashBtn.disabled = !has;
      dashBtn.title = has ? "Previous firewall" : "No previous firewall";
    }
    if (panelBtn) {
      const has = fwPanelMapCenterPastIds.length > 0;
      panelBtn.disabled = !has;
      panelBtn.title = has ? "Previous firewall" : "No previous firewall";
    }
  }

  function recordFwMapDotCenter(map, row) {
    const id = fwMapStableRowId(row);
    if (!id) return;
    if (map === dashFwMap) {
      if (fwDashMapLastCenteredId && fwDashMapLastCenteredId !== id) {
        fwDashMapCenterPastIds.push(fwDashMapLastCenteredId);
      }
      fwDashMapLastCenteredId = id;
    } else if (map === panelFwMap) {
      if (fwPanelMapLastCenteredId && fwPanelMapLastCenteredId !== id) {
        fwPanelMapCenterPastIds.push(fwPanelMapLastCenteredId);
      }
      fwPanelMapLastCenteredId = id;
    } else {
      return;
    }
    updateFwMapBackNavUi();
  }

  function fwMapBackNavGo(map) {
    if (typeof L === "undefined" || !map) return;
    const past =
      map === dashFwMap ? fwDashMapCenterPastIds : map === panelFwMap ? fwPanelMapCenterPastIds : null;
    if (!past || past.length === 0) return;
    let row = null;
    let id = null;
    while (past.length > 0 && !row) {
      id = past.pop();
      row =
        map === dashFwMap ? findFwRowByIdForDashMap(id) : map === panelFwMap ? findFwRowByIdForPanelMap(id) : null;
      if (row && !fwRowMapLatLng(row)) row = null;
    }
    updateFwMapBackNavUi();
    if (!row || !id) return;
    hideFwMapHoverPortalNow();
    const ll = fwRowMapLatLng(row);
    map.panTo(L.latLng(ll.lat, ll.lon), { animate: true, duration: 0.45, easeLinearity: 0.22 });
    if (map === dashFwMap) fwDashMapLastCenteredId = id;
    else if (map === panelFwMap) fwPanelMapLastCenteredId = id;
  }

  function initFwMapBackNavigation() {
    const dashBtn = document.getElementById("dash-fw-map-back");
    const panelBtn = document.getElementById("panel-fw-map-back");
    if (dashBtn && !dashBtn.dataset.fwBackNavWired) {
      dashBtn.dataset.fwBackNavWired = "1";
      dashBtn.addEventListener("click", () => fwMapBackNavGo(dashFwMap));
    }
    if (panelBtn && !panelBtn.dataset.fwBackNavWired) {
      panelBtn.dataset.fwBackNavWired = "1";
      panelBtn.addEventListener("click", () => fwMapBackNavGo(panelFwMap));
    }
    updateFwMapBackNavUi();
  }

  function attachFwMapMarkerClickToCenter(map, marker) {
    if (!map || !marker) return;
    marker.on("click", (ev) => {
      if (ev && ev.originalEvent) {
        L.DomEvent.stopPropagation(ev.originalEvent);
      }
      const row = marker.fwRow;
      const ll = row ? fwRowMapLatLng(row) : null;
      if (!ll) return;
      hideFwMapHoverPortalNow();
      recordFwMapDotCenter(map, row);
      map.panTo(L.latLng(ll.lat, ll.lon), { animate: true, duration: 0.45, easeLinearity: 0.22 });
    });
  }

  function countFwRowsWithMapCoords(rows) {
    let n = 0;
    for (const row of rows) {
      if (fwRowMapLatLng(row)) n++;
    }
    return n;
  }

  function updatePanelFwMapShowingLabel(panelRows) {
    const el = document.getElementById("panel-fw-map-count");
    if (!el) return;
    const rows =
      panelRows ||
      (typeof fwController !== "undefined" && fwController?.getFullFilteredRows
        ? fwController.getFullFilteredRows()
        : fwPrepared);
    const n = countFwRowsWithMapCoords(rows);
    el.textContent = n === 1 ? "Showing 1 firewall" : `Showing ${n} firewalls`;
  }

  function refreshFwMapMarkers(opts) {
    const refit = opts?.refit !== false;
    const panelRows =
      typeof fwController !== "undefined" && fwController?.getFullFilteredRows
        ? fwController.getFullFilteredRows()
        : fwPrepared;
    updatePanelFwMapShowingLabel(panelRows);
    if (typeof L === "undefined") return;
    if (!refit) {
      const dSig = fwMapMarkerDataSignature(fwPrepared);
      const pSig = fwMapMarkerDataSignature(panelRows);
      if (dSig === _lastFwDashMapMarkerSig && pSig === _lastFwPanelMapMarkerSig) {
        return;
      }
    }
    hideFwMapHoverPortalNow();
    initDashFwMapIfNeeded();
    initPanelFwMapIfNeeded();
    if (dashFwLayer) dashFwLayer.clearLayers();
    if (panelFwLayer) panelFwLayer.clearLayers();
    if (dashFwClusterLayer) dashFwClusterLayer.clearLayers();
    if (panelFwClusterLayer) panelFwClusterLayer.clearLayers();
    if (dashFwEdgeLayer) dashFwEdgeLayer.clearLayers();
    if (panelFwEdgeLayer) panelFwEdgeLayer.clearLayers();
    fwPrepared.forEach((row) => {
      const pos = fwRowMapLatLng(row);
      if (!pos) return;
      const ll = [pos.lat, pos.lon];
      const html = buildFwMapTooltipHtml(row);
      const icon = fwMapMarkerIconForRow(row);
      if (dashFwLayer) {
        const m = L.marker(ll, { icon }).addTo(dashFwLayer);
        m.fwRow = row;
        attachFwMapMarkerHoverCard(dashFwMap, m, html);
        attachFwMapMarkerClickToCenter(dashFwMap, m);
      }
    });
    panelRows.forEach((row) => {
      const pos = fwRowMapLatLng(row);
      if (!pos) return;
      const ll = [pos.lat, pos.lon];
      const html = buildFwMapTooltipHtml(row);
      const icon = fwMapMarkerIconForRow(row);
      if (panelFwLayer) {
        const m2 = L.marker(ll, { icon }).addTo(panelFwLayer);
        m2.fwRow = row;
        attachFwMapMarkerHoverCard(panelFwMap, m2, html);
        attachFwMapMarkerClickToCenter(panelFwMap, m2);
      }
    });
    if (refit) {
      applySavedFwMapViewOrFit(dashFwMap, FW_MAP_VIEW_KEY_DASH);
      applySavedFwMapViewOrFit(panelFwMap, FW_MAP_VIEW_KEY_PANEL, panelRows);
    }
    fwMapSyncMarkerLayers(dashFwMap, dashFwEdgeLayer, dashFwClusterLayer, dashFwLayer);
    fwMapSyncMarkerLayers(panelFwMap, panelFwEdgeLayer, panelFwClusterLayer, panelFwLayer);
    _lastFwDashMapMarkerSig = fwMapMarkerDataSignature(fwPrepared);
    _lastFwPanelMapMarkerSig = fwMapMarkerDataSignature(panelRows);
    // Leaflet often renders a blank tile layer if init ran before the container had its
    // final size; invalidateSize after updates matches tab-switch and map-toggle behavior.
    invalidateFwMapSizes();
  }

  function readFwMapSectionCollapsed(storageKey) {
    try {
      return localStorage.getItem(storageKey) === "1";
    } catch {
      return false;
    }
  }

  function writeFwMapSectionCollapsed(storageKey, collapsed) {
    try {
      localStorage.setItem(storageKey, collapsed ? "1" : "0");
    } catch {
      /* ignore */
    }
  }

  function initFwMapSectionToggles() {
    const pairs = [
      { wrap: "dash-fw-map-wrap", btn: "dash-fw-map-toggle", key: "sophos-central-fw-map-dash-collapsed" },
      { wrap: "panel-fw-map-wrap", btn: "panel-fw-map-toggle", key: "sophos-central-fw-map-panel-collapsed" },
    ];
    pairs.forEach(({ wrap, btn, key }) => {
      const w = document.getElementById(wrap);
      const b = document.getElementById(btn);
      if (!w || !b) return;
      const collapsed = readFwMapSectionCollapsed(key);
      if (collapsed) {
        w.classList.add("fw-map-section--collapsed");
        b.setAttribute("aria-expanded", "false");
      }
      b.addEventListener("click", () => {
        const willCollapse = !w.classList.contains("fw-map-section--collapsed");
        w.classList.toggle("fw-map-section--collapsed", willCollapse);
        b.setAttribute("aria-expanded", willCollapse ? "false" : "true");
        writeFwMapSectionCollapsed(key, willCollapse);
        invalidateFwMapSizes();
        if (!willCollapse) {
          requestAnimationFrame(() => {
            refreshFwMapMarkers();
          });
        }
      });
    });
  }

  function destroyFwLocPickMap() {
    if (fwLocPickMap) {
      fwLocPickMap.remove();
      fwLocPickMap = null;
      fwLocPickMarker = null;
    }
  }

  function syncFwLocInputsFromMarker() {
    if (!fwLocPickMarker) return;
    const ll = fwLocPickMarker.getLatLng();
    const latEl = document.getElementById("fw-location-lat");
    const lonEl = document.getElementById("fw-location-lon");
    if (latEl) latEl.value = ll.lat.toFixed(6);
    if (lonEl) lonEl.value = ll.lng.toFixed(6);
  }

  function ensureFwLocPickMap(lat0, lng0) {
    const el = document.getElementById("fw-location-pick-map");
    if (!el || typeof L === "undefined") return;
    destroyFwLocPickMap();
    const lat = Number.isFinite(lat0) ? lat0 : 20;
    const lng = Number.isFinite(lng0) ? lng0 : 0;
    const z = Number.isFinite(lat0) && Number.isFinite(lng0) ? 12 : 2;
    fwLocPickMap = L.map(el, { scrollWheelZoom: true });
    attachFwBaseTileLayer(fwLocPickMap);
    fwLocPickMarker = L.marker([lat, lng], { draggable: true }).addTo(fwLocPickMap);
    fwLocPickMap.setView([lat, lng], z);
    fwLocPickMap.on("click", (e) => {
      fwLocPickMarker.setLatLng(e.latlng);
      syncFwLocInputsFromMarker();
    });
    fwLocPickMarker.on("dragend", syncFwLocInputsFromMarker);
  }

  function closeFwLocationModal() {
    const m = document.getElementById("fw-location-modal");
    if (!m || m.hidden) return;
    if (fwLocSuggestTimer) {
      clearTimeout(fwLocSuggestTimer);
      fwLocSuggestTimer = null;
    }
    destroyFwLocPickMap();
    m.hidden = true;
    m.setAttribute("aria-hidden", "true");
    document.body.style.overflow = "";
    fwLocEditingId = null;
    if (fwLocModalFocusBefore && typeof fwLocModalFocusBefore.focus === "function") {
      fwLocModalFocusBefore.focus();
    }
    fwLocModalFocusBefore = null;
  }

  async function openFwLocationModal(firewallId) {
    const m = document.getElementById("fw-location-modal");
    const titleEl = document.getElementById("fw-location-modal-title");
    const addrEl = document.getElementById("fw-location-address");
    const latEl = document.getElementById("fw-location-lat");
    const lonEl = document.getElementById("fw-location-lon");
    const stEl = document.getElementById("fw-location-modal-status");
    const sugEl = document.getElementById("fw-location-suggestions");
    if (!m || !titleEl || !addrEl || !latEl || !lonEl || !firewallId) return;
    const row = fwPrepared.find((r) => r._id === firewallId);
    if (!row) return;
    fwLocModalFocusBefore = document.activeElement;
    fwLocEditingId = firewallId;
    m.hidden = false;
    m.setAttribute("aria-hidden", "false");
    document.body.style.overflow = "hidden";
    titleEl.textContent = row.has_location === 1 ? "Change firewall location" : "Set firewall location";
    addrEl.value = "";
    let la = row.geo_lat;
    let lo = row.geo_lon;
    if (row.has_location !== 1) {
      la = null;
      lo = null;
      const hint = fwRowMapLatLng(row);
      if (hint) {
        la = hint.lat;
        lo = hint.lon;
      } else if (row.first_external_ipv4) {
        const g = await fetchGeoipForIPv4(row.first_external_ipv4);
        if (fwLocEditingId === firewallId && g) {
          la = g.lat;
          lo = g.lon;
          fwMapGeoipGuess.set(row._id, g);
          refreshFwMapMarkers({ refit: false });
        }
      }
    }
    latEl.value = la != null ? String(la) : "";
    lonEl.value = lo != null ? String(lo) : "";
    if (stEl) stEl.textContent = "";
    if (sugEl) {
      sugEl.hidden = true;
      sugEl.innerHTML = "";
    }
    document.getElementById("fw-location-modal-close")?.focus();
    requestAnimationFrame(() => {
      if (fwLocEditingId !== firewallId) return;
      ensureFwLocPickMap(la != null ? la : null, lo != null ? lo : null);
      invalidateFwMapSizes();
    });
  }

  function renderFwLocSuggestions(results) {
    const sugEl = document.getElementById("fw-location-suggestions");
    if (!sugEl) return;
    sugEl.innerHTML = "";
    if (!results.length) {
      sugEl.hidden = true;
      return;
    }
    results.forEach((r, idx) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "fw-location-suggest-item";
      btn.setAttribute("role", "option");
      btn.id = `fw-loc-sug-${idx}`;
      btn.textContent = r.display_name || `${r.lat}, ${r.lon}`;
      btn.addEventListener("click", () => {
        const lat = Number(r.lat);
        const lon = Number(r.lon);
        const addrEl = document.getElementById("fw-location-address");
        if (addrEl && r.display_name) addrEl.value = r.display_name;
        const latEl = document.getElementById("fw-location-lat");
        const lonEl = document.getElementById("fw-location-lon");
        if (latEl) latEl.value = Number.isFinite(lat) ? String(lat) : "";
        if (lonEl) lonEl.value = Number.isFinite(lon) ? String(lon) : "";
        if (fwLocPickMarker && Number.isFinite(lat) && Number.isFinite(lon)) {
          fwLocPickMarker.setLatLng([lat, lon]);
          fwLocPickMap?.setView([lat, lon], 14);
        }
        sugEl.hidden = true;
        sugEl.innerHTML = "";
      });
      sugEl.appendChild(btn);
    });
    sugEl.hidden = false;
  }

  function initFwLocationModal() {
    const m = document.getElementById("fw-location-modal");
    const addrEl = document.getElementById("fw-location-address");
    if (!m || !addrEl) return;
    m.querySelector(".fw-location-modal__backdrop")?.addEventListener("click", closeFwLocationModal);
    document.getElementById("fw-location-modal-close")?.addEventListener("click", closeFwLocationModal);
    document.getElementById("fw-location-cancel")?.addEventListener("click", closeFwLocationModal);
    m.addEventListener("keydown", (e) => {
      if (e.key === "Escape") closeFwLocationModal();
    });
    addrEl.addEventListener("input", () => {
      if (fwLocSuggestTimer) clearTimeout(fwLocSuggestTimer);
      const sugEl = document.getElementById("fw-location-suggestions");
      if (sugEl) {
        sugEl.hidden = true;
        sugEl.innerHTML = "";
      }
      const q = addrEl.value.trim();
      if (q.length < 3) return;
      fwLocSuggestTimer = setTimeout(async () => {
        try {
          const data = await loadJson(`/api/geocode/search?q=${encodeURIComponent(q)}&limit=8`);
          renderFwLocSuggestions(Array.isArray(data.results) ? data.results : []);
        } catch {
          /* ignore */
        }
      }, 450);
    });
    document.getElementById("fw-location-save")?.addEventListener("click", async () => {
      const stEl = document.getElementById("fw-location-modal-status");
      const addr = (document.getElementById("fw-location-address")?.value || "").trim();
      const latStr = (document.getElementById("fw-location-lat")?.value || "").trim();
      const lonStr = (document.getElementById("fw-location-lon")?.value || "").trim();
      if (!fwLocEditingId) return;
      let payload;
      if (addr) {
        payload = { address: addr };
      } else {
        const lat = parseFloat(latStr);
        const lon = parseFloat(lonStr);
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
          if (stEl) stEl.textContent = "Enter a street address or both latitude and longitude.";
          return;
        }
        payload = { latitude: lat, longitude: lon };
      }
      if (stEl) stEl.textContent = "Saving…";
      try {
        await apiRequestJson(`/api/firewalls/${encodeURIComponent(fwLocEditingId)}/location`, {
          method: "PATCH",
          body: JSON.stringify(payload),
        });
        const savedFwIdForGuess = fwLocEditingId;
        if (savedFwIdForGuess) fwMapGeoipGuess.delete(savedFwIdForGuess);
        const updated = await loadJson("/api/firewalls");
        fwRaw = updated;
        fwPrepared = fwRaw.map(prepareFirewall);
        applyFirewallRecencyTags(fwPrepared);
        buildFirewallFilters();
        finalizeFwPreparedState();
        fwController.render();
        refreshFwMapMarkers();
        const savedFwId = fwLocEditingId;
        closeFwLocationModal();
        if (savedFwId && fwDetailFlyoutOpenId === savedFwId) {
          refreshFwDetailFlyoutVisuals();
        }
      } catch (err) {
        if (stEl) stEl.textContent = err.message || "Could not save location.";
      }
    });
  }

  function fwConnectivitySegmentClass(c) {
    if (c === true) return "fw-conn-chart__seg fw-conn-chart__seg--up";
    if (c === false) return "fw-conn-chart__seg fw-conn-chart__seg--down";
    return "fw-conn-chart__seg fw-conn-chart__seg--unk";
  }

  function renderFwConnectivityChartHtml(data) {
    const host = document.getElementById("fw-detail-connectivity-body");
    if (!host) return;
    const segments = Array.isArray(data.segments) ? data.segments : [];
    const winStart = data.window_start ? Date.parse(data.window_start) : NaN;
    const winEnd = data.window_end ? Date.parse(data.window_end) : NaN;
    if (!Number.isFinite(winStart) || !Number.isFinite(winEnd) || winEnd <= winStart) {
      host.innerHTML = '<p class="muted">Could not build connectivity timeline.</p>';
      return;
    }
    const span = winEnd - winStart;
    const VB_W = 1000;
    const VB_H = 52;
    const padY = 10;
    const barH = VB_H - padY * 2;
    const eventCount = Number(data.event_count) || 0;

    if (segments.length === 0) {
      host.innerHTML =
        '<p class="muted">No connectivity history in sync change logs yet. History appears after Central sync records firewall inserts or connection state changes.</p>';
      return;
    }

    function xAt(ms) {
      return ((ms - winStart) / span) * VB_W;
    }

    const rects = [];
    for (const seg of segments) {
      const s = Date.parse(seg.start);
      const e = Date.parse(seg.end);
      if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) continue;
      const x0 = Math.min(VB_W, Math.max(0, xAt(s)));
      const x1 = Math.min(VB_W, Math.max(0, xAt(e)));
      const w = Math.max(0.35, x1 - x0);
      rects.push(
        `<rect class="${fwConnectivitySegmentClass(seg.connected)}" x="${x0.toFixed(2)}" y="${padY}" width="${w.toFixed(
          2
        )}" height="${barH}" rx="2" />`
      );
    }

    const startLabel = escapeHtml(new Date(winStart).toLocaleDateString());
    const endLabel = escapeHtml(new Date(winEnd).toLocaleDateString());
    const ariaSummary = `Last ${Number(data.days) || 30} days from ${data.window_start || ""} to ${
      data.window_end || ""
    }; ${eventCount} sync change rows for this firewall.`;
    host.innerHTML = `<div class="fw-detail-flyout__connectivity-chart">
      <svg viewBox="0 0 ${VB_W} ${VB_H}" preserveAspectRatio="none" role="img" aria-label="${escapeAttr(ariaSummary)}">
        ${rects.join("")}
      </svg>
      <div class="fw-detail-flyout__connectivity-legend" aria-hidden="true">
        <span><span class="fw-detail-flyout__connectivity-swatch fw-detail-flyout__connectivity-swatch--up"></span>Connected</span>
        <span><span class="fw-detail-flyout__connectivity-swatch fw-detail-flyout__connectivity-swatch--down"></span>Not connected</span>
        <span><span class="fw-detail-flyout__connectivity-swatch fw-detail-flyout__connectivity-swatch--unk"></span>Unknown</span>
      </div>
      <div class="fw-conn-chart__axis" style="display:flex;justify-content:space-between;margin-top:4px;">
        <span>${startLabel}</span><span>${endLabel}</span>
      </div>
    </div>`;
  }

  async function loadFwDetailFlyoutConnectivity(fwId) {
    const host = document.getElementById("fw-detail-connectivity-body");
    if (!host) return;
    try {
      const data = await loadJson(
        `/api/firewalls/${encodeURIComponent(fwId)}/connectivity-history?days=30`
      );
      renderFwConnectivityChartHtml(data);
    } catch {
      host.innerHTML = '<p class="muted">Could not load connectivity history.</p>';
    }
  }

  function destroyFwDetailFlyoutMap() {
    if (fwDetailFlyoutMap) {
      fwDetailFlyoutMap.remove();
      fwDetailFlyoutMap = null;
      fwDetailFlyoutMapMarker = null;
    }
  }

  function ensureFwDetailFlyoutMap(row) {
    const mapEl = document.getElementById("fw-detail-flyout-map");
    const ph = document.getElementById("fw-detail-flyout-map-placeholder");
    if (!mapEl) return;
    const pos = row ? fwRowMapLatLng(row) : null;
    const lat = pos?.lat;
    const lng = pos?.lon;
    if (lat == null || lng == null || typeof L === "undefined") {
      destroyFwDetailFlyoutMap();
      mapEl.innerHTML = "";
      mapEl.hidden = true;
      if (ph) ph.hidden = false;
      return;
    }
    if (ph) ph.hidden = true;
    mapEl.hidden = false;
    destroyFwDetailFlyoutMap();
    fwDetailFlyoutMap = L.map(mapEl, fwMapBaseOptions());
    attachFwBaseTileLayer(fwDetailFlyoutMap);
    fwDetailFlyoutMapMarker = L.marker([lat, lng], {
      icon: fwMapMarkerIconForRow(row),
    }).addTo(fwDetailFlyoutMap);
    fwDetailFlyoutMap.setView([lat, lng], 11, { animate: false });
    requestAnimationFrame(() => {
      fwDetailFlyoutMap?.invalidateSize({ animate: false });
    });
  }

  function refreshFwDetailFlyoutVisuals() {
    if (!fwDetailFlyoutOpenId) return;
    const row = fwPrepared.find((r) => r._id === fwDetailFlyoutOpenId);
    if (!row) return;
    const titleEl = document.getElementById("fw-detail-flyout-title");
    if (titleEl) titleEl.textContent = row.hostname || row.firewall_name || "Firewall";
    const cardEl = document.getElementById("fw-detail-flyout-card");
    if (cardEl) cardEl.innerHTML = buildFwMapCardHtml(row, { forFlyout: true });
    const link = document.getElementById("fw-detail-flyout-loc-link");
    if (link) {
      link.textContent = row.has_location === 1 ? "Change location" : "Set location";
    }
    const fwBanner = document.getElementById("fw-detail-flyout-firmware-banner");
    if (fwBanner) {
      if (fwPreparedRowHasFirmwareUpgrade(row)) {
        fwBanner.hidden = false;
        fwBanner.innerHTML = `<span class="fw-detail-flyout__firmware-banner-icon" aria-hidden="true">${firewallFirmwareUpgradeIconSvg()}</span><div class="fw-detail-flyout__firmware-banner-main"><p class="fw-detail-flyout__firmware-banner-msg">A firmware update is available.</p><button type="button" class="cell-link fw-detail-flyout__firmware-update-btn" data-fw-id="${escapeHtml(row._id)}">Update</button></div>`;
      } else {
        fwBanner.hidden = true;
        fwBanner.innerHTML = "";
      }
    }
    const syncSuspendBanner = document.getElementById("fw-detail-flyout-sync-suspend-banner");
    if (syncSuspendBanner) {
      const showSyncSuspend = row.has_group_sync_status === 1 && row.group_sync_status_suspended === 1;
      if (showSyncSuspend) {
        syncSuspendBanner.hidden = false;
        const msg = "This firewall is suspended from a sync issue.";
        syncSuspendBanner.innerHTML = `<span class="fw-detail-flyout__sync-suspend-banner-icon" aria-hidden="true">${firewallGroupSyncIconSvg()}</span><div class="fw-detail-flyout__sync-suspend-banner-main"><p class="fw-detail-flyout__sync-suspend-banner-msg">${escapeHtml(msg)}</p></div>`;
      } else {
        syncSuspendBanner.hidden = true;
        syncSuspendBanner.innerHTML = "";
      }
    }
    ensureFwDetailFlyoutMap(row);
    requestAnimationFrame(() => invalidateFwMapSizes());
  }

  async function loadFwDetailFlyoutAlerts(fwId) {
    const host = document.getElementById("fw-detail-panel-alerts");
    if (!host) return;
    host.innerHTML = '<p class="muted">Loading alerts…</p>';
    try {
      const data = await loadJson(
        `/api/alerts?firewall_id=${encodeURIComponent(fwId)}&page_size=200&page=1`
      );
      const items = Array.isArray(data.items) ? data.items : [];
      if (items.length === 0) {
        host.innerHTML = '<p class="muted">No alerts for this firewall.</p>';
        return;
      }
      const rows = items
        .map((a) => {
          const id = escapeHtml(a.id || "");
          const sev = severityClass(a.severity);
          const desc = escapeHtml(a.description || "—");
          const ra = escapeHtml(fmtDate(a.raised_at));
          return `<tr class="fw-detail-alert-row" tabindex="0" data-alert-id="${id}" aria-label="View alert details">
            <td><span class="${sev}">${escapeHtml(a.severity || "—")}</span></td>
            <td class="fw-detail-alert-row__desc" title="${escapeAttr(a.description || "")}">${desc}</td>
            <td class="muted">${ra}</td>
          </tr>`;
        })
        .join("");
      host.innerHTML = `<div class="table-scroll fw-detail-flyout__table-scroll"><table class="data-table data-table--dense fw-detail-flyout__alerts-table">
        <thead><tr><th scope="col">Severity</th><th scope="col">Description</th><th scope="col">Raised</th></tr></thead>
        <tbody>${rows}</tbody></table></div>`;
    } catch {
      host.innerHTML = '<p class="muted">Could not load alerts.</p>';
    }
  }

  async function loadFwDetailFlyoutSubscriptions(serial) {
    const host = document.getElementById("fw-detail-panel-subs");
    if (!host) return;
    if (!serial || serial === "—") {
      host.innerHTML =
        '<p class="muted">No serial number on this record; subscriptions are listed by license serial.</p>';
      return;
    }
    host.innerHTML = '<p class="muted">Loading subscriptions…</p>';
    try {
      const subs = await loadJson(`/api/license-subscriptions?serial=${encodeURIComponent(serial)}`);
      const list = Array.isArray(subs) ? subs : [];
      if (list.length === 0) {
        host.innerHTML = '<p class="muted">No subscriptions for this serial.</p>';
        return;
      }
      const rows = list
        .map((s) => {
          return `<tr><td>${escapeHtml(s.product_code || "—")}</td><td>${escapeHtml(s.product_name || "—")}</td><td>${escapeHtml(s.type || "—")}</td><td class="muted">${escapeHtml(s.start_date || "—")}</td><td class="muted">${escapeHtml(s.end_date || "—")}</td></tr>`;
        })
        .join("");
      host.innerHTML = `<div class="table-scroll fw-detail-flyout__table-scroll"><table class="data-table data-table--dense">
        <thead><tr><th>Code</th><th>Product</th><th>Type</th><th>Start</th><th>End</th></tr></thead>
        <tbody>${rows}</tbody></table></div>`;
    } catch {
      host.innerHTML = '<p class="muted">Could not load subscriptions.</p>';
    }
  }

  function fwDetailFlyoutActivateTab(which) {
    const tabA = document.getElementById("fw-detail-tab-alerts");
    const tabS = document.getElementById("fw-detail-tab-subs");
    const panelA = document.getElementById("fw-detail-panel-alerts");
    const panelS = document.getElementById("fw-detail-panel-subs");
    if (!tabA || !tabS || !panelA || !panelS) return;
    const showAlerts = which === "alerts";
    tabA.setAttribute("aria-selected", showAlerts ? "true" : "false");
    tabS.setAttribute("aria-selected", showAlerts ? "false" : "true");
    tabA.tabIndex = showAlerts ? 0 : -1;
    tabS.tabIndex = showAlerts ? -1 : 0;
    panelA.hidden = !showAlerts;
    panelS.hidden = showAlerts;
  }

  function closeFwDetailFlyout() {
    const backdrop = document.getElementById("fw-detail-flyout-backdrop");
    const panel = document.getElementById("fw-detail-flyout");
    destroyFwDetailFlyoutMap();
    fwDetailFlyoutOpenId = null;
    if (backdrop) backdrop.hidden = true;
    if (panel) {
      panel.hidden = true;
      panel.setAttribute("aria-hidden", "true");
    }
  }

  async function openFwDetailFlyout(fwId) {
    const row = fwPrepared.find((r) => r._id === fwId);
    if (!row) return;
    const backdrop = document.getElementById("fw-detail-flyout-backdrop");
    const panel = document.getElementById("fw-detail-flyout");
    if (!backdrop || !panel) return;
    fwDetailFlyoutOpenId = fwId;
    backdrop.hidden = false;
    panel.hidden = false;
    panel.setAttribute("aria-hidden", "false");
    const connBody = document.getElementById("fw-detail-connectivity-body");
    if (connBody) connBody.innerHTML = '<p class="muted">Loading…</p>';
    refreshFwDetailFlyoutVisuals();
    fwDetailFlyoutActivateTab("alerts");
    const serial = row.serial_number && row.serial_number !== "—" ? row.serial_number : "";
    await Promise.all([
      loadFwDetailFlyoutConnectivity(fwId),
      loadFwDetailFlyoutAlerts(fwId),
      loadFwDetailFlyoutSubscriptions(serial),
    ]);
    requestAnimationFrame(() => invalidateFwMapSizes());
    panel.querySelector(".flyout__close-btn")?.focus();
  }

  async function onFwDetailFlyoutEditName() {
    const id = fwDetailFlyoutOpenId;
    if (!id) return;
    const row = fwPrepared.find((r) => r._id === id);
    if (!row) return;
    const cur =
      row.firewall_name && row.firewall_name !== "—" ? row.firewall_name : "";
    const next = window.prompt("Firewall label (name in Sophos Central):", cur);
    if (next == null) return;
    const trimmed = String(next).trim();
    if (trimmed === "") {
      notifyAppUser("Label required", "Label cannot be empty.", "error");
      return;
    }
    if (trimmed === cur) return;
    try {
      await apiRequestJson(`/api/firewalls/${encodeURIComponent(id)}/label`, {
        method: "PATCH",
        body: JSON.stringify({ name: trimmed }),
      });
      const updated = await loadJson("/api/firewalls");
      fwRaw = updated;
      fwPrepared = fwRaw.map(prepareFirewall);
      applyFirewallRecencyTags(fwPrepared);
      buildFirewallFilters();
      finalizeFwPreparedState();
      fwController.render();
      refreshFwMapMarkers({ refit: false });
      refreshFwDetailFlyoutVisuals();
    } catch (err) {
      notifyAppUser("Could not update label", err.message || "Could not update label.", "error");
    }
  }

  function initFwDetailFlyout() {
    const backdrop = document.getElementById("fw-detail-flyout-backdrop");
    const panel = document.getElementById("fw-detail-flyout");
    const locLink = document.getElementById("fw-detail-flyout-loc-link");
    if (!backdrop || !panel) return;
    backdrop.addEventListener("click", closeFwDetailFlyout);
    panel.querySelector(".flyout__close-btn")?.addEventListener("click", closeFwDetailFlyout);
    panel.addEventListener("keydown", (e) => {
      if (e.key === "Escape") closeFwDetailFlyout();
    });
    locLink?.addEventListener("click", () => {
      const id = fwDetailFlyoutOpenId;
      if (id) openFwLocationModal(id).catch(console.error);
    });
    panel.addEventListener("click", (e) => {
      const fwUpBtn = e.target.closest("button.fw-detail-flyout__firmware-update-btn");
      if (fwUpBtn && panel.contains(fwUpBtn)) {
        e.preventDefault();
        const fwId = fwUpBtn.getAttribute("data-fw-id") || fwDetailFlyoutOpenId;
        if (!fwId) return;
        closeFwDetailFlyout();
        openFwFirmwareBatchModal({ firewallIds: [fwId] }).catch(console.error);
        return;
      }
      const edit = e.target.closest("[data-fw-flyout-edit-name]");
      if (edit && panel.contains(edit)) {
        e.preventDefault();
        onFwDetailFlyoutEditName().catch(console.error);
        return;
      }
      const tr = e.target.closest("tr.fw-detail-alert-row[data-alert-id]");
      if (tr && panel.contains(tr)) {
        const aid = tr.getAttribute("data-alert-id");
        if (aid) openAlertFlyout(aid).catch(console.error);
      }
    });
    panel.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      const tr = e.target.closest("tr.fw-detail-alert-row[data-alert-id]");
      if (!tr || !panel.contains(tr)) return;
      e.preventDefault();
      const aid = tr.getAttribute("data-alert-id");
      if (aid) openAlertFlyout(aid).catch(console.error);
    });
    const tabA = document.getElementById("fw-detail-tab-alerts");
    const tabS = document.getElementById("fw-detail-tab-subs");
    tabA?.addEventListener("click", () => fwDetailFlyoutActivateTab("alerts"));
    tabS?.addEventListener("click", () => fwDetailFlyoutActivateTab("subs"));
  }

  function distinctValues(rows, key, limit = 60) {
    const set = new Set();
    rows.forEach((r) => {
      const v = r[key];
      const s = v == null || v === "" ? "—" : String(v);
      set.add(s);
    });
    return Array.from(set).sort((a, b) => a.localeCompare(b)).slice(0, limit);
  }

  const FW_FACET_SEARCH_KEYS = new Set(["hostname", "serial_number"]);

  /** Status facet options (prepareFirewall labels); always listed so Pending approval is available even with zero matching rows. */
  const FW_STATUS_FACET_PRESETS = ["Connected", "Offline", "Suspended", "Pending approval"];

  function fwFacetSearchPlaceholder(key) {
    if (key === "hostname") return "Search host names…";
    if (key === "serial_number") return "Search serial numbers…";
    return "";
  }

  function fwFacetSearchAriaLabel(key) {
    if (key === "hostname") return "Filter host name list by search text";
    if (key === "serial_number") return "Filter serial number list by search text";
    return "Filter list by search text";
  }

  function applyFwFacetListSearchInput(inp) {
    const wrap = inp.closest(".filter-group");
    if (!wrap) return;
    const q = (inp.value || "").trim().toLowerCase();
    wrap.querySelectorAll(".filter-opt").forEach((lab) => {
      const cb = lab.querySelector('input[type="checkbox"][data-cat]');
      const text = (cb ? cb.value : lab.textContent || "").toLowerCase();
      lab.style.display = !q || text.includes(q) ? "" : "none";
    });
  }

  function clearFwFacetSearchInputs(host) {
    if (!host) return;
    host.querySelectorAll("input[data-fw-facet-search]").forEach((inp) => {
      inp.value = "";
      applyFwFacetListSearchInput(inp);
    });
  }

  function bindFwFacetSearchInputs(host) {
    host.querySelectorAll("input[data-fw-facet-search]").forEach((inp) => {
      const onChange = () => applyFwFacetListSearchInput(inp);
      inp.addEventListener("input", onChange);
      inp.addEventListener("search", onChange);
    });
  }

  function distinctFwGroupFacetValues(enriched) {
    const set = new Set();
    let hasEmpty = false;
    enriched.forEach((r) => {
      const leaves = r.fw_group_facet_values;
      if (!Array.isArray(leaves) || !leaves.length) hasEmpty = true;
      else leaves.forEach((l) => set.add(String(l)));
    });
    if (hasEmpty) set.add("—");
    return Array.from(set).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" })).slice(0, 80);
  }

  /** Toolbar tenant multiselect (same UX as dashboard alerts); `prefix` builds ids `{prefix}-tenant-ms`, etc. */
  function createToolbarTenantMultiselect({ prefix, getTenantSet, getDataRows, onChange }) {
    function optionNames() {
      const rows = getDataRows() || [];
      const fromData = new Set();
      for (const r of rows) {
        const v = r.tenant_name;
        fromData.add(v == null || v === "" ? "—" : String(v));
      }
      const merged = new Set(fromData);
      getTenantSet().forEach((t) => merged.add(String(t)));
      return [...merged].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
    }

    function updateSummary() {
      const sumEl = document.getElementById(`${prefix}-tenant-ms-summary`);
      const clearBtn = document.getElementById(`${prefix}-tenant-ms-clear`);
      if (!sumEl) return;
      const set = getTenantSet();
      const n = set.size;
      if (n === 0) {
        sumEl.textContent = "All tenants";
        if (clearBtn) clearBtn.hidden = true;
        return;
      }
      if (clearBtn) clearBtn.hidden = false;
      if (n === 1) {
        const one = [...set][0];
        sumEl.textContent = one.length > 42 ? `${one.slice(0, 39)}…` : one;
        return;
      }
      sumEl.textContent = `${n} tenants`;
    }

    function applySearch() {
      const inp = document.getElementById(`${prefix}-tenant-ms-search`);
      const list = document.getElementById(`${prefix}-tenant-ms-list`);
      if (!inp || !list) return;
      const q = (inp.value || "").trim().toLowerCase();
      list.querySelectorAll(".da-tenant-ms__opt").forEach((row) => {
        const t = (row.getAttribute("data-tenant-label") || "").toLowerCase();
        row.style.display = !q || t.includes(q) ? "" : "none";
      });
    }

    function setOpen(open) {
      const panel = document.getElementById(`${prefix}-tenant-ms-panel`);
      const trig = document.getElementById(`${prefix}-tenant-ms-trigger`);
      if (!panel || !trig) return;
      panel.hidden = !open;
      trig.setAttribute("aria-expanded", open ? "true" : "false");
      trig.classList.toggle("is-open", open);
      if (open) {
        const s = document.getElementById(`${prefix}-tenant-ms-search`);
        if (s) {
          s.value = "";
          applySearch();
          queueMicrotask(() => s.focus());
        }
      }
    }

    function refresh() {
      const list = document.getElementById(`${prefix}-tenant-ms-list`);
      if (!list) return;
      const names = optionNames();
      const maxOpts = 200;
      const slice = names.slice(0, maxOpts);
      const set = getTenantSet();
      list.innerHTML = slice
        .map(
          (name) => `
      <label class="da-tenant-ms__opt" data-tenant-label="${escapeAttr(name)}">
        <input type="checkbox" class="da-tenant-ms__cb" value="${escapeAttr(name)}" />
        <span class="da-tenant-ms__opt-text">${escapeHtml(name)}</span>
      </label>`
        )
        .join("");
      if (names.length > maxOpts) {
        list.insertAdjacentHTML(
          "beforeend",
          `<p class="da-tenant-ms__cap muted">Showing first ${maxOpts} of ${names.length} tenants. Refine filters to narrow the list.</p>`
        );
      }
      list.querySelectorAll(".da-tenant-ms__cb").forEach((cb) => {
        cb.checked = set.has(cb.value);
        cb.addEventListener("change", () => {
          if (cb.checked) set.add(cb.value);
          else set.delete(cb.value);
          updateSummary();
          schedulePersistUiState();
          onChange();
        });
      });
      updateSummary();
      applySearch();
    }

    let inited = false;
    function init() {
      if (inited) return;
      inited = true;
      const root = document.getElementById(`${prefix}-tenant-ms`);
      const trig = document.getElementById(`${prefix}-tenant-ms-trigger`);
      const panel = document.getElementById(`${prefix}-tenant-ms-panel`);
      const clearBtn = document.getElementById(`${prefix}-tenant-ms-clear`);
      const searchInp = document.getElementById(`${prefix}-tenant-ms-search`);
      if (!root || !trig || !panel) return;

      trig.addEventListener("click", (e) => {
        e.stopPropagation();
        setOpen(panel.hidden);
      });

      clearBtn?.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (getTenantSet().size === 0) return;
        getTenantSet().clear();
        refresh();
        setOpen(false);
        schedulePersistUiState();
        onChange();
      });

      searchInp?.addEventListener("input", () => applySearch());
      searchInp?.addEventListener("search", () => applySearch());

      searchInp?.addEventListener("keydown", (e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          setOpen(false);
          trig.focus();
        }
      });

      const rootId = `${prefix}-tenant-ms`;
      document.addEventListener(
        "pointerdown",
        (e) => {
          if (panel.hidden) return;
          if (e.target.closest(`#${rootId}`)) return;
          setOpen(false);
        },
        true
      );

      document.addEventListener("keydown", (e) => {
        if (e.key !== "Escape") return;
        if (panel.hidden) return;
        setOpen(false);
        trig.focus();
      });
    }

    return { refresh, init, setOpen };
  }

  const fwToolbarTenantMs = createToolbarTenantMultiselect({
    prefix: "fw",
    getTenantSet: () => {
      if (!(fwFilterState.tenant_name instanceof Set)) fwFilterState.tenant_name = new Set();
      return fwFilterState.tenant_name;
    },
    getDataRows: () => fwPrepared,
    onChange: () => {
      fwController.render();
      updateFirewallFiltersChrome();
      renderOperationsView();
    },
  });

  const opsToolbarTenantMs = createToolbarTenantMultiselect({
    prefix: "ops",
    getTenantSet: () => {
      if (!(fwFilterState.tenant_name instanceof Set)) fwFilterState.tenant_name = new Set();
      return fwFilterState.tenant_name;
    },
    getDataRows: () => fwPrepared,
    onChange: () => {
      fwController.render();
      updateFirewallFiltersChrome();
      renderOperationsView();
    },
  });

  function getFirewallFilterHosts() {
    return ["firewall-filters", "ops-firewall-filters"]
      .map((id) => document.getElementById(id))
      .filter(Boolean);
  }

  function bindFirewallFilterHostEvents(host) {
    if (!host) return;
    host.querySelectorAll(".filter-group__head").forEach((btn) => {
      btn.addEventListener("click", () => {
        const g = btn.closest(".filter-group");
        g.classList.toggle("is-open");
        btn.setAttribute("aria-expanded", g.classList.contains("is-open"));
      });
    });
    host.querySelectorAll('input[type="checkbox"][data-cat]').forEach((cb) => {
      cb.addEventListener("change", () => {
        const cat = cb.dataset.cat;
        const st = fwFilterState[cat];
        if (!st) return;
        if (cb.checked) st.add(cb.value);
        else st.delete(cb.value);
        fwController.render();
        renderOperationsView();
        schedulePersistUiState();
      });
    });
    bindFwFacetSearchInputs(host);
  }

  function buildFirewallFilters() {
    fwFilterState.tenant_name = new Set();
    const hosts = getFirewallFilterHosts();
    const primary = document.getElementById("firewall-filters");
    if (!primary && hosts.length === 0) return;
    const groups = [
      { key: "status", label: "Status" },
      { key: "group_name", label: "Group" },
      { key: "hostname", label: "Host name" },
      { key: "serial_number", label: "Serial number" },
      { key: "model", label: "Model" },
      { key: "firmware_version", label: "Firmware" },
      { key: "firmware_update", label: "Firmware updates", useFirmwareCatalog: true },
      { key: "connected_label", label: "Connected" },
      { key: "suspended_label", label: "Suspended" },
      { key: "external_ips", label: "External IPs" },
    ];

    const enriched = fwPrepared.map((r) => ({
      ...r,
      connected_label: yesNo(r.connected),
      suspended_label: yesNo(r.suspended),
    }));

    const innerHtml = groups
      .map((g, idx) => {
        const opts = g.useFirmwareCatalog
          ? [...fwFirmwareVersionCatalog]
            .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }))
            .concat("None")
          : g.key === "status"
            ? (() => {
                const fromData = distinctValues(enriched, g.key, 80);
                const merged = [...FW_STATUS_FACET_PRESETS];
                for (const v of fromData) {
                  if (!merged.includes(v)) merged.push(v);
                }
                return merged;
              })()
            : g.key === "group_name"
              ? distinctFwGroupFacetValues(enriched)
              : distinctValues(enriched, g.key, 80);
        fwFilterState[g.key] = new Set();
        const open = idx < 3 ? "is-open" : "";
        const optsHtml = opts
          .map(
            (o) => `
          <label class="filter-opt">
            <input type="checkbox" data-cat="${escapeHtml(g.key)}" value="${escapeHtml(o)}" />
            <span>${escapeHtml(o)}</span>
          </label>`
          )
          .join("");
        const facetSearch =
          FW_FACET_SEARCH_KEYS.has(g.key) &&
          `<div class="filter-group__facet-search">
            <input type="search" class="filter-group__facet-search-input" autocomplete="off"
              data-fw-facet-search="${escapeHtml(g.key)}"
              placeholder="${escapeHtml(fwFacetSearchPlaceholder(g.key))}"
              aria-label="${escapeHtml(fwFacetSearchAriaLabel(g.key))}" />
          </div>`;
        return `
        <div class="filter-group ${open}" data-cat-wrap="${escapeHtml(g.key)}">
          <button type="button" class="filter-group__head" aria-expanded="${idx < 3}">
            <span>${escapeHtml(g.label)}</span>
            <span class="filter-group__chev">▼</span>
          </button>
          <div class="filter-group__body">${facetSearch || ""}${optsHtml}</div>
        </div>`;
      })
      .join("");

    const targetHosts = hosts.length ? hosts : primary ? [primary] : [];
    for (const h of targetHosts) {
      h.innerHTML = innerHtml;
      bindFirewallFilterHostEvents(h);
    }
    updateFirewallFiltersChrome();
    fwToolbarTenantMs.refresh();
    opsToolbarTenantMs.refresh();
  }

  function firewallFacetFilterCount() {
    let n = fwLinkMode === "offline" || fwLinkMode === "firmware_updates" ? 1 : 0;
    for (const st of Object.values(fwFilterState)) {
      if (st instanceof Set) n += st.size;
    }
    if ((document.getElementById("fw-search")?.value || "").trim()) n += 1;
    return n;
  }

  function updateFirewallFiltersChrome() {
    const n = firewallFacetFilterCount();
    for (const ids of [
      ["fw-filters-head-actions", "fw-facet-count", "fw-facet-reset"],
      ["ops-filters-head-actions", "ops-facet-count", "ops-facet-reset"],
    ]) {
      const wrap = document.getElementById(ids[0]);
      const countEl = document.getElementById(ids[1]);
      const resetBtn = document.getElementById(ids[2]);
      if (!wrap || !countEl || !resetBtn) continue;
      resetBtn.hidden = n === 0;
      if (n === 0) {
        wrap.hidden = true;
        countEl.textContent = "";
        continue;
      }
      wrap.hidden = false;
      countEl.innerHTML = `<span class="filters__facet-count-num">${n}</span> applied`;
    }
  }

  function syncFirewallFilterCheckboxesFromState() {
    for (const host of getFirewallFilterHosts()) {
      host.querySelectorAll('input[type="checkbox"][data-cat]').forEach((cb) => {
        const cat = cb.dataset.cat;
        const st = fwFilterState[cat];
        if (!st) return;
        cb.checked = st.has(cb.value);
      });
    }
  }

  function clearFirewallFilters() {
    fwLinkMode = null;
    for (const st of Object.values(fwFilterState)) {
      if (st && typeof st.clear === "function") st.clear();
    }
    for (const host of getFirewallFilterHosts()) {
      host.querySelectorAll('input[type="checkbox"][data-cat]').forEach((cb) => {
        cb.checked = false;
      });
      clearFwFacetSearchInputs(host);
    }
    const search = document.getElementById("fw-search");
    if (search) search.value = "";
    updateFirewallFiltersChrome();
    fwToolbarTenantMs.refresh();
    opsToolbarTenantMs.refresh();
    renderOperationsView();
  }

  function resetFirewallFacetFilters() {
    fwLinkMode = null;
    for (const st of Object.values(fwFilterState)) {
      if (st && typeof st.clear === "function") st.clear();
    }
    for (const host of getFirewallFilterHosts()) {
      host.querySelectorAll('input[type="checkbox"][data-cat]').forEach((cb) => {
        cb.checked = false;
      });
      clearFwFacetSearchInputs(host);
    }
    const fwSearch = document.getElementById("fw-search");
    if (fwSearch) fwSearch.value = "";
    fwController.render();
    setFiltersPanelCollapsed(document.querySelector("#fw-subpanel-firewalls .filters"), true);
    setFiltersPanelCollapsed(document.querySelector("#panel-operations .filters"), true);
    schedulePersistUiState();
    fwToolbarTenantMs.refresh();
    opsToolbarTenantMs.refresh();
  }

  function firewallFiltered() {
    const enriched = fwPrepared.map((r) => ({
      ...r,
      connected_label: yesNo(r.connected),
      suspended_label: yesNo(r.suspended),
    }));

    return enriched.filter((row) => {
      if (fwLinkMode === "offline") {
        if (row.connected === 1 && row.suspended === 0) return false;
      } else if (fwLinkMode === "firmware_updates") {
        const uc = Number(row.firmware_upgrade_count);
        if (!Number.isFinite(uc) || uc <= 0) return false;
      }
      for (const [cat, selected] of Object.entries(fwFilterState)) {
        if (!selected || selected.size === 0) continue;
        if (cat === "firmware_update") {
          const avail = row.firmware_available_updates || [];
          const hasNone = avail.length === 0;
          const any = [...selected].some((opt) =>
            opt === "None" ? hasNone : avail.includes(opt)
          );
          if (!any) return false;
          continue;
        }
        if (cat === "group_name") {
          const leaves = row.fw_group_facet_values;
          const bucket = !Array.isArray(leaves) || !leaves.length ? ["—"] : leaves.map(String);
          const hit = [...selected].some((s) => bucket.includes(s));
          if (!hit) return false;
          continue;
        }
        const val =
          cat === "connected_label"
            ? yesNo(row.connected)
            : cat === "suspended_label"
              ? yesNo(row.suspended)
              : row[cat] == null || row[cat] === ""
                ? "—"
                : String(row[cat]);
        if (!selected.has(val)) return false;
      }
      return true;
    });
  }

  function getFwRowSearchText(row) {
    return [
      row.status,
      row.hostname,
      row.group_name,
      row.serial_number,
      row.model,
      row.firmware_version,
      (row.firmware_available_updates || []).join(" "),
      yesNo(row.connected),
      yesNo(row.suspended),
      row.external_ips,
      row.tenant_name,
      row.state_changed_at,
      row.tagsPlain,
      row.alert_count > 0 ? String(row.alert_count) : "",
      row.has_group_sync_status ? "group sync status" : "",
      row.firmware_upgrade_count > 0 ? "firmware upgrade" : "",
      row.firewall_name,
      row.tenant_id,
      row.managing_status,
      row.reporting_status,
      row.firewall_id,
      row.capabilities_sort,
      row.has_location ? "location set update coordinates" : "location set",
      row.geo_lat != null ? String(row.geo_lat) : "",
      row.geo_lon != null ? String(row.geo_lon) : "",
    ]
      .join(" ")
      .toLowerCase();
  }

  let opsAutoRefreshTimer = null;
  const OPS_AUTO_REFRESH_MS = 45000;

  function stopOperationsAutoRefresh() {
    if (opsAutoRefreshTimer != null) {
      clearInterval(opsAutoRefreshTimer);
      opsAutoRefreshTimer = null;
    }
  }

  function startOperationsAutoRefresh() {
    stopOperationsAutoRefresh();
    if (getActiveTabName() !== "operations") return;
    opsAutoRefreshTimer = window.setInterval(() => {
      if (getActiveTabName() !== "operations") return;
      void loadFirewalls({ preserve: true })
        .then(() => {
          onSessionUserActivity();
        })
        .catch(() => {});
    }, OPS_AUTO_REFRESH_MS);
  }

  /** For "online first": online+suspended (0), then online not suspended (1), then offline (2). */
  function operationsOnlineFirstTier(row) {
    if (!fwRowConnected(row)) return 2;
    return fwRowSuspended(row) ? 0 : 1;
  }

  function operationsRowsFilteredSorted() {
    const sortSel = document.getElementById("ops-sort");
    const mode = sortSel?.value || "state_online_first";
    let rows = firewallFiltered();
    const q = (document.getElementById("ops-search")?.value || "").trim().toLowerCase();
    if (q) rows = rows.filter((row) => getFwRowSearchText(row).includes(q));
    const cmpHost = (a, b) =>
      String(a.hostname || "").localeCompare(String(b.hostname || ""), undefined, { sensitivity: "base" });
    rows = [...rows];
    rows.sort((a, b) => {
      const ah = firewallStatusHealthy(a);
      const bh = firewallStatusHealthy(b);
      if (mode === "state_online_first") {
        const ta = operationsOnlineFirstTier(a);
        const tb = operationsOnlineFirstTier(b);
        if (ta !== tb) return ta - tb;
        return cmpHost(a, b);
      }
      if (mode === "state_offline_first") {
        if (ah !== bh) return ah ? 1 : -1;
        return cmpHost(a, b);
      }
      if (mode === "hostname") return cmpHost(a, b);
      if (mode === "tenant") {
        return String(a.tenant_name || "").localeCompare(String(b.tenant_name || ""), undefined, {
          sensitivity: "base",
        });
      }
      if (mode === "last_sync") {
        const ta = parseFirewallIsoMs(a.last_sync) ?? 0;
        const tb = parseFirewallIsoMs(b.last_sync) ?? 0;
        return tb - ta;
      }
      if (mode === "state_changed") {
        const ta = parseFirewallIsoMs(a.state_changed_at) ?? 0;
        const tb = parseFirewallIsoMs(b.state_changed_at) ?? 0;
        return tb - ta;
      }
      return cmpHost(a, b);
    });
    return rows;
  }

  function operationsCardToneClass(row) {
    const ap =
      fwRawIsApprovalPending(row.managing_status) || fwRawIsApprovalPending(row.reporting_status);
    if (ap) return "ops-card--approval";
    if (!fwRowConnected(row)) return "ops-card--offline";
    if (fwRowSuspended(row)) return "ops-card--suspended";
    return "ops-card--healthy";
  }

  function operationsCardTintClasses(row) {
    const now = Date.now();
    const t = parseFirewallIsoMs(row.state_changed_at);
    if (t == null || now - t > 15 * 60 * 1000) return "";
    if (firewallStatusHealthy(row)) return "ops-card--tint-pos";
    return "ops-card--tint-neg";
  }

  /** Stable hue 0–359 from namespace + value so the same string reuses the same color on every card. */
  function operationsFacetHue(namespace, value) {
    const s = value != null ? String(value) : "";
    let h = 2166136261;
    const seed = `${namespace}:${s}`;
    for (let i = 0; i < seed.length; i++) {
      h ^= seed.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return Math.abs(h) % 360;
  }

  function operationsFacetPillPresentation(namespace, raw) {
    const s = raw != null ? String(raw) : "";
    if (!s || s === "—") {
      return { cls: "ops-pill ops-pill--facet ops-pill--facet-empty", style: "" };
    }
    const hue = operationsFacetHue(namespace, s);
    return {
      cls: "ops-pill ops-pill--facet",
      style: `background:hsl(${hue} 46% 90%);border-color:hsl(${hue} 38% 76%);color:hsl(${hue} 32% 24%)`,
    };
  }

  function renderOperationsPills(row) {
    const ap =
      fwRawIsApprovalPending(row.managing_status) || fwRawIsApprovalPending(row.reporting_status);
    const conn = fwRowConnected(row);
    const susp = fwRowSuspended(row);
    const bits = [];
    if (ap) bits.push(`<span class="ops-pill ops-pill--approval">Pending approval</span>`);
    else if (!conn) bits.push(`<span class="ops-pill ops-pill--offline">Offline</span>`);
    else bits.push(`<span class="ops-pill ops-pill--online">Online</span>`);
    if (susp && conn)
      bits.push(`<span class="ops-pill ops-pill--suspended">Suspended</span>`);
    const rawFw = row.firmware_version != null && row.firmware_version !== "" ? String(row.firmware_version) : "";
    const fwDisp = escapeHtml(fwFirmwareDisplay(row.firmware_version));
    const fwTitle = rawFw ? escapeAttr(rawFw) : "";
    bits.push(
      `<span class="ops-pill ops-pill--fw"${fwTitle ? ` title="${fwTitle}"` : ""}>${fwDisp}</span>`
    );
    return bits.join("");
  }

  function renderOperationsChangeStrip(rows) {
    const strip = document.getElementById("ops-change-strip");
    const posEl = document.getElementById("ops-change-strip-pos");
    const negEl = document.getElementById("ops-change-strip-neg");
    if (!strip || !posEl || !negEl) return;
    const windowMs = 15 * 60 * 1000;
    const now = Date.now();
    const recent = rows
      .map((r) => ({ r, t: parseFirewallIsoMs(r.state_changed_at) }))
      .filter((x) => x.t != null && now - x.t <= windowMs && now - x.t >= 0)
      .sort((a, b) => b.t - a.t);
    const pos = recent.find((x) => firewallStatusHealthy(x.r));
    const neg = recent.find((x) => !firewallStatusHealthy(x.r));
    let any = false;
    if (pos) {
      const host = firewallFilterHostnameValue(pos.r.hostname, pos.r.firewall_name);
      const rel = formatStateChangeRelative(pos.r.state_changed_at);
      posEl.textContent = `${host} · ${pos.r.status} · ${rel}`;
      posEl.hidden = false;
      any = true;
    } else {
      posEl.hidden = true;
      posEl.textContent = "";
    }
    if (neg) {
      const host = firewallFilterHostnameValue(neg.r.hostname, neg.r.firewall_name);
      const rel = formatStateChangeRelative(neg.r.state_changed_at);
      negEl.textContent = `${host} · ${neg.r.status} · ${rel}`;
      negEl.hidden = false;
      any = true;
    } else {
      negEl.hidden = true;
      negEl.textContent = "";
    }
    strip.hidden = !any;
  }

  function renderOperationsView() {
    const grid = document.getElementById("ops-card-grid");
    if (!grid) return;
    const rows = operationsRowsFilteredSorted();
    const opsTitleCount = document.getElementById("page-title-ops-count");
    if (opsTitleCount && getActiveTabName() === "operations") {
      opsTitleCount.hidden = false;
      const n = rows.length;
      opsTitleCount.textContent = n === 1 ? "1 firewall shown" : `${n} firewalls shown`;
    }
    renderOperationsChangeStrip(rows);
    if (!rows.length) {
      grid.innerHTML =
        '<p class="muted" style="padding:1rem 0;">No firewalls match the current filters.</p>';
      return;
    }
    const cards = rows
      .map((row) => {
        const tone = operationsCardToneClass(row);
        const tint = operationsCardTintClasses(row);
        const titleText = firewallFilterHostnameValue(row.hostname, row.firewall_name);
        const hostFacet =
          row.hostname != null && String(row.hostname) !== "" && String(row.hostname) !== "—"
            ? String(row.hostname)
            : "";
        const hostAttr = escapeAttr(hostFacet);
        const icon = renderFirewallStatusIconHtml(row);
        const tenantRaw = row.tenant_name != null ? String(row.tenant_name) : "";
        const tenantDisp = escapeHtml(tenantRaw || "—");
        const tenantAttr = escapeAttr(tenantRaw);
        const modelRaw = row.model != null && row.model !== "" ? String(row.model) : "";
        const modelDispPlain = fwModelDisplay(row.model);
        const modelDisp = escapeHtml(modelDispPlain);
        const modelTitle = modelRaw && modelRaw !== "—" ? escapeAttr(modelRaw) : "";
        const modelFacet = operationsFacetPillPresentation("model", modelRaw || modelDispPlain);
        const tenantFacet = operationsFacetPillPresentation("tenant", tenantRaw);
        const modelPill = `<span class="${modelFacet.cls}"${modelFacet.style ? ` style="${escapeAttr(modelFacet.style)}"` : ""}${modelTitle ? ` title="${modelTitle}"` : ""}>${modelDisp}</span>`;
        const tenantPill =
          tenantRaw && tenantRaw !== "—"
            ? `<button type="button" class="cell-link ops-card__tenant-btn ${tenantFacet.cls}" data-ops-tenant="${tenantAttr}" title="Open Firewalls and search for this tenant" aria-label="Open Firewalls and search for tenant ${escapeAttr(tenantAttr)}"${tenantFacet.style ? ` style="${escapeAttr(tenantFacet.style)}"` : ""}>${tenantDisp}</button>`
            : `<span class="${tenantFacet.cls}"${tenantFacet.style ? ` style="${escapeAttr(tenantFacet.style)}"` : ""}>${tenantDisp}</span>`;
        const syncRel = formatSyncLastRelative(row.last_sync);
        const stateRel = formatStateChangeRelative(row.state_changed_at);
        const syncTitleRaw = syncPreciseTimeForTitle(row.last_sync);
        const stateTitleRaw = syncPreciseTimeForTitle(row.state_changed_at);
        const syncTitleAttr = syncTitleRaw ? ` title="${escapeAttr(syncTitleRaw)}"` : "";
        const stateTitleAttr = stateTitleRaw ? ` title="${escapeAttr(stateTitleRaw)}"` : "";
        const syncIcon = `<svg class="ops-card__sync-ico" viewBox="0 0 24 24" width="11" height="11" aria-hidden="true"><path fill="currentColor" d="M12 4V1L8 5l4 4V6c3.31 0 6 2.69 6 6 0 1.01-.25 1.97-.7 2.8l1.46 1.46C19.54 15.03 20 13.57 20 12c0-4.42-3.58-8-8-8zm0 14c-3.31 0-6-2.69-6-6 0-1.01.25-1.97.7-2.8L5.24 7.74C4.46 8.97 4 10.43 4 12c0 4.42 3.58 8 8 8v3l4-4-4-4v3z"/></svg>`;
        const stateEyeIcon = `<svg class="ops-card__state-ico" viewBox="0 0 24 24" width="11" height="11" aria-hidden="true"><path fill="currentColor" d="M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z"/></svg>`;
        const hostBtn = hostFacet
          ? `<button type="button" class="cell-link ops-card__hostname-btn" data-ops-hostname="${hostAttr}" title="Open Firewalls and search for this host" aria-label="Open Firewalls and search for ${escapeAttr(titleText)}">${escapeHtml(titleText)}</button>`
          : `<span class="ops-card__title-text">${escapeHtml(titleText)}</span>`;
        return `<div class="ops-card ${tone} ${tint}" data-ops-fw="${escapeAttr(row._id)}" role="button" tabindex="0" aria-label="Open details for ${escapeAttr(titleText)}">
                <span class="ops-card__accent" aria-hidden="true"></span>
                <div class="ops-card__body">
                  <div class="ops-card__title">${icon}${hostBtn}</div>
                  <div class="ops-card__pills">${renderOperationsPills(row)}${modelPill}${tenantPill}</div>
                  <div class="ops-card__footer">
                    <span class="ops-card__meta ops-card__meta--sync"${syncTitleAttr}>${syncIcon}<span class="ops-card__meta-text">${escapeHtml(syncRel)}</span></span>
                    <span class="ops-card__meta ops-card__meta--state"${stateTitleAttr}>${stateEyeIcon}<span class="ops-card__meta-text">${escapeHtml(stateRel)}</span></span>
                  </div>
                </div>
              </div>`;
      })
      .join("");
    grid.innerHTML = `<div class="ops-card-flow">${cards}</div>`;
  }

  function updateOpsQuickFilterToolbarUi() {
    const wrap = document.getElementById("ops-toolbar-quick");
    if (!wrap) return;
    const c = fwFilterState.connected_label;
    const s = fwFilterState.suspended_label;
    const onlineMatch =
      fwLinkMode === null &&
      c &&
      s &&
      c.size === 1 &&
      s.size === 1 &&
      c.has("Yes") &&
      s.has("No");
    wrap.querySelectorAll("[data-ops-quick]").forEach((btn) => {
      const q = btn.getAttribute("data-ops-quick");
      let on = false;
      if (q === "online") on = onlineMatch;
      else if (q === "offline") on = fwLinkMode === "offline";
      else if (q === "suspended") {
        const st = fwFilterState.status;
        on = !!(st && st.size === 1 && st.has("Suspended"));
      } else if (q === "pending") {
        const st = fwFilterState.status;
        on = !!(st && st.size === 1 && st.has("Pending approval"));
      } else if (q === "firmware_updates") on = fwLinkMode === "firmware_updates";
      btn.classList.toggle("is-active", on);
    });
  }

  function applyOperationsQuickFilter(q) {
    clearFirewallFilters();
    const c = fwFilterState.connected_label;
    const s = fwFilterState.suspended_label;
    const st = fwFilterState.status;
    if (q === "online") {
      c.clear();
      s.clear();
      c.add("Yes");
      s.add("No");
    } else if (q === "offline") {
      fwLinkMode = "offline";
    } else if (q === "suspended") {
      if (st) {
        st.clear();
        st.add("Suspended");
      }
    } else if (q === "pending") {
      if (st) {
        st.clear();
        st.add("Pending approval");
      }
    } else if (q === "firmware_updates") {
      fwLinkMode = "firmware_updates";
    }
    syncFirewallFilterCheckboxesFromState();
    fwController.render();
    renderOperationsView();
    updateFirewallFiltersChrome();
    updateFwQuickFilterToolbarUi();
    updateOpsQuickFilterToolbarUi();
    fwToolbarTenantMs.refresh();
    opsToolbarTenantMs.refresh();
    schedulePersistUiState();
  }

  function initOperationsViewPanel() {
    document.getElementById("ops-sort")?.addEventListener("change", () => {
      renderOperationsView();
      schedulePersistUiState();
    });
    document.getElementById("ops-search")?.addEventListener("input", () => {
      renderOperationsView();
      schedulePersistUiState();
    });
    document.getElementById("ops-toolbar-quick")?.addEventListener("click", (e) => {
      const t = e.target.closest("[data-ops-quick]");
      if (!t) return;
      applyOperationsQuickFilter(t.getAttribute("data-ops-quick"));
    });
    const opsGrid = document.getElementById("ops-card-grid");
    opsGrid?.addEventListener("click", (e) => {
      const hostBtn = e.target.closest(".ops-card__hostname-btn");
      if (hostBtn) {
        e.preventDefault();
        e.stopPropagation();
        const h = hostBtn.getAttribute("data-ops-hostname");
        if (h && h !== "—") {
          goToFirewallsWithSearchOnly(h);
        }
        return;
      }
      const tenBtn = e.target.closest(".ops-card__tenant-btn");
      if (tenBtn) {
        e.preventDefault();
        e.stopPropagation();
        const t = tenBtn.getAttribute("data-ops-tenant");
        if (t != null && t !== "" && t !== "—") {
          goToFirewallsWithSearchOnly(t);
        }
        return;
      }
      const card = e.target.closest("[data-ops-fw]");
      if (!card) return;
      const id = card.getAttribute("data-ops-fw");
      if (!id) return;
      openFwDetailFlyout(id).catch(console.error);
    });
    opsGrid?.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      const card = e.target.closest(".ops-card[data-ops-fw]");
      if (!card || e.target.closest(".ops-card__hostname-btn, .ops-card__tenant-btn")) return;
      e.preventDefault();
      const id = card.getAttribute("data-ops-fw");
      if (id) openFwDetailFlyout(id).catch(console.error);
    });
  }

  const fwTableEl = document.getElementById("fw-table");
  const fwTbody = document.getElementById("fw-tbody");
  buildFwThead();

  function updateFwQuickFilterToolbarUi() {
    const wrap = document.getElementById("fw-toolbar-quick");
    if (!wrap) return;
    const c = fwFilterState.connected_label;
    const s = fwFilterState.suspended_label;
    const onlineMatch =
      fwLinkMode === null &&
      c &&
      s &&
      c.size === 1 &&
      s.size === 1 &&
      c.has("Yes") &&
      s.has("No");
    wrap.querySelectorAll("[data-fw-quick]").forEach((btn) => {
      const q = btn.getAttribute("data-fw-quick");
      let on = false;
      if (q === "online") on = onlineMatch;
      else if (q === "offline") on = fwLinkMode === "offline";
      else if (q === "suspended") {
        const st = fwFilterState.status;
        on = !!(st && st.size === 1 && st.has("Suspended"));
      } else if (q === "pending") {
        const st = fwFilterState.status;
        on = !!(st && st.size === 1 && st.has("Pending approval"));
      }
      else if (q === "firmware_updates") on = fwLinkMode === "firmware_updates";
      btn.classList.toggle("is-active", on);
    });
  }

  let updateFwApproveButtonState = () => {};

  const fwController = createTableController({
    tbody: fwTbody,
    countEl: document.getElementById("fw-count"),
    rangeEl: document.getElementById("fw-lazy-hint"),
    pageSizeEl: document.getElementById("fw-page-size"),
    searchInput: document.getElementById("fw-search"),
    selectAllInput: document.getElementById("fw-select-all"),
    sortHeaders: [],
    sortDelegateRoot: fwTableEl,
    initialSort: { sortKey: "status", sortDir: 1 },
    getFilteredRows: firewallFiltered,
    getRowSearchText: getFwRowSearchText,
    renderRow: (row, selected) => renderFirewallDataRow(row, selected),
    afterRender: () => {
      updateFirewallFiltersChrome();
      refreshFwMapMarkers({ refit: false });
      updateFwQuickFilterToolbarUi();
      updateOpsQuickFilterToolbarUi();
      renderOperationsView();
      updateFwApproveButtonState();
      updateFwFirmwareUpgradeButtonState();
      updateFwDeleteLocalButtonState();
    },
    onSelectionChange: () => {
      updateFwApproveButtonState();
      updateFwFirmwareUpgradeButtonState();
      updateFwDeleteLocalButtonState();
    },
  });

  function firmwareVersionSortKey(ver) {
    const s = String(ver);
    const parts = s.split(/(\d+)/).filter(Boolean);
    return parts.map((p) => (/^\d+$/.test(p) ? parseInt(p, 10) : p.toLowerCase()));
  }

  function compareFirmwareVersionLabels(a, b) {
    const ka = firmwareVersionSortKey(a);
    const kb = firmwareVersionSortKey(b);
    const n = Math.max(ka.length, kb.length);
    for (let i = 0; i < n; i++) {
      const x = ka[i];
      const y = kb[i];
      if (x === undefined) return -1;
      if (y === undefined) return 1;
      if (typeof x === "number" && typeof y === "number") {
        if (x !== y) return x - y;
      } else if (typeof x === "string" && typeof y === "string") {
        const c = x.localeCompare(y);
        if (c !== 0) return c;
      } else {
        return typeof x === "number" ? -1 : 1;
      }
    }
    return 0;
  }

  function syncFwBatchScheduleChrome() {
    const sched = document.getElementById("fw-firmware-batch-schedule");
    const clearBtn = document.getElementById("fw-firmware-batch-schedule-clear");
    const confirmBtn = document.getElementById("fw-firmware-batch-confirm");
    if (!sched || !confirmBtn) return;
    const has = Boolean(sched.value && String(sched.value).trim());
    if (clearBtn) clearBtn.hidden = !has;
    confirmBtn.textContent = has ? "Schedule Upgrade" : "Upgrade now";
  }

  function updateFwFirmwareBatchConfirmEnabled() {
    const confirmBtn = document.getElementById("fw-firmware-batch-confirm");
    if (!confirmBtn) return;
    const anyVersion =
      fwBatchModalRows.length > 0 &&
      fwBatchModalRows.some((r) => {
        const c = fwBatchChoiceByFwId.get(r._id);
        return c != null && String(c).trim() !== "";
      });
    confirmBtn.disabled = !anyVersion;
  }

  function renderFwFirmwareBatchTable() {
    const tbody = document.getElementById("fw-firmware-batch-tbody");
    if (!tbody) return;
    tbody.innerHTML = fwBatchModalRows
      .map((row) => {
        const id = row._id;
        const versions = Array.isArray(row.firmware_available_updates)
          ? [...row.firmware_available_updates].sort(compareFirmwareVersionLabels)
          : [];
        const defaultLow = versions[0];
        if (!fwBatchChoiceByFwId.has(id)) {
          fwBatchChoiceByFwId.set(id, defaultLow !== undefined ? defaultLow : null);
        }
        const chosen = fwBatchChoiceByFwId.get(id);
        const host = escapeHtml(row.hostname);
        const tenant = escapeHtml(row.tenant_name);
        const cur = escapeHtml(row.firmware_version || "—");
        const verButtons = versions
          .map((v) => {
            const isPri = chosen === v;
            const cls = isPri
              ? "fw-batch-choice-btn fw-batch-choice-btn--primary"
              : "fw-batch-choice-btn";
            return `<button type="button" class="${cls}" data-fw-batch-fw="${escapeAttr(id)}" data-fw-batch-ver="${escapeAttr(v)}">${escapeHtml(v)}</button>`;
          })
          .join("");
        const noneOn = chosen == null || chosen === "";
        const noneCls = noneOn
          ? "fw-batch-choice-btn fw-batch-choice-btn--no-upgrade-selected"
          : "fw-batch-choice-btn";
        const noneBtn = `<button type="button" class="${noneCls}" data-fw-batch-fw="${escapeAttr(id)}" data-fw-batch-none="1">No upgrade</button>`;
        return `<tr data-fw-batch-row="${escapeAttr(id)}">
      <td>${host}</td>
      <td>${tenant}</td>
      <td>${cur}</td>
      <td><div class="fw-firmware-batch-modal__choices">${verButtons}${noneBtn}</div></td>
    </tr>`;
      })
      .join("");
    updateFwFirmwareBatchConfirmEnabled();
  }

  function setFwFirmwareBatchModalOpen(open) {
    const modal = document.getElementById("fw-firmware-batch-modal");
    if (!modal) return;
    modal.hidden = !open;
    modal.setAttribute("aria-hidden", open ? "false" : "true");
  }

  async function openFwFirmwareBatchModal(options) {
    const opts = options && typeof options === "object" ? options : {};
    const explicit = Array.isArray(opts.firewallIds)
      ? opts.firewallIds.map((x) => String(x).trim()).filter(Boolean)
      : [];
    if (!isAdmin()) return;
    const ids =
      explicit.length > 0
        ? new Set(explicit)
        : new Set(fwController.getSelectedIds().filter(Boolean));
    fwBatchModalRows = fwPrepared.filter(
      (r) => ids.has(r._id) && (Number(r.firmware_upgrade_count) > 0 || (r.firmware_available_updates || []).length > 0)
    );
    if (fwBatchModalRows.length === 0) return;
    fwBatchChoiceByFwId = new Map();
    const sched = document.getElementById("fw-firmware-batch-schedule");
    if (sched) sched.value = "";
    const st = document.getElementById("fw-firmware-batch-status");
    if (st) st.textContent = "";
    const notesRoot = document.getElementById("fw-firmware-batch-notes-root");
    if (notesRoot) {
      notesRoot.hidden = false;
      notesRoot.innerHTML = '<p class="muted">Loading release notes…</p>';
    }
    setFwFirmwareBatchModalOpen(true);

    const versionSet = new Set();
    fwBatchModalRows.forEach((r) => {
      (r.firmware_available_updates || []).forEach((v) => {
        const s = v != null && String(v).trim() !== "" ? String(v).trim() : "";
        if (s) versionSet.add(s);
      });
    });
    const sortedVers = [...versionSet].sort(compareFirmwareVersionLabels);

    if (notesRoot) {
      if (sortedVers.length === 0) {
        notesRoot.innerHTML = "";
        notesRoot.hidden = true;
      } else {
        try {
          const params = new URLSearchParams();
          sortedVers.forEach((v) => params.append("versions", v));
          const data = await loadJson(`/api/firmware-version-details?${params.toString()}`);
          const details = Array.isArray(data?.version_details) ? data.version_details : [];
          notesRoot.innerHTML = renderFwFirmwareBatchNotesBody(sortedVers, details);
          notesRoot.hidden = false;
          setFwFirmwareNotesExpanded(notesRoot, false);
        } catch (e) {
          console.error(e);
          notesRoot.innerHTML =
            '<p class="muted">Could not load release notes. You can still choose target versions below.</p>';
          notesRoot.hidden = false;
        }
      }
    }

    renderFwFirmwareBatchTable();
    syncFwBatchScheduleChrome();
    document.getElementById("fw-firmware-batch-confirm")?.focus();
  }

  function initFwFirmwareBatchUpgradeModal() {
    const modal = document.getElementById("fw-firmware-batch-modal");
    const tbody = document.getElementById("fw-firmware-batch-tbody");
    const sched = document.getElementById("fw-firmware-batch-schedule");
    const clearSched = document.getElementById("fw-firmware-batch-schedule-clear");
    const cancel = document.getElementById("fw-firmware-batch-cancel");
    const confirm = document.getElementById("fw-firmware-batch-confirm");
    const closeBtn = document.getElementById("fw-firmware-batch-modal-close");
    const openBtn = document.getElementById("fw-firmware-upgrade-batch-btn");
    const backdrop = modal?.querySelector(".fw-firmware-batch-modal__backdrop");

    openBtn?.addEventListener("click", () => {
      if (openBtn.disabled) return;
      openFwFirmwareBatchModal().catch(console.error);
    });

    function closeModal() {
      const nr = document.getElementById("fw-firmware-batch-notes-root");
      if (nr) {
        nr.innerHTML = "";
        nr.hidden = true;
      }
      setFwFirmwareBatchModalOpen(false);
      openBtn?.focus();
    }

    modal?.addEventListener("click", (e) => {
      const nr = document.getElementById("fw-firmware-batch-notes-root");
      const notesToggle = e.target.closest("#fw-firmware-batch-notes-root button.fw-firmware-modal__notes-toggle");
      if (notesToggle && nr && modal.contains(notesToggle)) {
        e.preventDefault();
        toggleFwFirmwareNotesCollapse(nr);
        return;
      }
      const tab = e.target.closest("#fw-firmware-batch-notes-root button.fw-firmware-modal__tab");
      if (!tab || !modal.contains(tab)) return;
      const list = tab.closest('.fw-firmware-modal__tabs[role="tablist"]');
      if (!list) return;
      const tabs = [...list.querySelectorAll('[role="tab"]')];
      const idx = tabs.indexOf(tab);
      if (idx < 0) return;
      activateFwBatchFirmwareNotesTab(idx);
    });

    modal?.addEventListener("keydown", (e) => {
      const tab = e.target.closest("#fw-firmware-batch-notes-root button.fw-firmware-modal__tab");
      if (!tab || !modal.contains(tab)) return;
      const list = tab.closest('.fw-firmware-modal__tabs[role="tablist"]');
      if (!list) return;
      const tabs = [...list.querySelectorAll('[role="tab"]')];
      const i = tabs.indexOf(tab);
      if (i < 0) return;
      let next = i;
      if (e.key === "ArrowRight") next = (i + 1) % tabs.length;
      else if (e.key === "ArrowLeft") next = (i - 1 + tabs.length) % tabs.length;
      else if (e.key === "Home") next = 0;
      else if (e.key === "End") next = tabs.length - 1;
      else return;
      e.preventDefault();
      activateFwBatchFirmwareNotesTab(next);
      tabs[next]?.focus();
    });

    cancel?.addEventListener("click", closeModal);
    closeBtn?.addEventListener("click", closeModal);
    backdrop?.addEventListener("click", closeModal);

    sched?.addEventListener("input", () => {
      syncFwBatchScheduleChrome();
    });

    clearSched?.addEventListener("click", () => {
      if (sched) sched.value = "";
      syncFwBatchScheduleChrome();
      sched?.focus();
    });

    tbody?.addEventListener("click", (e) => {
      const verBtn = e.target.closest("button[data-fw-batch-ver]");
      const noneBtn = e.target.closest("button[data-fw-batch-none]");
      const t = verBtn || noneBtn;
      if (!t) return;
      const fid = t.getAttribute("data-fw-batch-fw");
      if (!fid) return;
      if (noneBtn) {
        fwBatchChoiceByFwId.set(fid, null);
      } else {
        fwBatchChoiceByFwId.set(fid, t.getAttribute("data-fw-batch-ver"));
        const nr = document.getElementById("fw-firmware-batch-notes-root");
        const picked = t.getAttribute("data-fw-batch-ver");
        if (nr && picked) {
          const ti = findFwFirmwareTabIndexByVersion(nr, picked);
          if (ti >= 0) activateFwBatchFirmwareNotesTab(ti);
          else setFwFirmwareNotesExpanded(nr, true);
        }
      }
      renderFwFirmwareBatchTable();
    });

    confirm?.addEventListener("click", async () => {
      if (!isAdmin() || confirm.disabled) return;
      const items = fwBatchModalRows.map((r) => ({
        firewall_id: r._id,
        upgrade_to_version: fwBatchChoiceByFwId.get(r._id) || null,
      }));
      let scheduledAt = null;
      if (sched && sched.value && String(sched.value).trim()) {
        const d = new Date(sched.value);
        if (!Number.isNaN(d.getTime())) scheduledAt = d.toISOString();
      }
      confirm.disabled = true;
      const st = document.getElementById("fw-firmware-batch-status");
      if (st) st.textContent = "";
      try {
        const res = await apiRequestJson("/api/firewalls/firmware-upgrade-batch", {
          method: "POST",
          body: JSON.stringify({ items, scheduled_at: scheduledAt }),
        });
        const lines = [];
        const ok = (res.scheduled || []).filter((x) => x.ok);
        const bad = (res.scheduled || []).filter((x) => !x.ok);
        if (ok.length) lines.push(`Submitted: ${ok.length}`);
        if (bad.length) {
          lines.push(
            `Failed: ${bad.length}`,
            ...bad.slice(0, 6).map((x) => `  ${x.id}: ${x.detail || "error"}`)
          );
        }
        if (res.skipped && res.skipped.length) lines.push(`Skipped: ${res.skipped.length}`);
        if (res.errors && res.errors.length) {
          lines.push(
            `Errors: ${res.errors.length}`,
            ...res.errors.slice(0, 5).map((x) => `  ${x.id}: ${x.detail}`)
          );
        }
        if (res.credential_syncs && res.credential_syncs.length) {
          const failed = res.credential_syncs.filter((s) => !s.ok);
          if (failed.length) {
            lines.push(
              `Credential sync issues: ${failed.length}`,
              ...failed.slice(0, 3).map((s) => `  ${s.credential_id}: ${s.error || "failed"}`)
            );
          }
        }
        const summaryText = lines.length ? lines.join("\n") : "Done.";
        const summaryVariant =
          /(^|\n)Errors?:/i.test(summaryText) || /(^|\n)Failed:/i.test(summaryText) ? "info" : "success";
        notifyAppUser("Firmware upgrade", summaryText, summaryVariant);
        closeModal();
        fwController.clearSelection();
        try {
          await loadFirewalls({ preserve: false });
          await loadDashboard({});
          refreshDashboardStatCards();
          refreshAppSyncStatusBar();
        } catch (refreshErr) {
          notifyAppUser(
            "Dashboard refresh",
            refreshErr && refreshErr.message ? refreshErr.message : String(refreshErr),
            "error"
          );
        }
      } catch (err) {
        notifyAppUser("Firmware upgrade", err && err.message ? err.message : String(err), "error");
      } finally {
        updateFwFirmwareBatchConfirmEnabled();
      }
    });
  }

  updateFwApproveButtonState = function () {
    const btn = document.getElementById("fw-approve-btn");
    if (!btn || btn.hidden) return;
    const ids = fwController.getSelectedIds();
    const sel = new Set(ids.filter(Boolean));
    const any = fwPrepared.some(
      (r) =>
        sel.has(r._id) &&
        (fwRawIsApprovalPending(r.managing_status) || fwRawIsApprovalPending(r.reporting_status))
    );
    btn.disabled = !any;
  };

  function updateFwFirmwareUpgradeButtonState() {
    const btn = document.getElementById("fw-firmware-upgrade-batch-btn");
    if (!btn || btn.hidden) return;
    const ids = fwController.getSelectedIds();
    const sel = new Set(ids.filter(Boolean));
    const any = fwPrepared.some(
      (r) =>
        sel.has(r._id) &&
        (Number(r.firmware_upgrade_count) > 0 || (r.firmware_available_updates || []).length > 0)
    );
    btn.disabled = !any;
  }

  function updateFwDeleteLocalButtonState() {
    const btn = document.getElementById("fw-delete-local-btn");
    if (!btn || btn.hidden) return;
    const n = fwController.getSelectedIds().filter(Boolean).length;
    btn.disabled = n < 1;
  }

  function applyFwApproveButtonVisibility() {
    const btn = document.getElementById("fw-approve-btn");
    const fwUp = document.getElementById("fw-firmware-upgrade-batch-btn");
    const delLocal = document.getElementById("fw-delete-local-btn");
    const admin = isAdmin();
    if (btn) {
      btn.hidden = !admin;
    }
    if (fwUp) {
      fwUp.hidden = !admin;
    }
    if (delLocal) {
      delLocal.hidden = !admin;
    }
    const grCreate = document.getElementById("gr-create-group-btn");
    if (grCreate) {
      grCreate.hidden = !admin;
    }
    const grDel = document.getElementById("gr-delete-groups-btn");
    if (grDel) {
      grDel.hidden = !admin;
    }
    updateFwApproveButtonState();
    updateFwFirmwareUpgradeButtonState();
    updateFwDeleteLocalButtonState();
    updateGrDeleteGroupsButtonState();
  }

  function initFwToolbarQuickFilters() {
    document.getElementById("fw-toolbar-quick")?.addEventListener("click", (e) => {
      const t = e.target.closest("[data-fw-quick]");
      if (!t) return;
      const q = t.getAttribute("data-fw-quick");
      if (q === "online") {
        goToFirewallsOnline();
        return;
      }
      if (q === "offline") {
        goToFirewallsOffline();
        return;
      }
      if (q === "suspended") {
        goToFirewallsSuspended();
        return;
      }
      if (q === "pending") {
        goToFirewallsPending();
        return;
      }
      if (q === "firmware_updates") {
        goToFirewallsFirmwareUpdates();
        return;
      }
    });
  }

  function setFwDeleteLocalModalOpen(open) {
    const modal = document.getElementById("fw-delete-local-modal");
    if (!modal) return;
    modal.hidden = !open;
    modal.setAttribute("aria-hidden", open ? "false" : "true");
  }

  function initFwDeleteLocalModal() {
    const modal = document.getElementById("fw-delete-local-modal");
    const openBtn = document.getElementById("fw-delete-local-btn");
    const cancel = document.getElementById("fw-delete-local-cancel");
    const proceed = document.getElementById("fw-delete-local-proceed");
    const closeBtn = document.getElementById("fw-delete-local-modal-close");
    const backdrop = modal?.querySelector(".fw-delete-local-modal__backdrop");
    const statusEl = document.getElementById("fw-delete-local-modal-status");

    function closeModal() {
      if (statusEl) statusEl.textContent = "";
      setFwDeleteLocalModalOpen(false);
      openBtn?.focus();
    }

    openBtn?.addEventListener("click", () => {
      if (!isAdmin() || openBtn.disabled) return;
      const ids = fwController.getSelectedIds().filter(Boolean);
      const n = ids.length;
      if (n === 0) return;
      if (statusEl) statusEl.textContent = "";
      const proceedLabel = n === 1 ? "Delete 1 Firewall" : `Delete ${n} Firewalls`;
      if (proceed) {
        proceed.textContent = proceedLabel;
        proceed.setAttribute("aria-label", proceedLabel);
      }
      setFwDeleteLocalModalOpen(true);
      proceed?.focus();
    });

    cancel?.addEventListener("click", closeModal);
    closeBtn?.addEventListener("click", closeModal);
    backdrop?.addEventListener("click", closeModal);

    proceed?.addEventListener("click", async () => {
      if (!isAdmin() || proceed.disabled) return;
      const ids = fwController.getSelectedIds().filter(Boolean);
      if (ids.length === 0) return;
      if (statusEl) statusEl.textContent = "";
      proceed.disabled = true;
      try {
        const res = await apiRequestJson("/api/firewalls/delete-local-batch", {
          method: "POST",
          body: JSON.stringify({ firewall_ids: ids }),
        });
        const deleted = Array.isArray(res.deleted) ? res.deleted.length : 0;
        const nf = Array.isArray(res.not_found) ? res.not_found.length : 0;
        if (nf > 0) {
          notifyAppUser(
            "Remove firewalls",
            deleted > 0
              ? `Removed ${deleted} from the local database. ${nf} selected id(s) were not found.`
              : `No matching firewalls in the local database (${nf} id(s)).`,
            "info"
          );
        }
        closeModal();
        fwController.clearSelection();
        await loadFirewalls({ preserve: false });
        await loadDashboard({});
        refreshDashboardStatCards();
        refreshAppSyncStatusBar();
      } catch (err) {
        if (statusEl) {
          statusEl.textContent = err && err.message ? err.message : String(err);
        } else {
          notifyAppUser("Remove firewalls", err && err.message ? err.message : String(err), "error");
        }
      } finally {
        proceed.disabled = false;
      }
    });
  }

  function initFwApproveButton() {
    const btn = document.getElementById("fw-approve-btn");
    if (!btn) return;
    btn.addEventListener("click", async () => {
      if (!isAdmin() || btn.disabled) return;
      const ids = fwController.getSelectedIds().filter(Boolean);
      const pendingIds = fwPrepared
        .filter(
          (r) =>
            ids.includes(r._id) &&
            (fwRawIsApprovalPending(r.managing_status) || fwRawIsApprovalPending(r.reporting_status))
        )
        .map((r) => r._id);
      if (pendingIds.length === 0) return;
      btn.disabled = true;
      try {
        const res = await apiRequestJson("/api/firewalls/approve-batch", {
          method: "POST",
          body: JSON.stringify({ firewall_ids: pendingIds }),
        });
        const lines = [];
        if (res.approved && res.approved.length > 0) {
          lines.push(`Approved: ${res.approved.length}`);
        }
        if (res.skipped && res.skipped.length > 0) {
          lines.push(`Skipped: ${res.skipped.length}`);
        }
        if (res.errors && res.errors.length > 0) {
          lines.push(
            `Errors: ${res.errors.length}`,
            ...res.errors.slice(0, 5).map((x) => `  ${x.id}: ${x.detail}`)
          );
        }
        if (res.credential_syncs && res.credential_syncs.length > 0) {
          const failed = res.credential_syncs.filter((s) => !s.ok);
          if (failed.length > 0) {
            lines.push(
              `Credential sync issues: ${failed.length}`,
              ...failed.slice(0, 3).map((s) => `  ${s.credential_id}: ${s.error || "failed"}`)
            );
          }
        }
        const approveText = lines.length ? lines.join("\n") : "Done.";
        const approveVariant =
          /(^|\n)Errors?:/i.test(approveText) || /(^|\n)Credential sync issues:/i.test(approveText)
            ? "info"
            : "success";
        notifyAppUser("Approve firewalls", approveText, approveVariant);
        fwController.clearSelection();
        await loadFirewalls({ preserve: false });
        await loadDashboard({});
        refreshDashboardStatCards();
        refreshAppSyncStatusBar();
      } catch (err) {
        notifyAppUser("Approve firewalls", err && err.message ? err.message : String(err), "error");
      } finally {
        updateFwApproveButtonState();
      }
    });
  }

  initFwToolbarQuickFilters();
  initFwApproveButton();
  initFwFirmwareBatchUpgradeModal();
  initFwDeleteLocalModal();

  initFwColumnPicker();

  fwTbody.addEventListener("click", (e) => {
    const grpBtn = e.target.closest("button.fw-to-central-group");
    if (grpBtn) {
      e.preventDefault();
      const gid = grpBtn.getAttribute("data-group-id");
      if (gid) goToGroupsFilteredByGroup(gid);
      return;
    }
    const trHit = e.target.closest("tr");
    if (
      trHit &&
      fwTbody.contains(trHit) &&
      !e.target.closest("input, button, a, label, textarea, select")
    ) {
      const cb = trHit.querySelector("input.row-check[data-id]");
      const fid = cb && cb.getAttribute("data-id");
      if (fid) {
        openFwDetailFlyout(fid).catch(console.error);
        return;
      }
    }
    const locBtn = e.target.closest("button.fw-loc-btn");
    if (locBtn) {
      e.preventDefault();
      const fid = locBtn.getAttribute("data-fw-id");
      if (fid) openFwLocationModal(fid).catch(console.error);
      return;
    }
    const upBtn = e.target.closest("button.fw-firmware-upgrade-btn");
    if (upBtn) {
      e.preventDefault();
      const fid = upBtn.getAttribute("data-fw-id");
      if (fid) openFwFirmwareBatchModal({ firewallIds: [fid] }).catch(console.error);
      return;
    }
    const dashBtn = e.target.closest("button.fw-alerts-dash-link");
    if (dashBtn) {
      e.preventDefault();
      const enc = dashBtn.getAttribute("data-fw-host");
      if (enc == null || enc === "") return;
      try {
        goToDashboardAlertsForFirewall(decodeURIComponent(enc));
      } catch {
        /* ignore malformed data-fw-host */
      }
      return;
    }
    const fwHostnameLink = e.target.closest("a.cell-link[data-id]");
    if (fwHostnameLink && fwTbody.contains(fwHostnameLink)) {
      e.preventDefault();
      const fid = fwHostnameLink.getAttribute("data-id");
      if (fid) openFwDetailFlyout(fid).catch(console.error);
      return;
    }
    const a = e.target.closest("a.cell-link");
    if (a) e.preventDefault();
  });

  function openFirewallStatusFilterGroup() {
    expandFirewallFiltersPanel();
    const wrap = document.querySelector('#firewall-filters .filter-group[data-cat-wrap="status"]');
    if (!wrap) return;
    wrap.classList.add("is-open");
    const head = wrap.querySelector(".filter-group__head");
    if (head) head.setAttribute("aria-expanded", "true");
  }

  function openFirewallTenantFilterGroup() {
    fwToolbarTenantMs.setOpen(true);
  }

  function goToFirewallsFilteredByTenant(tenantName) {
    if (tenantName == null || tenantName === "") return;
    clearFirewallFilters();
    const tn = fwFilterState.tenant_name;
    if (tn) {
      tn.clear();
      tn.add(tenantName);
    }
    syncFirewallFilterCheckboxesFromState();
    fwToolbarTenantMs.refresh();
    openFirewallTenantFilterGroup();
    fwController.resetSort();
    fwController.resetPage();
    activateTab("firewalls");
  }

  function openFirewallTenantAndGroupFilterGroups() {
    expandFirewallFiltersPanel();
    fwToolbarTenantMs.setOpen(true);
    const wrap = document.querySelector('#firewall-filters .filter-group[data-cat-wrap="group_name"]');
    if (!wrap) return;
    wrap.classList.add("is-open");
    const head = wrap.querySelector(".filter-group__head");
    if (head) head.setAttribute("aria-expanded", "true");
  }

  /** Jump to Firewalls with tenant (+ optional Central group leaf name) facet filters applied. */
  function goToFirewallsFilteredByTenantAndGroup(tenantName, groupLeafName) {
    if (tenantName == null || tenantName === "" || tenantName === "—") return;
    clearFirewallFilters();
    const tn = fwFilterState.tenant_name;
    if (tn) {
      tn.clear();
      tn.add(String(tenantName));
    }
    const g = fwFilterState.group_name;
    const leaf = groupLeafName != null ? String(groupLeafName).trim() : "";
    if (g && leaf && leaf !== "—") {
      g.clear();
      g.add(leaf);
    }
    syncFirewallFilterCheckboxesFromState();
    fwToolbarTenantMs.refresh();
    openFirewallTenantAndGroupFilterGroups();
    fwController.resetSort();
    fwController.resetPage();
    activateTab("firewalls");
  }

  function openGroupsTenantGroupParentFilterGroups() {
    expandGroupFiltersPanel();
    grToolbarTenantMs.setOpen(true);
    for (const sel of [
      '#group-filters .filter-group[data-cat-wrap="group_name"]',
      '#group-filters .filter-group[data-cat-wrap="parent_display"]',
    ]) {
      const wrap = document.querySelector(sel);
      if (!wrap) continue;
      wrap.classList.add("is-open");
      const head = wrap.querySelector(".filter-group__head");
      if (head) head.setAttribute("aria-expanded", "true");
    }
  }

  /** Switch to Groups and apply facet filters to the row with this Central group id. */
  function goToGroupsFilteredByGroup(groupId) {
    const gid = groupId != null ? String(groupId).trim() : "";
    if (!gid) return;
    const row = grPrepared.find((r) => String(r.id) === gid);
    if (!row) return;

    for (const st of Object.values(grFilterState)) {
      if (st && typeof st.clear === "function") st.clear();
    }
    const host = document.getElementById("group-filters");
    if (host) {
      host.querySelectorAll('input[type="checkbox"][data-cat]').forEach((cb) => {
        cb.checked = false;
      });
    }

    if (!(grFilterState.tenant_name instanceof Set)) grFilterState.tenant_name = new Set();
    if (!(grFilterState.group_name instanceof Set)) grFilterState.group_name = new Set();
    if (!(grFilterState.parent_display instanceof Set)) grFilterState.parent_display = new Set();
    grFilterState.tenant_name.add(String(row.tenant_name ?? "—"));
    grFilterState.group_name.add(String(row.group_name ?? "—"));
    grFilterState.parent_display.add(String(row.parent_display ?? "—"));

    syncGroupFilterCheckboxesFromState();
    grToolbarTenantMs.refresh();
    updateGroupFiltersChrome();
    grController.resetSort();
    grController.resetPage();
    activeFirewallsSubtab = "groups";
    activateTab("firewalls");
    expandGroupFiltersPanel();
    openGroupsTenantGroupParentFilterGroups();
    schedulePersistUiState();
  }

  function openFirewallHostnameFilterGroup() {
    expandFirewallFiltersPanel();
    const wrap = document.querySelector(
      '#firewall-filters .filter-group[data-cat-wrap="hostname"]'
    );
    if (!wrap) return;
    wrap.classList.add("is-open");
    const head = wrap.querySelector(".filter-group__head");
    if (head) head.setAttribute("aria-expanded", "true");
  }

  /**
   * Switch to Firewalls and set the toolbar search only (no facet changes).
   * Used from Operations cards so shared fwFilterState does not reset and the Operations
   * view keeps the same facet filters when the user returns.
   */
  function goToFirewallsWithSearchOnly(query) {
    const raw = query != null ? String(query).trim() : "";
    if (!raw || raw === "—") return;
    const search = document.getElementById("fw-search");
    if (search) search.value = raw;
    fwController.resetSort();
    fwController.resetPage();
    closeAlertFlyout();
    activateTab("firewalls");
    fwController.render();
    schedulePersistUiState();
  }

  function goToFirewallsFilteredByHostname(hostname) {
    if (hostname == null || hostname === "" || hostname === "—") return;
    const hs = fwFilterState.hostname;
    if (!hs) return;
    clearFirewallFilters();
    hs.clear();
    hs.add(hostname);
    syncFirewallFilterCheckboxesFromState();
    openFirewallHostnameFilterGroup();
    fwController.resetSort();
    fwController.resetPage();
    closeAlertFlyout();
    activateTab("firewalls");
  }

  function openFirewallSerialFilterGroup() {
    expandFirewallFiltersPanel();
    const wrap = document.querySelector(
      '#firewall-filters .filter-group[data-cat-wrap="serial_number"]'
    );
    if (!wrap) return;
    wrap.classList.add("is-open");
    const head = wrap.querySelector(".filter-group__head");
    if (head) head.setAttribute("aria-expanded", "true");
  }

  /** Filter firewalls to the row whose serial matches (same value as license serial). */
  function goToFirewallsFilteredBySerial(serial) {
    if (serial == null || String(serial).trim() === "" || serial === "—") return;
    const sn = fwFilterState.serial_number;
    if (!sn) return;
    clearFirewallFilters();
    sn.clear();
    sn.add(String(serial));
    syncFirewallFilterCheckboxesFromState();
    openFirewallSerialFilterGroup();
    fwController.resetSort();
    fwController.resetPage();
    closeAlertFlyout();
    activateTab("firewalls");
  }

  /** Firewalls tab search matches ``firewall_id`` (and other row text); facets cleared. */
  function goToFirewallsFilteredByFirewallId(firewallId) {
    const id = firewallId != null ? String(firewallId).trim() : "";
    if (!id) return;
    clearFirewallFilters();
    const search = document.getElementById("fw-search");
    if (search) search.value = id;
    fwController.resetSort();
    fwController.resetPage();
    closeAlertFlyout();
    activateTab("firewalls");
    schedulePersistUiState();
  }

  function goToFirewallsUnfiltered() {
    clearFirewallFilters();
    fwController.resetSort();
    fwController.resetPage();
    activateTab("firewalls");
    schedulePersistUiState();
  }

  function openFirewallConnectedAndSuspendedGroups() {
    expandFirewallFiltersPanel();
    for (const key of ["connected_label", "suspended_label"]) {
      const wrap = document.querySelector(
        `#firewall-filters .filter-group[data-cat-wrap="${key}"]`
      );
      if (!wrap) continue;
      wrap.classList.add("is-open");
      const head = wrap.querySelector(".filter-group__head");
      if (head) head.setAttribute("aria-expanded", "true");
    }
  }

  function goToFirewallsOnline() {
    const c = fwFilterState.connected_label;
    const s = fwFilterState.suspended_label;
    if (!c || !s) return;
    clearFirewallFilters();
    c.clear();
    c.add("Yes");
    s.clear();
    s.add("No");
    syncFirewallFilterCheckboxesFromState();
    openFirewallConnectedAndSuspendedGroups();
    fwController.resetSort();
    fwController.resetPage();
    activateTab("firewalls");
    schedulePersistUiState();
  }

  function goToFirewallsOffline() {
    expandFirewallFiltersPanel();
    clearFirewallFilters();
    fwLinkMode = "offline";
    fwController.resetSort();
    fwController.resetPage();
    activateTab("firewalls");
    schedulePersistUiState();
  }

  function goToFirewallsSuspended() {
    expandFirewallFiltersPanel();
    clearFirewallFilters();
    const st = fwFilterState.status;
    if (st) {
      st.clear();
      st.add("Suspended");
    }
    syncFirewallFilterCheckboxesFromState();
    openFirewallStatusFilterGroup();
    fwController.resetSort();
    fwController.resetPage();
    activateTab("firewalls");
    schedulePersistUiState();
  }

  function goToFirewallsPending() {
    expandFirewallFiltersPanel();
    clearFirewallFilters();
    const st = fwFilterState.status;
    if (st) {
      st.clear();
      st.add("Pending approval");
    }
    syncFirewallFilterCheckboxesFromState();
    openFirewallStatusFilterGroup();
    fwController.resetSort();
    fwController.resetPage();
    activateTab("firewalls");
    schedulePersistUiState();
  }

  function goToFirewallsFirmwareUpdates() {
    expandFirewallFiltersPanel();
    clearFirewallFilters();
    fwLinkMode = "firmware_updates";
    fwController.resetSort();
    fwController.resetPage();
    activateTab("firewalls");
    schedulePersistUiState();
  }

  async function loadFirewalls(opts = {}) {
    const preserve = opts.preserve === true;
    let fwFacetSnap = null;
    const fwLinkModeSnap = fwLinkMode;
    if (preserve) {
      fwFacetSnap = {};
      for (const [k, st] of Object.entries(fwFilterState)) {
        if (st instanceof Set && st.size > 0) fwFacetSnap[k] = [...st];
      }
    }
    const [fwList, fvPayload] = await Promise.all([
      loadJson("/api/firewalls"),
      loadJson("/api/firmware-versions").catch(() => ({ versions: [] })),
    ]);
    fwRaw = fwList;
    fwFirmwareVersionCatalog = Array.isArray(fvPayload?.versions)
      ? fvPayload.versions.map(String)
      : [];
    fwPrepared = fwRaw.map(prepareFirewall);
    applyFirewallRecencyTags(fwPrepared);
    buildFirewallFilters();
    if (preserve) {
      if (fwFacetSnap) {
        for (const [k, arr] of Object.entries(fwFacetSnap)) {
          const st = fwFilterState[k];
          if (st && Array.isArray(arr)) {
            arr.forEach((x) => st.add(String(x)));
          }
        }
      }
      fwLinkMode = fwLinkModeSnap;
      syncFirewallFilterCheckboxesFromState();
      updateFirewallFiltersChrome();
    }
    if (!preserve) {
      fwController.clearSelection();
      fwController.resetPage();
    }
    finalizeFwPreparedState();
    fwToolbarTenantMs.refresh();
    opsToolbarTenantMs.refresh();
    renderOperationsView();
    refreshFwMapMarkers();
  }

  /* ---------- Tenants ---------- */
  let tnPrepared = [];
  const tnFilterState = {};

  const TN_COL_VISIBILITY_KEY = "sophos-central-tn-columns-v1";
  const TN_COLUMNS = [
    { id: "name", label: "Name", sortKey: "name", thClass: "th-sortable" },
    {
      id: "credential_name",
      label: "Credentials",
      sortKey: "credential_name",
      thClass: "th-sortable tn-col-credentials",
    },
    { id: "firewall_count", label: "Firewalls", sortKey: "firewall_count", thClass: "th-sortable tn-col-firewalls" },
    { id: "show_as", label: "Show as", sortKey: "show_as", thClass: "th-sortable" },
    { id: "status", label: "Status", sortKey: "status", thClass: "th-sortable" },
    { id: "data_region", label: "Region", sortKey: "data_region", thClass: "th-sortable tn-col-region" },
    { id: "billing_type", label: "Billing", sortKey: "billing_type", thClass: "th-sortable tn-col-billing" },
    { id: "api_host", label: "API host", sortKey: "api_host", thClass: "th-sortable" },
    { id: "updated_at", label: "Updated", sortKey: "updated_at", thClass: "th-sortable" },
    {
      id: "tenant_id",
      label: "Tenant ID",
      sortKey: "tenant_id",
      thClass: "th-sortable fw-col-code",
      defaultVisible: false,
    },
  ];

  function defaultTnColumnVisibility() {
    const o = {};
    TN_COLUMNS.forEach((c) => {
      o[c.id] = c.defaultVisible !== false;
    });
    return o;
  }

  function loadTnColumnVisibility() {
    const d = defaultTnColumnVisibility();
    try {
      const raw = localStorage.getItem(TN_COL_VISIBILITY_KEY);
      if (!raw) return d;
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        TN_COLUMNS.forEach((c) => {
          if (typeof parsed[c.id] === "boolean") d[c.id] = parsed[c.id];
        });
      }
    } catch {
      /* ignore */
    }
    return d;
  }

  let tnColVisible = loadTnColumnVisibility();

  function persistTnColumnVisibility() {
    try {
      localStorage.setItem(TN_COL_VISIBILITY_KEY, JSON.stringify(tnColVisible));
    } catch {
      /* ignore */
    }
  }

  function buildTnThead() {
    const tr = document.getElementById("tn-thead-row");
    if (!tr) return;
    tr.innerHTML = "";
    TN_COLUMNS.forEach((col) => {
      if (!tnColVisible[col.id]) return;
      const th = document.createElement("th");
      th.scope = "col";
      th.textContent = col.label;
      if (col.sortKey) {
        th.dataset.sort = col.sortKey;
        th.className = col.thClass || "th-sortable";
      } else {
        th.className = col.thClass || "";
      }
      tr.appendChild(th);
    });
  }

  function filterTnColumnMenuList() {
    const q = (document.getElementById("tn-cols-filter")?.value || "").trim().toLowerCase();
    const list = document.getElementById("tn-cols-list");
    if (!list) return;
    list.querySelectorAll("li[data-col-label]").forEach((li) => {
      const lab = (li.dataset.colLabel || "").toLowerCase();
      li.hidden = q !== "" && !lab.includes(q);
    });
  }

  function buildTnColumnMenuList() {
    const list = document.getElementById("tn-cols-list");
    if (!list) return;
    list.innerHTML = TN_COLUMNS.map(
      (c) => `
      <li class="toolbar__cols-item" data-col-id="${escapeHtml(c.id)}" data-col-label="${escapeHtml(c.label.toLowerCase())}">
        <label class="toolbar__cols-label">
          <input type="checkbox" data-tn-col="${escapeHtml(c.id)}" ${tnColVisible[c.id] ? "checked" : ""} />
          <span>${escapeHtml(c.label)}</span>
        </label>
      </li>`
    ).join("");
    filterTnColumnMenuList();
  }

  function positionTnColsDropdown() {
    const btn = document.getElementById("tn-cols-trigger");
    const panel = document.getElementById("tn-cols-panel");
    const modal = document.getElementById("tn-cols-modal");
    if (!btn || !panel || !modal || modal.hidden) return;
    panel.style.maxHeight = "";
    const r = btn.getBoundingClientRect();
    const gap = 6;
    const margin = 8;
    const pw = panel.offsetWidth || Math.min(380, window.innerWidth - 2 * margin);
    let left = r.left;
    if (left + pw > window.innerWidth - margin) {
      left = window.innerWidth - margin - pw;
    }
    left = Math.max(margin, left);
    const topBelow = r.bottom + gap;
    panel.style.left = `${left}px`;
    panel.style.top = `${topBelow}px`;
    const after = panel.getBoundingClientRect();
    if (after.bottom > window.innerHeight - margin) {
      const aboveTop = r.top - gap - after.height;
      if (aboveTop >= margin) {
        panel.style.top = `${aboveTop}px`;
      } else {
        panel.style.top = `${margin}px`;
        panel.style.maxHeight = `${Math.max(120, window.innerHeight - 2 * margin)}px`;
      }
    }
  }

  function setTnColumnPanelOpen(open) {
    const modal = document.getElementById("tn-cols-modal");
    const btn = document.getElementById("tn-cols-trigger");
    const panel = document.getElementById("tn-cols-panel");
    if (!modal || !btn) return;
    modal.hidden = !open;
    modal.setAttribute("aria-hidden", open ? "false" : "true");
    btn.setAttribute("aria-expanded", open ? "true" : "false");
    if (!open && panel) {
      panel.style.top = "";
      panel.style.left = "";
      panel.style.maxHeight = "";
    }
    if (open) {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => positionTnColsDropdown());
      });
    }
  }

  function initTnColumnPicker() {
    buildTnColumnMenuList();
    const btn = document.getElementById("tn-cols-trigger");
    const modal = document.getElementById("tn-cols-modal");
    const panel = document.getElementById("tn-cols-panel");
    const filterIn = document.getElementById("tn-cols-filter");
    const list = document.getElementById("tn-cols-list");
    const closeBtn = document.getElementById("tn-cols-close");
    if (!btn || !modal || !panel) return;
    list?.addEventListener("change", (e) => {
      const cb = e.target.closest("input[data-tn-col]");
      if (!cb) return;
      const id = cb.dataset.tnCol;
      if (!id || !Object.prototype.hasOwnProperty.call(tnColVisible, id)) return;
      const col = TN_COLUMNS.find((c) => c.id === id);
      if (col && !cb.checked && tnController.getSortKey() === col.sortKey) {
        tnController.resetSort();
      }
      tnColVisible[id] = cb.checked;
      persistTnColumnVisibility();
      buildTnThead();
      tnController.render();
    });
    function openTnColsModalFromTrigger() {
      const willOpen = modal.hidden;
      setTnColumnPanelOpen(willOpen);
      if (willOpen) {
        buildTnColumnMenuList();
        filterIn?.focus();
      }
    }
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      openTnColsModalFromTrigger();
    });
    btn.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        openTnColsModalFromTrigger();
      }
    });
    filterIn?.addEventListener("input", () => filterTnColumnMenuList());
    closeBtn?.addEventListener("click", () => {
      setTnColumnPanelOpen(false);
      btn.focus();
    });
    modal.querySelector(".fw-cols-modal__backdrop")?.addEventListener("click", () => {
      setTnColumnPanelOpen(false);
      btn.focus();
    });
    document.addEventListener("mousedown", (e) => {
      if (modal.hidden) return;
      if (btn.contains(e.target) || panel.contains(e.target)) return;
      setTnColumnPanelOpen(false);
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !modal.hidden) {
        setTnColumnPanelOpen(false);
        btn.focus();
      }
    });

    function repositionTnColsIfOpen() {
      if (!modal.hidden) positionTnColsDropdown();
    }
    window.addEventListener("resize", repositionTnColsIfOpen);
    window.addEventListener("scroll", repositionTnColsIfOpen, true);
  }

  function prepareTenant(row) {
    return {
      _id: row.id,
      tenant_id: row.id || "—",
      name: row.name || "—",
      firewall_count: row.firewall_count ?? 0,
      show_as: row.show_as || "—",
      status: row.status || "—",
      data_region: row.data_region || row.data_geography || "—",
      billing_type: row.billing_type || "—",
      api_host: row.api_host || "—",
      updated_at: row.updated_at || "",
      first_sync: row.first_sync || "",
      last_sync: row.last_sync || "",
      client_id: row.client_id || "",
      credential_name: row.credential_name && String(row.credential_name).trim() !== "" ? row.credential_name : "—",
    };
  }

  function tenantFiltered() {
    return tnPrepared.filter((row) => {
      for (const [cat, selected] of Object.entries(tnFilterState)) {
        if (!selected || selected.size === 0) continue;
        const val =
          cat === "firewall_count"
            ? String(row.firewall_count ?? 0)
            : row[cat] == null || row[cat] === ""
              ? "—"
              : String(row[cat]);
        if (!selected.has(val)) return false;
      }
      return true;
    });
  }

  function buildTenantFilters() {
    const host = document.getElementById("tenant-filters");
    if (!host) return;
    const groups = [
      { key: "name", label: "Name" },
      { key: "credential_name", label: "Credentials" },
      { key: "show_as", label: "Show as" },
      { key: "status", label: "Status" },
      { key: "data_region", label: "Region" },
      { key: "billing_type", label: "Billing" },
      { key: "api_host", label: "API host" },
      { key: "firewall_count", label: "Firewalls" },
    ];

    host.innerHTML = groups
      .map((g, idx) => {
        const opts = distinctValues(tnPrepared, g.key, 80);
        tnFilterState[g.key] = new Set();
        const open = idx < 3 ? "is-open" : "";
        const optsHtml = opts
          .map(
            (o) => `
          <label class="filter-opt">
            <input type="checkbox" data-cat="${escapeHtml(g.key)}" value="${escapeHtml(o)}" />
            <span>${escapeHtml(o)}</span>
          </label>`
          )
          .join("");
        return `
        <div class="filter-group ${open}" data-cat-wrap="${escapeHtml(g.key)}">
          <button type="button" class="filter-group__head" aria-expanded="${idx < 3}">
            <span>${escapeHtml(g.label)}</span>
            <span class="filter-group__chev">▼</span>
          </button>
          <div class="filter-group__body">${optsHtml}</div>
        </div>`;
      })
      .join("");

    host.querySelectorAll(".filter-group__head").forEach((btn) => {
      btn.addEventListener("click", () => {
        const g = btn.closest(".filter-group");
        g.classList.toggle("is-open");
        btn.setAttribute("aria-expanded", g.classList.contains("is-open"));
      });
    });

    host.querySelectorAll('input[type="checkbox"][data-cat]').forEach((cb) => {
      cb.addEventListener("change", () => {
        const cat = cb.dataset.cat;
        const st = tnFilterState[cat];
        if (!st) return;
        if (cb.checked) st.add(cb.value);
        else st.delete(cb.value);
        tnDashBilling = null;
        tnController.render();
        refreshDashboardStatCards();
      });
    });
    updateTenantFiltersChrome();
  }

  function tenantFacetFilterCount() {
    let n = 0;
    for (const st of Object.values(tnFilterState)) {
      if (st instanceof Set) n += st.size;
    }
    return n;
  }

  function updateTenantFiltersChrome() {
    const wrap = document.getElementById("tn-filters-head-actions");
    const countEl = document.getElementById("tn-facet-count");
    const resetBtn = document.getElementById("tn-facet-reset");
    if (!wrap || !countEl || !resetBtn) return;
    const n = tenantFacetFilterCount();
    resetBtn.hidden = n === 0;
    if (n === 0) {
      wrap.hidden = true;
      countEl.textContent = "";
      return;
    }
    wrap.hidden = false;
    countEl.innerHTML = `<span class="filters__facet-count-num">${n}</span> applied`;
  }

  function syncTenantFilterCheckboxesFromState() {
    const host = document.getElementById("tenant-filters");
    if (!host) return;
    host.querySelectorAll('input[type="checkbox"][data-cat]').forEach((cb) => {
      const cat = cb.dataset.cat;
      const st = tnFilterState[cat];
      if (!st) return;
      cb.checked = st.has(cb.value);
    });
  }

  function resetTenantFacetFilters() {
    tnDashBilling = null;
    const host = document.getElementById("tenant-filters");
    for (const st of Object.values(tnFilterState)) {
      if (st && typeof st.clear === "function") st.clear();
    }
    if (host) {
      host.querySelectorAll('input[type="checkbox"][data-cat]').forEach((cb) => {
        cb.checked = false;
      });
    }
    tnController.render();
    setFiltersPanelCollapsed(document.querySelector("#panel-tenants .filters"), true);
    schedulePersistUiState();
    refreshDashboardStatCards();
  }

  function tnPillHashSlot(str, salt, modulo) {
    let h = salt >>> 0;
    const s = String(str);
    for (let i = 0; i < s.length; i++) h = (Math.imul(h, 33) + s.charCodeAt(i)) >>> 0;
    return (h % modulo) + 1;
  }

  function tnRegionPillClass(raw) {
    const n = String(raw).trim().toLowerCase();
    const presets = {
      us: "tn-region--us",
      "u.s.": "tn-region--us",
      usa: "tn-region--us",
      eu: "tn-region--eu",
      eur: "tn-region--eu",
      europe: "tn-region--eu",
      uk: "tn-region--uk",
      gb: "tn-region--uk",
      de: "tn-region--de",
      au: "tn-region--au",
      ca: "tn-region--ca",
      jp: "tn-region--jp",
      in: "tn-region--in",
      ap: "tn-region--ap",
      global: "tn-region--global",
    };
    if (presets[n]) return `tag-pill tn-region-pill ${presets[n]}`;
    const slot = tnPillHashSlot(n, 0x9e3779b1, 8);
    return `tag-pill tn-region-pill tn-region--fb${slot}`;
  }

  function tnBillingPillClass(raw) {
    const n = String(raw).trim().toLowerCase();
    const presets = {
      trial: "tn-bill--trial",
      paid: "tn-bill--paid",
      subscription: "tn-bill--subscription",
      msp: "tn-bill--msp",
      partner: "tn-bill--partner",
      usage: "tn-bill--usage",
      billable: "tn-bill--billable",
      free: "tn-bill--free",
      enterprise: "tn-bill--enterprise",
    };
    if (presets[n]) return `tag-pill tn-bill-pill ${presets[n]}`;
    const slot = tnPillHashSlot(n, 0x7f4a7c15, 8);
    return `tag-pill tn-bill-pill tn-bill--fb${slot}`;
  }

  function tnRegionPillHtml(label) {
    const raw =
      label == null || String(label).trim() === "" || String(label).trim() === "—"
        ? "—"
        : String(label).trim();
    const cls =
      raw === "—" ? "tag-pill tn-region-pill tn-pill--empty" : tnRegionPillClass(raw);
    return `<span class="${cls}">${escapeHtml(raw)}</span>`;
  }

  function tnBillingPillHtml(label) {
    const raw =
      label == null || String(label).trim() === "" || String(label).trim() === "—"
        ? "—"
        : String(label).trim();
    const cls =
      raw === "—" ? "tag-pill tn-bill-pill tn-pill--empty" : tnBillingPillClass(raw);
    return `<span class="${cls}">${escapeHtml(raw)}</span>`;
  }

  function renderTnDataCell(colId, row) {
    switch (colId) {
      case "name": {
        const pill = renderFwRecencyPillHtml(row._recencyTag);
        const nameCell =
          row.name && row.name !== "—"
            ? `<button type="button" class="cell-link tenant-to-firewalls" data-tenant-name="${escapeHtml(row.name)}" title="Show firewalls for this tenant">${escapeHtml(row.name)}</button>`
            : `<span>${escapeHtml(row.name)}</span>`;
        return `<td><span class="table-recency-inline">${pill}${nameCell}</span></td>`;
      }
      case "credential_name":
        return `<td class="tn-col-credentials muted">${escapeHtml(row.credential_name)}</td>`;
      case "firewall_count": {
        const n = row.firewall_count ?? 0;
        const countStr = escapeHtml(String(n));
        const pill = `<span class="tag-pill tn-col-firewalls-pill">${countStr}</span>`;
        const canLink = row.name && row.name !== "—";
        const inner = canLink
          ? `<button type="button" class="cell-link tenant-to-firewalls" data-tenant-name="${escapeAttr(row.name)}" title="Show firewalls for this tenant">${pill}</button>`
          : pill;
        return `<td class="tn-col-firewalls">${inner}</td>`;
      }
      case "show_as":
        return `<td>${escapeHtml(row.show_as)}</td>`;
      case "status":
        return `<td>${escapeHtml(row.status)}</td>`;
      case "data_region":
        return `<td class="tn-col-region">${tnRegionPillHtml(row.data_region)}</td>`;
      case "billing_type":
        return `<td class="tn-col-billing">${tnBillingPillHtml(row.billing_type)}</td>`;
      case "api_host":
        return `<td class="muted">${escapeHtml(row.api_host)}</td>`;
      case "updated_at":
        return `<td class="muted">${fmtDate(row.updated_at)}</td>`;
      case "tenant_id":
        return `<td class="fw-col-code">${escapeHtml(row.tenant_id)}</td>`;
      default:
        return "<td></td>";
    }
  }

  function renderTenantDataRow(row) {
    const cells = TN_COLUMNS.filter((c) => tnColVisible[c.id])
      .map((c) => renderTnDataCell(c.id, row))
      .join("");
    return `<tr>${cells}</tr>`;
  }

  buildTnThead();

  const tnTableEl = document.getElementById("tn-table");
  const tnController = createTableController({
    tbody: document.getElementById("tn-tbody"),
    countEl: document.getElementById("tn-count"),
    rangeEl: document.getElementById("tn-lazy-hint"),
    pageSizeEl: document.getElementById("tn-page-size"),
    searchInput: document.getElementById("tn-search"),
    selectAllInput: null,
    sortHeaders: [],
    sortDelegateRoot: tnTableEl,
    getFilteredRows: tenantFiltered,
    getRowSearchText: (row) =>
      [
        row.name,
        row.credential_name,
        String(row.firewall_count),
        row.show_as,
        row.status,
        row.data_region,
        row.billing_type,
        row.api_host,
        row.updated_at,
        row.tenant_id,
      ]
        .join(" ")
        .toLowerCase(),
    renderRow: (row) => renderTenantDataRow(row),
    afterRender: updateTenantFiltersChrome,
  });

  initTnColumnPicker();

  document.getElementById("tn-tbody").addEventListener("click", (e) => {
    const btn = e.target.closest("button.tenant-to-firewalls");
    if (!btn) return;
    const tenantName = btn.getAttribute("data-tenant-name");
    if (tenantName) goToFirewallsFilteredByTenant(tenantName);
  });

  async function loadTenants(opts = {}) {
    const preserve = opts.preserve === true;
    const rows = await loadJson("/api/tenants");
    tnPrepared = rows.map(prepareTenant);
    applyTenantRecencyTags(tnPrepared);
    buildTenantFilters();
    if (!preserve) {
      tnController.clearSelection();
      tnController.resetPage();
    }
  }

  /* ---------- Groups (firewall_groups) ---------- */
  let grPrepared = [];
  const grFilterState = {};

  const GR_COL_VISIBILITY_KEY = "sophos-central-gr-columns-v1";
  const GR_COLUMNS = [
    {
      id: "breadcrumb",
      label: "Group",
      sortKey: "breadcrumb",
      thClass: "th-sortable gr-col-group",
    },
    { id: "tenant_name", label: "Tenant", sortKey: "tenant_name", thClass: "th-sortable" },
    {
      id: "imported_from",
      label: "Imported from",
      sortKey: "imported_from",
      thClass: "th-sortable",
    },
    {
      id: "firewall_count",
      label: "Firewalls",
      sortKey: "firewall_count",
      thClass: "th-sortable gr-col-firewalls",
    },
    {
      id: "sync_issues_count",
      label: "Sync issues",
      sortKey: "sync_issues_count",
      thClass: "th-sortable gr-col-sync-issues",
    },
    {
      id: "updated_at",
      label: "Updated at",
      sortKey: "updated_at",
      thClass: "th-sortable gr-col-updated-at",
    },
    {
      id: "group_name",
      label: "Group name (leaf)",
      sortKey: "group_name",
      thClass: "th-sortable",
      defaultVisible: false,
    },
    {
      id: "parent_display",
      label: "Parent group",
      sortKey: "parent_display",
      thClass: "th-sortable",
      defaultVisible: false,
    },
    {
      id: "locked_label",
      label: "Locked",
      sortKey: "locked_label",
      thClass: "th-sortable",
      defaultVisible: false,
    },
    {
      id: "last_sync",
      label: "Last sync",
      sortKey: "last_sync",
      thClass: "th-sortable",
      defaultVisible: false,
    },
    {
      id: "tenant_id",
      label: "Tenant ID",
      sortKey: "tenant_id",
      thClass: "th-sortable fw-col-code",
      defaultVisible: false,
    },
    {
      id: "id",
      label: "Group ID",
      sortKey: "id",
      thClass: "th-sortable fw-col-code",
      defaultVisible: false,
    },
  ];

  function defaultGrColumnVisibility() {
    const o = {};
    GR_COLUMNS.forEach((c) => {
      o[c.id] = c.defaultVisible !== false;
    });
    return o;
  }

  function loadGrColumnVisibility() {
    const d = defaultGrColumnVisibility();
    try {
      const raw = localStorage.getItem(GR_COL_VISIBILITY_KEY);
      if (!raw) return d;
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        GR_COLUMNS.forEach((c) => {
          if (typeof parsed[c.id] === "boolean") d[c.id] = parsed[c.id];
        });
      }
    } catch {
      /* ignore */
    }
    return d;
  }

  let grColVisible = loadGrColumnVisibility();

  function persistGrColumnVisibility() {
    try {
      localStorage.setItem(GR_COL_VISIBILITY_KEY, JSON.stringify(grColVisible));
    } catch {
      /* ignore */
    }
  }

  function buildGrThead() {
    const tr = document.getElementById("gr-thead-row");
    if (!tr) return;
    const checkTh = tr.querySelector(".th-check");
    if (!checkTh) return;
    while (tr.lastElementChild && tr.lastElementChild !== checkTh) {
      tr.removeChild(tr.lastElementChild);
    }
    GR_COLUMNS.forEach((col) => {
      if (!grColVisible[col.id]) return;
      const th = document.createElement("th");
      th.scope = "col";
      th.textContent = col.label;
      if (col.sortKey) {
        th.dataset.sort = col.sortKey;
        th.className = col.thClass || "th-sortable";
      } else {
        th.className = col.thClass || "";
      }
      tr.appendChild(th);
    });
  }

  function updateGrDeleteGroupsButtonState() {
    const btn = document.getElementById("gr-delete-groups-btn");
    if (!btn || btn.hidden) return;
    const n = grController.getSelectedIds().filter(Boolean).length;
    btn.disabled = n < 1;
  }

  function filterGrColumnMenuList() {
    const q = (document.getElementById("gr-cols-filter")?.value || "").trim().toLowerCase();
    const list = document.getElementById("gr-cols-list");
    if (!list) return;
    list.querySelectorAll("li[data-col-label]").forEach((li) => {
      const lab = (li.dataset.colLabel || "").toLowerCase();
      li.hidden = q !== "" && !lab.includes(q);
    });
  }

  function buildGrColumnMenuList() {
    const list = document.getElementById("gr-cols-list");
    if (!list) return;
    list.innerHTML = GR_COLUMNS.map(
      (c) => `
      <li class="toolbar__cols-item" data-col-id="${escapeHtml(c.id)}" data-col-label="${escapeHtml(c.label.toLowerCase())}">
        <label class="toolbar__cols-label">
          <input type="checkbox" data-gr-col="${escapeHtml(c.id)}" ${grColVisible[c.id] ? "checked" : ""} />
          <span>${escapeHtml(c.label)}</span>
        </label>
      </li>`
    ).join("");
    filterGrColumnMenuList();
  }

  function positionGrColsDropdown() {
    const btn = document.getElementById("gr-cols-trigger");
    const panel = document.getElementById("gr-cols-panel");
    const modal = document.getElementById("gr-cols-modal");
    if (!btn || !panel || !modal || modal.hidden) return;
    panel.style.maxHeight = "";
    const r = btn.getBoundingClientRect();
    const gap = 6;
    const margin = 8;
    const pw = panel.offsetWidth || Math.min(380, window.innerWidth - 2 * margin);
    let left = r.left;
    if (left + pw > window.innerWidth - margin) {
      left = window.innerWidth - margin - pw;
    }
    left = Math.max(margin, left);
    const topBelow = r.bottom + gap;
    panel.style.left = `${left}px`;
    panel.style.top = `${topBelow}px`;
    const after = panel.getBoundingClientRect();
    if (after.bottom > window.innerHeight - margin) {
      const aboveTop = r.top - gap - after.height;
      if (aboveTop >= margin) {
        panel.style.top = `${aboveTop}px`;
      } else {
        panel.style.top = `${margin}px`;
        panel.style.maxHeight = `${Math.max(120, window.innerHeight - 2 * margin)}px`;
      }
    }
  }

  function setGrColumnPanelOpen(open) {
    const modal = document.getElementById("gr-cols-modal");
    const btn = document.getElementById("gr-cols-trigger");
    const panel = document.getElementById("gr-cols-panel");
    if (!modal || !btn) return;
    modal.hidden = !open;
    modal.setAttribute("aria-hidden", open ? "false" : "true");
    btn.setAttribute("aria-expanded", open ? "true" : "false");
    if (!open && panel) {
      panel.style.top = "";
      panel.style.left = "";
      panel.style.maxHeight = "";
    }
    if (open) {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => positionGrColsDropdown());
      });
    }
  }

  function initGrColumnPicker() {
    buildGrColumnMenuList();
    const btn = document.getElementById("gr-cols-trigger");
    const modal = document.getElementById("gr-cols-modal");
    const panel = document.getElementById("gr-cols-panel");
    const filterIn = document.getElementById("gr-cols-filter");
    const list = document.getElementById("gr-cols-list");
    const closeBtn = document.getElementById("gr-cols-close");
    if (!btn || !modal || !panel) return;
    list?.addEventListener("change", (e) => {
      const cb = e.target.closest("input[data-gr-col]");
      if (!cb) return;
      const id = cb.dataset.grCol;
      if (!id || !Object.prototype.hasOwnProperty.call(grColVisible, id)) return;
      const col = GR_COLUMNS.find((c) => c.id === id);
      if (col && !cb.checked && grController.getSortKey() === col.sortKey) {
        grController.resetSort();
      }
      grColVisible[id] = cb.checked;
      persistGrColumnVisibility();
      buildGrThead();
      grController.render();
    });
    function openGrColsModalFromTrigger() {
      const willOpen = modal.hidden;
      setGrColumnPanelOpen(willOpen);
      if (willOpen) {
        buildGrColumnMenuList();
        filterIn?.focus();
      }
    }
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      openGrColsModalFromTrigger();
    });
    btn.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        openGrColsModalFromTrigger();
      }
    });
    filterIn?.addEventListener("input", () => filterGrColumnMenuList());
    closeBtn?.addEventListener("click", () => {
      setGrColumnPanelOpen(false);
      btn.focus();
    });
    modal.querySelector(".fw-cols-modal__backdrop")?.addEventListener("click", () => {
      setGrColumnPanelOpen(false);
      btn.focus();
    });
    document.addEventListener("mousedown", (e) => {
      if (modal.hidden) return;
      if (btn.contains(e.target) || panel.contains(e.target)) return;
      setGrColumnPanelOpen(false);
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !modal.hidden) {
        setGrColumnPanelOpen(false);
        btn.focus();
      }
    });

    function repositionGrColsIfOpen() {
      if (!modal.hidden) positionGrColsDropdown();
    }
    window.addEventListener("resize", repositionGrColsIfOpen);
    window.addEventListener("scroll", repositionGrColsIfOpen, true);
  }

  function prepareGroup(row) {
    let segs = Array.isArray(row.breadcrumb_segments)
      ? row.breadcrumb_segments.map((s) => String(s))
      : [];
    if (!segs.length && row.breadcrumb) {
      segs = String(row.breadcrumb)
        .split(/\s*›\s*/)
        .map((s) => s.trim())
        .filter(Boolean);
    }
    if (!segs.length) segs = ["—"];
    const breadcrumb = row.breadcrumb || segs.join(" › ");
    return {
      _id: row.id,
      id: row.id || "—",
      tenant_id: row.tenant_id || "",
      tenant_name: row.tenant_name || "—",
      group_name: row.group_name || "—",
      parent_display: row.parent_display || "—",
      breadcrumb,
      breadcrumb_segments: segs,
      firewall_count: row.firewall_count ?? 0,
      sync_issues_count: row.sync_issues_count ?? 0,
      locked_label: row.locked_label || "No",
      created_at: row.created_at || "",
      last_sync: row.last_sync || "",
      updated_at: row.updated_at || "",
      client_id: row.client_id || "",
      imported_from: (row.imported_from && String(row.imported_from).trim()) || "",
      imported_from_firewall_id:
        row.imported_from_firewall_id != null && String(row.imported_from_firewall_id).trim() !== ""
          ? String(row.imported_from_firewall_id).trim()
          : "",
    };
  }

  function groupBreadcrumbHtml(row) {
    const segs = row.breadcrumb_segments || [];
    if (!segs.length) return `<span class="muted">—</span>`;
    return `<span class="group-breadcrumb">${segs
      .map(
        (seg, i) =>
          `${i > 0 ? '<span class="group-breadcrumb__sep" aria-hidden="true"> \u203a </span>' : ""}<span class="group-breadcrumb__segment">${escapeHtml(seg)}</span>`
      )
      .join("")}</span>`;
  }

  function groupFiltered() {
    return grPrepared.filter((row) => {
      for (const [cat, selected] of Object.entries(grFilterState)) {
        if (!selected || selected.size === 0) continue;
        const val =
          cat === "firewall_count"
            ? String(row.firewall_count ?? 0)
            : row[cat] == null || row[cat] === ""
              ? "—"
              : String(row[cat]);
        if (!selected.has(val)) return false;
      }
      return true;
    });
  }

  const grToolbarTenantMs = createToolbarTenantMultiselect({
    prefix: "gr",
    getTenantSet: () => {
      if (!(grFilterState.tenant_name instanceof Set)) grFilterState.tenant_name = new Set();
      return grFilterState.tenant_name;
    },
    getDataRows: () => grPrepared,
    onChange: () => {
      grController.render();
      updateGroupFiltersChrome();
    },
  });

  function buildGroupFilters() {
    grFilterState.tenant_name = new Set();
    const host = document.getElementById("group-filters");
    if (!host) return;
    const groups = [
      { key: "group_name", label: "Group name" },
      { key: "parent_display", label: "Parent group" },
      { key: "locked_label", label: "Locked" },
      { key: "firewall_count", label: "Firewalls" },
    ];

    host.innerHTML = groups
      .map((g, idx) => {
        const opts = distinctValues(grPrepared, g.key, 80);
        grFilterState[g.key] = new Set();
        const open = idx < 3 ? "is-open" : "";
        const optsHtml = opts
          .map(
            (o) => `
          <label class="filter-opt">
            <input type="checkbox" data-cat="${escapeHtml(g.key)}" value="${escapeHtml(o)}" />
            <span>${escapeHtml(o)}</span>
          </label>`
          )
          .join("");
        return `
        <div class="filter-group ${open}" data-cat-wrap="${escapeHtml(g.key)}">
          <button type="button" class="filter-group__head" aria-expanded="${idx < 3}">
            <span>${escapeHtml(g.label)}</span>
            <span class="filter-group__chev">▼</span>
          </button>
          <div class="filter-group__body">${optsHtml}</div>
        </div>`;
      })
      .join("");

    host.querySelectorAll(".filter-group__head").forEach((btn) => {
      btn.addEventListener("click", () => {
        const g = btn.closest(".filter-group");
        g.classList.toggle("is-open");
        btn.setAttribute("aria-expanded", g.classList.contains("is-open"));
      });
    });

    host.querySelectorAll('input[type="checkbox"][data-cat]').forEach((cb) => {
      cb.addEventListener("change", () => {
        const cat = cb.dataset.cat;
        const st = grFilterState[cat];
        if (!st) return;
        if (cb.checked) st.add(cb.value);
        else st.delete(cb.value);
        grController.render();
      });
    });
    updateGroupFiltersChrome();
    grToolbarTenantMs.refresh();
  }

  function groupFacetFilterCount() {
    let n = 0;
    for (const st of Object.values(grFilterState)) {
      if (st instanceof Set) n += st.size;
    }
    return n;
  }

  function updateGroupFiltersChrome() {
    const wrap = document.getElementById("gr-filters-head-actions");
    const countEl = document.getElementById("gr-facet-count");
    const resetBtn = document.getElementById("gr-facet-reset");
    if (!wrap || !countEl || !resetBtn) return;
    const n = groupFacetFilterCount();
    resetBtn.hidden = n === 0;
    if (n === 0) {
      wrap.hidden = true;
      countEl.textContent = "";
      return;
    }
    wrap.hidden = false;
    countEl.innerHTML = `<span class="filters__facet-count-num">${n}</span> applied`;
  }

  function syncGroupFilterCheckboxesFromState() {
    const host = document.getElementById("group-filters");
    if (!host) return;
    host.querySelectorAll('input[type="checkbox"][data-cat]').forEach((cb) => {
      const cat = cb.dataset.cat;
      const st = grFilterState[cat];
      if (!st) return;
      cb.checked = st.has(cb.value);
    });
  }

  function resetGroupFacetFilters() {
    const host = document.getElementById("group-filters");
    for (const st of Object.values(grFilterState)) {
      if (st && typeof st.clear === "function") st.clear();
    }
    if (host) {
      host.querySelectorAll('input[type="checkbox"][data-cat]').forEach((cb) => {
        cb.checked = false;
      });
    }
    grController.render();
    setFiltersPanelCollapsed(document.querySelector("#fw-subpanel-groups .filters"), true);
    schedulePersistUiState();
    grToolbarTenantMs.refresh();
  }

  function grImportFromPillStyleAttr(label) {
    let h = 5381;
    const t = String(label);
    for (let i = 0; i < t.length; i++) {
      h = ((h << 5) + h) ^ t.charCodeAt(i);
    }
    const hue = Math.abs(h) % 360;
    return `background:hsl(${hue} 42% 90%);color:hsl(${hue} 48% 22%);border:1px solid hsl(${hue} 38% 76%)`;
  }

  function renderGrDataCell(colId, row) {
    switch (colId) {
      case "tenant_name": {
        const cell =
          row.tenant_name && row.tenant_name !== "—"
            ? `<button type="button" class="cell-link gr-to-tenant-firewalls" data-tenant-name="${escapeAttr(row.tenant_name)}" title="Show firewalls for this tenant">${escapeHtml(row.tenant_name)}</button>`
            : `<span>${escapeHtml(row.tenant_name)}</span>`;
        return `<td>${cell}</td>`;
      }
      case "breadcrumb": {
        const pill = renderFwRecencyPillHtml(row._recencyTag);
        const tn = escapeAttr(row.tenant_name);
        const gn = escapeAttr(row.group_name);
        const inner = `<button type="button" class="cell-link gr-to-firewalls" data-tenant-name="${tn}" data-group-name="${gn}" title="Show firewalls in this tenant and group">${groupBreadcrumbHtml(row)}</button>`;
        return `<td class="gr-col-group"><span class="table-recency-inline">${pill}${inner}</span></td>`;
      }
      case "imported_from": {
        const v = (row.imported_from || "").trim();
        if (!v) return `<td class="gr-col-imported-from"></td>`;
        const style = grImportFromPillStyleAttr(v);
        const styleEsc = escapeAttr(style);
        const fid = (row.imported_from_firewall_id || "").trim();
        if (fid) {
          const pill = `<button type="button" class="tag-pill gr-import-pill gr-import-pill--action" style="${styleEsc}" data-firewall-id="${escapeAttr(fid)}" title="Show this firewall on the Firewalls tab">${escapeHtml(v)}</button>`;
          return `<td class="gr-col-imported-from">${pill}</td>`;
        }
        const pill = `<span class="tag-pill gr-import-pill" style="${styleEsc}">${escapeHtml(v)}</span>`;
        return `<td class="gr-col-imported-from">${pill}</td>`;
      }
      case "firewall_count": {
        const n = row.firewall_count ?? 0;
        const countStr = escapeHtml(String(n));
        const pill = `<span class="tag-pill tn-col-firewalls-pill">${countStr}</span>`;
        const tn = escapeAttr(row.tenant_name);
        const gn = escapeAttr(row.group_name);
        const inner = `<button type="button" class="cell-link gr-to-firewalls" data-tenant-name="${tn}" data-group-name="${gn}" title="Show firewalls in this tenant and group">${pill}</button>`;
        return `<td class="gr-col-firewalls">${inner}</td>`;
      }
      case "sync_issues_count": {
        const n = Number(row.sync_issues_count);
        const show = Number.isFinite(n) && n > 0;
        const inner = show
          ? `<span class="tag-pill gr-sync-issues-pill">${escapeHtml(String(n))}</span>`
          : "";
        return `<td class="gr-col-sync-issues">${inner}</td>`;
      }
      case "group_name":
        return `<td>${escapeHtml(row.group_name)}</td>`;
      case "parent_display":
        return `<td>${escapeHtml(row.parent_display)}</td>`;
      case "locked_label":
        return `<td>${escapeHtml(row.locked_label)}</td>`;
      case "last_sync":
        return `<td class="muted">${fmtDate(row.last_sync)}</td>`;
      case "updated_at": {
        const iso = row.updated_at;
        const raw = iso == null ? "" : String(iso).trim();
        if (!raw) return `<td class="muted gr-col-updated-at">—</td>`;
        const rel = formatSyncLastRelative(iso, true);
        const full = syncPreciseTimeForTitle(iso);
        const titleAttr = full ? ` title="${escapeAttr(full)}"` : "";
        return `<td class="muted gr-col-updated-at"${titleAttr}>${escapeHtml(rel)}</td>`;
      }
      case "tenant_id":
        return `<td class="fw-col-code">${escapeHtml(row.tenant_id)}</td>`;
      case "id":
        return `<td class="fw-col-code">${escapeHtml(row.id)}</td>`;
      default:
        return "<td></td>";
    }
  }

  function renderGroupDataRow(row, selected) {
    const cells = GR_COLUMNS.filter((c) => grColVisible[c.id])
      .map((c) => renderGrDataCell(c.id, row))
      .join("");
    const checked = selected.has(row._id) ? " checked" : "";
    return `<tr>
        <td class="th-check"><input type="checkbox" class="row-check" data-id="${escapeHtml(row._id)}"${checked} /></td>
        ${cells}
      </tr>`;
  }

  buildGrThead();

  const grTableEl = document.getElementById("gr-table");
  const grController = createTableController({
    tbody: document.getElementById("gr-tbody"),
    countEl: document.getElementById("gr-count"),
    rangeEl: document.getElementById("gr-lazy-hint"),
    pageSizeEl: document.getElementById("gr-page-size"),
    searchInput: document.getElementById("gr-search"),
    selectAllInput: document.getElementById("gr-select-all"),
    sortHeaders: [],
    sortDelegateRoot: grTableEl,
    getFilteredRows: groupFiltered,
    getRowSearchText: (row) =>
      [
        row.tenant_name,
        row.imported_from,
        row.imported_from_firewall_id,
        row.breadcrumb,
        row.group_name,
        row.parent_display,
        row.locked_label,
        String(row.firewall_count),
        String(row.sync_issues_count ?? 0),
        row.last_sync,
        row.updated_at,
        row.tenant_id,
        row.id,
        ...(row.breadcrumb_segments || []),
      ]
        .join(" ")
        .toLowerCase(),
    renderRow: (row, selected) => renderGroupDataRow(row, selected),
    afterRender: () => {
      updateGroupFiltersChrome();
      updateGrDeleteGroupsButtonState();
    },
    onSelectionChange: () => {
      updateGrDeleteGroupsButtonState();
    },
  });

  initGrColumnPicker();

  function setGrDeleteGroupsModalOpen(open) {
    const modal = document.getElementById("gr-delete-groups-modal");
    if (!modal) return;
    modal.hidden = !open;
    modal.setAttribute("aria-hidden", open ? "false" : "true");
  }

  function initGrDeleteGroupsModal() {
    const modal = document.getElementById("gr-delete-groups-modal");
    const openBtn = document.getElementById("gr-delete-groups-btn");
    const cancel = document.getElementById("gr-delete-groups-cancel");
    const proceed = document.getElementById("gr-delete-groups-proceed");
    const closeBtn = document.getElementById("gr-delete-groups-modal-close");
    const backdrop = modal?.querySelector(".gr-delete-groups-modal__backdrop");
    const statusEl = document.getElementById("gr-delete-groups-modal-status");
    const leadEl = document.getElementById("gr-delete-groups-modal-lead");

    function closeModal() {
      if (statusEl) statusEl.textContent = "";
      setGrDeleteGroupsModalOpen(false);
      openBtn?.focus();
    }

    openBtn?.addEventListener("click", () => {
      if (!isAdmin() || openBtn.disabled) return;
      const ids = grController.getSelectedIds().filter(Boolean);
      const n = ids.length;
      if (n === 0) return;
      if (statusEl) statusEl.textContent = "";
      const proceedLabel = n === 1 ? "Delete 1 group" : `Delete ${n} groups`;
      if (proceed) {
        proceed.textContent = proceedLabel;
        proceed.setAttribute("aria-label", proceedLabel);
      }
      if (leadEl) {
        leadEl.textContent =
          n === 1
            ? "The selected group will be permanently deleted on Sophos Central if you continue."
            : `The ${n} selected groups will be permanently deleted on Sophos Central if you continue.`;
      }
      setGrDeleteGroupsModalOpen(true);
      cancel?.focus();
    });

    cancel?.addEventListener("click", closeModal);
    closeBtn?.addEventListener("click", closeModal);
    backdrop?.addEventListener("click", closeModal);

    proceed?.addEventListener("click", async () => {
      if (!isAdmin() || proceed.disabled) return;
      const ids = grController.getSelectedIds().filter(Boolean);
      if (ids.length === 0) return;
      if (statusEl) statusEl.textContent = "";
      proceed.disabled = true;
      try {
        const res = await apiRequestJson("/api/firewall-groups/delete-batch", {
          method: "POST",
          body: JSON.stringify({ group_ids: ids }),
        });
        const lines = [];
        if (res.deleted && res.deleted.length > 0) {
          lines.push(`Deleted on Central: ${res.deleted.length}`);
        }
        if (res.errors && res.errors.length > 0) {
          lines.push(
            `Errors: ${res.errors.length}`,
            ...res.errors.slice(0, 5).map((x) => `  ${x.id}: ${x.detail}`)
          );
        }
        if (res.credential_syncs && res.credential_syncs.length > 0) {
          const failed = res.credential_syncs.filter((s) => !s.ok);
          if (failed.length > 0) {
            lines.push(
              `Credential sync issues: ${failed.length}`,
              ...failed.slice(0, 3).map((s) => `  ${s.credential_id}: ${s.error || "failed"}`)
            );
          }
        }
        const msg = lines.length ? lines.join("\n") : "Done.";
        const variant =
          /(^|\n)Errors?:/i.test(msg) || /(^|\n)Credential sync issues:/i.test(msg)
            ? "info"
            : "success";
        notifyAppUser("Delete firewall groups", msg, variant);
        closeModal();
        grController.clearSelection();
        await loadFirewallGroups({ preserve: true });
        grController.render();
        refreshAppSyncStatusBar();
      } catch (err) {
        if (statusEl) {
          statusEl.textContent = err && err.message ? err.message : String(err);
        } else {
          notifyAppUser(
            "Delete firewall groups",
            err && err.message ? err.message : String(err),
            "error"
          );
        }
      } finally {
        proceed.disabled = false;
      }
    });

    document.addEventListener("keydown", (e) => {
      const m = document.getElementById("gr-delete-groups-modal");
      if (!m || m.hidden) return;
      if (e.key === "Escape") {
        e.preventDefault();
        closeModal();
      }
    });
  }

  initGrDeleteGroupsModal();

  let grCreateImportSources = [];
  let grCreateAvailableAll = [];
  let grCreateAssignedIds = [];
  let grCreateSelectedAvailId = "";
  let grCreateSelectedAssignedId = "";
  let grCreateSelectedImportId = "";
  let grCreateModalFocusBefore = null;

  function grCreateFirewallLabel(fw) {
    const name = (fw && fw.name != null && String(fw.name).trim() !== "" ? String(fw.name).trim() : null) || "—";
    const host = fw && fw.hostname != null && String(fw.hostname).trim() !== "" ? String(fw.hostname).trim() : "";
    return { name, host };
  }

  function grCreateMatchesSearch(fw, q) {
    const t = (q || "").trim().toLowerCase();
    if (!t) return true;
    const { name, host } = grCreateFirewallLabel(fw);
    return `${name} ${host}`.toLowerCase().includes(t);
  }

  function grCreateByIdMap() {
    const m = new Map();
    for (const f of grCreateImportSources) {
      const id = String(f.id || "").trim();
      if (id) m.set(id, f);
    }
    for (const f of grCreateAvailableAll) {
      const id = String(f.id || "").trim();
      if (id) m.set(id, f);
    }
    return m;
  }

  function grCreateRenderFwRowHtml(fw, selectedId, role) {
    const id = String(fw.id || "").trim();
    const { name, host } = grCreateFirewallLabel(fw);
    const icon = renderFirewallStatusIconHtml(fw);
    const sel = id === selectedId ? " is-selected" : "";
    return `<li role="option" tabindex="-1" class="gr-create-group-modal__fw-item${sel}" data-fw-id="${escapeAttr(id)}" data-role="${escapeAttr(role)}">
      ${icon}
      <div class="gr-create-group-modal__fw-item-main">
        <span class="gr-create-group-modal__fw-badge">${escapeHtml(name)}</span>
        ${host ? `<span class="gr-create-group-modal__fw-host">${escapeHtml(host)}</span>` : ""}
      </div>
    </li>`;
  }

  function grCreateFilteredAvailable() {
    const q = document.getElementById("gr-create-avail-search")?.value || "";
    const assigned = new Set(grCreateAssignedIds);
    return grCreateAvailableAll.filter((f) => {
      const id = String(f.id || "").trim();
      return id && !assigned.has(id) && grCreateMatchesSearch(f, q);
    });
  }

  function grCreateFilteredAssigned() {
    const q = document.getElementById("gr-create-assigned-search")?.value || "";
    const m = grCreateByIdMap();
    return grCreateAssignedIds.map((id) => m.get(id)).filter((f) => f && grCreateMatchesSearch(f, q));
  }

  function grCreateRenderDualLists() {
    const availEl = document.getElementById("gr-create-avail-list");
    const assEl = document.getElementById("gr-create-assigned-list");
    if (!availEl || !assEl) return;
    const fa = grCreateFilteredAvailable();
    const fb = grCreateFilteredAssigned();
    if (grCreateSelectedAvailId && !fa.some((x) => String(x.id) === grCreateSelectedAvailId)) {
      grCreateSelectedAvailId = "";
    }
    if (grCreateSelectedAssignedId && !fb.some((x) => String(x.id) === grCreateSelectedAssignedId)) {
      grCreateSelectedAssignedId = "";
    }
    availEl.innerHTML = fa.map((f) => grCreateRenderFwRowHtml(f, grCreateSelectedAvailId, "avail")).join("");
    assEl.innerHTML = fb.map((f) => grCreateRenderFwRowHtml(f, grCreateSelectedAssignedId, "assigned")).join("");
    grCreateUpdateXferButtons();
  }

  function grCreateRenderImportList() {
    const host = document.getElementById("gr-create-import-list");
    if (!host) return;
    if (grCreateSelectedImportId && !grCreateImportSources.some((x) => String(x.id) === grCreateSelectedImportId)) {
      grCreateSelectedImportId = "";
    }
    host.innerHTML = grCreateImportSources
      .map((f) => grCreateRenderFwRowHtml(f, grCreateSelectedImportId, "import"))
      .join("");
  }

  function grCreateUpdateXferButtons() {
    const b1 = document.getElementById("gr-create-xfer-one-right");
    const b2 = document.getElementById("gr-create-xfer-all-right");
    const b3 = document.getElementById("gr-create-xfer-one-left");
    const b4 = document.getElementById("gr-create-xfer-all-left");
    const fa = grCreateFilteredAvailable();
    const nAss = grCreateAssignedIds.length;
    if (b1) b1.disabled = !grCreateSelectedAvailId || !fa.some((x) => String(x.id) === grCreateSelectedAvailId);
    if (b2) b2.disabled = fa.length === 0;
    if (b3) b3.disabled = !grCreateSelectedAssignedId;
    if (b4) b4.disabled = nAss === 0;
  }

  function grCreateConfigMode() {
    const imp = document.getElementById("gr-create-config-import");
    return imp && imp.checked ? "import" : "default";
  }

  function grCreateUpdateImportVisibility() {
    const wrap = document.getElementById("gr-create-import-wrap");
    const importRadio = document.getElementById("gr-create-config-import");
    if (!wrap) return;
    const show = importRadio && importRadio.checked;
    wrap.hidden = !show;
    if (!show) {
      grCreateSelectedImportId = "";
      grCreateRenderImportList();
    } else {
      grCreateRenderImportList();
    }
  }

  function grCreateSetTenantReady(ready) {
    const lock = document.getElementById("gr-create-group-main-lock");
    const nameIn = document.getElementById("gr-create-group-name");
    const fs = document.getElementById("gr-create-group-fields");
    if (lock) {
      lock.classList.toggle("gr-create-group-modal__main-lock--inactive", !ready);
    }
    if (nameIn) {
      nameIn.disabled = !ready;
    }
    if (fs) {
      fs.disabled = !ready;
    }
    grCreateUpdateSubmitEnabled();
  }

  function grCreateUpdateSubmitEnabled() {
    const btn = document.getElementById("gr-create-group-submit");
    const nameIn = document.getElementById("gr-create-group-name");
    if (!btn || !nameIn || nameIn.disabled) {
      if (btn) btn.disabled = true;
      return;
    }
    const name = (nameIn.value || "").trim();
    if (!name) {
      btn.disabled = true;
      return;
    }
    if (grCreateConfigMode() === "import" && grCreateImportSources.length > 0 && !grCreateSelectedImportId) {
      btn.disabled = true;
      return;
    }
    btn.disabled = false;
  }

  function resetGrCreateGroupModal() {
    grCreateImportSources = [];
    grCreateAvailableAll = [];
    grCreateAssignedIds = [];
    grCreateSelectedAvailId = "";
    grCreateSelectedAssignedId = "";
    grCreateSelectedImportId = "";
    const tenantSel = document.getElementById("gr-create-tenant");
    if (tenantSel) tenantSel.value = "";
    const nameIn = document.getElementById("gr-create-group-name");
    if (nameIn) nameIn.value = "";
    const defRadio = document.getElementById("gr-create-config-default");
    if (defRadio) defRadio.checked = true;
    const st = document.getElementById("gr-create-group-modal-status");
    if (st) st.textContent = "";
    const avs = document.getElementById("gr-create-avail-search");
    const ass = document.getElementById("gr-create-assigned-search");
    if (avs) avs.value = "";
    if (ass) ass.value = "";
    grCreateSetTenantReady(false);
    grCreateUpdateImportVisibility();
    grCreateRenderDualLists();
    grCreateRenderImportList();
    grCreateUpdateSubmitEnabled();
  }

  async function openGrCreateGroupModal() {
    const modal = document.getElementById("gr-create-group-modal");
    if (!modal) return;
    resetGrCreateGroupModal();
    grCreateModalFocusBefore = document.activeElement;
    modal.hidden = false;
    modal.setAttribute("aria-hidden", "false");
    document.body.style.overflow = "hidden";
    try {
      const tenants = await loadJson("/api/tenants");
      const sel = document.getElementById("gr-create-tenant");
      if (sel) {
        const cur = sel.value;
        sel.innerHTML =
          '<option value="">Select tenant…</option>' +
          (Array.isArray(tenants)
            ? tenants
                .map((t) => {
                  const id = String(t.id || "").trim();
                  if (!id) return "";
                  const lab = String(t.show_as || t.name || id).trim() || id;
                  return `<option value="${escapeAttr(id)}">${escapeHtml(lab)}</option>`;
                })
                .join("")
            : "");
        if (cur && [...sel.options].some((o) => o.value === cur)) sel.value = cur;
      }
    } catch {
      const st = document.getElementById("gr-create-group-modal-status");
      if (st) st.textContent = "Could not load tenants.";
    }
    document.getElementById("gr-create-tenant")?.focus();
  }

  function closeGrCreateGroupModal() {
    const modal = document.getElementById("gr-create-group-modal");
    if (!modal || modal.hidden) return;
    modal.hidden = true;
    modal.setAttribute("aria-hidden", "true");
    document.body.style.overflow = "";
    if (grCreateModalFocusBefore && typeof grCreateModalFocusBefore.focus === "function") {
      grCreateModalFocusBefore.focus();
    }
    grCreateModalFocusBefore = null;
  }

  async function grCreateOnTenantSelected() {
    const sel = document.getElementById("gr-create-tenant");
    const st = document.getElementById("gr-create-group-modal-status");
    const tid = (sel?.value || "").trim();
    grCreateImportSources = [];
    grCreateAvailableAll = [];
    grCreateAssignedIds = [];
    grCreateSelectedAvailId = "";
    grCreateSelectedAssignedId = "";
    grCreateSelectedImportId = "";
    const avs = document.getElementById("gr-create-avail-search");
    const ass = document.getElementById("gr-create-assigned-search");
    if (avs) avs.value = "";
    if (ass) ass.value = "";
    if (!tid) {
      grCreateSetTenantReady(false);
      if (st) st.textContent = "";
      grCreateUpdateImportVisibility();
      grCreateRenderDualLists();
      return;
    }
    grCreateSetTenantReady(false);
    if (st) st.textContent = "Loading firewalls…";
    try {
      const data = await loadJson(
        `/api/tenants/${encodeURIComponent(tid)}/firewall-group-create-data`
      );
      grCreateImportSources = Array.isArray(data.import_sources) ? data.import_sources : [];
      grCreateAvailableAll = Array.isArray(data.available_firewalls) ? data.available_firewalls : [];
      if (st) st.textContent = "";
      grCreateSetTenantReady(true);
    } catch (err) {
      if (st) {
        st.textContent =
          err && err.message ? String(err.message) : "Could not load firewalls for this tenant.";
      }
      grCreateSetTenantReady(false);
      grCreateImportSources = [];
      grCreateAvailableAll = [];
    }
    grCreateUpdateImportVisibility();
    grCreateRenderDualLists();
    grCreateUpdateSubmitEnabled();
  }

  function initGrCreateGroupModal() {
    document.getElementById("gr-create-group-btn")?.addEventListener("click", () => {
      if (!isAdmin()) return;
      openGrCreateGroupModal();
    });
    document.getElementById("gr-create-group-modal-close")?.addEventListener("click", () => {
      closeGrCreateGroupModal();
    });
    document.getElementById("gr-create-group-cancel")?.addEventListener("click", () => {
      closeGrCreateGroupModal();
    });
    document.getElementById("gr-create-group-modal")?.querySelector(".gr-create-group-modal__backdrop")
      ?.addEventListener("click", () => {
        closeGrCreateGroupModal();
      });
    document.getElementById("gr-create-tenant")?.addEventListener("change", () => {
      grCreateOnTenantSelected();
    });
    document.getElementById("gr-create-group-name")?.addEventListener("input", () => {
      grCreateUpdateSubmitEnabled();
    });
    document.getElementById("gr-create-config-default")?.addEventListener("change", () => {
      grCreateUpdateImportVisibility();
      grCreateUpdateSubmitEnabled();
    });
    document.getElementById("gr-create-config-import")?.addEventListener("change", () => {
      grCreateUpdateImportVisibility();
      grCreateUpdateSubmitEnabled();
    });
    document.getElementById("gr-create-avail-search")?.addEventListener("input", () => {
      grCreateRenderDualLists();
    });
    document.getElementById("gr-create-assigned-search")?.addEventListener("input", () => {
      grCreateRenderDualLists();
    });
    document.getElementById("gr-create-avail-list")?.addEventListener("click", (e) => {
      const li = e.target.closest(".gr-create-group-modal__fw-item[data-role='avail']");
      if (!li) return;
      grCreateSelectedAvailId = li.getAttribute("data-fw-id") || "";
      grCreateRenderDualLists();
    });
    document.getElementById("gr-create-assigned-list")?.addEventListener("click", (e) => {
      const li = e.target.closest(".gr-create-group-modal__fw-item[data-role='assigned']");
      if (!li) return;
      grCreateSelectedAssignedId = li.getAttribute("data-fw-id") || "";
      grCreateRenderDualLists();
    });
    document.getElementById("gr-create-import-list")?.addEventListener("click", (e) => {
      const li = e.target.closest(".gr-create-group-modal__fw-item[data-role='import']");
      if (!li) return;
      grCreateSelectedImportId = li.getAttribute("data-fw-id") || "";
      grCreateRenderImportList();
      grCreateUpdateSubmitEnabled();
    });
    document.getElementById("gr-create-xfer-one-right")?.addEventListener("click", () => {
      if (!grCreateSelectedAvailId) return;
      if (!grCreateAssignedIds.includes(grCreateSelectedAvailId)) {
        grCreateAssignedIds.push(grCreateSelectedAvailId);
      }
      grCreateSelectedAvailId = "";
      grCreateRenderDualLists();
      grCreateUpdateSubmitEnabled();
    });
    document.getElementById("gr-create-xfer-all-right")?.addEventListener("click", () => {
      const add = grCreateFilteredAvailable().map((f) => String(f.id));
      const seen = new Set(grCreateAssignedIds);
      for (const id of add) {
        if (!seen.has(id)) {
          grCreateAssignedIds.push(id);
          seen.add(id);
        }
      }
      grCreateSelectedAvailId = "";
      grCreateRenderDualLists();
      grCreateUpdateSubmitEnabled();
    });
    document.getElementById("gr-create-xfer-one-left")?.addEventListener("click", () => {
      if (!grCreateSelectedAssignedId) return;
      grCreateAssignedIds = grCreateAssignedIds.filter((x) => x !== grCreateSelectedAssignedId);
      grCreateSelectedAssignedId = "";
      grCreateRenderDualLists();
      grCreateUpdateSubmitEnabled();
    });
    document.getElementById("gr-create-xfer-all-left")?.addEventListener("click", () => {
      grCreateAssignedIds = [];
      grCreateSelectedAssignedId = "";
      grCreateRenderDualLists();
      grCreateUpdateSubmitEnabled();
    });
    document.getElementById("gr-create-group-submit")?.addEventListener("click", async () => {
      const tid = (document.getElementById("gr-create-tenant")?.value || "").trim();
      const name = (document.getElementById("gr-create-group-name")?.value || "").trim();
      if (!tid || !name) return;
      let importId = null;
      if (grCreateConfigMode() === "import") {
        if (grCreateImportSources.length > 0) {
          importId = grCreateSelectedImportId || null;
          if (!importId) return;
        }
      }
      const btn = document.getElementById("gr-create-group-submit");
      if (btn) btn.disabled = true;
      try {
        const res = await apiRequestJson("/api/firewall-groups/create", {
          method: "POST",
          body: JSON.stringify({
            tenant_id: tid,
            name,
            assign_firewall_ids: [...grCreateAssignedIds],
            config_import_source_firewall_id: importId,
          }),
        });
        const lines = ["Firewall group created."];
        if (res && res.group_id) lines.push(`Group id: ${res.group_id}`);
        if (res && res.credential_syncs && res.credential_syncs.length) {
          const bad = res.credential_syncs.filter((s) => !s.ok);
          if (bad.length) {
            lines.push("Credential sync issues:", ...bad.slice(0, 3).map((s) => `  ${s.error || "failed"}`));
          }
        }
        const groupText = lines.join("\n");
        const groupVariant = /Credential sync issues/i.test(groupText) ? "info" : "success";
        notifyAppUser("Firewall group", groupText, groupVariant);
        closeGrCreateGroupModal();
        await loadFirewallGroups({ preserve: true });
      } catch (err) {
        notifyAppUser("Firewall group", err && err.message ? err.message : String(err), "error");
      } finally {
        grCreateUpdateSubmitEnabled();
      }
    });
    document.addEventListener("keydown", (e) => {
      const modal = document.getElementById("gr-create-group-modal");
      if (!modal || modal.hidden) return;
      if (e.key === "Escape") {
        e.preventDefault();
        closeGrCreateGroupModal();
      }
    });
  }

  initGrCreateGroupModal();

  document.getElementById("gr-tbody")?.addEventListener("click", (e) => {
    const imp = e.target.closest("button.gr-import-pill--action");
    if (imp) {
      const fid = imp.getAttribute("data-firewall-id");
      if (fid) goToFirewallsFilteredByFirewallId(fid);
      return;
    }
    const t = e.target.closest("button.gr-to-tenant-firewalls");
    if (t) {
      const tenantName = t.getAttribute("data-tenant-name");
      if (tenantName) goToFirewallsFilteredByTenant(tenantName);
      return;
    }
    const g = e.target.closest("button.gr-to-firewalls");
    if (g) {
      const tenantName = g.getAttribute("data-tenant-name");
      const groupName = g.getAttribute("data-group-name");
      goToFirewallsFilteredByTenantAndGroup(tenantName, groupName);
    }
  });

  async function loadFirewallGroups(opts = {}) {
    const preserve = opts.preserve === true;
    let snap = null;
    if (preserve) {
      snap = {};
      for (const [k, st] of Object.entries(grFilterState)) {
        if (st instanceof Set && st.size > 0) snap[k] = [...st];
      }
    }
    const rows = await loadJson("/api/firewall-groups");
    grPrepared = rows.map(prepareGroup);
    applyListRecencyTags(grPrepared, {
      createdKey: "created_at",
      stateKey: "updated_at",
      lastSyncKey: "last_sync",
      clientKey: "client_id",
    });
    buildGroupFilters();
    if (preserve && snap) {
      for (const [k, arr] of Object.entries(snap)) {
        const st = grFilterState[k];
        if (st && Array.isArray(arr)) {
          arr.forEach((x) => st.add(String(x)));
        }
      }
      syncGroupFilterCheckboxesFromState();
      updateGroupFiltersChrome();
    }
    if (!preserve) {
      grController.clearSelection();
      grController.resetPage();
    }
    grToolbarTenantMs.refresh();
  }

  /* ---------- Licenses ---------- */
  let lcPrepared = [];
  let lcDetailPrepared = [];
  const lcFilterState = {};
  let lcViewMode = "summary";

  const lcEndDatePresetSelections = new Set();
  let lcEndDateCustomFrom = "";
  let lcEndDateCustomTo = "";
  const lcStartDatePresetSelections = new Set();
  let lcStartDateCustomFrom = "";
  let lcStartDateCustomTo = "";

  const LC_COL_KEYS = {
    summary: "sophos-central-lc-columns-v1",
    details: "sophos-central-lc-columns-v1-details",
  };

  const LC_COLUMNS_SUMMARY = [
    { id: "serial_number", label: "Serial number", sortKey: "serial_number", thClass: "th-sortable" },
    {
      id: "firewall_hostname",
      label: "Hostname",
      sortKey: "firewall_hostname",
      thClass: "th-sortable",
    },
    {
      id: "managed_by_tenant",
      label: "Manage By",
      sortKey: "managed_by_tenant",
      thClass: "th-sortable",
    },
    { id: "tenant_name", label: "Tenant", sortKey: "tenant_name", thClass: "th-sortable" },
    { id: "model", label: "Model", sortKey: "model", thClass: "th-sortable" },
    { id: "model_type", label: "Model type", sortKey: "model_type", thClass: "th-sortable" },
    { id: "last_seen_at", label: "Last seen", sortKey: "last_seen_at", thClass: "th-sortable" },
    {
      id: "subscription_count",
      label: "Subscriptions",
      sortKey: "subscription_count",
      thClass: "th-sortable lc-col-subscriptions",
    },
    { id: "state", label: "State", sortKey: "state", thClass: "th-sortable" },
    {
      id: "tenant_id",
      label: "Tenant ID",
      sortKey: "tenant_id",
      thClass: "th-sortable fw-col-code",
      defaultVisible: false,
    },
    {
      id: "partner_id",
      label: "Partner ID",
      sortKey: "partner_id",
      thClass: "th-sortable fw-col-code",
      defaultVisible: false,
    },
    {
      id: "organization_id",
      label: "Organization ID",
      sortKey: "organization_id",
      thClass: "th-sortable fw-col-code",
      defaultVisible: false,
    },
  ];

  const LC_COLUMNS_DETAILS = [
    {
      id: "serial_number",
      label: "Serial number",
      sortKey: "serial_number",
      thClass: "th-sortable",
    },
    {
      id: "license_identifier",
      label: "License identifier",
      sortKey: "license_identifier",
      thClass: "th-sortable fw-col-code",
    },
    { id: "product_name", label: "Product", sortKey: "product_name", thClass: "th-sortable" },
    {
      id: "product_code",
      label: "Product code",
      sortKey: "product_code",
      thClass: "th-sortable fw-col-code",
    },
    {
      id: "subscription_type",
      label: "Subscription type",
      sortKey: "subscription_type",
      thClass: "th-sortable",
    },
    { id: "start_date", label: "Start", sortKey: "start_date", thClass: "th-sortable" },
    { id: "end_date", label: "End", sortKey: "end_date", thClass: "th-sortable" },
    { id: "perpetual", label: "Perpetual", sortKey: "perpetual", thClass: "th-sortable" },
    { id: "unlimited", label: "Unlimited", sortKey: "unlimited", thClass: "th-sortable" },
    { id: "quantity", label: "Quantity", sortKey: "quantity", thClass: "th-sortable" },
    { id: "usage_count", label: "Usage", sortKey: "usage_count", thClass: "th-sortable" },
    {
      id: "subscription_state",
      label: "Subscription state",
      sortKey: "subscription_state",
      thClass: "th-sortable",
    },
    {
      id: "license_state",
      label: "License state",
      sortKey: "license_state",
      thClass: "th-sortable",
    },
    { id: "tenant_name", label: "Tenant", sortKey: "tenant_name", thClass: "th-sortable" },
    { id: "model", label: "Model", sortKey: "model", thClass: "th-sortable" },
    {
      id: "firewall_hostname",
      label: "Hostname",
      sortKey: "firewall_hostname",
      thClass: "th-sortable",
    },
    {
      id: "managed_by_tenant",
      label: "Manage By",
      sortKey: "managed_by_tenant",
      thClass: "th-sortable",
      defaultVisible: false,
    },
    {
      id: "model_type",
      label: "Model type",
      sortKey: "model_type",
      thClass: "th-sortable",
      defaultVisible: false,
    },
    {
      id: "last_seen_at",
      label: "Last seen",
      sortKey: "last_seen_at",
      thClass: "th-sortable",
      defaultVisible: false,
    },
  ];

  function getLcColumns() {
    return lcViewMode === "details" ? LC_COLUMNS_DETAILS : LC_COLUMNS_SUMMARY;
  }

  function defaultLcColVisFor(columns) {
    const o = {};
    columns.forEach((c) => {
      o[c.id] = c.defaultVisible !== false;
    });
    return o;
  }

  function loadLcColumnVisibilitySnapshot(mode) {
    const columns = mode === "details" ? LC_COLUMNS_DETAILS : LC_COLUMNS_SUMMARY;
    const d = defaultLcColVisFor(columns);
    const key = LC_COL_KEYS[mode];
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return d;
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        columns.forEach((c) => {
          if (typeof parsed[c.id] === "boolean") d[c.id] = parsed[c.id];
        });
      }
    } catch {
      /* ignore */
    }
    return d;
  }

  let lcColVisible = loadLcColumnVisibilitySnapshot("summary");

  function persistLcColumnVisibilityNow() {
    try {
      localStorage.setItem(LC_COL_KEYS[lcViewMode], JSON.stringify(lcColVisible));
    } catch {
      /* ignore */
    }
  }

  function buildLcThead() {
    const tr = document.getElementById("lc-thead-row");
    if (!tr) return;
    tr.replaceChildren();
    getLcColumns().forEach((col) => {
      if (!lcColVisible[col.id]) return;
      const th = document.createElement("th");
      th.scope = "col";
      th.textContent = col.label;
      if (col.sortKey) {
        th.dataset.sort = col.sortKey;
        th.className = col.thClass || "th-sortable";
      } else {
        th.className = col.thClass || "";
      }
      tr.appendChild(th);
    });
  }

  function updateLcViewToggleUi() {
    const sum = document.getElementById("lc-view-summary");
    const det = document.getElementById("lc-view-details");
    if (!sum || !det) return;
    sum.setAttribute("aria-pressed", lcViewMode === "summary" ? "true" : "false");
    det.setAttribute("aria-pressed", lcViewMode === "details" ? "true" : "false");
  }

  function filterLcColumnMenuList() {
    const q = (document.getElementById("lc-cols-filter")?.value || "").trim().toLowerCase();
    const list = document.getElementById("lc-cols-list");
    if (!list) return;
    list.querySelectorAll("li[data-col-label]").forEach((li) => {
      const lab = (li.dataset.colLabel || "").toLowerCase();
      li.hidden = q !== "" && !lab.includes(q);
    });
  }

  function buildLcColumnMenuList() {
    const list = document.getElementById("lc-cols-list");
    if (!list) return;
    list.innerHTML = getLcColumns().map(
      (c) => `
      <li class="toolbar__cols-item" data-col-id="${escapeHtml(c.id)}" data-col-label="${escapeHtml(c.label.toLowerCase())}">
        <label class="toolbar__cols-label">
          <input type="checkbox" data-lc-col="${escapeHtml(c.id)}" ${lcColVisible[c.id] ? "checked" : ""} />
          <span>${escapeHtml(c.label)}</span>
        </label>
      </li>`
    ).join("");
    filterLcColumnMenuList();
  }

  function positionLcColsDropdown() {
    const btn = document.getElementById("lc-cols-trigger");
    const panel = document.getElementById("lc-cols-panel");
    const modal = document.getElementById("lc-cols-modal");
    if (!btn || !panel || !modal || modal.hidden) return;
    panel.style.maxHeight = "";
    const r = btn.getBoundingClientRect();
    const gap = 6;
    const margin = 8;
    const pw = panel.offsetWidth || Math.min(380, window.innerWidth - 2 * margin);
    let left = r.left;
    if (left + pw > window.innerWidth - margin) {
      left = window.innerWidth - margin - pw;
    }
    left = Math.max(margin, left);
    const topBelow = r.bottom + gap;
    panel.style.left = `${left}px`;
    panel.style.top = `${topBelow}px`;
    const after = panel.getBoundingClientRect();
    if (after.bottom > window.innerHeight - margin) {
      const aboveTop = r.top - gap - after.height;
      if (aboveTop >= margin) {
        panel.style.top = `${aboveTop}px`;
      } else {
        panel.style.top = `${margin}px`;
        panel.style.maxHeight = `${Math.max(120, window.innerHeight - 2 * margin)}px`;
      }
    }
  }

  function setLcColumnPanelOpen(open) {
    const modal = document.getElementById("lc-cols-modal");
    const btn = document.getElementById("lc-cols-trigger");
    const panel = document.getElementById("lc-cols-panel");
    if (!modal || !btn) return;
    modal.hidden = !open;
    modal.setAttribute("aria-hidden", open ? "false" : "true");
    btn.setAttribute("aria-expanded", open ? "true" : "false");
    if (!open && panel) {
      panel.style.top = "";
      panel.style.left = "";
      panel.style.maxHeight = "";
    }
    if (open) {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => positionLcColsDropdown());
      });
    }
  }

  function initLcColumnPicker() {
    buildLcColumnMenuList();
    const btn = document.getElementById("lc-cols-trigger");
    const modal = document.getElementById("lc-cols-modal");
    const panel = document.getElementById("lc-cols-panel");
    const filterIn = document.getElementById("lc-cols-filter");
    const list = document.getElementById("lc-cols-list");
    const closeBtn = document.getElementById("lc-cols-close");
    if (!btn || !modal || !panel) return;
    list?.addEventListener("change", (e) => {
      const cb = e.target.closest("input[data-lc-col]");
      if (!cb) return;
      const id = cb.dataset.lcCol;
      if (!id || !Object.prototype.hasOwnProperty.call(lcColVisible, id)) return;
      const col = getLcColumns().find((c) => c.id === id);
      if (col && !cb.checked && lcController.getSortKey() === col.sortKey) {
        lcController.resetSort();
      }
      lcColVisible[id] = cb.checked;
      persistLcColumnVisibilityNow();
      buildLcThead();
      lcController.render();
    });
    function openLcColsModalFromTrigger() {
      const willOpen = modal.hidden;
      setLcColumnPanelOpen(willOpen);
      if (willOpen) {
        buildLcColumnMenuList();
        filterIn?.focus();
      }
    }
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      openLcColsModalFromTrigger();
    });
    btn.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        openLcColsModalFromTrigger();
      }
    });
    filterIn?.addEventListener("input", () => filterLcColumnMenuList());
    closeBtn?.addEventListener("click", () => {
      setLcColumnPanelOpen(false);
      btn.focus();
    });
    modal.querySelector(".fw-cols-modal__backdrop")?.addEventListener("click", () => {
      setLcColumnPanelOpen(false);
      btn.focus();
    });
    document.addEventListener("mousedown", (e) => {
      if (modal.hidden) return;
      if (btn.contains(e.target) || panel.contains(e.target)) return;
      setLcColumnPanelOpen(false);
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !modal.hidden) {
        setLcColumnPanelOpen(false);
        btn.focus();
      }
    });

    function repositionLcColsIfOpen() {
      if (!modal.hidden) positionLcColsDropdown();
    }
    window.addEventListener("resize", repositionLcColsIfOpen);
    window.addEventListener("scroll", repositionLcColsIfOpen, true);
  }

  function prepareLicense(row) {
    const hostLabel =
      row.firewall_host_label != null && String(row.firewall_host_label).trim() !== ""
        ? String(row.firewall_host_label).trim()
        : "";
    const managedBy =
      row.managed_by_tenant != null && String(row.managed_by_tenant).trim() !== ""
        ? String(row.managed_by_tenant).trim()
        : "";
    return {
      _id: row.serial_number,
      _licenseSerial: row.serial_number != null && String(row.serial_number).trim() !== "" ? String(row.serial_number).trim() : "",
      serial_number: row.serial_number || "—",
      firewall_hostname: hostLabel,
      managed_by_tenant: managedBy,
      tenant_name: row.tenant_name || "—",
      tenant_id: row.tenant_id || "—",
      partner_id: row.partner_id || "—",
      organization_id: row.organization_id || "—",
      model: row.model || "—",
      model_type: row.model_type || "—",
      last_seen_at: row.last_seen_at || "",
      subscription_count: row.subscription_count ?? 0,
      state: row.state === "Active" ? "Active" : "Expired",
    };
  }

  function prepareLicenseDetail(row) {
    const hostLabel =
      row.firewall_host_label != null && String(row.firewall_host_label).trim() !== ""
        ? String(row.firewall_host_label).trim()
        : "";
    const managedBy =
      row.managed_by_tenant != null && String(row.managed_by_tenant).trim() !== ""
        ? String(row.managed_by_tenant).trim()
        : "";
    const serialRaw = row.serial_number != null && String(row.serial_number).trim() !== "" ? String(row.serial_number).trim() : "";
    const serial = serialRaw || "—";
    const subId =
      row.subscription_id != null && String(row.subscription_id).trim() !== ""
        ? String(row.subscription_id).trim()
        : "";
    const subStateRaw = row.subscription_state;
    let subscription_state = "—";
    if (subId) {
      subscription_state = subStateRaw === "Active" ? "Active" : "Expired";
    }
    const qty = row.quantity;
    const usage = row.usage_count;
    return {
      _id: subId ? `${serialRaw}|${subId}` : `${serialRaw}|`,
      _licenseSerial: serialRaw,
      serial_number: serial,
      firewall_hostname: hostLabel,
      managed_by_tenant: managedBy,
      tenant_name: row.tenant_name || "—",
      tenant_id: row.tenant_id || "—",
      partner_id: row.partner_id || "—",
      organization_id: row.organization_id || "—",
      model: row.model || "—",
      model_type: row.model_type || "—",
      last_seen_at: row.last_seen_at || "",
      license_state: row.license_state === "Active" ? "Active" : "Expired",
      subscription_id: subId,
      license_identifier:
        row.license_identifier != null && String(row.license_identifier).trim() !== ""
          ? String(row.license_identifier).trim()
          : "—",
      product_code: row.product_code || "—",
      product_name: row.product_name || "—",
      start_date: row.start_date || "",
      end_date: row.end_date || "",
      perpetual: row.perpetual === 1 || row.perpetual === true ? "Yes" : "No",
      unlimited: row.unlimited === 1 || row.unlimited === true ? "Yes" : "No",
      subscription_type:
        row.subscription_type != null && String(row.subscription_type).trim() !== ""
          ? String(row.subscription_type).trim()
          : "—",
      quantity: qty != null && qty !== "" ? Number(qty) : null,
      usage_count: usage != null && usage !== "" ? Number(usage) : null,
      subscription_state,
    };
  }

  function licenseFacetValue(row, cat) {
    if (cat === "subscription_count") return String(row.subscription_count ?? 0);
    if (cat === "quantity" || cat === "usage_count") {
      const v = row[cat];
      if (v == null || Number.isNaN(v)) return "—";
      return String(v);
    }
    const v = row[cat];
    if (v == null || v === "") return "—";
    return String(v);
  }

  function lcAddDaysCalendar(d, n) {
    const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    x.setDate(x.getDate() + n);
    return x;
  }

  function lcDayNormMs(d) {
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  }

  function lcDayBetweenInclusive(d, minD, maxD) {
    const t = lcDayNormMs(d);
    return t >= lcDayNormMs(minD) && t <= lcDayNormMs(maxD);
  }

  function lcEndDateFacetEffectivePresets() {
    const out = [];
    for (const p of lcEndDatePresetSelections) {
      if (p === "custom") {
        if (lcEndDateCustomFrom.trim() && lcEndDateCustomTo.trim()) out.push("custom");
      } else {
        out.push(p);
      }
    }
    return out;
  }

  function lcStartDateFacetEffectivePresets() {
    const out = [];
    for (const p of lcStartDatePresetSelections) {
      if (p === "custom") {
        if (lcStartDateCustomFrom.trim() && lcStartDateCustomTo.trim()) out.push("custom");
      } else {
        out.push(p);
      }
    }
    return out;
  }

  function licenseMatchLcEndDateFacet(row) {
    const presets = lcEndDateFacetEffectivePresets();
    if (presets.length === 0) return true;
    const today = startOfTodayLocal();
    const end = parseLicenseDay(row.end_date);
    let ok = false;
    for (const p of presets) {
      if (p === "custom") {
        const fromD = parseLicenseDay(lcEndDateCustomFrom.trim());
        const toD = parseLicenseDay(lcEndDateCustomTo.trim());
        if (!end || !fromD || !toD) continue;
        if (lcDayBetweenInclusive(end, fromD, toD)) ok = true;
      } else if (!end) {
        continue;
      } else if (p === "past30") {
        const minD = lcAddDaysCalendar(today, -30);
        if (lcDayBetweenInclusive(end, minD, today)) ok = true;
      } else if (p === "next30") {
        const lo = lcAddDaysCalendar(today, 1);
        const hi = lcAddDaysCalendar(today, 30);
        if (lcDayBetweenInclusive(end, lo, hi)) ok = true;
      } else if (p === "next60") {
        const lo = lcAddDaysCalendar(today, 1);
        const hi = lcAddDaysCalendar(today, 60);
        if (lcDayBetweenInclusive(end, lo, hi)) ok = true;
      } else if (p === "next90") {
        const lo = lcAddDaysCalendar(today, 1);
        const hi = lcAddDaysCalendar(today, 90);
        if (lcDayBetweenInclusive(end, lo, hi)) ok = true;
      }
    }
    return ok;
  }

  function licenseMatchLcStartDateFacet(row) {
    const presets = lcStartDateFacetEffectivePresets();
    if (presets.length === 0) return true;
    const today = startOfTodayLocal();
    const start = parseLicenseDay(row.start_date);
    let ok = false;
    for (const p of presets) {
      if (p === "custom") {
        const fromD = parseLicenseDay(lcStartDateCustomFrom.trim());
        const toD = parseLicenseDay(lcStartDateCustomTo.trim());
        if (!start || !fromD || !toD) continue;
        if (lcDayBetweenInclusive(start, fromD, toD)) ok = true;
      } else if (!start) {
        continue;
      } else if (p === "started") {
        if (lcDayNormMs(start) <= lcDayNormMs(today)) ok = true;
      } else if (p === "future") {
        if (lcDayNormMs(start) > lcDayNormMs(today)) ok = true;
      }
    }
    return ok;
  }

  function licenseFiltered() {
    const rows = lcViewMode === "details" ? lcDetailPrepared : lcPrepared;
    return rows.filter((row) => {
      if (lcViewMode === "details") {
        if (!licenseMatchLcEndDateFacet(row)) return false;
        if (!licenseMatchLcStartDateFacet(row)) return false;
      }
      for (const [cat, selected] of Object.entries(lcFilterState)) {
        if (!selected || selected.size === 0) continue;
        const val = licenseFacetValue(row, cat);
        if (!selected.has(val)) return false;
      }
      return true;
    });
  }

  function clearLcDateFacetSelections() {
    lcEndDatePresetSelections.clear();
    lcStartDatePresetSelections.clear();
    lcEndDateCustomFrom = "";
    lcEndDateCustomTo = "";
    lcStartDateCustomFrom = "";
    lcStartDateCustomTo = "";
  }

  function lcEndDateFacetGroupHtml(idx) {
    const open = idx < 3 ? "is-open" : "";
    const opts = [
      ["past30", "Past 30 days"],
      ["next30", "Next 30 days"],
      ["next60", "Next 60 days"],
      ["next90", "Next 90 days"],
      ["custom", "Custom"],
    ];
    const checks = opts
      .map(
        ([val, label]) => `
          <label class="filter-opt">
            <input type="checkbox" data-lc-end-preset="${escapeHtml(val)}" />
            <span>${escapeHtml(label)}</span>
          </label>`
      )
      .join("");
    return `
        <div class="filter-group ${open}" data-cat-wrap="lc_end_date_facet">
          <button type="button" class="filter-group__head" aria-expanded="${idx < 3}">
            <span>End date</span>
            <span class="filter-group__chev">▼</span>
          </button>
          <div class="filter-group__body filter-group__body--date-facet">${checks}
            <div class="filter-date-custom" data-lc-end-custom hidden>
              <div class="filter-date-custom__row">
                <label class="filter-date-custom__lab">From</label>
                <input type="date" class="filter-date-custom__input" data-lc-end-from />
              </div>
              <div class="filter-date-custom__row">
                <label class="filter-date-custom__lab">To</label>
                <input type="date" class="filter-date-custom__input" data-lc-end-to />
              </div>
            </div>
          </div>
        </div>`;
  }

  function lcStartDateFacetGroupHtml(idx) {
    const open = idx < 3 ? "is-open" : "";
    const opts = [
      ["started", "Already started"],
      ["future", "Future start date"],
      ["custom", "Custom"],
    ];
    const checks = opts
      .map(
        ([val, label]) => `
          <label class="filter-opt">
            <input type="checkbox" data-lc-start-preset="${escapeHtml(val)}" />
            <span>${escapeHtml(label)}</span>
          </label>`
      )
      .join("");
    return `
        <div class="filter-group ${open}" data-cat-wrap="lc_start_date_facet">
          <button type="button" class="filter-group__head" aria-expanded="${idx < 3}">
            <span>Start date</span>
            <span class="filter-group__chev">▼</span>
          </button>
          <div class="filter-group__body filter-group__body--date-facet">${checks}
            <div class="filter-date-custom" data-lc-start-custom hidden>
              <div class="filter-date-custom__row">
                <label class="filter-date-custom__lab">From</label>
                <input type="date" class="filter-date-custom__input" data-lc-start-from />
              </div>
              <div class="filter-date-custom__row">
                <label class="filter-date-custom__lab">To</label>
                <input type="date" class="filter-date-custom__input" data-lc-start-to />
              </div>
            </div>
          </div>
        </div>`;
  }

  function updateLcEndCustomVisibility(host) {
    const wrap = host.querySelector("[data-lc-end-custom]");
    if (wrap) wrap.hidden = !lcEndDatePresetSelections.has("custom");
  }

  function updateLcStartCustomVisibility(host) {
    const wrap = host.querySelector("[data-lc-start-custom]");
    if (wrap) wrap.hidden = !lcStartDatePresetSelections.has("custom");
  }

  function readLcDateInputsFromDom(host) {
    lcEndDateCustomFrom = host.querySelector("[data-lc-end-from]")?.value?.trim() || "";
    lcEndDateCustomTo = host.querySelector("[data-lc-end-to]")?.value?.trim() || "";
    lcStartDateCustomFrom = host.querySelector("[data-lc-start-from]")?.value?.trim() || "";
    lcStartDateCustomTo = host.querySelector("[data-lc-start-to]")?.value?.trim() || "";
  }

  function syncLcDateFacetUi() {
    const host = document.getElementById("license-filters");
    if (!host || lcViewMode !== "details") return;
    host.querySelectorAll("[data-lc-end-preset]").forEach((cb) => {
      const v = cb.getAttribute("data-lc-end-preset");
      if (v) cb.checked = lcEndDatePresetSelections.has(v);
    });
    host.querySelectorAll("[data-lc-start-preset]").forEach((cb) => {
      const v = cb.getAttribute("data-lc-start-preset");
      if (v) cb.checked = lcStartDatePresetSelections.has(v);
    });
    const ef = host.querySelector("[data-lc-end-from]");
    const et = host.querySelector("[data-lc-end-to]");
    const sf = host.querySelector("[data-lc-start-from]");
    const st = host.querySelector("[data-lc-start-to]");
    if (ef) ef.value = lcEndDateCustomFrom;
    if (et) et.value = lcEndDateCustomTo;
    if (sf) sf.value = lcStartDateCustomFrom;
    if (st) st.value = lcStartDateCustomTo;
    updateLcEndCustomVisibility(host);
    updateLcStartCustomVisibility(host);
  }

  function wireLcDateFacetFilters(host) {
    if (lcViewMode !== "details") return;
    host.querySelectorAll("[data-lc-end-preset]").forEach((cb) => {
      cb.addEventListener("change", () => {
        const v = cb.getAttribute("data-lc-end-preset");
        if (!v) return;
        if (cb.checked) lcEndDatePresetSelections.add(v);
        else lcEndDatePresetSelections.delete(v);
        readLcDateInputsFromDom(host);
        updateLcEndCustomVisibility(host);
        lcDashState = null;
        lcController.render();
        refreshDashboardStatCards();
        updateLicenseFiltersChrome();
        schedulePersistUiState();
      });
    });
    host.querySelectorAll("[data-lc-start-preset]").forEach((cb) => {
      cb.addEventListener("change", () => {
        const v = cb.getAttribute("data-lc-start-preset");
        if (!v) return;
        if (cb.checked) lcStartDatePresetSelections.add(v);
        else lcStartDatePresetSelections.delete(v);
        readLcDateInputsFromDom(host);
        updateLcStartCustomVisibility(host);
        lcDashState = null;
        lcController.render();
        refreshDashboardStatCards();
        updateLicenseFiltersChrome();
        schedulePersistUiState();
      });
    });
    const onDateChange = () => {
      readLcDateInputsFromDom(host);
      lcDashState = null;
      lcController.render();
      refreshDashboardStatCards();
      updateLicenseFiltersChrome();
      schedulePersistUiState();
    };
    host.querySelectorAll("[data-lc-end-from], [data-lc-end-to], [data-lc-start-from], [data-lc-start-to]").forEach((inp) => {
      inp.addEventListener("change", onDateChange);
    });
  }

  const lcToolbarTenantMs = createToolbarTenantMultiselect({
    prefix: "lc",
    getTenantSet: () => {
      if (!(lcFilterState.tenant_name instanceof Set)) lcFilterState.tenant_name = new Set();
      return lcFilterState.tenant_name;
    },
    getDataRows: () => (lcViewMode === "details" ? lcDetailPrepared : lcPrepared),
    onChange: () => {
      lcDashState = null;
      lcController.render();
      refreshDashboardStatCards();
      updateLicenseFiltersChrome();
    },
  });

  function buildLicenseFilters() {
    lcFilterState.tenant_name = new Set();
    const host = document.getElementById("license-filters");
    if (!host) return;
    clearLcDateFacetSelections();
    const dataRows = lcViewMode === "details" ? lcDetailPrepared : lcPrepared;
    const groups =
      lcViewMode === "details"
        ? [
            { key: "model", label: "Model" },
            { key: "product_name", label: "Product" },
            { key: "product_code", label: "Product code" },
            { key: "subscription_type", label: "Subscription type" },
            { key: "subscription_state", label: "Subscription state" },
            { special: "lcStartDates" },
            { special: "lcEndDates" },
            { key: "perpetual", label: "Perpetual" },
            { key: "license_state", label: "License state" },
          ]
        : [
            { key: "model", label: "Model" },
            { key: "model_type", label: "Model type" },
            { key: "state", label: "State" },
            { key: "subscription_count", label: "Subscriptions" },
          ];

    host.innerHTML = groups
      .map((g, idx) => {
        if (g.special === "lcEndDates") return lcEndDateFacetGroupHtml(idx);
        if (g.special === "lcStartDates") return lcStartDateFacetGroupHtml(idx);
        const opts = distinctValues(dataRows, g.key, 80);
        lcFilterState[g.key] = new Set();
        const open = idx < 3 ? "is-open" : "";
        const optsHtml = opts
          .map(
            (o) => `
          <label class="filter-opt">
            <input type="checkbox" data-cat="${escapeHtml(g.key)}" value="${escapeHtml(o)}" />
            <span>${escapeHtml(o)}</span>
          </label>`
          )
          .join("");
        return `
        <div class="filter-group ${open}" data-cat-wrap="${escapeHtml(g.key)}">
          <button type="button" class="filter-group__head" aria-expanded="${idx < 3}">
            <span>${escapeHtml(g.label)}</span>
            <span class="filter-group__chev">▼</span>
          </button>
          <div class="filter-group__body">${optsHtml}</div>
        </div>`;
      })
      .join("");

    host.querySelectorAll(".filter-group__head").forEach((btn) => {
      btn.addEventListener("click", () => {
        const g = btn.closest(".filter-group");
        g.classList.toggle("is-open");
        btn.setAttribute("aria-expanded", g.classList.contains("is-open"));
      });
    });

    host.querySelectorAll('input[type="checkbox"][data-cat]').forEach((cb) => {
      cb.addEventListener("change", () => {
        const cat = cb.dataset.cat;
        const st = lcFilterState[cat];
        if (!st) return;
        if (cb.checked) st.add(cb.value);
        else st.delete(cb.value);
        lcDashState = null;
        lcController.render();
        refreshDashboardStatCards();
      });
    });
    wireLcDateFacetFilters(host);
    updateLicenseFiltersChrome();
    lcToolbarTenantMs.refresh();
  }

  function licenseFacetFilterCount() {
    let n = 0;
    for (const st of Object.values(lcFilterState)) {
      if (st instanceof Set) n += st.size;
    }
    if (lcViewMode === "details") {
      n += lcEndDatePresetSelections.size + lcStartDatePresetSelections.size;
    }
    return n;
  }

  function updateLicenseFiltersChrome() {
    const wrap = document.getElementById("lc-filters-head-actions");
    const countEl = document.getElementById("lc-facet-count");
    const resetBtn = document.getElementById("lc-facet-reset");
    if (!wrap || !countEl || !resetBtn) return;
    const n = licenseFacetFilterCount();
    resetBtn.hidden = n === 0;
    if (n === 0) {
      wrap.hidden = true;
      countEl.textContent = "";
      return;
    }
    wrap.hidden = false;
    countEl.innerHTML = `<span class="filters__facet-count-num">${n}</span> applied`;
  }

  function syncLicenseFilterCheckboxesFromState() {
    const host = document.getElementById("license-filters");
    if (!host) return;
    host.querySelectorAll('input[type="checkbox"][data-cat]').forEach((cb) => {
      const cat = cb.dataset.cat;
      const st = lcFilterState[cat];
      if (!st) return;
      cb.checked = st.has(cb.value);
    });
  }

  function resetLicenseFacetFilters() {
    lcDashState = null;
    clearLcDateFacetSelections();
    const host = document.getElementById("license-filters");
    for (const st of Object.values(lcFilterState)) {
      if (st && typeof st.clear === "function") st.clear();
    }
    if (host) {
      host.querySelectorAll('input[type="checkbox"][data-cat]').forEach((cb) => {
        cb.checked = false;
      });
      host.querySelectorAll("[data-lc-end-preset], [data-lc-start-preset]").forEach((cb) => {
        cb.checked = false;
      });
      host.querySelectorAll("[data-lc-end-from], [data-lc-end-to], [data-lc-start-from], [data-lc-start-to]").forEach((inp) => {
        inp.value = "";
      });
      updateLcEndCustomVisibility(host);
      updateLcStartCustomVisibility(host);
    }
    lcController.render();
    setFiltersPanelCollapsed(document.querySelector("#panel-licenses .filters"), true);
    schedulePersistUiState();
    refreshDashboardStatCards();
    lcToolbarTenantMs.refresh();
  }

  /** Active / Expired (and em dash) as a pill with readable text on a tinted background. */
  function lcStatePillHtml(rawLabel) {
    const text = rawLabel == null ? "" : String(rawLabel).trim();
    if (!text || text === "—") {
      return `<span class="tag-pill lc-state-pill lc-state-pill--empty">${escapeHtml("—")}</span>`;
    }
    const active = text === "Active";
    const variant = active ? "lc-state-pill--active" : "lc-state-pill--expired";
    return `<span class="tag-pill lc-state-pill ${variant}">${escapeHtml(text)}</span>`;
  }

  function renderLcDataCell(colId, row) {
    switch (colId) {
      case "serial_number":
        return `<td>${escapeHtml(row.serial_number)}</td>`;
      case "firewall_hostname": {
        if (!row.firewall_hostname) return "<td></td>";
        const ser = row.serial_number === "—" ? "" : String(row.serial_number);
        const serialAttr = escapeAttr(ser);
        const label = escapeHtml(row.firewall_hostname);
        return `<td><button type="button" class="cell-link lc-to-firewall" data-fw-serial="${serialAttr}" title="Show this firewall in Firewalls">${label}</button></td>`;
      }
      case "managed_by_tenant":
        return row.managed_by_tenant
          ? `<td>${escapeHtml(row.managed_by_tenant)}</td>`
          : "<td></td>";
      case "tenant_name":
        return `<td>${escapeHtml(row.tenant_name)}</td>`;
      case "model":
        return `<td>${escapeHtml(row.model)}</td>`;
      case "model_type":
        return `<td>${escapeHtml(row.model_type)}</td>`;
      case "last_seen_at":
        return `<td class="muted">${fmtDate(row.last_seen_at)}</td>`;
      case "subscription_count": {
        const n = row.subscription_count ?? 0;
        const pill = `<span class="tag-pill lc-col-subscriptions-pill">${escapeHtml(String(n))}</span>`;
        return `<td class="lc-col-subscriptions">${pill}</td>`;
      }
      case "state":
        return `<td>${lcStatePillHtml(row.state)}</td>`;
      case "tenant_id":
        return `<td class="fw-col-code">${escapeHtml(row.tenant_id)}</td>`;
      case "partner_id":
        return `<td class="fw-col-code">${escapeHtml(row.partner_id)}</td>`;
      case "organization_id":
        return `<td class="fw-col-code">${escapeHtml(row.organization_id)}</td>`;
      case "license_identifier":
        return `<td class="fw-col-code">${escapeHtml(row.license_identifier || "—")}</td>`;
      case "product_name":
        return `<td>${escapeHtml(row.product_name || "—")}</td>`;
      case "product_code":
        return `<td class="fw-col-code">${escapeHtml(row.product_code || "—")}</td>`;
      case "subscription_type":
        return `<td>${escapeHtml(row.subscription_type || "—")}</td>`;
      case "start_date":
        return `<td class="muted">${fmtDate(row.start_date)}</td>`;
      case "end_date":
        return `<td class="muted">${fmtDate(row.end_date)}</td>`;
      case "perpetual":
        return `<td>${escapeHtml(row.perpetual || "—")}</td>`;
      case "unlimited":
        return `<td>${escapeHtml(row.unlimited || "—")}</td>`;
      case "quantity": {
        const q = row.quantity;
        if (q == null || Number.isNaN(q)) return "<td></td>";
        return `<td>${escapeHtml(String(q))}</td>`;
      }
      case "usage_count": {
        const u = row.usage_count;
        if (u == null || Number.isNaN(u)) return "<td></td>";
        return `<td>${escapeHtml(String(u))}</td>`;
      }
      case "subscription_state": {
        if (!row.subscription_state || row.subscription_state === "—") return "<td></td>";
        return `<td>${lcStatePillHtml(row.subscription_state)}</td>`;
      }
      case "license_state":
        return `<td>${lcStatePillHtml(row.license_state)}</td>`;
      default:
        return "<td></td>";
    }
  }

  function parseLicenseDay(s) {
    const raw = String(s || "").trim();
    if (!raw) return null;
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(raw);
    if (m) {
      const y = +m[1];
      const mo = +m[2] - 1;
      const d = +m[3];
      const dt = new Date(y, mo, d);
      if (dt.getFullYear() !== y || dt.getMonth() !== mo || dt.getDate() !== d) return null;
      return dt;
    }
    const t = Date.parse(raw);
    if (Number.isNaN(t)) return null;
    const x = new Date(t);
    const dt = new Date(x.getFullYear(), x.getMonth(), x.getDate());
    return dt;
  }

  function startOfTodayLocal() {
    const n = new Date();
    return new Date(n.getFullYear(), n.getMonth(), n.getDate());
  }

  function dayAfter(d) {
    const x = new Date(d.getTime());
    x.setDate(x.getDate() + 1);
    return x;
  }

  function noonLocal(d) {
    return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 12, 0, 0, 0);
  }

  function mergeOverlappingLicenseIntervals(intervals) {
    if (!intervals.length) return [];
    const sorted = intervals.slice().sort((a, b) => a.s.getTime() - b.s.getTime());
    const out = [{ s: sorted[0].s, e: sorted[0].e }];
    for (let i = 1; i < sorted.length; i++) {
      const cur = sorted[i];
      const last = out[out.length - 1];
      if (cur.s.getTime() <= last.e.getTime()) {
        if (cur.e.getTime() > last.e.getTime()) last.e = cur.e;
      } else {
        out.push({ s: cur.s, e: cur.e });
      }
    }
    return out;
  }

  function buildLicenseGanttModel(subs) {
    const byName = new Map();
    const allStarts = [];
    const allEnds = [];

    for (const sub of subs) {
      const start = parseLicenseDay(sub.start_date);
      const end = parseLicenseDay(sub.end_date);
      if (!start || !end || start.getTime() > end.getTime()) continue;
      const nameRaw = sub.product_name;
      const key =
        nameRaw == null || String(nameRaw).trim() === "" ? "—" : String(nameRaw).trim();
      if (!byName.has(key)) {
        byName.set(key, { key, types: new Set(), intervals: [] });
      }
      const g = byName.get(key);
      if (sub.type != null && String(sub.type).trim() !== "") {
        g.types.add(String(sub.type).trim());
      }
      g.intervals.push({ s: start, e: end });
      allStarts.push(start);
      allEnds.push(end);
    }

    const groups = [];
    for (const g of byName.values()) {
      const merged = mergeOverlappingLicenseIntervals(g.intervals);
      const types = [...g.types].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
      groups.push({
        name: g.key,
        types,
        merged,
      });
    }
    groups.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));

    if (!allStarts.length) {
      return {
        groups: [],
        minMs: null,
        maxMs: null,
        markers: [],
        axisCapped: false,
        fadeHorizonMs: null,
      };
    }

    let segMinMs = Infinity;
    let segMaxMs = -Infinity;
    for (const g of groups) {
      for (const seg of g.merged) {
        const t0 = seg.s.getTime();
        const t1 = dayAfter(seg.e).getTime();
        if (t0 < segMinMs) segMinMs = t0;
        if (t1 > segMaxMs) segMaxMs = t1;
      }
    }

    const earliest = allStarts.reduce((a, b) => (a.getTime() <= b.getTime() ? a : b));
    const furthestEnd = allEnds.reduce((a, b) => (a.getTime() >= b.getTime() ? a : b));
    const today0 = startOfTodayLocal();
    const todayMs = noonLocal(today0).getTime();

    const upcomingEnds = allEnds.filter((e) => e.getTime() >= today0.getTime());
    let nextExpiry = null;
    if (upcomingEnds.length) {
      nextExpiry = upcomingEnds.reduce((a, b) => (a.getTime() <= b.getTime() ? a : b));
    }

    /* Axis stops at ~5y past today; bar tails beyond that fade (no 2099-scale). */
    const MS_DAY = 86400000;
    const FADE_YEARS = 5;
    const fadeHorizonMs = noonLocal(
      (() => {
        const d = new Date(today0);
        d.setFullYear(d.getFullYear() + FADE_YEARS);
        return d;
      })()
    ).getTime();
    let axisCapped = segMaxMs > fadeHorizonMs;
    let maxMs = axisCapped
      ? Math.max(fadeHorizonMs, segMinMs + MS_DAY * 30, todayMs + MS_DAY)
      : segMaxMs;
    let minMs = Math.min(segMinMs, noonLocal(earliest).getTime());

    const markerDates = [today0];
    if (nextExpiry) markerDates.push(nextExpiry);
    markerDates.push(furthestEnd);

    for (const t of markerDates) {
      const ms = noonLocal(t).getTime();
      if (ms < minMs) minMs = ms;
      if (axisCapped) {
        if (ms > maxMs && ms <= fadeHorizonMs) maxMs = ms;
      } else if (ms > maxMs) {
        maxMs = ms;
      }
    }

    let span = maxMs - minMs;
    const pad = Math.max(86400000 * 2, span * 0.04);
    minMs -= pad;
    maxMs += pad;
    span = maxMs - minMs;
    if (span <= 0) {
      minMs -= 86400000;
      maxMs += 86400000;
      span = maxMs - minMs;
    }

    const markers = [
      {
        kind: "start",
        ms: noonLocal(earliest).getTime(),
        label: "Earliest start",
      },
      { kind: "today", ms: todayMs, label: "Today" },
    ];
    if (nextExpiry) {
      markers.push({
        kind: "expiry-next",
        ms: noonLocal(nextExpiry).getTime(),
        label: "Next expiry",
      });
    }
    const showFurthest =
      !nextExpiry || furthestEnd.getTime() !== nextExpiry.getTime();
    if (showFurthest) {
      markers.push({
        kind: "expiry-far",
        ms: noonLocal(furthestEnd).getTime(),
        label: "Furthest expiry",
      });
    }

    return {
      groups,
      minMs,
      maxMs,
      span,
      markers,
      axisCapped,
      fadeHorizonMs,
    };
  }

  function renderLicenseGanttHtml(model) {
    if (!model.groups.length) {
      return '<p class="muted">No subscriptions with valid start and end dates.</p>';
    }
    const { groups, minMs, maxMs, span, fadeHorizonMs, axisCapped } = model;
    const minLabel = minMs != null ? escapeHtml(new Date(minMs).toLocaleDateString()) : "—";
    const maxLabel = maxMs != null ? escapeHtml(new Date(maxMs).toLocaleDateString()) : "—";

    const VB_W = 1000;
    const ROW = 40;
    const BAR_H = 18;
    const n = groups.length;
    const vbH = n * ROW;

    function xAt(ms) {
      return ((ms - minMs) / span) * VB_W;
    }

    function clampBarX(x, w, maxW) {
      const cx = Math.min(maxW, Math.max(0, x));
      let cw = Math.max(0.5, w);
      if (cx + cw > maxW) cw = Math.max(0.5, maxW - cx);
      return { x: cx, w: cw };
    }

    const strokeByKind = {
      start: { stroke: "#6a6a6a", dash: "5 4" },
      today: { stroke: "#0066cc", dash: null },
      "expiry-next": { stroke: "#c05600", dash: null },
      "expiry-far": { stroke: "#6a1b9a", dash: null },
    };

    const markerLines = model.markers
      .map((m) => {
        const x = Math.min(VB_W, Math.max(0, xAt(m.ms)));
        const spec = strokeByKind[m.kind] || strokeByKind.today;
        const dash = spec.dash ? ` stroke-dasharray="${spec.dash}"` : "";
        return `<line class="lc-gantt__svg-line lc-gantt__svg-line--${escapeAttr(m.kind)}" x1="${x.toFixed(2)}" x2="${x.toFixed(2)}" y1="0" y2="${vbH}" stroke="${escapeAttr(spec.stroke)}" stroke-width="2" vector-effect="non-scaling-stroke"${dash} />`;
      })
      .join("");

    const rowBands = groups
      .map(
        (_, i) =>
          `<rect class="lc-gantt__svg-row-bg" x="0" y="${i * ROW}" width="${VB_W}" height="${ROW}" fill="${i % 2 === 0 ? "#f7f7f7" : "#efefef"}" />`
      )
      .join("");

    const fadeDefs = [];
    const barsSvg = groups
      .map((g, i) => {
        const y = i * ROW + (ROW - BAR_H) / 2;
        return g.merged
          .map((seg, j) => {
            const t0 = seg.s.getTime();
            const t1 = dayAfter(seg.e).getTime();
            const xStartRaw = xAt(t0);
            const xEndRaw = Math.min(VB_W, Math.max(0, xAt(t1)));
            const xFade =
              fadeHorizonMs != null
                ? Math.min(VB_W, Math.max(0, xAt(fadeHorizonMs)))
                : VB_W;
            const tailFades =
              fadeHorizonMs != null &&
              axisCapped &&
              t1 > fadeHorizonMs &&
              xEndRaw > xFade + 0.5;

            if (!tailFades) {
              let w = xEndRaw - xStartRaw;
              const c = clampBarX(xStartRaw, w, VB_W);
              return `<rect class="lc-gantt__svg-bar" x="${c.x.toFixed(2)}" y="${y.toFixed(2)}" width="${c.w.toFixed(2)}" height="${BAR_H}" rx="3" />`;
            }

            const xSolidEnd = Math.min(xFade, xEndRaw);
            let parts = "";
            if (xSolidEnd > xStartRaw + 0.25) {
              const c = clampBarX(xStartRaw, xSolidEnd - xStartRaw, VB_W);
              parts += `<rect class="lc-gantt__svg-bar" x="${c.x.toFixed(2)}" y="${y.toFixed(2)}" width="${c.w.toFixed(2)}" height="${BAR_H}" rx="3" />`;
            }
            const fadeW = xEndRaw - xFade;
            if (fadeW > 0.5) {
              const gid = `lcg-fade-${i}-${j}`;
              fadeDefs.push(
                `<linearGradient id="${gid}" gradientUnits="userSpaceOnUse" x1="${xFade.toFixed(2)}" y1="${y.toFixed(2)}" x2="${xEndRaw.toFixed(2)}" y2="${y.toFixed(2)}"><stop offset="0%" stop-color="#2d7dcc" stop-opacity="0.92"/><stop offset="100%" stop-color="#2d7dcc" stop-opacity="0"/></linearGradient>`
              );
              parts += `<rect class="lc-gantt__svg-bar lc-gantt__svg-bar--fade" fill="url(#${gid})" x="${xFade.toFixed(2)}" y="${y.toFixed(2)}" width="${fadeW.toFixed(2)}" height="${BAR_H}" rx="3" />`;
            }
            return parts;
          })
          .join("");
      })
      .join("");

    const defsBlock =
      fadeDefs.length > 0 ? `<defs>${fadeDefs.join("")}</defs>` : "";

    const svgChart = `<svg class="lc-gantt__svg" viewBox="0 0 ${VB_W} ${vbH}" preserveAspectRatio="none" width="100%" height="100%" role="img" aria-label="Subscription timeline by product">
        ${defsBlock}
        ${rowBands}
        ${barsSvg}
        ${markerLines}
      </svg>`;

    const rowsHtml = groups
      .map((g, i) => {
        const row = i + 1;
        const nameText = g.name && String(g.name).trim() ? String(g.name).trim() : "—";
        const pills = (g.types || [])
          .map((t) => `<span class="lc-gantt__type-pill">${escapeHtml(t)}</span>`)
          .join("");
        return `<div class="lc-gantt__label" style="grid-row:${row}"><span class="lc-gantt__label-text">${escapeHtml(nameText)}</span>${pills}</div>`;
      })
      .join("");
    const chartCell = `<div class="lc-gantt__chart-cell" style="grid-row:1 / span ${n}">${svgChart}</div>`;

    const legendByLabel = {
      "Earliest start": '<span class="lc-gantt__legend-swatch lc-gantt__legend-swatch--start"></span>',
      Today: '<span class="lc-gantt__legend-swatch lc-gantt__legend-swatch--today"></span>',
      "Next expiry": '<span class="lc-gantt__legend-swatch lc-gantt__legend-swatch--expiry-next"></span>',
      "Furthest expiry": '<span class="lc-gantt__legend-swatch lc-gantt__legend-swatch--expiry-far"></span>',
    };
    const legendItems = model.markers
      .map((m) => {
        const sw = legendByLabel[m.label] || "";
        return `<span class="lc-gantt__legend-item">${sw}<span>${escapeHtml(m.label)}</span></span>`;
      })
      .join("");

    const capNote =
      model.axisCapped && model.fadeHorizonMs != null
        ? `<p class="lc-gantt__cap-note muted">The time axis runs to ${escapeHtml(new Date(model.fadeHorizonMs).toLocaleDateString())} (about five years from today). Licenses with later placeholder ends fade out after that; see the table for exact end dates.</p>`
        : "";

    return `<div class="lc-gantt">
      <p class="lc-gantt__bounds">Timeline: ${minLabel} — ${maxLabel}</p>
      ${capNote}
      <div class="lc-gantt__main">
        <div class="lc-gantt__grid" style="grid-template-rows: repeat(${n}, var(--lc-gantt-row))">${rowsHtml}${chartCell}</div>
      </div>
      <div class="lc-gantt__legend">
        <div class="lc-gantt__legend-title">Timeline markers</div>
        <div class="lc-gantt__legend-items">${legendItems}</div>
      </div>
    </div>`;
  }

  function closeLicenseSubscriptionsFlyout() {
    const backdrop = document.getElementById("license-flyout-backdrop");
    const panel = document.getElementById("license-flyout");
    if (backdrop) backdrop.hidden = true;
    if (panel) {
      panel.hidden = true;
      panel.setAttribute("aria-hidden", "true");
    }
  }

  async function openLicenseSubscriptionsFlyout(serial) {
    const backdrop = document.getElementById("license-flyout-backdrop");
    const panel = document.getElementById("license-flyout");
    const body = document.getElementById("license-flyout-body");
    const title = document.getElementById("license-flyout-title");
    if (!backdrop || !panel || !body || !title) return;

    const safeSerial = serial == null ? "" : String(serial);
    title.textContent = "License subscriptions";
    body.innerHTML = '<p class="muted">Loading subscriptions…</p>';
    backdrop.hidden = false;
    panel.hidden = false;
    panel.setAttribute("aria-hidden", "false");

    const closeBtn = panel.querySelector(".flyout__close-btn");
    closeBtn?.focus();

    let subs;
    try {
      const q = encodeURIComponent(safeSerial);
      subs = await loadJson(`/api/license-subscriptions?serial=${q}`);
    } catch (e) {
      console.error(e);
      body.innerHTML =
        '<p class="muted">Could not load subscriptions. Check the console or try again.</p>';
      return;
    }

    if (!Array.isArray(subs)) subs = [];

    const lic = lcPrepared.find((r) => r._id === safeSerial);
    const serialHtml = escapeHtml(lic?.serial_number || safeSerial || "—");
    const metaBits = [];
    if (lic?.model && lic.model !== "—") metaBits.push(escapeHtml(lic.model));
    if (lic?.tenant_name && lic.tenant_name !== "—") metaBits.push(escapeHtml(lic.tenant_name));
    const meta = metaBits.length ? ` · ${metaBits.join(" · ")}` : "";

    title.textContent = `Subscriptions — ${lic?.serial_number || safeSerial || "—"}`;
    const model = buildLicenseGanttModel(subs);
    const ganttHtml = renderLicenseGanttHtml(model);

    const listRows = subs
      .map((s) => {
        const pc = escapeHtml(s.product_code || "—");
        const pn = escapeHtml(s.product_name || "—");
        const sd = escapeHtml(s.start_date || "—");
        const ed = escapeHtml(s.end_date || "—");
        return `<tr><td>${pc}</td><td>${pn}</td><td class="muted">${sd}</td><td class="muted">${ed}</td></tr>`;
      })
      .join("");

    body.innerHTML = `
      <p class="lc-gantt__lead">Serial <code>${serialHtml}</code>${meta}</p>
      ${subs.length === 0 ? '<p class="muted">No subscriptions for this license.</p>' : ""}
      ${subs.length ? ganttHtml : ""}
      ${subs.length
        ? `<h3 class="lc-gantt__legend-title" style="margin-top:24px">All subscriptions (${subs.length})</h3>
      <div class="table-scroll" style="max-height:240px;margin-top:8px">
        <table class="data-table data-table--dense">
          <thead><tr><th>Product code</th><th>Product</th><th>Start</th><th>End</th></tr></thead>
          <tbody>${listRows}</tbody>
        </table>
      </div>`
        : ""
      }
    `;
  }

  function initLicenseSubscriptionsFlyout() {
    document.getElementById("license-flyout-backdrop")?.addEventListener("click", closeLicenseSubscriptionsFlyout);
    document.querySelector("#license-flyout .flyout__close-btn")?.addEventListener("click", closeLicenseSubscriptionsFlyout);

    const lcTbody = document.getElementById("lc-tbody");
    if (lcTbody) {
      lcTbody.addEventListener("click", (e) => {
        const fwBtn = e.target.closest("button.lc-to-firewall");
        if (fwBtn) {
          e.preventDefault();
          e.stopPropagation();
          const ser = fwBtn.getAttribute("data-fw-serial");
          if (ser == null || ser === "") return;
          goToFirewallsFilteredBySerial(ser);
          schedulePersistUiState();
          return;
        }
        const tr = e.target.closest("tr.lc-row");
        if (!tr) return;
        const serial = tr.getAttribute("data-serial");
        if (serial == null || serial === "") return;
        openLicenseSubscriptionsFlyout(serial).catch(console.error);
      });
      lcTbody.addEventListener("keydown", (e) => {
        if (e.key !== "Enter" && e.key !== " ") return;
        if (e.target.closest("button.lc-to-firewall")) return;
        const tr = e.target.closest("tr.lc-row");
        if (!tr) return;
        e.preventDefault();
        const serial = tr.getAttribute("data-serial");
        if (serial == null || serial === "") return;
        openLicenseSubscriptionsFlyout(serial).catch(console.error);
      });
    }
  }

  function renderLicenseDataRow(row) {
    const cells = getLcColumns()
      .filter((c) => lcColVisible[c.id])
      .map((c) => renderLcDataCell(c.id, row))
      .join("");
    const serialForFlyout =
      row._licenseSerial != null && String(row._licenseSerial).trim() !== ""
        ? String(row._licenseSerial).trim()
        : row.serial_number !== "—"
          ? String(row.serial_number)
          : "";
    const serialAttr = escapeAttr(serialForFlyout);
    return `<tr class="lc-row" tabindex="0" data-serial="${serialAttr}" aria-label="View subscriptions for this license">
        ${cells}
      </tr>`;
  }

  buildLcThead();

  const lcTableEl = document.getElementById("lc-table");
  const lcController = createTableController({
    tbody: document.getElementById("lc-tbody"),
    countEl: document.getElementById("lc-count"),
    rangeEl: document.getElementById("lc-lazy-hint"),
    pageSizeEl: document.getElementById("lc-page-size"),
    searchInput: document.getElementById("lc-search"),
    selectAllInput: null,
    sortHeaders: [],
    sortDelegateRoot: lcTableEl,
    getFilteredRows: licenseFiltered,
    getRowSearchText: (row) => {
      if (lcViewMode === "details") {
        return [
          row.serial_number,
          row.license_identifier,
          row.product_name,
          row.product_code,
          row.subscription_type,
          row.start_date,
          row.end_date,
          row.perpetual,
          row.unlimited,
          row.quantity != null && !Number.isNaN(row.quantity) ? String(row.quantity) : "",
          row.usage_count != null && !Number.isNaN(row.usage_count) ? String(row.usage_count) : "",
          row.subscription_state,
          row.license_state,
          row.tenant_name,
          row.model,
          row.model_type,
          row.firewall_hostname,
          row.managed_by_tenant,
          row.last_seen_at,
        ]
          .join(" ")
          .toLowerCase();
      }
      return [
        row.serial_number,
        row.firewall_hostname,
        row.managed_by_tenant,
        row.tenant_name,
        row.tenant_id,
        row.partner_id,
        row.organization_id,
        row.model,
        row.model_type,
        row.last_seen_at,
        String(row.subscription_count),
        row.state,
      ]
        .join(" ")
        .toLowerCase();
    },
    renderRow: (row) => renderLicenseDataRow(row),
    afterRender: updateLicenseFiltersChrome,
  });

  initLcColumnPicker();

  function setLicenseViewMode(mode) {
    if (mode !== "summary" && mode !== "details") return;
    if (mode === lcViewMode) return;
    if (mode === "summary") {
      lcDashState = null;
      refreshDashboardStatCards();
    }
    persistLcColumnVisibilityNow();
    lcViewMode = mode;
    lcColVisible = loadLcColumnVisibilitySnapshot(mode);
    updateLcViewToggleUi();
    buildLcThead();
    buildLcColumnMenuList();
    buildLicenseFilters();
    lcController.resetSort();
    lcController.clearSelection();
    lcController.resetPage();
    lcController.render(true);
    schedulePersistUiState();
  }

  function expandLicenseFiltersPanel() {
    setFiltersPanelCollapsed(document.querySelector("#panel-licenses .filters"), false);
  }

  function openLicenseFilterGroup(cat) {
    expandLicenseFiltersPanel();
    const wrap = document.querySelector(`#license-filters .filter-group[data-cat-wrap="${cat}"]`);
    if (!wrap) return;
    wrap.classList.add("is-open");
    const head = wrap.querySelector(".filter-group__head");
    if (head) head.setAttribute("aria-expanded", "true");
  }

  async function goToLicensesUnfiltered() {
    lcDashState = null;
    clearLcDateFacetSelections();
    if (Object.keys(lcFilterState).length === 0) {
      await loadLicenses();
    }
    for (const st of Object.values(lcFilterState)) {
      if (st && typeof st.clear === "function") st.clear();
    }
    const host = document.getElementById("license-filters");
    if (host) {
      host.querySelectorAll('input[type="checkbox"][data-cat]').forEach((cb) => {
        cb.checked = false;
      });
    }
    syncLcDateFacetUi();
    lcController.resetSort();
    lcController.resetPage();
    lcController.clearSelection();
    activateTab("licenses");
    lcController.render(true);
    updateLicenseFiltersChrome();
    schedulePersistUiState();
    refreshDashboardStatCards();
    lcToolbarTenantMs.refresh();
  }

  async function goToLicensesFilteredBySubscriptionState(state) {
    if (state !== "Active" && state !== "Expired") return;
    if (Object.keys(lcFilterState).length === 0) {
      await loadLicenses();
    }
    setLicenseViewMode("details");
    lcDashState = state;
    for (const st of Object.values(lcFilterState)) {
      if (st && typeof st.clear === "function") st.clear();
    }
    clearLcDateFacetSelections();
    const subSet = lcFilterState.subscription_state;
    if (!subSet) return;
    subSet.clear();
    subSet.add(state);
    syncLicenseFilterCheckboxesFromState();
    syncLcDateFacetUi();
    openLicenseFilterGroup("subscription_state");
    lcController.resetSort();
    lcController.resetPage();
    lcController.clearSelection();
    activateTab("licenses");
    lcController.render(true);
    updateLicenseFiltersChrome();
    schedulePersistUiState();
    refreshDashboardStatCards();
    lcToolbarTenantMs.refresh();
  }

  /** Dashboard expiring count: same window as API (past 30 / next 90 end dates); applies End date Past 30 + Next 90. */
  async function goToLicensesDashboardExpiring() {
    if (Object.keys(lcFilterState).length === 0) {
      await loadLicenses();
    }
    lcDashState = "Expiring";
    setLicenseViewMode("details");
    for (const st of Object.values(lcFilterState)) {
      if (st && typeof st.clear === "function") st.clear();
    }
    clearLcDateFacetSelections();
    lcEndDatePresetSelections.add("past30");
    lcEndDatePresetSelections.add("next90");
    syncLicenseFilterCheckboxesFromState();
    syncLcDateFacetUi();
    openLicenseFilterGroup("lc_end_date_facet");
    lcController.resetSort();
    lcController.resetPage();
    lcController.clearSelection();
    activateTab("licenses");
    lcController.render(true);
    updateLicenseFiltersChrome();
    schedulePersistUiState();
    refreshDashboardStatCards();
    lcToolbarTenantMs.refresh();
  }

  function initLcViewToggle() {
    document.getElementById("lc-view-summary")?.addEventListener("click", () => setLicenseViewMode("summary"));
    document.getElementById("lc-view-details")?.addEventListener("click", () => setLicenseViewMode("details"));
  }

  initLcViewToggle();
  initLicenseSubscriptionsFlyout();

  /* ---------- Table export (CSV / JSON / XLSX) ---------- */
  let tableExportKind = null;
  let tableExportAnchor = null;

  function exportTimestampForFilename() {
    return new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  }

  function triggerDownloadText(filename, mime, text) {
    const blob = new Blob([text], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  function csvEscapeCell(val) {
    const s = val == null ? "" : String(val);
    if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  }

  function downloadXlsxFile(filename, sheetName, aoa) {
    const XLSX = window.XLSX;
    if (!XLSX?.utils?.aoa_to_sheet) {
      notifyAppUser(
        "Export unavailable",
        "Excel export is not available (spreadsheet library failed to load). Use CSV or JSON instead.",
        "error"
      );
      return;
    }
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    const wb = XLSX.utils.book_new();
    const sn = (sheetName || "Export").slice(0, 31) || "Sheet1";
    XLSX.utils.book_append_sheet(wb, ws, sn);
    XLSX.writeFile(wb, filename);
  }

  function deliverTableExport(format, labels, dataRows, objectsForJson, baseName, sheetName) {
    const ts = exportTimestampForFilename();
    if (format === "json") {
      triggerDownloadText(
        `${baseName}-${ts}.json`,
        "application/json;charset=utf-8",
        JSON.stringify(objectsForJson, null, 2)
      );
      return;
    }
    if (format === "csv") {
      const lines = [labels.map(csvEscapeCell).join(",")];
      for (const row of dataRows) lines.push(row.map(csvEscapeCell).join(","));
      triggerDownloadText(`${baseName}-${ts}.csv`, "text/csv;charset=utf-8", `\uFEFF${lines.join("\r\n")}`);
      return;
    }
    downloadXlsxFile(`${baseName}-${ts}.xlsx`, sheetName, [labels, ...dataRows]);
  }

  function exportPlainDateTime(s) {
    if (!s) return "";
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? String(s) : d.toLocaleString();
  }

  function fwExportCell(row, colId) {
    switch (colId) {
      case "status":
        return row.status || "";
      case "firmware_upgrade":
        return String(row.firmware_upgrade_count ?? 0);
      case "alert_count":
        return String(row.alert_count ?? 0);
      case "model":
        return fwModelDisplay(row.model);
      case "firmware_version":
        return fwFirmwareDisplay(row.firmware_version);
      case "connected":
        return yesNo(row.connected);
      case "suspended":
        return yesNo(row.suspended);
      case "state_changed_at":
        return exportPlainDateTime(row.state_changed_at);
      case "tagsPlain":
        return row.tagsPlain || "";
      case "capabilities_json":
        return row.capabilities_display != null ? String(row.capabilities_display) : "";
      case "location":
        return row.has_location === 1 && row.geo_lat != null && row.geo_lon != null
          ? `${row.geo_lat}, ${row.geo_lon}`
          : "";
      default: {
        const v = row[colId];
        return v == null || v === "" ? "" : String(v);
      }
    }
  }

  function tnExportCell(row, colId) {
    if (colId === "updated_at") return exportPlainDateTime(row.updated_at);
    if (colId === "firewall_count") return String(row.firewall_count ?? 0);
    if (colId === "name") {
      const tag = row._recencyTag;
      const p =
        tag === "new" ? "NEW " : tag === "old" ? "OLD " : tag === "upd" ? "UPD " : "";
      const v = row.name;
      return p + (v == null || v === "" ? "" : String(v));
    }
    if (colId === "credential_name") {
      const v = row.credential_name;
      return v == null || v === "" || v === "—" ? "" : String(v);
    }
    const v = row[colId];
    return v == null || v === "" ? "" : String(v);
  }

  function grExportCell(row, colId) {
    if (colId === "last_sync" || colId === "updated_at") return exportPlainDateTime(row[colId]);
    if (colId === "firewall_count") return String(row.firewall_count ?? 0);
    if (colId === "sync_issues_count") return String(row.sync_issues_count ?? 0);
    if (colId === "breadcrumb") {
      const tag = row._recencyTag;
      const p =
        tag === "new" ? "NEW " : tag === "old" ? "OLD " : tag === "upd" ? "UPD " : "";
      return p + (row.breadcrumb || "");
    }
    if (colId === "imported_from") return row.imported_from || "";
    const v = row[colId];
    return v == null || v === "" ? "" : String(v);
  }

  function lcExportCell(colId, row) {
    switch (colId) {
      case "last_seen_at":
      case "start_date":
      case "end_date":
        return exportPlainDateTime(row[colId]);
      case "subscription_count":
        return String(row.subscription_count ?? 0);
      case "quantity":
      case "usage_count": {
        const v = row[colId];
        if (v == null || Number.isNaN(v)) return "";
        return String(v);
      }
      case "state":
      case "subscription_state":
      case "license_state":
        return row[colId] ? String(row[colId]) : "";
      default: {
        const v = row[colId];
        return v == null || v === "" ? "" : String(v);
      }
    }
  }

  function buildDashboardAlertExportParams() {
    const params = new URLSearchParams();
    params.set("page_size", "200");
    appendDashboardAlertApiParams(params);
    daFilterState.tenant_name.forEach((v) => params.append("tenant_name", v));
    daFilterState.firewall_hostname.forEach((v) => params.append("firewall_hostname", v));
    const q = getDashboardAlertsSearchQuery();
    if (q) params.set("q", q);
    return params;
  }

  async function fetchAllDashboardAlertsForExport() {
    const params = buildDashboardAlertExportParams();
    const all = [];
    let page = 1;
    let total = Infinity;
    while (all.length < total) {
      params.set("page", String(page));
      const data = await loadJson(`/api/alerts?${params.toString()}`);
      total = data.total ?? 0;
      const items = data.items || [];
      if (!items.length) break;
      all.push(...items);
      page += 1;
      if (items.length < 200) break;
    }
    return all;
  }

  function alertRowDisplayCell(r, col) {
    if (col === "raised_at") return exportPlainDateTime(r.raised_at);
    if (col === "recency_tag") {
      const t = r.recency_tag;
      if (t === "new") return "NEW";
      if (t === "old") return "OLD";
      if (t === "upd") return "UPD";
      return "";
    }
    const v = r[col];
    return v == null || v === "" ? "—" : String(v);
  }

  async function exportDashboardAlertsTable(format) {
    const all = await fetchAllDashboardAlertsForExport();
    const headers = [
      { id: "severity", label: "Severity" },
      { id: "recency_tag", label: "NEW/UPD/OLD" },
      { id: "tenant_name", label: "Tenant" },
      { id: "firewall_hostname", label: "Firewall" },
      { id: "description", label: "Description" },
      { id: "raised_at", label: "Raised" },
    ];
    const labels = headers.map((h) => h.label);
    const dataRows = all.map((r) => headers.map((h) => alertRowDisplayCell(r, h.id)));
    const objectsForJson = all.map((r) => {
      const o = {};
      headers.forEach((h) => {
        o[h.label] = alertRowDisplayCell(r, h.id);
      });
      return o;
    });
    deliverTableExport(format, labels, dataRows, objectsForJson, "alerts", "Alerts");
  }

  function closeTableExportPopover() {
    const pop = document.getElementById("table-export-popover");
    if (pop) {
      pop.hidden = true;
      pop.style.visibility = "";
    }
    tableExportKind = null;
    tableExportAnchor = null;
    document.querySelectorAll(".toolbar__export-btn").forEach((b) => b.setAttribute("aria-expanded", "false"));
  }

  function positionTableExportPopover(anchor) {
    const pop = document.getElementById("table-export-popover");
    if (!pop || !anchor) return;
    pop.hidden = false;
    pop.style.visibility = "hidden";
    requestAnimationFrame(() => {
      const r = anchor.getBoundingClientRect();
      const pw = pop.offsetWidth;
      const ph = pop.offsetHeight;
      let left = r.right - pw;
      if (left < 8) left = 8;
      if (left + pw > window.innerWidth - 8) left = Math.max(8, window.innerWidth - 8 - pw);
      let top = r.bottom + 6;
      if (top + ph > window.innerHeight - 8) top = Math.max(8, r.top - ph - 6);
      pop.style.position = "fixed";
      pop.style.left = `${left}px`;
      pop.style.top = `${top}px`;
      pop.style.zIndex = "400";
      pop.style.visibility = "";
    });
  }

  function openTableExportPopover(anchor, kind) {
    const pop = document.getElementById("table-export-popover");
    if (!pop) return;
    tableExportKind = kind;
    tableExportAnchor = anchor;
    document.querySelectorAll(".toolbar__export-btn").forEach((b) => b.setAttribute("aria-expanded", "false"));
    anchor.setAttribute("aria-expanded", "true");
    positionTableExportPopover(anchor);
  }

  function bindExportButton(id, kind) {
    document.getElementById(id)?.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const btn = e.currentTarget;
      const pop = document.getElementById("table-export-popover");
      if (!pop) return;
      if (!pop.hidden && tableExportAnchor === btn) closeTableExportPopover();
      else openTableExportPopover(btn, kind);
    });
  }

  async function runTableExport(format) {
    const kind = tableExportKind;
    closeTableExportPopover();
    if (!kind || !["csv", "json", "xlsx"].includes(format)) return;
    try {
      if (kind === "da") {
        await exportDashboardAlertsTable(format);
        return;
      }
      if (kind === "fw") {
        const rows = fwController.getFullFilteredRows();
        const headers = FW_COLUMNS.filter((c) => fwColVisible[c.id]).map((c) => ({ id: c.id, label: c.label }));
        const labels = headers.map((h) => h.label);
        const dataRows = rows.map((r) => headers.map((h) => fwExportCell(r, h.id)));
        const objectsForJson = rows.map((r) => {
          const o = {};
          headers.forEach((h) => {
            o[h.label] = fwExportCell(r, h.id);
          });
          return o;
        });
        deliverTableExport(format, labels, dataRows, objectsForJson, "firewalls", "Firewalls");
        return;
      }
      if (kind === "tn") {
        const rows = tnController.getFullFilteredRows();
        const headers = TN_COLUMNS.filter((c) => tnColVisible[c.id]).map((c) => ({ id: c.id, label: c.label }));
        const labels = headers.map((h) => h.label);
        const dataRows = rows.map((r) => headers.map((h) => tnExportCell(r, h.id)));
        const objectsForJson = rows.map((r) => {
          const o = {};
          headers.forEach((h) => {
            o[h.label] = tnExportCell(r, h.id);
          });
          return o;
        });
        deliverTableExport(format, labels, dataRows, objectsForJson, "tenants", "Tenants");
        return;
      }
      if (kind === "gr") {
        const rows = grController.getFullFilteredRows();
        const headers = GR_COLUMNS.filter((c) => grColVisible[c.id]).map((c) => ({ id: c.id, label: c.label }));
        const labels = headers.map((h) => h.label);
        const dataRows = rows.map((r) => headers.map((h) => grExportCell(r, h.id)));
        const objectsForJson = rows.map((r) => {
          const o = {};
          headers.forEach((h) => {
            o[h.label] = grExportCell(r, h.id);
          });
          return o;
        });
        deliverTableExport(format, labels, dataRows, objectsForJson, "firewall-groups", "Firewall groups");
        return;
      }
      if (kind === "lc") {
        const rows = lcController.getFullFilteredRows();
        const headers = getLcColumns()
          .filter((c) => lcColVisible[c.id])
          .map((c) => ({ id: c.id, label: c.label }));
        const labels = headers.map((h) => h.label);
        const dataRows = rows.map((r) => headers.map((h) => lcExportCell(h.id, r)));
        const objectsForJson = rows.map((r) => {
          const o = {};
          headers.forEach((h) => {
            o[h.label] = lcExportCell(h.id, r);
          });
          return o;
        });
        const base = lcViewMode === "details" ? "licenses-details" : "licenses";
        deliverTableExport(format, labels, dataRows, objectsForJson, base, "Licenses");
      }
    } catch (err) {
      console.error(err);
      notifyAppUser("Export failed", "Export failed. See the console for details.", "error");
    }
  }

  function initTableExportUi() {
    const pop = document.getElementById("table-export-popover");
    if (!pop) return;

    bindExportButton("da-export-btn", "da");
    bindExportButton("fw-export-btn", "fw");
    bindExportButton("tn-export-btn", "tn");
    bindExportButton("gr-export-btn", "gr");
    bindExportButton("lc-export-btn", "lc");

    pop.querySelectorAll("[data-export-format]").forEach((b) => {
      b.addEventListener("click", () => {
        const fmt = b.getAttribute("data-export-format");
        if (fmt) runTableExport(fmt).catch(console.error);
      });
    });

    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !pop.hidden) closeTableExportPopover();
    });
    document.addEventListener("mousedown", (e) => {
      if (pop.hidden) return;
      if (pop.contains(e.target)) return;
      if (e.target.closest(".toolbar__export-btn")) return;
      closeTableExportPopover();
    });

    window.addEventListener("resize", () => {
      if (!pop.hidden && tableExportAnchor) positionTableExportPopover(tableExportAnchor);
    });
  }

  initTableExportUi();

  function collectUiState() {
    const daPageSizeEl = document.getElementById("da-page-size");
    const daSearchEl = document.getElementById("da-search");
    const fwSearch = document.getElementById("fw-search");
    const opsSearchEl = document.getElementById("ops-search");
    const opsSortEl = document.getElementById("ops-sort");
    const fwPageSizeEl = document.getElementById("fw-page-size");
    const tnSearch = document.getElementById("tn-search");
    const tnPageSizeEl = document.getElementById("tn-page-size");
    const grSearch = document.getElementById("gr-search");
    const grPageSizeEl = document.getElementById("gr-page-size");
    const lcSearch = document.getElementById("lc-search");
    const lcPageSizeEl = document.getElementById("lc-page-size");
    const dashFiltersAside = document.querySelector("#panel-dashboard .filters");
    const fwFiltersAside = document.querySelector("#fw-subpanel-firewalls .filters");
    const opsFiltersAside = document.querySelector("#panel-operations .filters");
    const grFiltersAside = document.querySelector("#fw-subpanel-groups .filters");
    const tnFiltersAside = document.querySelector("#panel-tenants .filters");
    const lcFiltersAside = document.querySelector("#panel-licenses .filters");

    const fwFilters = {};
    for (const [k, st] of Object.entries(fwFilterState)) {
      if (st instanceof Set) fwFilters[k] = [...st];
    }
    const tnFilters = {};
    for (const [k, st] of Object.entries(tnFilterState)) {
      if (st instanceof Set) tnFilters[k] = [...st];
    }
    const grFilters = {};
    for (const [k, st] of Object.entries(grFilterState)) {
      if (st instanceof Set) grFilters[k] = [...st];
    }
    const lcFilters = {};
    for (const [k, st] of Object.entries(lcFilterState)) {
      if (st instanceof Set) lcFilters[k] = [...st];
    }
    const opsFilters = {};
    for (const [k, st] of Object.entries(fwFilterState)) {
      if (st instanceof Set) opsFilters[k] = [...st];
    }

    const daRaisedFromEl = document.getElementById("da-raised-custom-from");
    const daRaisedToEl = document.getElementById("da-raised-custom-to");
    if (daRaisedFromEl) daRaisedCustomStored.from = daRaisedFromEl.value;
    if (daRaisedToEl) daRaisedCustomStored.to = daRaisedToEl.value;

    return {
      tab: getActiveTabName(),
      dashboard: {
        severity_levels: [...daSeverityLevels],
        raised_preset: daRaisedPreset,
        raised_custom_from: daRaisedCustomStored.from,
        raised_custom_to: daRaisedCustomStored.to,
        search: daSearchEl ? daSearchEl.value : "",
        pageSize: daPageSizeEl
          ? Math.max(1, parseInt(daPageSizeEl.value, 10) || daState.pageSize)
          : daState.pageSize,
        tenant_names: [...daFilterState.tenant_name],
        firewall_hostnames: [...daFilterState.firewall_hostname],
        filtersExpanded: dashFiltersAside
          ? !dashFiltersAside.classList.contains("filters--collapsed")
          : undefined,
      },
      firewalls: {
        subtab: activeFirewallsSubtab,
        linkMode: fwLinkMode,
        search: fwSearch ? fwSearch.value : "",
        pageSize: fwPageSizeEl ? Math.max(1, parseInt(fwPageSizeEl.value, 10) || 50) : 50,
        filters: fwFilters,
        table: fwController.getTableState(),
        filtersExpanded: fwFiltersAside
          ? !fwFiltersAside.classList.contains("filters--collapsed")
          : undefined,
      },
      operations: {
        search: opsSearchEl ? opsSearchEl.value : "",
        sort: opsSortEl ? opsSortEl.value : "state_online_first",
        linkMode: fwLinkMode,
        filters: opsFilters,
        tenant_names:
          fwFilterState.tenant_name instanceof Set ? [...fwFilterState.tenant_name] : [],
        filtersExpanded: opsFiltersAside
          ? !opsFiltersAside.classList.contains("filters--collapsed")
          : undefined,
      },
      groups: {
        search: grSearch ? grSearch.value : "",
        pageSize: grPageSizeEl ? Math.max(1, parseInt(grPageSizeEl.value, 10) || 50) : 50,
        filters: grFilters,
        table: grController.getTableState(),
        filtersExpanded: grFiltersAside
          ? !grFiltersAside.classList.contains("filters--collapsed")
          : undefined,
      },
      tenants: {
        search: tnSearch ? tnSearch.value : "",
        pageSize: tnPageSizeEl ? Math.max(1, parseInt(tnPageSizeEl.value, 10) || 50) : 50,
        filters: tnFilters,
        table: tnController.getTableState(),
        filtersExpanded: tnFiltersAside
          ? !tnFiltersAside.classList.contains("filters--collapsed")
          : undefined,
      },
      licenses: {
        viewMode: lcViewMode,
        search: lcSearch ? lcSearch.value : "",
        pageSize: lcPageSizeEl ? Math.max(1, parseInt(lcPageSizeEl.value, 10) || 50) : 50,
        filters: lcFilters,
        endDateFacet: {
          presets: [...lcEndDatePresetSelections],
          customFrom: lcEndDateCustomFrom,
          customTo: lcEndDateCustomTo,
        },
        startDateFacet: {
          presets: [...lcStartDatePresetSelections],
          customFrom: lcStartDateCustomFrom,
          customTo: lcStartDateCustomTo,
        },
        table: lcController.getTableState(),
        filtersExpanded: lcFiltersAside
          ? !lcFiltersAside.classList.contains("filters--collapsed")
          : undefined,
      },
    };
  }

  function applyFirewallSaved(s) {
    if (!s || typeof s !== "object") return;
    const legacyLm = s.linkMode;
    fwLinkMode =
      legacyLm === "offline" || legacyLm === "firmware_updates" ? legacyLm : null;
    const search = document.getElementById("fw-search");
    if (search && typeof s.search === "string") search.value = s.search;
    const psEl = document.getElementById("fw-page-size");
    if (psEl && s.pageSize != null) {
      const v = String(s.pageSize);
      if ([...psEl.options].some((o) => o.value === v)) psEl.value = v;
    }
    const filters = s.filters && typeof s.filters === "object" ? s.filters : {};
    for (const [k, arr] of Object.entries(filters)) {
      const st = fwFilterState[k];
      if (!st || !(st instanceof Set) || !Array.isArray(arr)) continue;
      st.clear();
      arr.forEach((x) => st.add(String(x)));
    }
    const statusSt = fwFilterState.status;
    if (legacyLm === "suspended" && statusSt) {
      statusSt.clear();
      statusSt.add("Suspended");
    } else if (legacyLm === "pending" && statusSt) {
      statusSt.clear();
      statusSt.add("Pending approval");
    }
    syncFirewallFilterCheckboxesFromState();
    fwToolbarTenantMs.refresh();
    opsToolbarTenantMs.refresh();
    renderOperationsView();
    if (s.table && typeof s.table === "object") fwController.setTableState(s.table);
    if (typeof s.filtersExpanded === "boolean") {
      const aside = document.querySelector("#fw-subpanel-firewalls .filters");
      if (aside) setFiltersPanelCollapsed(aside, !s.filtersExpanded);
    }
    if (s.subtab === "groups" || s.subtab === "firewalls") {
      activeFirewallsSubtab = s.subtab;
      if (getActiveTabName() === "firewalls") setFirewallsSubtab(activeFirewallsSubtab, false);
    }
  }

  function applyOperationsSaved(s) {
    if (!s || typeof s !== "object") return;
    const touchFw =
      ("filters" in s && s.filters && typeof s.filters === "object") ||
      "linkMode" in s ||
      Array.isArray(s.tenant_names);
    if (touchFw) {
      const legacyLm = s.linkMode;
      if ("linkMode" in s) {
        fwLinkMode =
          legacyLm === "offline" || legacyLm === "firmware_updates" ? legacyLm : null;
      }
      if ("filters" in s && s.filters && typeof s.filters === "object") {
        for (const [k, arr] of Object.entries(s.filters)) {
          const st = fwFilterState[k];
          if (!st || !(st instanceof Set) || !Array.isArray(arr)) continue;
          st.clear();
          arr.forEach((x) => st.add(String(x)));
        }
      }
      const statusSt = fwFilterState.status;
      if (legacyLm === "suspended" && statusSt) {
        statusSt.clear();
        statusSt.add("Suspended");
      } else if (legacyLm === "pending" && statusSt) {
        statusSt.clear();
        statusSt.add("Pending approval");
      }
      if (Array.isArray(s.tenant_names)) {
        const tset = fwFilterState.tenant_name;
        if (tset instanceof Set) {
          tset.clear();
          s.tenant_names.forEach((x) => tset.add(String(x)));
        }
      }
      syncFirewallFilterCheckboxesFromState();
      updateFirewallFiltersChrome();
      fwController.render();
      fwToolbarTenantMs.refresh();
      opsToolbarTenantMs.refresh();
      updateFwQuickFilterToolbarUi();
    }
    const search = document.getElementById("ops-search");
    if (search && typeof s.search === "string") search.value = s.search;
    const sortEl = document.getElementById("ops-sort");
    if (sortEl && typeof s.sort === "string" && [...sortEl.options].some((o) => o.value === s.sort)) {
      sortEl.value = s.sort;
    }
    if (typeof s.filtersExpanded === "boolean") {
      const aside = document.querySelector("#panel-operations .filters");
      if (aside) setFiltersPanelCollapsed(aside, !s.filtersExpanded);
    }
    renderOperationsView();
    updateOpsQuickFilterToolbarUi();
  }

  async function loadPersistedOperationsUi() {
    try {
      const data = await loadJson("/api/me/operations-ui");
      if (data && typeof data === "object" && Object.keys(data).length > 0) {
        applyOperationsSaved(data);
      }
    } catch {
      /* ignore */
    }
  }

  function applyTenantSaved(s) {
    if (!s || typeof s !== "object") return;
    const el = document.getElementById("tn-search");
    if (el && typeof s.search === "string") el.value = s.search;
    const psEl = document.getElementById("tn-page-size");
    if (psEl && s.pageSize != null) {
      const v = String(s.pageSize);
      if ([...psEl.options].some((o) => o.value === v)) psEl.value = v;
    }
    const filters = s.filters && typeof s.filters === "object" ? s.filters : {};
    for (const [k, arr] of Object.entries(filters)) {
      const st = tnFilterState[k];
      if (!st || !(st instanceof Set) || !Array.isArray(arr)) continue;
      st.clear();
      arr.forEach((x) => st.add(String(x)));
    }
    syncTenantFilterCheckboxesFromState();
    if (s.table && typeof s.table === "object") tnController.setTableState(s.table);
    if (typeof s.filtersExpanded === "boolean") {
      const aside = document.querySelector("#panel-tenants .filters");
      if (aside) setFiltersPanelCollapsed(aside, !s.filtersExpanded);
    }
  }

  function applyGroupSaved(s) {
    if (!s || typeof s !== "object") return;
    const el = document.getElementById("gr-search");
    if (el && typeof s.search === "string") el.value = s.search;
    const psEl = document.getElementById("gr-page-size");
    if (psEl && s.pageSize != null) {
      const v = String(s.pageSize);
      if ([...psEl.options].some((o) => o.value === v)) psEl.value = v;
    }
    const filters = s.filters && typeof s.filters === "object" ? s.filters : {};
    for (const [k, arr] of Object.entries(filters)) {
      const st = grFilterState[k];
      if (!st || !(st instanceof Set) || !Array.isArray(arr)) continue;
      st.clear();
      arr.forEach((x) => st.add(String(x)));
    }
    syncGroupFilterCheckboxesFromState();
    grToolbarTenantMs.refresh();
    if (s.table && typeof s.table === "object") grController.setTableState(s.table);
    if (typeof s.filtersExpanded === "boolean") {
      const aside = document.querySelector("#fw-subpanel-groups .filters");
      if (aside) setFiltersPanelCollapsed(aside, !s.filtersExpanded);
    }
  }

  function applyLicenseSaved(s) {
    if (!s || typeof s !== "object") return;
    const el = document.getElementById("lc-search");
    if (el && typeof s.search === "string") el.value = s.search;
    const psEl = document.getElementById("lc-page-size");
    if (psEl && s.pageSize != null) {
      const v = String(s.pageSize);
      if ([...psEl.options].some((o) => o.value === v)) psEl.value = v;
    }
    if (s.viewMode === "details" || s.viewMode === "summary") {
      if (s.viewMode !== lcViewMode) {
        persistLcColumnVisibilityNow();
        lcViewMode = s.viewMode;
        lcColVisible = loadLcColumnVisibilitySnapshot(lcViewMode);
        updateLcViewToggleUi();
        buildLcThead();
        buildLcColumnMenuList();
      }
    }
    const filters = s.filters && typeof s.filters === "object" ? s.filters : {};
    buildLicenseFilters();
    for (const [k, arr] of Object.entries(filters)) {
      const st = lcFilterState[k];
      if (!st || !(st instanceof Set) || !Array.isArray(arr)) continue;
      arr.forEach((x) => st.add(String(x)));
    }
    const ed = s.endDateFacet;
    if (ed && typeof ed === "object" && Array.isArray(ed.presets)) {
      lcEndDatePresetSelections.clear();
      ed.presets.forEach((x) => {
        if (typeof x === "string") lcEndDatePresetSelections.add(x);
      });
      if (typeof ed.customFrom === "string") lcEndDateCustomFrom = ed.customFrom;
      if (typeof ed.customTo === "string") lcEndDateCustomTo = ed.customTo;
    }
    const sd = s.startDateFacet;
    if (sd && typeof sd === "object" && Array.isArray(sd.presets)) {
      lcStartDatePresetSelections.clear();
      sd.presets.forEach((x) => {
        if (typeof x === "string") lcStartDatePresetSelections.add(x);
      });
      if (typeof sd.customFrom === "string") lcStartDateCustomFrom = sd.customFrom;
      if (typeof sd.customTo === "string") lcStartDateCustomTo = sd.customTo;
    }
    syncLicenseFilterCheckboxesFromState();
    syncLcDateFacetUi();
    lcToolbarTenantMs.refresh();
    if (s.table && typeof s.table === "object") lcController.setTableState(s.table);
    if (typeof s.filtersExpanded === "boolean") {
      const aside = document.querySelector("#panel-licenses .filters");
      if (aside) setFiltersPanelCollapsed(aside, !s.filtersExpanded);
    }
  }

  async function loadLicenses(opts = {}) {
    const preserve = opts.preserve === true;
    const [rows, detailRows] = await Promise.all([
      loadJson("/api/licenses"),
      loadJson("/api/licenses-detailed"),
    ]);
    lcPrepared = rows.map(prepareLicense);
    lcDetailPrepared = detailRows.map(prepareLicenseDetail);
    buildLicenseFilters();
    if (!preserve) {
      lcController.clearSelection();
      lcController.resetPage();
    }
  }

  function captureMainScrollSnapshot() {
    const scrollEls = Array.from(document.querySelectorAll("main.main .table-scroll"));
    return {
      winX: window.scrollX,
      winY: window.scrollY,
      tableScrolls: scrollEls.map((el) => ({
        el,
        top: el.scrollTop,
        left: el.scrollLeft,
      })),
    };
  }

  function restoreMainScrollSnapshot(snap) {
    if (!snap) return;
    window.scrollTo(snap.winX ?? 0, snap.winY ?? 0);
    snap.tableScrolls?.forEach(({ el, top, left }) => {
      if (el && el.isConnected) {
        el.scrollTop = top ?? 0;
        el.scrollLeft = left ?? 0;
      }
    });
  }

  async function performSilentDataRefresh() {
    if (silentDataRefreshInFlight) return;
    silentDataRefreshInFlight = true;
    const snap = captureMainScrollSnapshot();
    const ae = document.activeElement;
    const fwVis = fwController.getVisibleCount();
    const grVis = grController.getVisibleCount();
    const tnVis = tnController.getVisibleCount();
    const lcVis = lcController.getVisibleCount();
    try {
      await Promise.all([
        loadDashboard({ preserve: true }),
        loadFirewalls({ preserve: true }),
        loadFirewallGroups({ preserve: true }),
        loadTenants({ preserve: true }),
        loadLicenses({ preserve: true }),
      ]);
      fwController.render();
      grController.render();
      tnController.render();
      lcController.render();
      fwController.restoreVisibleSlice(fwVis);
      grController.restoreVisibleSlice(grVis);
      tnController.restoreVisibleSlice(tnVis);
      lcController.restoreVisibleSlice(lcVis);
      refreshSettingsSyncIfVisible();
    } catch (e) {
      console.error(e);
    } finally {
      silentDataRefreshInFlight = false;
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          restoreMainScrollSnapshot(snap);
          if (ae && typeof ae.focus === "function" && ae.isConnected) {
            try {
              ae.focus({ preventScroll: true });
            } catch {
              ae.focus();
            }
          }
        });
      });
    }
  }

  onSuccessfulDataSyncTimestampChange = () => {
    void performSilentDataRefresh();
  };

  /* ---------- Boot ---------- */
  initAuthForms();
  initUserMenu();
  initAppSyncStatusBar();
  initNotificationsFlyout();
  initProfileModal();
  initCollapsibleFilterPanels();
  initFacetFilterResetControls();
  initSettingsModal();
  initDashboardAlertsUi();
  fwToolbarTenantMs.init();
  opsToolbarTenantMs.init();
  grToolbarTenantMs.init();
  lcToolbarTenantMs.init();
  initFwMapHeightsAndResizeHandles();
  initFwMapSectionToggles();
  initFwMapBackNavigation();
  initFwLocationModal();
  initFwDetailFlyout();
  initOperationsViewPanel();

  async function init() {
    const saved = readUiState();
    if (saved?.dashboard) hydrateDashboardFromSaved(saved.dashboard);
    if (saved?.firewalls?.subtab === "groups" || saved?.firewalls?.subtab === "firewalls") {
      activeFirewallsSubtab = saved.firewalls.subtab;
    }
    if (saved?.tab === "groups") activeFirewallsSubtab = "groups";
    const initialMainTab = saved?.tab === "groups" ? "firewalls" : saved?.tab;
    if (initialMainTab && TITLES[initialMainTab]) activateTab(initialMainTab, false);

    try {
      await loadUiSettings();
      await Promise.all([
        loadDashboard(),
        loadFirewalls(),
        loadFirewallGroups(),
        loadTenants(),
        loadLicenses(),
      ]);

      if (saved?.firewalls) applyFirewallSaved(saved.firewalls);
      if (saved?.groups) applyGroupSaved(saved.groups);
      if (saved?.tenants) applyTenantSaved(saved.tenants);
      if (saved?.licenses) applyLicenseSaved(saved.licenses);

      await loadPersistedOperationsUi();
      // Apply session operations after server so sort/search/filters match this tab (server payload can lag).
      if (saved?.operations) applyOperationsSaved(saved.operations);

      fwController.render();
      grController.render();
      tnController.render();
      lcController.render();

      applyFwApproveButtonVisibility();
      schedulePersistUiState();
    } catch (e) {
      console.error(e);
      pageTitle.textContent = "Error loading data";
    }
  }

  bootAuth();
})();

