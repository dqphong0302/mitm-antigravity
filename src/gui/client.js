const { I18N } = require("./i18n");

function guiClientScript() {
  return `
    const I18N = ${JSON.stringify(I18N)};
    const STORAGE_THEME = "mitm-ag-theme";
    const STORAGE_LANG = "mitm-ag-language";
    const state = {
      config: null,
      builtInAliases: [],
      models: [],
      logs: { backend: "", proxy: "" },
      theme: localStorage.getItem(STORAGE_THEME) || "system",
      lang: localStorage.getItem(STORAGE_LANG) || "en",
      status: null,
      doctor: null,
      platform: { isWin: false, isMac: false, isLinux: false, needsSudoPassword: false },
    };
    const $ = (id) => document.getElementById(id);

    function t(key, values) {
      const table = I18N[state.lang] || I18N.en;
      let text = table[key] || I18N.en[key] || key;
      for (const [name, value] of Object.entries(values || {})) {
        text = text.replace(new RegExp("\\\\{" + name + "\\\\}", "g"), String(value));
      }
      return text;
    }

    function preferredTheme() {
      if (state.theme === "light" || state.theme === "dark") return state.theme;
      return window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    }

    function applyTheme() {
      document.documentElement.dataset.theme = preferredTheme();
      if ($("themeSelect")) $("themeSelect").value = state.theme;
    }

    function applyLanguage(options) {
      document.documentElement.lang = state.lang;
      if ($("languageSelect")) $("languageSelect").value = state.lang;
      document.querySelectorAll("[data-i18n]").forEach((el) => {
        el.textContent = t(el.dataset.i18n);
      });
      document.querySelectorAll("[data-i18n-placeholder]").forEach((el) => {
        el.setAttribute("placeholder", t(el.dataset.i18nPlaceholder));
      });
      document.querySelectorAll("[data-i18n-title]").forEach((el) => {
        el.setAttribute("title", t(el.dataset.i18nTitle));
      });
      document.querySelectorAll("[data-i18n-aria-label]").forEach((el) => {
        el.setAttribute("aria-label", t(el.dataset.i18nAriaLabel));
      });
      if (state.config) renderMappings();
      if (state.status && !(options && options.skipStatus)) renderStatus(state.status);
      if (state.doctor) renderDoctor(state.doctor);
      applyLogFilter();
    }

    function esc(value) {
      return String(value || "").replace(/[&<>"']/g, (char) => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        "\\\"": "&quot;",
        "'": "&#39;"
      }[char]));
    }

    async function api(path, opts) {
      let res;
      try {
        res = await fetch(path, {
          ...(opts || {}),
          headers: { "Content-Type": "application/json", ...((opts && opts.headers) || {}) }
        });
      } catch (error) {
        throw new Error(t("error.network", { message: error.message }));
      }

      const contentType = res.headers.get("content-type") || "";
      const data = contentType.includes("application/json")
        ? await res.json().catch(() => ({}))
        : { error: await res.text().catch(() => "") };

      if (!res.ok) {
        const requestId = data.requestId ? " [" + data.requestId + "]" : "";
        const logs = data.logPaths ? " Logs: backend=" + data.logPaths.backend + " proxy=" + data.logPaths.proxy : "";
        throw new Error((data.error || t("error.requestFailed")) + requestId + logs);
      }
      return data;
    }

    function showStatus(id, text, kind) {
      const el = $(id);
      if (!el) return;
      el.className = "status " + (kind || "");
      el.textContent = text;
      el.style.display = "flex";
    }

    function toCompletionsUrl(raw) {
      if (!raw) return "";
      let url = raw.trim();
      while (url.endsWith("/")) url = url.slice(0, -1);
      if (url.endsWith("/chat/completions") || url.endsWith("/responses")) return url;
      return url + "/chat/completions";
    }

    function toBaseUrl(url) {
      if (!url) return "";
      if (url.endsWith("/chat/completions")) return url.slice(0, -"/chat/completions".length);
      if (url.endsWith("/responses")) return url.slice(0, -"/responses".length);
      return url;
    }

    function readForm() {
      return {
        routerUrl: toCompletionsUrl($("baseUrl").value),
        apiKey: $("apiKey").value,
        model: $("model").value.trim(),
        modelPrefix: "",
        alwaysIntercept: !$("passthroughUnmapped").checked,
        mockModelList: false,
        modelMap: readMappings()
      };
    }

    function readMappings() {
      const out = {};
      document.querySelectorAll("[data-alias]").forEach((row) => {
        const alias = row.dataset.alias;
        const select = row.querySelector("select.model-select");
        const input = row.querySelector("input.upstream-model");
        const reasoning = row.querySelector("select.reasoning-select");
        const value = select ? select.value.trim() : (input ? input.value.trim() : "");
        const reasoningEffort = reasoning ? reasoning.value.trim() : "";
        if (alias && value) {
          out[alias] = reasoningEffort ? { model: value, reasoning_effort: reasoningEffort } : value;
        }
      });
      return out;
    }

    function mappingModelValue(entry) {
      if (!entry) return "";
      if (typeof entry === "string") return entry;
      if (typeof entry === "object") return entry.model || "";
      return "";
    }

    function makeModelCell(selected) {
      if (state.models.length > 0) {
        const values = Array.from(new Set(["", selected, ...state.models].filter((value) => value !== undefined)));
        const options = values.map((value) => {
          return "<option value=\\"" + esc(value) + "\\"" + (value === selected ? " selected" : "") + ">" + esc(value || t("mapping.noMapping")) + "</option>";
        }).join("");
        return "<select class=\\"model-select\\">" + options + "</select>";
      }
      return "<input class=\\"upstream-model\\" value=\\"" + esc(selected) + "\\" placeholder=\\"e.g. cx/gpt-5.5\\">";
    }

    function mappingReasoningValue(entry) {
      if (!entry || typeof entry !== "object") return "";
      return entry.reasoning_effort || "";
    }

    function makeReasoningCell(selected) {
      const values = ["", "low", "medium", "high", "xhigh"];
      const labels = {
        "": t("reasoning.default"),
        low: "Low",
        medium: "Medium",
        high: "High",
        xhigh: "XHigh"
      };
      const options = values.map((value) => {
        return "<option value=\\"" + esc(value) + "\\"" + (value === selected ? " selected" : "") + ">" + esc(labels[value] || value) + "</option>";
      }).join("");
      return "<select class=\\"reasoning-select\\" aria-label=\\"Reasoning effort\\">" + options + "</select>";
    }


    function renderMappings() {
      const map = (state.config && state.config.modelMap) || {};
      const aliases = state.builtInAliases.slice();
      const mappedCount = aliases.filter((alias) => map[alias]).length;
      $("mappingCount").textContent = t("mapping.count", { mapped: mappedCount, total: aliases.length });

      if (aliases.length === 0) {
        $("mappingRows").innerHTML = "<tr><td colspan=\\"5\\">" + esc(t("mapping.noModels")) + "</td></tr>";
        return;
      }

      $("mappingRows").innerHTML = aliases.map((alias) => {
        const entry = map[alias] || "";
        const mapped = Boolean(mappingModelValue(entry));
        return "<tr data-alias=\\"" + esc(alias) + "\\">" +
          "<td class=\\"alias-cell\\">" + esc(alias) + "</td>" +
          "<td class=\\"arrow-cell\\">→</td>" +
          "<td class=\\"model-cell\\">" + makeModelCell(mappingModelValue(entry)) + "</td>" +
          "<td class=\\"reasoning-cell\\">" + makeReasoningCell(mappingReasoningValue(entry)) + "</td>" +
          "<td class=\\"mapping-state\\"><span class=\\"tag " + (mapped ? "ok" : "neutral") + "\\">" + esc(mapped ? t("mapping.mapped") : t("mapping.unmapped")) + "</span></td>" +
        "</tr>";
      }).join("");
    }

    function setMetric(id, value, cls) {
      const el = $(id);
      if (!el) return;
      el.textContent = value;
      el.className = "metric-value " + (cls || "neutral");
    }

    function renderProxyToggle(status) {
      const btn = $("proxyToggleBtn");
      if (!btn) return;
      const running = Boolean(status && status.proxyListening);
      btn.textContent = running ? t("button.stopShort") : t("button.startShort");
      btn.dataset.action = running ? "stop" : "start";
      btn.classList.toggle("danger", running);
      btn.classList.toggle("ready", !running);
      btn.setAttribute("aria-label", running ? t("button.stop") : t("button.start"));
      btn.title = running ? t("button.stop") : t("button.start");
    }

    function renderStatus(status) {
      state.status = status;
      // Append the manager mode (embedded/detached/idle) to the proxy metric
      // so users immediately see HOW the proxy is running, not just whether
      // a listener is up. Embedded means the GUI process owns it (fast reload,
      // no UAC); detached means a separate process; idle means stopped.
      const mode = status.proxyMode && status.proxyMode !== "idle" ? " · " + status.proxyMode : "";
      setMetric(
        "s-proxy",
        (status.proxyListening ? t("status.running") : t("status.stopped")) + mode,
        status.proxyListening ? "ok" : "err"
      );
      setMetric("s-dns", status.dnsConfigured ? t("status.active") : t("status.notSet"), status.dnsConfigured ? "ok" : "err");
      setMetric("s-cert", status.certExists ? t("status.generated") : t("status.missing"), status.certExists ? "ok" : "err");
      setMetric("s-trust", status.certInstalled ? t("status.trusted") : t("status.notTrusted"), status.certInstalled ? "ok" : "warn");
      setMetric("s-node-trust", status.nodeTrustApplied ? t("status.active") : (status.nodeTrustSupported ? t("status.missing") : t("status.notApplicable")), status.nodeTrustApplied ? "ok" : (status.nodeTrustSupported ? "warn" : "neutral"));
      setMetric("s-models", status.mappedModels > 0 ? t("status.aliasCount", { count: status.mappedModels }) : "—", status.mappedModels > 0 ? "ok" : "neutral");
      setMetric("s-router", status.routerUrl || "—", "neutral");
      setMetric("s-autostart", status.autoStart && status.autoStart.enabled ? t("status.enabled") : t("status.disabled"), status.autoStart && status.autoStart.enabled ? "ok" : "warn");
      renderProxyToggle(status);
      renderReadinessWarnings(status);
    }

    function readinessMessage(text) {
      return '<div class="status warn readiness-item">' + esc(text) + '</div>';
    }

    function renderReadinessWarnings(status) {
      const target = $("mappingReadiness");
      if (!target) return;
      const warnings = [];
      if (status.dnsConfigured && !status.proxyListening) warnings.push(t("readiness.dnsWithoutProxy"));
      if (status.proxyListening && !status.dnsConfigured) warnings.push(t("readiness.proxyWithoutDns"));
      if (!status.certInstalled) warnings.push(t("readiness.certMissing"));
      if (status.nodeTrustSupported && !status.nodeTrustApplied) warnings.push(t("readiness.nodeTrustMissing"));
      if (status.portOwnerText && !status.proxyListening) warnings.push(t("readiness.portBusy", { port: status.port || 443, owner: status.portOwnerText }));
      target.innerHTML = warnings.map(readinessMessage).join("");
    }

    let statusRequest = null;
    let lastStatusRequestAt = 0;

    async function loadStatus(options) {
      const force = Boolean(options && options.force);
      const now = Date.now();
      if (!force && statusRequest) return statusRequest;
      if (!force && now - lastStatusRequestAt < 1200) return statusRequest || Promise.resolve();
      lastStatusRequestAt = now;
      statusRequest = api("/api/status")
        .then(renderStatus)
        .catch(() => {
          // Status polling is best-effort; actionable errors appear in explicit actions.
        })
        .finally(() => {
          statusRequest = null;
        });
      return statusRequest;
    }

    // Server-Sent Events: backend emits proxy lifecycle changes (start/stop/
    // reload/error) and a heartbeat. We use it to keep the dashboard live
    // without aggressive polling. EventSource auto-reconnects on network blips.
    let proxyEvents = null;
    let proxyEventsRetryAt = 0;
    function subscribeProxyEvents() {
      if (typeof EventSource === "undefined") return;
      try {
        if (proxyEvents) proxyEvents.close();
        proxyEvents = new EventSource("/api/events");
      } catch {
        return;
      }
      proxyEvents.addEventListener("status", () => {
        // The status payload omits some derived fields (cert, dns) so always
        // re-fetch /api/status. Force-bypass the 1.2s debounce.
        loadStatus({ force: true });
      });
      proxyEvents.addEventListener("error", () => {
        loadStatus({ force: true });
      });
      // Browser EventSource auto-reconnects on transient drops, but if the
      // backend itself restarts (e.g. after an upgrade) the readyState can
      // stick at CLOSED. Fall back to a manual retry guarded by a 3s cooldown
      // so we don't busy-loop while the backend is genuinely down.
      proxyEvents.onerror = () => {
        if (proxyEvents && proxyEvents.readyState === EventSource.CLOSED) {
          const now = Date.now();
          if (now - proxyEventsRetryAt < 3000) return;
          proxyEventsRetryAt = now;
          setTimeout(subscribeProxyEvents, 1500);
        }
      };
    }

    function setSystemButtons(disabled) {
      ["proxyToggleBtn", "applyDnsBtn", "applyAppTrustBtn", "startProxyOnlyBtn", "stopCleanupBtn", "removeDnsBtn", "forceKillPortBtn", "enableAutoStartBtn", "disableAutoStartBtn", "uninstallCertBtn", "runDoctorBtn", "refreshQuotasBtn"].forEach((id) => {
        if ($(id)) $(id).disabled = disabled;
      });
    }

    // Body cho các action cần elevated privileges.
    // Sudo password KHÔNG được nhập trong app – OS tự xử lý qua dialog riêng
    // (osascript trên macOS, UAC trên Windows).
    function elevatedBody(extra) {
      return JSON.stringify(extra || {});
    }

    async function load() {
      const data = await api("/api/bootstrap");
      state.config = data.config;
      state.builtInAliases = data.antigravityAliases || [];
      state.platform = data.platform || state.platform;
      if (data.cachedModels && data.cachedModels.length > 0 && state.models.length === 0) {
        state.models = data.cachedModels;
      }
      $("configPath").textContent = data.configPath;
      $("settingsConfigPath").textContent = data.configPath || "—";
      $("settingsBundledPath").textContent = data.bundledSettingsPath || "—";
      $("settingsLegacyPath").textContent = data.legacyConfigPath || "—";
      $("settingsMachine").textContent = data.machine || "—";
      $("baseUrl").value = toBaseUrl(state.config.routerUrl || "");
      $("apiKey").value = state.config.apiKey || "";
      $("model").value = state.config.model || "";
      $("passthroughUnmapped").checked = state.config.alwaysIntercept !== true;
      // Hiện Linux info banner nếu đang chạy trên Linux
      const linuxPanel = $("linuxInfoPanel");
      if (linuxPanel) linuxPanel.style.display = state.platform.isLinux ? "" : "none";
      renderMappings();
      applyLanguage({ skipStatus: true });
      loadStatus();
    }

    async function checkKey() {
      $("checkBtn").disabled = true;
      showStatus("endpointStatus", t("message.testing"), "loading");
      try {
        const form = readForm();
        const result = await api("/api/check-key", { method: "POST", body: JSON.stringify(form) });
        state.models = result.models || [];
        const saved = await api("/api/config", { method: "PUT", body: JSON.stringify(form) });
        state.config = saved.config;
        const reloadText = saved.proxy && saved.proxy.reloaded ? " " + t("message.proxyReloaded") + "." : "";
        showStatus("endpointStatus", t("message.loadedModels", { count: state.models.length, url: result.modelsUrl }) + reloadText, "ok");
        renderMappings();
        loadStatus();
      } catch (error) {
        const detail = error.hint ? error.message + " " + error.hint : error.message;
        showStatus("endpointStatus", t("error.prefix", { message: detail }), "err");
      } finally {
        $("checkBtn").disabled = false;
      }
    }

    async function saveMappingsAndReload() {
      $("saveMappingsBtn").disabled = true;
      showStatus("mappingStatus", t("message.savingMapping"), "loading");
      try {
        const result = await api("/api/config", { method: "PUT", body: JSON.stringify(readForm()) });
        state.config = result.config;
        renderMappings();
        const reload = result.proxy || {};
        const reloadText = reload.reloaded ? t("message.proxyReloaded") : t("message.proxyNotRunning");
        showStatus("mappingStatus", t("message.mappingSaved", { reload: reloadText }), "ok");
        loadStatus();
      } catch (error) {
        showStatus("mappingStatus", t("error.prefix", { message: error.message }), "err");
      } finally {
        $("saveMappingsBtn").disabled = false;
      }
    }

    function summarizeProxyStart(result) {
      const parts = [];
      parts.push(result.restarted ? t("message.proxyRestarted") : (result.alreadyRunning ? t("message.proxyAlreadyRunning") : t("message.proxyStarted")));
      if (result.dns && result.dns.added) parts.push(t("message.dnsActive"));
      if (result.cert && result.cert.installed) parts.push(t("message.certTrusted"));
      if (result.nodeTrust && result.nodeTrust.applied) parts.push(t("message.nodeTrustActive"));
      else if (result.nodeTrust && result.nodeTrust.error) parts.push(t("message.nodeTrustFailed"));
      let restartText = "";
      if (result.nodeTrust && result.nodeTrust.antigravityRunning) restartText = " " + t("message.restartAntigravityRunning");
      else if (result.nodeTrust && result.nodeTrust.restartRequired) restartText = " " + t("message.restartAntigravity");
      return parts.join(", ") + "." + restartText;
    }

    async function startProxy() {
      setSystemButtons(true);
      showStatus("systemStatus", t("message.starting"), "loading");
      try {
        const result = await api("/api/start-proxy", { method: "POST", body: elevatedBody() });
        showStatus("systemStatus", summarizeProxyStart(result), "ok");
        loadStatus();
      } catch (error) {
        showStatus("systemStatus", t("error.prefix", { message: error.message }), "err");
      } finally {
        setSystemButtons(false);
      }
    }

    async function startProxyOnly() {
      setSystemButtons(true);
      showStatus("systemStatus", t("message.startingProxyOnly"), "loading");
      try {
        const result = await api("/api/start-proxy-only", { method: "POST", body: elevatedBody() });
        showStatus("systemStatus", result.restarted ? t("message.proxyRestarted") : (result.alreadyRunning ? t("message.proxyAlreadyRunning") : t("message.proxyStarted")), "ok");
        loadStatus();
      } catch (error) {
        showStatus("systemStatus", t("error.prefix", { message: error.message }), "err");
      } finally {
        setSystemButtons(false);
      }
    }

    async function stopProxy() {
      setSystemButtons(true);
      showStatus("systemStatus", t("message.stopping"), "loading");
      try {
        const result = await api("/api/stop-proxy", { method: "POST", body: elevatedBody() });
        showStatus("systemStatus", result.stopped ? t("message.proxyStopped") : t("message.proxyWasNotRunning"), "ok");
        loadStatus();
      } catch (error) {
        showStatus("systemStatus", t("error.prefix", { message: error.message }), "err");
      } finally {
        setSystemButtons(false);
      }
    }

    async function toggleProxy() {
      const action = state.status && state.status.proxyListening ? "stop" : "start";
      if (action === "stop") return stopProxy();
      return startProxy();
    }

    async function forceKillPort() {
      const cfg = state.config || {};
      const port = cfg.port || 443;
      if (!window.confirm(t("message.killingPort", { port }))) return;
      setSystemButtons(true);
      showStatus("systemStatus", t("message.killingPort", { port }), "loading");
      try {
        const result = await api("/api/force-kill-port", { method: "POST", body: elevatedBody() });
        if (!result.wasListening) {
          showStatus("systemStatus", t("message.portWasFree", { port: result.port }), "ok");
        } else {
          showStatus("systemStatus", t("message.portKilled", { owner: result.ownerText || "process", port: result.port }), "ok");
        }
        loadStatus();
      } catch (error) {
        showStatus("systemStatus", t("error.prefix", { message: error.message }), "err");
      } finally {
        setSystemButtons(false);
      }
    }

    async function applyDns() {
      setSystemButtons(true);
      showStatus("systemStatus", t("message.applyingDns"), "loading");
      try {
        const result = await api("/api/apply-dns", { method: "POST", body: elevatedBody() });
        const parts = [
          result.dns && result.dns.added ? t("message.dnsAdded") : t("message.dnsAlreadyActive"),
          result.cert && result.cert.installed ? t("message.certTrusted") : t("message.certAlreadyTrusted")
        ];
        if (result.nodeTrust && result.nodeTrust.applied) parts.push(t("message.nodeTrustActive"));
        else if (result.nodeTrust && result.nodeTrust.error) parts.push(t("message.nodeTrustFailed"));
        if (result.proxy && result.proxy.reloaded) parts.push(t("message.proxyReloaded"));
        let restartText = "";
        if (result.nodeTrust && result.nodeTrust.antigravityRunning) restartText = " " + t("message.restartAntigravityRunning");
        else if (result.nodeTrust && result.nodeTrust.restartRequired) restartText = " " + t("message.restartAntigravity");
        showStatus("systemStatus", parts.join(", ") + "." + restartText, "ok");
        loadStatus();
      } catch (error) {
        showStatus("systemStatus", t("error.prefix", { message: error.message }), "err");
      } finally {
        setSystemButtons(false);
      }
    }

    async function applyAppTrust() {
      setSystemButtons(true);
      showStatus("systemStatus", t("message.applyingAppTrust"), "loading");
      try {
        const result = await api("/api/apply-app-trust", { method: "POST", body: elevatedBody() });
        const nodeTrust = result.nodeTrust || {};
        let message = nodeTrust.supported === false
          ? t("message.nodeTrustNotSupported")
          : (nodeTrust.applied ? t("message.nodeTrustActive") : t("message.nodeTrustFailed"));
        if (nodeTrust.antigravityRunning) message += ". " + t("message.restartAntigravityRunning");
        else if (nodeTrust.restartRequired) message += ". " + t("message.restartAntigravity");
        showStatus("systemStatus", message, nodeTrust.applied ? "ok" : "warn");
        loadStatus();
      } catch (error) {
        showStatus("systemStatus", t("error.prefix", { message: error.message }), "err");
      } finally {
        setSystemButtons(false);
      }
    }

    async function removeDns() {
      setSystemButtons(true);
      showStatus("systemStatus", t("message.removingDns"), "loading");
      try {
        const result = await api("/api/remove-dns", { method: "POST", body: elevatedBody() });
        showStatus("systemStatus", result.dns.removed ? t("message.dnsRemoved") : t("message.dnsWasNotActive"), "ok");
        loadStatus();
      } catch (error) {
        showStatus("systemStatus", t("error.prefix", { message: error.message }), "err");
      } finally {
        setSystemButtons(false);
      }
    }

    async function stopAndCleanup() {
      setSystemButtons(true);
      showStatus("systemStatus", t("message.stopCleanup"), "loading");
      try {
        const result = await api("/api/stop-and-cleanup", { method: "POST", body: elevatedBody() });
        const stopText = result.stop && result.stop.stopped ? t("message.proxyStopped") : t("message.proxyWasNotRunning");
        const dnsText = result.dns && result.dns.removed ? t("message.dnsRemoved") : t("message.dnsWasNotActive");
        showStatus("systemStatus", t("message.stopCleanupDone", { stop: stopText, dns: dnsText }), "ok");
        loadStatus();
      } catch (error) {
        showStatus("systemStatus", t("error.prefix", { message: error.message }), "err");
      } finally {
        setSystemButtons(false);
      }
    }

    function renderDoctor(report) {
      state.doctor = report;
      const summaryKind = report.summary === "healthy" ? "ok" : (report.summary === "error" ? "err" : "warn");
      const summaryText = report.summary === "healthy" ? t("doctor.healthy") : (report.summary === "error" ? t("doctor.error") : t("doctor.warning"));
      showStatus("doctorSummary", summaryText, summaryKind);
      $("doctorChecks").innerHTML = (report.checks || []).map((check) => {
        const tagClass = check.severity === "ok" ? "ok" : (check.severity === "err" ? "danger" : "warn");
        const label = t("doctor.check." + check.id) || check.label;
        const value = check.ok ? t("doctor.pass") : t("doctor.attention");
        return "<div class=\\"doctor-card\\"><div class=\\"doctor-card-title\\">" + esc(label) + "</div><span class=\\"tag " + tagClass + "\\">" + esc(value) + "</span></div>";
      }).join("");
      $("doctorRecommendations").innerHTML = (report.recommendations || []).map((item) => "<li>" + esc(item) + "</li>").join("");
    }

    async function runDoctor() {
      setSystemButtons(true);
      showStatus("doctorSummary", t("message.runningDoctor"), "loading");
      try {
        const report = await api("/api/doctor");
        renderDoctor(report);
        renderStatus(report.status);
      } catch (error) {
        showStatus("doctorSummary", t("error.prefix", { message: error.message }), "err");
      } finally {
        setSystemButtons(false);
      }
    }

    async function uninstallCertUi() {
      if (!window.confirm(t("confirm.uninstallCert"))) return;
      setSystemButtons(true);
      showStatus("teardownStatus", t("message.uninstallingCert"), "loading");
      try {
        const result = await api("/api/uninstall-cert", { method: "POST", body: elevatedBody() });
        showStatus("teardownStatus", result.cert && result.cert.removed ? t("message.certRemoved") : t("message.certWasNotInstalled"), "ok");
        loadStatus();
      } catch (error) {
        showStatus("teardownStatus", t("error.prefix", { message: error.message }), "err");
      } finally {
        setSystemButtons(false);
      }
    }

    async function enableAutoStartUi() {
      setSystemButtons(true);
      showStatus("systemStatus", t("message.enablingAutoStart"), "loading");
      try {
        const result = await api("/api/autostart/enable", { method: "POST", body: JSON.stringify({}) });
        showStatus("systemStatus", t("message.autoStartEnabled", { method: result.method || "system" }), "ok");
        loadStatus();
      } catch (error) {
        showStatus("systemStatus", t("error.prefix", { message: error.message }), "err");
      } finally {
        setSystemButtons(false);
      }
    }

    async function disableAutoStartUi() {
      setSystemButtons(true);
      showStatus("systemStatus", t("message.disablingAutoStart"), "loading");
      try {
        await api("/api/autostart/disable", { method: "POST", body: JSON.stringify({}) });
        showStatus("systemStatus", t("message.autoStartDisabled"), "ok");
        loadStatus();
      } catch (error) {
        showStatus("systemStatus", t("error.prefix", { message: error.message }), "err");
      } finally {
        setSystemButtons(false);
      }
    }

    function matchesLogFilter(line, filter) {
      if (filter === "all") return true;
      if (filter === "errors") return /error|err|failed|fail|unauthorized|500|bad gateway/i.test(line);
      if (filter === "auth") return /AUTH|fetchUserInfo|loadCodeAssist|fetchAvailableModels/i.test(line);
      if (filter === "chat") return /CHAT|streamGenerateContent|generateContent|\\bOK\\b/i.test(line);
      if (filter === "dns") return /DNS|hosts/i.test(line);
      if (filter === "proxy") return /proxy|MITM ready|port/i.test(line);
      return true;
    }

    function filteredLog(text) {
      const filter = $("logFilter") ? $("logFilter").value : "all";
      if (!text) return "";
      return text.split("\\n").filter((line) => matchesLogFilter(line, filter)).join("\\n");
    }

    function setLogText(id, text) {
      const el = $(id);
      const value = (text || "").trim();
      el.textContent = value || t("logs.empty");
      el.classList.toggle("empty", !value);
      el.scrollTop = el.scrollHeight;
    }

    function applyLogFilter() {
      if (!$("backendLog")) return;
      setLogText("backendLog", filteredLog(state.logs.backend));
      setLogText("proxyLog", filteredLog(state.logs.proxy));
    }

    async function loadLogs() {
      try {
        const logs = await api("/api/logs");
        state.logs.backend = logs.backend || "";
        state.logs.proxy = logs.proxy || "";
        $("backendLogPath").textContent = logs.paths && logs.paths.backend ? logs.paths.backend : "—";
        $("proxyLogPath").textContent = logs.paths && logs.paths.proxy ? logs.paths.proxy : "—";
        applyLogFilter();
        showStatus("logsStatus", t("message.logsRefreshed"), "ok");
      } catch (error) {
        showStatus("logsStatus", t("error.prefix", { message: error.message }), "err");
      }
    }

    async function clearLogsUi() {
      $("clearLogsBtn").disabled = true;
      try {
        await api("/api/logs/clear", { method: "POST", body: JSON.stringify({}) });
        state.logs = { backend: "", proxy: "" };
        applyLogFilter();
        await loadLogs();
        showStatus("logsStatus", t("message.logsCleared"), "ok");
      } catch (error) {
        showStatus("logsStatus", t("error.prefix", { message: error.message }), "err");
      } finally {
        $("clearLogsBtn").disabled = false;
      }
    }

    async function exportConfigUi() {
      $("exportConfigBtn").disabled = true;
      showStatus("importExportStatus", t("message.exporting"), "loading");
      try {
        const data = await api("/api/config/export");
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = "mitm-antigravity-config.json";
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
        showStatus("importExportStatus", t("message.exported"), "ok");
      } catch (error) {
        showStatus("importExportStatus", t("error.prefix", { message: error.message }), "err");
      } finally {
        $("exportConfigBtn").disabled = false;
      }
    }

    async function importConfigUi(file) {
      $("importConfigBtn").disabled = true;
      showStatus("importExportStatus", t("message.importing"), "loading");
      try {
        const text = await file.text();
        const data = JSON.parse(text);
        const result = await api("/api/config/import", { method: "POST", body: JSON.stringify(data) });
        state.config = result.config;
        $("baseUrl").value = toBaseUrl(state.config.routerUrl || "");
        $("apiKey").value = state.config.apiKey || "";
        $("model").value = state.config.model || "";
        $("passthroughUnmapped").checked = state.config.alwaysIntercept !== true;
        renderMappings();
        showStatus("importExportStatus", t("message.imported", { file: file.name }), "ok");
        loadStatus();
      } catch (error) {
        showStatus("importExportStatus", t("error.prefix", { message: error.message }), "err");
      } finally {
        $("importConfigBtn").disabled = false;
        $("importConfigFile").value = "";
      }
    }

    let quotasCountdownInterval = null;
    let currentQuotasData = null;

    function fmtCountdown(iso, lang) {
      if (!iso) return "—";
      const t = new Date(iso).getTime();
      let s = Math.floor((t - Date.now()) / 1000);
      if (s <= 0) return lang === "vi" ? "đã reset" : "reset";
      const d = Math.floor(s / 86400); s -= d * 86400;
      const h = Math.floor(s / 3600); s -= h * 3600;
      const m = Math.floor(s / 60); s -= m * 60;
      if (d > 0) {
        return lang === "vi" ? "còn " + d + "n " + h + "g " + m + "p" : "in " + d + "d " + h + "h " + m + "m";
      }
      if (h > 0) {
        return lang === "vi" ? "còn " + h + "g " + m + "p " + s + "s" : "in " + h + "h " + m + "m " + s + "s";
      }
      return lang === "vi" ? "còn " + m + "p " + s + "s" : "in " + m + "m " + s + "s";
    }

    function pctColor(p) {
      if (p === null || p === undefined) return "var(--muted)";
      if (p >= 50) return "var(--ok)";
      if (p >= 20) return "var(--warn)";
      return "var(--danger)";
    }

    function pctColorClass(p) {
      if (p === null || p === undefined) return "neutral";
      if (p >= 50) return "good";
      if (p >= 20) return "warn";
      return "bad";
    }

    function fmtUnix(s, lang) {
      if (!s) return "—";
      try {
        return new Date(s * 1000).toLocaleString(lang === "vi" ? "vi-VN" : "en-US");
      } catch (e) {
        return String(s);
      }
    }

    function tickQuotas() {
      const lang = state.lang || "en";
      document.querySelectorAll("[data-reset-time]").forEach((el) => {
        const resetTime = el.dataset.resetTime;
        el.textContent = fmtCountdown(resetTime, lang);
      });
    }

    async function loadQuotas() {
      try {
        const container = $("quotasContainer");
        container.innerHTML = '<div class="notice">' + (state.lang === "vi" ? "Đang tải hạn mức tài khoản..." : "Loading account quotas...") + '</div>';
        
        const data = await api("/api/quotas");
        currentQuotasData = data;
        renderQuotas(data);

        if (!quotasCountdownInterval) {
          quotasCountdownInterval = setInterval(tickQuotas, 1000);
        }
      } catch (error) {
        $("quotasContainer").innerHTML = '<div class="notice warn">' + t("error.prefix", { message: error.message }) + '</div>';
      }
    }

    function renderQuotas(data) {
      const container = $("quotasContainer");
      if (!data || !data.accounts || data.accounts.length === 0) {
        container.innerHTML = '<div class="notice warn">' + t("quotas.noAccounts") + '</div>';
        return;
      }

      let html = "";
      
      if (!data.has_week) {
        html += '<div class="notice"><strong>' + 
          (state.lang === "vi" ? "Chưa thấy dữ liệu quota theo tuần trong file." : "No weekly quota data observed in account files.") + 
          '</strong> ' + 
          (state.lang === "vi" ? "Các tài khoản từ Antigravity-Manager hiện chỉ chứa chu kỳ ~5 giờ. Mục tuần sẽ tự động hiện khi file có dữ liệu." : "Account files stored by Antigravity-Manager currently only contain ~5 hour cycle data. The weekly section will appear once available.") + 
          '</div>';
      }

      html += '<div class="quotas-grid">';

      for (const a of data.accounts) {
        const badges = [];
        if (a.subscription_tier) badges.push('<span class="badge tier">' + a.subscription_tier + '</span>');
        if (a.is_current) badges.push('<span class="badge cur">' + (state.lang === "vi" ? "Đang dùng" : "Active") + '</span>');
        if (a.is_forbidden) badges.push('<span class="badge bad">' + (state.lang === "vi" ? "Bị cấm" : "Forbidden") + '</span>');
        if (a.disabled) badges.push('<span class="badge warn">' + t("quotas.disabled") + '</span>');
        if (a.validation_blocked) badges.push('<span class="badge warn">' + (state.lang === "vi" ? "Cần xác minh" : "Verify Required") + '</span>');

        const avgText = a.avg === null ? "—" : a.avg + "%";
        const avgVal = a.avg || 0;
        const donutColor = pctColor(a.avg);

        let acctHtml = 
          '<div class="acct-card' + (a.is_current ? ' cur' : '') + '">' +
            '<div class="acct-header">' +
              '<div class="acct-row1">' +
                '<span class="acct-email">' + (a.email || "unknown") + '</span>' +
              '</div>' +
              (a.name ? '<div class="acct-name">' + a.name + '</div>' : '') +
              '<div class="acct-badges">' + badges.join("") + '</div>' +
            '</div>' +
            
            '<div class="acct-summary">' +
              '<div class="acct-donut" style="--p: ' + avgVal + '; background: conic-gradient(' + donutColor + ' calc(' + avgVal + ' * 1%), var(--border) 0);">' +
                '<span class="acct-donut-value">' + avgText + '</span>' +
              '</div>' +
              '<div class="acct-stats">' +
                '<div class="acct-stat-item">' + t("quotas.averageLimit") + ': <strong>' + avgText + '</strong></div>' +
                '<div class="acct-stat-item">' + t("quotas.lowestLimit") + ': <strong>' + (a.lowest === null ? "—" : a.lowest + "%") + '</strong> · ' + a.model_count + ' models</div>' +
              '</div>' +
            '</div>' +
            
            (a.quota_groups && a.quota_groups.length > 0 ? (
              '<div class="acct-quota-groups-section">' +
                a.quota_groups.map(g => (
                  '<div class="acct-quota-group">' +
                    '<div class="acct-group-header">' +
                      '<span class="acct-group-title">' + g.display_name + '</span>' +
                      (g.description ? '<span class="acct-group-desc" title="' + g.description + '">ⓘ</span>' : '') +
                    '</div>' +
                    '<div class="buckets-list">' +
                      g.buckets.map(b => {
                        const p = b.percentage;
                        const w = p === null || p === undefined ? 0 : Math.max(0, Math.min(100, p));
                        const colorClass = pctColorClass(p);
                        const pctText = p === null || p === undefined ? "—" : Math.round(p) + "%";
                        const countdown = fmtCountdown(b.reset_time, state.lang);
                        return (
                          '<div class="bucket-item">' +
                            '<div class="bucket-details">' +
                              '<span class="bucket-name">' + b.display_name + '</span>' +
                              '<span class="bucket-pct ' + colorClass + '">' + pctText + '</span>' +
                            '</div>' +
                            '<div class="model-progress-bar">' +
                              '<div class="model-progress-fill ' + colorClass + '" style="width: ' + w + '%"></div>' +
                            '</div>' +
                            (b.reset_time ? '<div class="model-countdown">' + t("quotas.resetIn") + ': <span data-reset-time="' + b.reset_time + '">' + countdown + '</span></div>' : '') +
                          '</div>'
                        );
                      }).join("") +
                    '</div>' +
                  '</div>'
                )).join("") +
              '</div>'
            ) : '');
        
        let hasModels = false;
        if (a.windows) {
          const allModels = [];
          for (const key in a.windows) {
            allModels.push(...a.windows[key]);
          }
          if (allModels.length > 0) {
            hasModels = true;
            allModels.sort((x, y) => {
              if (x.recommended !== y.recommended) return x.recommended ? -1 : 1;
              return x.name.localeCompare(y.name);
            });

            acctHtml += 
              '<div class="acct-windows">' +
                '<div class="acct-window" style="margin-top: 4px;">' +
                  '<details>' +
                    '<summary style="font-size: 12px; font-weight: 600; color: var(--accent); cursor: pointer; outline: none; padding: 4px 0;">' + 
                      (state.lang === "vi" ? 'Danh sách model (' + allModels.length + ')' : 'Model List (' + allModels.length + ')') + 
                    '</summary>' +
                    '<div class="models-list" style="margin-top: 8px; max-height: 240px; overflow-y: auto; padding-right: 4px;">' +
                      allModels.map(m => {
                        const isRec = m.recommended ? " rec" : "";
                        return (
                          '<div class="model-item" style="padding: 4px 0; border-bottom: 1px dashed var(--border);">' +
                            '<div class="model-details" style="display: flex; justify-content: space-between; font-size: 12px;">' +
                              '<span class="model-name' + isRec + '" style="font-weight: 500; color: var(--text);">' + (m.display_name || m.name || "") + '</span>' +
                              (m.percentage !== null && m.percentage !== undefined ? '<span class="model-pct" style="color: var(--muted);">' + Math.round(m.percentage) + '%</span>' : '') +
                            '</div>' +
                          '</div>'
                        );
                      }).join("") +
                    '</div>' +
                  '</details>' +
                '</div>';
          }
        }

        if (hasModels) {
          acctHtml += '</div>';
        }
            
        acctHtml += 
            '<div class="acct-footer">' +
              '<span>' + t("quotas.lastUpdated") + ':</span>' +
              '<strong>' + fmtUnix(a.last_updated, state.lang) + '</strong>' +
            '</div>' +
          '</div>';

        html += acctHtml;
      }

      html += '</div>';
      container.innerHTML = html;
    }

    function switchTab(tab) {
      document.querySelectorAll(".tab-btn").forEach((btn) => {
        btn.classList.toggle("active", btn.dataset.tab === tab);
      });
      document.querySelectorAll(".tab-panel").forEach((panel) => {
        panel.classList.toggle("active", panel.dataset.panel === tab);
      });
      if (tab === "logs")        loadLogs();
      if (tab === "dashboard")   loadStatus();
      if (tab === "doctor")      runDoctor();
      if (tab === "quotas")      loadQuotas();
    }

    function bindEvents() {
      document.querySelectorAll(".tab-btn").forEach((btn) => {
        btn.addEventListener("click", () => switchTab(btn.dataset.tab));
      });
      $("themeSelect").addEventListener("change", () => {
        state.theme = $("themeSelect").value;
        localStorage.setItem(STORAGE_THEME, state.theme);
        applyTheme();
      });
      $("languageSelect").addEventListener("change", () => {
        state.lang = $("languageSelect").value;
        localStorage.setItem(STORAGE_LANG, state.lang);
        applyLanguage();
      });
      if (window.matchMedia) {
        const media = window.matchMedia("(prefers-color-scheme: dark)");
        if (media.addEventListener) media.addEventListener("change", applyTheme);
        else if (media.addListener) media.addListener(applyTheme);
      }
      $("checkBtn").addEventListener("click", checkKey);
      $("saveMappingsBtn").addEventListener("click", saveMappingsAndReload);
      $("refreshStatusBtn").addEventListener("click", loadStatus);
      $("refreshLogsBtn").addEventListener("click", loadLogs);
      $("clearLogsBtn").addEventListener("click", clearLogsUi);
      $("logFilter").addEventListener("change", applyLogFilter);
      $("proxyToggleBtn").addEventListener("click", toggleProxy);
      $("applyDnsBtn").addEventListener("click", applyDns);
      $("applyAppTrustBtn").addEventListener("click", applyAppTrust);
      $("startProxyOnlyBtn").addEventListener("click", startProxyOnly);
      $("stopCleanupBtn").addEventListener("click", stopAndCleanup);
      $("removeDnsBtn").addEventListener("click", removeDns);
      $("forceKillPortBtn").addEventListener("click", forceKillPort);
      $("runDoctorBtn").addEventListener("click", runDoctor);
      $("uninstallCertBtn").addEventListener("click", uninstallCertUi);
      $("refreshQuotasBtn").addEventListener("click", loadQuotas);
      $("enableAutoStartBtn").addEventListener("click", enableAutoStartUi);
      $("disableAutoStartBtn").addEventListener("click", disableAutoStartUi);
      subscribeProxyEvents();
      $("eyeBtn").addEventListener("click", () => {
        const input = $("apiKey");
        input.type = input.type === "password" ? "text" : "password";
      });
      $("exportConfigBtn").addEventListener("click", exportConfigUi);
      $("importConfigBtn").addEventListener("click", () => $("importConfigFile").click());
      $("importConfigFile").addEventListener("change", (e) => {
        if (e.target.files && e.target.files[0]) importConfigUi(e.target.files[0]);
      });
    }

    applyTheme();
    document.addEventListener("DOMContentLoaded", () => {
      bindEvents();
      applyTheme();
      applyLanguage({ skipStatus: true });
      load().catch((error) => showStatus("endpointStatus", t("error.prefix", { message: error.message }), "err"));
    });
  `;
}

module.exports = {
  guiClientScript,
};
