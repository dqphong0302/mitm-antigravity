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
        const value = select ? select.value.trim() : (input ? input.value.trim() : "");
        if (alias && value) {
          out[alias] = value;
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


    function renderMappings() {
      const map = (state.config && state.config.modelMap) || {};
      const aliases = state.builtInAliases.slice();
      const mappedCount = aliases.filter((alias) => map[alias]).length;
      $("mappingCount").textContent = t("mapping.count", { mapped: mappedCount, total: aliases.length });

      if (aliases.length === 0) {
        $("mappingRows").innerHTML = "<tr><td colspan=\\"4\\">" + esc(t("mapping.noModels")) + "</td></tr>";
        return;
      }

      $("mappingRows").innerHTML = aliases.map((alias) => {
        const entry = map[alias] || "";
        const mapped = Boolean(mappingModelValue(entry));
        return "<tr data-alias=\\"" + esc(alias) + "\\">" +
          "<td class=\\"alias-cell\\">" + esc(alias) + "</td>" +
          "<td class=\\"arrow-cell\\">→</td>" +
          "<td class=\\"model-cell\\">" + makeModelCell(mappingModelValue(entry)) + "</td>" +

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
      setMetric("s-proxy", status.proxyListening ? t("status.running") : t("status.stopped"), status.proxyListening ? "ok" : "err");
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

    async function loadStatus() {
      try {
        renderStatus(await api("/api/status"));
      } catch {
        // Status polling is best-effort; actionable errors appear in explicit actions.
      }
    }

    function setSystemButtons(disabled) {
      ["proxyToggleBtn", "applyDnsBtn", "startProxyOnlyBtn", "stopCleanupBtn", "removeDnsBtn", "forceKillPortBtn", "enableAutoStartBtn", "disableAutoStartBtn", "uninstallCertBtn", "runDoctorBtn"].forEach((id) => {
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
        showStatus("endpointStatus", t("message.loadedModels", { count: state.models.length, url: result.modelsUrl }), "ok");
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
        const reload = await api("/api/reload-proxy", { method: "POST", body: JSON.stringify({}) });
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

    function switchTab(tab) {
      document.querySelectorAll(".tab-btn").forEach((btn) => {
        btn.classList.toggle("active", btn.dataset.tab === tab);
      });
      document.querySelectorAll(".tab-panel").forEach((panel) => {
        panel.classList.toggle("active", panel.dataset.panel === tab);
      });
      if (tab === "logs") loadLogs();
      if (tab === "dashboard") loadStatus();
      if (tab === "doctor") runDoctor();
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
      $("startProxyOnlyBtn").addEventListener("click", startProxyOnly);
      $("stopCleanupBtn").addEventListener("click", stopAndCleanup);
      $("removeDnsBtn").addEventListener("click", removeDns);
      $("forceKillPortBtn").addEventListener("click", forceKillPort);
      $("runDoctorBtn").addEventListener("click", runDoctor);
      $("uninstallCertBtn").addEventListener("click", uninstallCertUi);
      $("enableAutoStartBtn").addEventListener("click", enableAutoStartUi);
      $("disableAutoStartBtn").addEventListener("click", disableAutoStartUi);
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
