const { guiClientScript } = require("./client");
const { guiStyles } = require("./styles");

function guiHtml() {
  return `<!doctype html>
<html lang="en" data-theme="light">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>MITM Antigravity</title>
  <script>
    (function () {
      try {
        var choice = localStorage.getItem("mitm-ag-theme") || "system";
        var dark = choice === "dark" || (choice === "system" && window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
        document.documentElement.dataset.theme = dark ? "dark" : "light";
        document.documentElement.lang = localStorage.getItem("mitm-ag-language") || "en";
      } catch (error) {}
    })();
  </script>
  <style>${guiStyles()}</style>
</head>
<body>
  <div class="app-shell">
    <header class="topbar">
      <div class="brand">
        <div class="brand-mark" aria-hidden="true">A</div>
        <div>
          <h1 data-i18n="app.title">MITM Antigravity</h1>
          <p data-i18n="app.subtitle">Local proxy control</p>
        </div>
      </div>
      <div class="top-actions">
        <label><span data-i18n="theme.label">Theme</span>
          <select id="themeSelect">
            <option value="system" data-i18n="theme.system">System</option>
            <option value="light" data-i18n="theme.light">Light</option>
            <option value="dark" data-i18n="theme.dark">Dark</option>
          </select>
        </label>
        <label><span data-i18n="language.label">Language</span>
          <select id="languageSelect">
            <option value="en" data-i18n="language.en">English</option>
            <option value="vi" data-i18n="language.vi">Tiếng Việt</option>
          </select>
        </label>
      </div>
      <div class="path-line"><span data-i18n="top.config">Config</span>: <span id="configPath">—</span></div>
    </header>

    <div class="layout">
      <nav class="tabs" aria-label="Main sections">
        <button class="tab-btn active" data-tab="dashboard" type="button" data-i18n="nav.dashboard">Dashboard</button>
        <button class="tab-btn" data-tab="doctor" type="button" data-i18n="nav.doctor">Doctor</button>
        <button class="tab-btn" data-tab="config" type="button" data-i18n="nav.config">Endpoint API</button>
        <button class="tab-btn" data-tab="mapping" type="button" data-i18n="nav.mapping">Model Mapping</button>
        <button class="tab-btn" data-tab="logs" type="button" data-i18n="nav.logs">Logs</button>
        <button class="tab-btn" data-tab="settings" type="button" data-i18n="nav.settings">Settings</button>
        <button class="tab-btn" data-tab="guide" type="button" data-i18n="nav.guide">Guide</button>
      </nav>

      <main>
        <section class="tab-panel active" data-panel="dashboard">
          <div class="dashboard-grid">
            <section class="panel" aria-labelledby="dashboardTitle">
              <div class="panel-header">
                <div>
                  <h2 class="panel-title" id="dashboardTitle" data-i18n="dashboard.title">Runtime Dashboard</h2>
                  <p class="panel-subtitle" data-i18n="dashboard.subtitle">Start or stop the proxy, check trust state, and inspect the active routing target.</p>
                </div>
                <button class="secondary" id="refreshStatusBtn" type="button" data-i18n="button.refresh">Refresh</button>
              </div>
              <div class="command-stack single">
                <button id="proxyToggleBtn" type="button" data-i18n="button.startShort">START</button>
              </div>
              <div id="systemStatus" class="status"></div>
            </section>

            <section class="metric-grid" aria-label="Runtime status">
              <div class="metric"><div class="metric-label" data-i18n="metric.proxy">Proxy Listener</div><div class="metric-value neutral" id="s-proxy">—</div></div>
              <div class="metric"><div class="metric-label" data-i18n="metric.router">Router URL</div><div class="metric-value neutral" id="s-router">—</div></div>
              <div class="metric"><div class="metric-label" data-i18n="metric.dns">DNS Redirect</div><div class="metric-value neutral" id="s-dns">—</div></div>
              <div class="metric"><div class="metric-label" data-i18n="metric.cert">Certificate</div><div class="metric-value neutral" id="s-cert">—</div></div>
              <div class="metric"><div class="metric-label" data-i18n="metric.trust">Cert Trusted</div><div class="metric-value neutral" id="s-trust">—</div></div>
              <div class="metric"><div class="metric-label" data-i18n="metric.nodeTrust">Antigravity Trust</div><div class="metric-value neutral" id="s-node-trust">—</div></div>

              <div class="metric"><div class="metric-label" data-i18n="metric.models">Mapped Models</div><div class="metric-value neutral" id="s-models">—</div></div>
              <div class="metric"><div class="metric-label" data-i18n="metric.autostart">Auto Start</div><div class="metric-value neutral" id="s-autostart">—</div></div>
            </section>
          </div>

          <section class="panel">
            <div class="panel-header">
              <h2 class="panel-title" data-i18n="dashboard.system">System actions</h2>
            </div>
            <div class="system-grid">
              <button id="applyDnsBtn" type="button" data-i18n="button.applyDns">Apply DNS & Cert</button>
              <button class="secondary" id="startProxyOnlyBtn" type="button" data-i18n="button.startProxyOnly">Start Proxy Only</button>
              <button class="danger" id="stopCleanupBtn" type="button" data-i18n="button.stopCleanup">Stop & Remove DNS</button>
              <button class="secondary" id="removeDnsBtn" type="button" data-i18n="button.removeDns">Remove DNS</button>
              <button class="danger" id="forceKillPortBtn" type="button" data-i18n="button.forceKillPort">Force Kill Port</button>
              <button class="secondary" id="enableAutoStartBtn" type="button" data-i18n="button.enableAutoStart">Enable Auto Start</button>
              <button class="secondary" id="disableAutoStartBtn" type="button" data-i18n="button.disableAutoStart">Disable Auto Start</button>
            </div>
          </section>
        </section>

        <section class="tab-panel" data-panel="doctor">
          <section class="panel">
            <div class="panel-header">
              <div>
                <h2 class="panel-title" data-i18n="doctor.title">Doctor Diagnostics</h2>
                <p class="panel-subtitle" data-i18n="doctor.subtitle">Run a CLI-equivalent health check for proxy, DNS, certificate, Antigravity trust, endpoint, and model mapping.</p>
              </div>
              <button class="secondary" id="runDoctorBtn" type="button" data-i18n="button.runDoctor">Run Doctor</button>
            </div>
            <div id="doctorSummary" class="status"></div>
            <div class="doctor-grid" id="doctorChecks"></div>
            <div class="recommendation-box">
              <div class="log-title" data-i18n="doctor.recommendations">Recommendations</div>
              <ul id="doctorRecommendations"></ul>
            </div>
          </section>
        </section>

        <section class="tab-panel" data-panel="guide">
          <section class="panel guide-hero">
            <div class="panel-header">
              <div>
                <h2 class="panel-title" data-i18n="guide.title">How to use safely</h2>
                <p class="panel-subtitle" data-i18n="guide.subtitle">MITM Antigravity has two runtime steps: run the local proxy and redirect Antigravity traffic to it.</p>
              </div>
            </div>
            <div class="guide-grid">
              <article class="guide-card">
                <div class="step-badge">1</div>
                <h3 data-i18n="guide.step1Title">Initialize proxy service</h3>
                <p data-i18n="guide.step1Body">Start the local HTTPS proxy. It listens on your machine and forwards mapped AI requests to your configured upstream endpoint.</p>
              </article>
              <article class="guide-card">
                <div class="step-badge">2</div>
                <h3 data-i18n="guide.step2Title">Redirect DNS to proxy</h3>
                <p data-i18n="guide.step2Body">Apply DNS and certificate trust so Antigravity traffic reaches the local proxy instead of going directly to Google.</p>
              </article>
              <article class="guide-card cleanup">
                <div class="step-badge">↩</div>
                <h3 data-i18n="guide.cleanupTitle">When you stop using it</h3>
                <p data-i18n="guide.cleanupBody">Reverse both setup steps: stop the proxy and remove DNS redirect. Use Stop & Remove DNS to return Antigravity to normal operation.</p>
              </article>
            </div>
          </section>
        </section>

        <section class="tab-panel" data-panel="config">
          <section class="panel">
            <div class="panel-header">
              <h2 class="panel-title" data-i18n="config.title">Endpoint & Authentication</h2>
            </div>
            <div class="form-grid">
              <label class="full"><span data-i18n="config.baseUrl">Base URL</span>
                <input id="baseUrl" autocomplete="off" data-i18n-placeholder="placeholder.baseUrl" placeholder="https://api.example.com/v1">
              </label>
              <label><span data-i18n="config.apiKey">API Key</span>
                <div class="input-wrap">
                  <input id="apiKey" type="password" autocomplete="off" data-i18n-placeholder="placeholder.apiKey" placeholder="sk-...">
                  <button class="secondary" id="eyeBtn" type="button" data-i18n="button.showKey">Show</button>
                </div>
              </label>
              <label><span data-i18n="config.forceModel">Force Model</span>
                <input id="model" autocomplete="off" data-i18n-placeholder="placeholder.forceModel" placeholder="Leave empty to use mapping">
              </label>
              <div class="full checkbox-row">
                <input type="checkbox" id="passthroughUnmapped">
                <label for="passthroughUnmapped" data-i18n="config.passthrough">Passthrough built-in models unless a mapping exists</label>
              </div>
            </div>
            <div class="row" style="margin-top:14px;">
              <button id="checkBtn" type="button" data-i18n="config.testSave">Test, Load & Save</button>
            </div>
            <div id="endpointStatus" class="status"></div>
          </section>
        </section>

        <section class="tab-panel" data-panel="mapping">
          <section class="panel">
            <div class="panel-header">
              <h2 class="panel-title"><span data-i18n="mapping.title">Built-in Model Mapping</span> <span class="tag neutral" id="mappingCount">0/6 mapped</span></h2>
              <p class="panel-subtitle" data-i18n="mapping.hint">Go to Endpoint API → Load, Test & Save to populate the model dropdown list.</p>
            </div>
            <div id="mappingReadiness" class="readiness-stack"></div>
            <div class="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th data-i18n="mapping.name">Antigravity model</th>
                    <th></th>
                    <th data-i18n="mapping.upstream">Upstream model</th>
                    <th data-i18n="mapping.reasoning">Reasoning</th>
                    <th data-i18n="mapping.status">Status</th>
                  </tr>
                </thead>
                <tbody id="mappingRows"></tbody>
              </table>
            </div>
            <div class="row" style="margin-top:14px;">
              <button id="saveMappingsBtn" type="button" data-i18n="mapping.saveReload">Save Mapping & Reload Proxy</button>
            </div>
            <div id="mappingStatus" class="status"></div>
            <p class="panel-subtitle" data-i18n="mapping.note">Only these six built-in Antigravity models can be mapped. Unmapped models pass through to Google.</p>
          </section>
        </section>

        <section class="tab-panel" data-panel="logs">
          <section class="panel">
            <div class="panel-header">
              <h2 class="panel-title" data-i18n="logs.title">Runtime Logs</h2>
              <div class="row">
                <button class="secondary" id="refreshLogsBtn" type="button" data-i18n="button.refresh">Refresh</button>
                <button class="secondary" id="clearLogsBtn" type="button" data-i18n="button.clear">Clear</button>
              </div>
            </div>
            <div class="log-toolbar">
              <label><span data-i18n="logs.filter">Filter</span>
                <select id="logFilter">
                  <option value="all" data-i18n="logs.all">All</option>
                  <option value="errors" data-i18n="logs.errors">Errors</option>
                  <option value="auth" data-i18n="logs.auth">Auth</option>
                  <option value="chat" data-i18n="logs.chat">Chat</option>
                  <option value="dns" data-i18n="logs.dns">DNS</option>
                  <option value="proxy" data-i18n="logs.proxyFilter">Proxy</option>
                </select>
              </label>
            </div>
            <div id="logsStatus" class="status"></div>
            <div class="log-grid">
              <div class="log-block">
                <div class="log-title" data-i18n="logs.backend">Backend / UI actions</div>
                <div class="log-path" id="backendLogPath">—</div>
                <pre class="log-output empty" id="backendLog">No log entries yet.</pre>
              </div>
              <div class="log-block">
                <div class="log-title" data-i18n="logs.proxy">Proxy process</div>
                <div class="log-path" id="proxyLogPath">—</div>
                <pre class="log-output empty" id="proxyLog">No log entries yet.</pre>
              </div>
            </div>
          </section>
        </section>

        <section class="tab-panel" data-panel="settings">
          <!-- Linux info banner – hiện khi chạy trên Linux -->
          <section class="panel" id="linuxInfoPanel" style="display:none;">
            <div class="panel-header">
              <div>
                <h2 class="panel-title" data-i18n="settings.linuxTitle">Linux Notice</h2>
              </div>
            </div>
            <div id="linuxInfoText" class="status warn" style="display:flex;" data-i18n="settings.linuxDesc">
              On Linux, certificate trust and DNS changes require administrator access. Run the app with sudo, or use the CLI with the --password flag. Certificate auto-install is not supported on Linux.
            </div>
          </section>
          <section class="panel">
            <div class="panel-header">
              <h2 class="panel-title" data-i18n="settings.title">Preferences</h2>
            </div>
            <div class="path-grid">
              <div class="path-item"><div class="path-label" data-i18n="settings.configPath">User settings</div><div class="path-value" id="settingsConfigPath">—</div></div>
              <div class="path-item"><div class="path-label" data-i18n="settings.bundledPath">Bundled settings</div><div class="path-value" id="settingsBundledPath">—</div></div>
              <div class="path-item"><div class="path-label" data-i18n="settings.legacyPath">Legacy config</div><div class="path-value" id="settingsLegacyPath">—</div></div>
              <div class="path-item"><div class="path-label" data-i18n="settings.machine">Machine</div><div class="path-value" id="settingsMachine">—</div></div>
            </div>
          </section>
          <section class="panel">
            <div class="panel-header">
              <h2 class="panel-title" data-i18n="settings.importExport">Import / Export Config</h2>
            </div>
            <p class="panel-subtitle" data-i18n="settings.importExportDesc">Export your current configuration (endpoint, API key, model mappings) as a portable JSON file, or import a previously exported config.</p>
            <div class="system-grid" style="margin-top:12px;">
              <button class="secondary" id="exportConfigBtn" type="button" data-i18n="button.exportConfig">Export Config</button>
              <button class="secondary" id="importConfigBtn" type="button" data-i18n="button.importConfig">Import Config</button>
              <input type="file" id="importConfigFile" accept=".json,application/json" style="display:none;">
            </div>
            <div id="importExportStatus" class="status"></div>
          </section>
          <section class="panel">
            <div class="panel-header">
              <div>
                <h2 class="panel-title" data-i18n="settings.teardown">Advanced Teardown</h2>
                <p class="panel-subtitle" data-i18n="settings.teardownDesc">Use this only when you want to remove the trusted MITM certificate from the system keychain/store.</p>
              </div>
            </div>
            <div class="system-grid" style="margin-top:12px;">
              <button class="danger" id="uninstallCertBtn" type="button" data-i18n="button.uninstallCert">Uninstall Certificate</button>
            </div>
            <div id="teardownStatus" class="status"></div>
          </section>
        </section>
      </main>
    </div>
  </div>
  <script>${guiClientScript()}</script>
</body>
</html>`;
}

module.exports = {
  guiHtml,
};
