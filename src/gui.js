const crypto = require("crypto");
const http = require("http");

const {
  ANTIGRAVITY_ALIASES,
  DEFAULT_REMOTE,
  IS_MAC,
} = require("./constants");
const {
  bundledSettingsPath,
  configPath,
  machineId,
  primaryTargetHost,
  readConfig,
  settingsPath,
  targetHostsFrom,
  writeConfig,
} = require("./config");
const { fetchAvailableModels, normalizeModelMap } = require("./models");
const { readRequestJson, sendJson } = require("./http");
const { appendLog, clearLogs, errorMeta, logPaths, readRecentLogs } = require("./logging");
const { openBrowser } = require("./system");
const {
  applyAntigravityNodeTrust,
  certExists,
  certPaths,
  checkAntigravityNodeTrust,
  checkCertInstalled,
  generateCert,
  installCert,
} = require("./cert");
const {
  addDNSEntries,
  dnsConfiguredForHosts,
  getRedirectIPs,
  removeDNSEntries,
} = require("./dns");
const {
  autoStartStatus,
  checkProxyHealth,
  disableAutoStart,
  enableAutoStart,
  startProxyDetached,
  stopProxyByPort,
} = require("./proxy-control");

function guiPresets() {
  return {};
}

function guiHtml() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>MITM Antigravity</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg-from: #0d0d1a;
      --glass: rgba(255,255,255,0.04);
      --glass-border: rgba(255,255,255,0.09);
      --text: #f0f0f8;
      --muted: #8892a4;
      --accent: #7c6ff7;
      --accent2: #38bdf8;
      --danger: #f87171;
      --ok: #4ade80;
      --warn: #fbbf24;
      --glow: rgba(124,111,247,0.35);
    }
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'Inter', ui-sans-serif, system-ui, sans-serif;
      background: linear-gradient(135deg, var(--bg-from) 0%, #0a0a1a 40%, #0e1626 100%);
      color: var(--text);
      min-height: 100vh;
      background-attachment: fixed;
    }
    body::before {
      content: '';
      position: fixed;
      width: 600px; height: 600px;
      background: radial-gradient(circle, rgba(124,111,247,0.12) 0%, transparent 70%);
      top: -200px; left: -100px;
      pointer-events: none;
      animation: orb1 12s ease-in-out infinite alternate;
    }
    body::after {
      content: '';
      position: fixed;
      width: 500px; height: 500px;
      background: radial-gradient(circle, rgba(56,189,248,0.10) 0%, transparent 70%);
      bottom: -150px; right: -100px;
      pointer-events: none;
      animation: orb2 15s ease-in-out infinite alternate;
    }
    @keyframes orb1 { from { transform: translate(0,0); } to { transform: translate(60px, 40px); } }
    @keyframes orb2 { from { transform: translate(0,0); } to { transform: translate(-40px, -30px); } }
    header {
      position: sticky; top: 0; z-index: 100;
      backdrop-filter: blur(16px);
      background: rgba(13,13,26,0.85);
      border-bottom: 1px solid var(--glass-border);
      padding: 16px 28px;
      display: flex; align-items: center; justify-content: space-between;
    }
    .logo { display: flex; align-items: center; gap: 12px; }
    .logo-icon {
      width: 34px; height: 34px;
      background: linear-gradient(135deg, var(--accent), var(--accent2));
      border-radius: 8px;
      display: flex; align-items: center; justify-content: center;
      font-size: 17px;
      box-shadow: 0 0 18px var(--glow);
    }
    h1 { font-size: 17px; font-weight: 700; letter-spacing: -0.3px; }
    h1 span { color: var(--accent); }
    .header-meta { font-size: 11px; color: var(--muted); font-family: 'JetBrains Mono', monospace; }
    main {
      max-width: 1100px; margin: 0 auto;
      padding: 28px 20px 60px;
      display: flex; flex-direction: column; gap: 20px;
    }
    .card {
      background: var(--glass);
      border: 1px solid var(--glass-border);
      border-radius: 14px; padding: 22px 24px;
      backdrop-filter: blur(12px);
      animation: fadeUp 0.4s ease both;
    }
    .card:nth-child(2) { animation-delay: 0.07s; }
    .card:nth-child(3) { animation-delay: 0.14s; }
    @keyframes fadeUp { from { opacity: 0; transform: translateY(14px); } to { opacity: 1; transform: translateY(0); } }
    .card-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 18px; }
    .card-title { font-size: 14px; font-weight: 600; display: flex; align-items: center; gap: 8px; }
    label { display: flex; flex-direction: column; gap: 6px; font-size: 12px; font-weight: 500; color: var(--muted); }
    label span.req { color: var(--accent); }
    input, select {
      width: 100%;
      background: rgba(255,255,255,0.05);
      border: 1px solid var(--glass-border);
      border-radius: 8px; padding: 10px 12px;
      font-family: inherit; font-size: 13px; color: var(--text);
      transition: border-color 0.2s, box-shadow 0.2s; outline: none;
    }
    input:focus, select:focus { border-color: var(--accent); box-shadow: 0 0 0 3px rgba(124,111,247,0.18); }
    input::placeholder { color: rgba(136,146,164,0.55); }
    select option { background: #1a1a2e; color: var(--text); }
    .input-wrap { position: relative; }
    .input-wrap input { padding-right: 40px; }
    .input-wrap .eye-btn {
      position: absolute; right: 10px; top: 50%; transform: translateY(-50%);
      background: none; border: none; cursor: pointer; color: var(--muted);
      font-size: 16px; padding: 2px 4px; transition: color 0.2s; min-height: unset;
    }
    .input-wrap .eye-btn:hover { color: var(--text); }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
    .full { grid-column: 1 / -1; }
    .row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
    button {
      display: inline-flex; align-items: center; justify-content: center; gap: 7px;
      border: 1px solid var(--accent);
      background: linear-gradient(135deg, var(--accent), #5a54d6);
      color: #fff; border-radius: 8px; min-height: 38px; padding: 8px 16px;
      font-family: inherit; font-size: 13px; font-weight: 500;
      cursor: pointer; transition: all 0.2s; white-space: nowrap;
    }
    button:hover:not(:disabled) { transform: translateY(-1px); box-shadow: 0 4px 16px var(--glow); }
    button:active:not(:disabled) { transform: translateY(0); }
    button.secondary { background: var(--glass); border-color: var(--glass-border); color: var(--text); }
    button.secondary:hover:not(:disabled) { border-color: var(--accent); box-shadow: 0 0 10px var(--glow); }
    button.danger {
      background: transparent; border-color: rgba(248,113,113,0.4); color: var(--danger);
      padding: 5px 10px; min-height: 30px; font-size: 12px;
    }
    button.danger:hover:not(:disabled) { background: rgba(248,113,113,0.1); box-shadow: 0 0 8px rgba(248,113,113,0.25); }
    button.preset {
      background: linear-gradient(135deg, rgba(56,189,248,0.15), rgba(124,111,247,0.15));
      border-color: rgba(56,189,248,0.35); color: var(--accent2);
      font-size: 12px; padding: 6px 12px; min-height: 32px;
    }
    button.preset:hover:not(:disabled) { box-shadow: 0 0 12px rgba(56,189,248,0.3); }
    button:disabled { opacity: 0.45; cursor: not-allowed; }
    button.primary-action {
      min-height: 52px; padding: 12px 22px; border-radius: 14px;
      font-size: 15px; font-weight: 700;
      box-shadow: 0 14px 36px rgba(124,111,247,0.28);
    }
    button.stop-action {
      min-height: 52px; padding: 12px 22px; border-radius: 14px;
      font-size: 15px; font-weight: 700;
      background: linear-gradient(135deg, rgba(248,113,113,0.95), rgba(190,18,60,0.92));
      border-color: rgba(248,113,113,0.75); color: #fff;
      box-shadow: 0 14px 36px rgba(248,113,113,0.20);
    }
    button.stop-action:hover:not(:disabled) { box-shadow: 0 16px 42px rgba(248,113,113,0.30); }
    .hero-grid { display: grid; grid-template-columns: minmax(0, 1.15fr) minmax(300px, .85fr); gap: 18px; align-items: stretch; }
    .hero-title { font-size: 24px; line-height: 1.15; letter-spacing: -0.8px; margin-bottom: 8px; }
    .hero-copy { color: var(--muted); font-size: 13px; line-height: 1.65; max-width: 660px; }
    .control-panel {
      display: flex; flex-direction: column; gap: 12px; justify-content: space-between;
      background: linear-gradient(135deg, rgba(124,111,247,0.13), rgba(56,189,248,0.08));
      border: 1px solid rgba(124,111,247,0.20); border-radius: 14px; padding: 16px;
    }
    .control-buttons { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
    .quick-status { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
    .quick-status .stat-card { padding: 12px; }
    .action-group { display: flex; flex-direction: column; gap: 10px; }
    .action-group-title { font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: .55px; }
    .action-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 10px; }
    .status {
      min-height: 24px; font-size: 13px;
      display: flex; align-items: center; gap: 7px;
      padding: 8px 12px; border-radius: 8px;
      background: rgba(255,255,255,0.03); border: 1px solid transparent;
      transition: all 0.3s;
    }
    .status.loading { color: var(--muted); border-color: var(--glass-border); }
    .status.ok  { color: var(--ok); border-color: rgba(74,222,128,0.25); background: rgba(74,222,128,0.07); }
    .status.err { color: var(--danger); border-color: rgba(248,113,113,0.25); background: rgba(248,113,113,0.07); }
    .status.warn { color: var(--warn); border-color: rgba(251,191,36,0.25); background: rgba(251,191,36,0.07); }
    .status.ok::before  { content: '\u25cf'; color: var(--ok); animation: pulse 2s ease infinite; }
    .status.err::before { content: '\u25cf'; color: var(--danger); }
    .status.warn::before { content: '\u25cf'; color: var(--warn); }
    .status.loading::before { content: '\u25cb'; }
    @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.4; } }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    thead tr { border-bottom: 1px solid var(--glass-border); }
    th { color: var(--muted); font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; padding: 8px 10px; text-align: left; }
    td { padding: 8px 10px; border-bottom: 1px solid rgba(255,255,255,0.04); vertical-align: middle; }
    tr:last-child td { border-bottom: none; }
    td.alias-cell { font-family: 'JetBrains Mono', monospace; font-size: 12px; color: var(--accent2); width: 28%; }
    td.model-cell { min-width: 280px; }
    td.reasoning-cell { width: 180px; }
    td.reasoning-cell select { border-color: rgba(56,189,248,0.35); background: rgba(56,189,248,0.08); }
    td.reasoning-cell::before { content: 'Reasoning effort'; display: block; margin-bottom: 5px; color: var(--muted); font-size: 10px; text-transform: uppercase; letter-spacing: 0.45px; }
    td.arrow-cell { width: 5%; color: var(--muted); text-align: center; }
    .empty-row td { color: var(--muted); text-align: center; padding: 24px; font-size: 13px; }
    .status-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 12px; }
    .stat-card {
      background: rgba(255,255,255,0.03);
      border: 1px solid var(--glass-border);
      border-radius: 10px; padding: 14px 16px;
    }
    .stat-label { font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 6px; }
    .stat-value { font-size: 14px; font-weight: 600; font-family: 'JetBrains Mono', monospace; }
    .stat-value.ok { color: var(--ok); }
    .stat-value.err { color: var(--danger); }
    .stat-value.warn { color: var(--warn); }
    .stat-value.neutral { color: var(--muted); }
    .checkbox-row { display: flex; align-items: center; gap: 10px; padding: 10px 0; }
    input[type="checkbox"] { width: 16px; min-height: 16px; height: 16px; accent-color: var(--accent); cursor: pointer; }
    .new-alias-row { display: flex; gap: 10px; align-items: flex-end; }
    .new-alias-row input { flex: 1; }
    .tag { display: inline-flex; align-items: center; gap: 4px; padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 600; font-family: 'JetBrains Mono', monospace; }
    .tag.purple { background: rgba(124,111,247,0.18); color: var(--accent); }
    .tabs {
      display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px;
      padding: 8px; border: 1px solid var(--glass-border); border-radius: 16px;
      background: rgba(255,255,255,0.035); backdrop-filter: blur(12px);
    }
    .tab-btn {
      min-height: 46px; border-radius: 12px; border-color: transparent;
      background: transparent; color: var(--muted); justify-content: center;
    }
    .tab-btn:hover:not(:disabled) { border-color: rgba(124,111,247,0.35); box-shadow: none; }
    .tab-btn.active {
      color: #fff; border-color: rgba(56,189,248,0.45);
      background: linear-gradient(135deg, rgba(124,111,247,0.85), rgba(56,189,248,0.35));
      box-shadow: 0 10px 30px rgba(124,111,247,0.18);
    }
    .tab-panel { display: none; flex-direction: column; gap: 20px; }
    .tab-panel.active { display: flex; animation: fadeUp 0.28s ease both; }
    .log-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
    .log-grid { display: grid; grid-template-columns: 1fr; gap: 14px; }
    .log-block { display: flex; flex-direction: column; gap: 8px; }
    .log-path { font-family: 'JetBrains Mono', monospace; font-size: 11px; color: var(--accent2); word-break: break-all; }
    .log-output {
      width: 100%; min-height: 240px; max-height: 420px; overflow: auto;
      white-space: pre-wrap; word-break: break-word;
      background: rgba(0,0,0,0.28); border: 1px solid var(--glass-border);
      border-radius: 10px; padding: 12px;
      font-family: 'JetBrains Mono', monospace; font-size: 11px; line-height: 1.55;
      color: #dbeafe;
    }
    .log-output.empty { color: var(--muted); }
    .divider { height: 1px; background: var(--glass-border); margin: 4px 0 18px; }
    @media (max-width: 700px) {
      .grid, .hero-grid, .control-buttons, .quick-status { grid-template-columns: 1fr; }
      .tabs { grid-template-columns: 1fr 1fr; }
      .status-grid { grid-template-columns: 1fr 1fr; }
      main { padding: 16px 14px 48px; }
    }
  </style>
</head>
<body>
  <header>
    <div class="logo">
      <div class="logo-icon">\u26a1</div>
      <h1>MITM <span>Antigravity</span></h1>
    </div>
    <div class="header-meta" id="configPath"></div>
  </header>
  <main>
    <section class="card hero-grid" aria-label="Proxy quick controls">
      <div>
        <div class="card-title">\uD83D\uDEE0 Local Control Dashboard</div>
        <div class="hero-title">Proxy and Antigravity trust are one click away.</div>
        <p class="hero-copy">Start the local MITM proxy and apply the DNS, certificate, and Antigravity Node trust needed for account verification from the main screen.</p>
      </div>
      <div class="control-panel">
        <div class="control-buttons">
          <button class="primary-action" id="startProxyBtn">\u25B6 Start Proxy &amp; Trust</button>
          <button class="stop-action" id="stopProxyBtn">\u23F9 Stop Proxy</button>
        </div>
        <div class="quick-status">
          <div class="stat-card"><div class="stat-label">Proxy Listener</div><div class="stat-value neutral" id="s-proxy">\u2014</div></div>
          <div class="stat-card"><div class="stat-label">Router URL</div><div class="stat-value neutral" style="font-size:11px;word-break:break-all;" id="s-router">\u2014</div></div>
        </div>
        <div id="systemStatus" class="status" style="display:none;"></div>
      </div>
    </section>
    <nav class="tabs" aria-label="Main sections">
      <button class="tab-btn active" id="tabConfigBtn" data-tab="config" type="button">\u2699 Config</button>
      <button class="tab-btn" id="tabMappingBtn" data-tab="mapping" type="button">\uD83D\uDDFA Model Mapping</button>
      <button class="tab-btn" id="tabProxyBtn" data-tab="proxy" type="button">\uD83D\uDCE1 Proxy &amp; System</button>
      <button class="tab-btn" id="tabLogsBtn" data-tab="logs" type="button">Logs</button>
    </nav>
    <section class="tab-panel active" id="tabConfigPanel" data-panel="config">
    <div class="card">
      <div class="card-header">
        <div class="card-title">\uD83D\uDD0C Endpoint &amp; Authentication</div>
      </div>
      <div class="divider"></div>
      <div class="grid">
        <label class="full">Base URL <span class="req">*</span>
          <input id="baseUrl" placeholder="https://api.example.com/v1" autocomplete="off">
        </label>
        <label>API Key
          <div class="input-wrap">
            <input id="apiKey" type="password" autocomplete="off" placeholder="sk-...">
            <button class="eye-btn" id="eyeBtn" title="Toggle visibility">\uD83D\uDC41</button>
          </div>
        </label>
        <label>Force Model
          <input id="model" placeholder="Leave empty to use mapping">
        </label>
        <label>Fallback Prefix
          <input id="modelPrefix" placeholder="ag/">
        </label>
        <div class="full checkbox-row">
          <input type="checkbox" id="passthroughUnmapped">
          <label for="passthroughUnmapped" style="flex-direction:row;color:var(--text);cursor:pointer;">Passthrough built-in models unless a mapping or custom alias exists</label>
        </div>
        <div class="full checkbox-row">
          <input type="checkbox" id="mockModelList">
          <label for="mockModelList" style="flex-direction:row;color:var(--text);cursor:pointer;">Expose custom aliases to Antigravity model list</label>
        </div>
      </div>
      <div class="row" style="margin-top:16px;">
        <button id="checkBtn">\uD83D\uDD0D Test, Load &amp; Save</button>
      </div>
      <div id="endpointStatus" class="status" style="margin-top:12px;display:none;"></div>
    </div>
    </section>
    <section class="tab-panel" id="tabMappingPanel" data-panel="mapping">
    <div class="card">
      <div class="card-header">
        <div class="card-title">\uD83D\uDDFA Custom Models <span class="tag purple" id="mappingCount">0 custom</span></div>
      </div>
      <div class="divider"></div>
      <table>
        <thead><tr>
          <th>Antigravity model name</th>
          <th style="width:5%"></th>
          <th>Upstream model</th>
          <th style="width:140px;">Reasoning</th>
          <th style="width:80px;"></th>
        </tr></thead>
        <tbody id="mappingRows"></tbody>
      </table>
      <div class="new-alias-row" style="margin-top:16px;">
        <input id="newAlias" placeholder="Custom model name shown in Antigravity (e.g. my-gpt-5-high)">
        <select id="newAliasModel" style="flex:1;"></select>
        <input id="newAliasModelCustom" style="display:none;flex:1;" placeholder="Custom upstream model (e.g. cx/gpt-5.5)">
        <select id="newAliasReasoning" style="max-width:170px;"><option value="">Default reasoning</option><option value="minimal">minimal</option><option value="low">low</option><option value="medium">medium</option><option value="high">high</option></select>
        <button class="secondary" id="addAliasBtn">+ Create custom model</button>
      </div>
      <div class="row" style="margin-top:14px;">
        <button id="saveMappingsBtn">\uD83D\uDCBE Save Mapping &amp; Reload Proxy</button>
      </div>
      <div id="mappingStatus" class="status" style="margin-top:12px;display:none;"></div>
      <div style="margin-top:10px;font-size:12px;color:var(--muted);">
        Custom models are saved to <span style="font-family:'JetBrains Mono',monospace;color:var(--accent2);" id="settingsPathHint">settings.json</span>.
        Built-in Antigravity models can be mapped but cannot be removed. Only custom models can be deleted.
      </div>
    </div>
    </section>
    <section class="tab-panel" id="tabProxyPanel" data-panel="proxy">
    <div class="card">
      <div class="card-header">
        <div class="card-title">\uD83D\uDCE1 Proxy Status</div>
        <button class="secondary" id="refreshStatusBtn" style="font-size:12px;padding:5px 12px;min-height:30px;">\u21bb Refresh</button>
      </div>
      <div class="divider"></div>
      <div style="margin-bottom:14px;font-size:12px;color:var(--muted);">
        Privileged actions use the operating system prompt when needed. The app never asks for or stores your sudo password.
      </div>
      <div class="action-group">
        <div class="action-group-title">Network actions</div>
        <div class="action-grid">
          <button id="applyDnsBtn">\uD83D\uDEE1 Apply DNS &amp; Cert</button>
          <button class="secondary" id="removeDnsBtn">\u2715 Remove DNS</button>
        </div>
      </div>
      <div class="action-group" style="margin-top:14px;">
        <div class="action-group-title">Startup behavior</div>
        <div class="action-grid">
          <button class="secondary" id="enableAutoStartBtn">Enable Auto Start</button>
          <button class="secondary" id="disableAutoStartBtn">Disable Auto Start</button>
        </div>
      </div>
      <div class="status-grid">
        <div class="stat-card"><div class="stat-label">DNS Redirect</div><div class="stat-value neutral" id="s-dns">\u2014</div></div>
        <div class="stat-card"><div class="stat-label">Certificate</div><div class="stat-value neutral" id="s-cert">\u2014</div></div>
        <div class="stat-card"><div class="stat-label">Cert Trusted</div><div class="stat-value neutral" id="s-trust">\u2014</div></div>
        <div class="stat-card"><div class="stat-label">Antigravity Trust</div><div class="stat-value neutral" id="s-node-trust">\u2014</div></div>
        <div class="stat-card"><div class="stat-label">Redirect IP</div><div class="stat-value neutral" id="s-ip">\u2014</div></div>
        <div class="stat-card"><div class="stat-label">Mapped Models</div><div class="stat-value neutral" id="s-models">\u2014</div></div>
        <div class="stat-card"><div class="stat-label">Auto Start</div><div class="stat-value neutral" id="s-autostart">\u2014</div></div>
      </div>
    </div>
    </section>
    <section class="tab-panel" id="tabLogsPanel" data-panel="logs">
    <div class="card">
      <div class="card-header">
        <div class="card-title">Runtime Logs</div>
        <div class="row">
          <button class="secondary" id="refreshLogsBtn" style="font-size:12px;padding:5px 12px;min-height:30px;">\u21bb Refresh</button>
          <button class="secondary" id="clearLogsBtn" style="font-size:12px;padding:5px 12px;min-height:30px;">Clear</button>
        </div>
      </div>
      <div class="divider"></div>
      <div id="logsStatus" class="status" style="margin-bottom:12px;display:none;"></div>
      <div class="log-grid">
        <div class="log-block">
          <div class="stat-label">Backend / UI actions</div>
          <div class="log-path" id="backendLogPath">\u2014</div>
          <pre class="log-output empty" id="backendLog">No log entries yet.</pre>
        </div>
        <div class="log-block">
          <div class="stat-label">Proxy process</div>
          <div class="log-path" id="proxyLogPath">\u2014</div>
          <pre class="log-output empty" id="proxyLog">No log entries yet.</pre>
        </div>
      </div>
    </div>
    </section>
  </main>
  <script>
    const DEFAULT_MODEL_PREFIX = "ag/";
    const state = { config: null, aliases: [], builtInAliases: [], models: [], presets: {} };
    const $ = (id) => document.getElementById(id);
    function showStatus(text, kind) {
      const el = $('endpointStatus');
      el.style.display = 'flex';
      el.className = 'status ' + (kind || '');
      el.textContent = text;
    }
    function showSystemStatus(text, kind) {
      const el = $('systemStatus');
      el.style.display = 'flex';
      el.className = 'status ' + (kind || '');
      el.textContent = text;
    }
    function showMappingStatus(text, kind) {
      const el = $('mappingStatus');
      el.style.display = 'flex';
      el.className = 'status ' + (kind || '');
      el.textContent = text;
    }
    function showLogsStatus(text, kind) {
      const el = $('logsStatus');
      el.style.display = 'flex';
      el.className = 'status ' + (kind || '');
      el.textContent = text;
    }
    function switchTab(tab) {
      document.querySelectorAll('.tab-btn').forEach((btn) => {
        btn.classList.toggle('active', btn.dataset.tab === tab);
      });
      document.querySelectorAll('.tab-panel').forEach((panel) => {
        panel.classList.toggle('active', panel.dataset.panel === tab);
      });
      if (tab === 'logs') loadLogs();
    }
    async function api(path, opts = {}) {
      let res;
      try {
        res = await fetch(path, { ...opts, headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) } });
      } catch (e) {
        throw new Error('Network error: ' + e.message);
      }
      const contentType = res.headers.get('content-type') || '';
      const data = contentType.includes('application/json')
        ? await res.json().catch(() => ({}))
        : { error: await res.text().catch(() => '') };
      if (!res.ok) {
        const requestId = data.requestId ? ' [' + data.requestId + ']' : '';
        const logs = data.logPaths ? ' Logs: backend=' + data.logPaths.backend + ' proxy=' + data.logPaths.proxy : '';
        throw new Error((data.error || 'Request failed') + requestId + logs);
      }
      return data;
    }
    function toCompletionsUrl(raw) {
      if (!raw) return '';
      raw = raw.trim();
      while (raw.endsWith('/')) raw = raw.slice(0, -1);
      if (raw.endsWith('/chat/completions') || raw.endsWith('/responses')) return raw;
      return raw + '/chat/completions';
    }
    function toBaseUrl(url) {
      if (!url) return '';
      if (url.endsWith('/chat/completions')) return url.slice(0, -'/chat/completions'.length);
      if (url.endsWith('/responses')) return url.slice(0, -'/responses'.length);
      return url;
    }
    function readForm() {
      return {
        routerUrl: toCompletionsUrl($('baseUrl').value),
        apiKey: $('apiKey').value,
        model: $('model').value.trim(),
        modelPrefix: $('modelPrefix').value.trim(),
        alwaysIntercept: !$('passthroughUnmapped').checked,
        mockModelList: $('mockModelList').checked,
        modelMap: readMappings(),
      };
    }
    function readMappings() {
      const out = {};
      document.querySelectorAll('[data-alias]').forEach((row) => {
        const alias = row.dataset.alias;
        const sel = row.querySelector('select.model-select');
        const inp = row.querySelector('input.custom-model');
        const value = sel ? sel.value.trim() : (inp ? inp.value.trim() : '');
        const reasoning = (row.querySelector('select.reasoning-effort') || {}).value || '';
        if (alias && value) {
          out[alias] = reasoning ? { model: value, reasoning_effort: reasoning } : value;
        }
      });
      return out;
    }
    function esc(v) {
      return String(v || '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    }
    function makeModelCell(alias, selected) {
      if (state.models.length > 0) {
        const vals = Array.from(new Set(['', selected, ...state.models].filter(v => v !== undefined)));
        const opts = vals.map(v => '<option value="' + esc(v) + '"' + (v === selected ? ' selected' : '') + '>' + esc(v || 'No mapping') + '</option>').join('');
        return '<select class="model-select">' + opts + '</select>';
      }
      return '<input class="custom-model" value="' + esc(selected) + '" placeholder="e.g. cx/gpt-5.5">';
    }
    function mappingModelValue(entry) {
      if (!entry) return '';
      if (typeof entry === 'string') return entry;
      if (typeof entry === 'object') return entry.model || '';
      return '';
    }
    function mappingReasoningValue(entry) {
      return entry && typeof entry === 'object' ? (entry.reasoning_effort || '') : '';
    }
    function makeReasoningCell(selected) {
      const options = ['', 'minimal', 'low', 'medium', 'high'];
      return '<select class="reasoning-effort" title="Reasoning effort"><option value=""' + (selected === '' ? ' selected' : '') + '>Default reasoning</option>' + options.slice(1).map(v => '<option value="' + esc(v) + '"' + (v === selected ? ' selected' : '') + '>' + esc(v) + '</option>').join('') + '</select>';
    }
    function renderNewAliasModelOptions() {
      const selected = $('newAliasModel').value;
      const models = Array.from(new Set(state.models.filter(Boolean)));
      const options = ['<option value="">Use default prefix after save</option>']
        .concat(models.map(model => '<option value="' + esc(model) + '">' + esc(model) + '</option>'))
        .concat('<option value="__custom__">Custom upstream model...</option>');
      $('newAliasModel').innerHTML = options.join('');
      if (models.includes(selected) || selected === '__custom__') $('newAliasModel').value = selected;
      $('newAliasModelCustom').style.display = $('newAliasModel').value === '__custom__' ? 'block' : 'none';
    }
    function isBuiltInAlias(alias) {
      return state.builtInAliases.includes(alias);
    }
    function renderMappings() {
      const map = (state.config && state.config.modelMap) || {};
      const aliases = Array.from(new Set([...state.builtInAliases, ...Object.keys(map)].filter(Boolean)));
      const customCount = aliases.filter(alias => !isBuiltInAlias(alias)).length;
      const mappedBuiltInCount = state.builtInAliases.filter(alias => map[alias]).length;
      $('mappingCount').textContent = customCount + ' custom' + (customCount !== 1 ? ' models' : ' model') + ', ' + mappedBuiltInCount + ' built-in mapped';
      if (aliases.length === 0) {
        $('mappingRows').innerHTML = '<tr class="empty-row"><td colspan="5">No custom models yet. Built-in Antigravity models pass through unless explicitly mapped.</td></tr>';
        return;
      }
      $('mappingRows').innerHTML = aliases.map(alias => {
        const entry = map[alias] || '';
        const actionCell = isBuiltInAlias(alias)
          ? '<span class="tag purple">Built-in</span>'
          : '<button class="danger" data-remove="' + esc(alias) + '">\u2715 Remove</button>';
        return '<tr data-alias="' + esc(alias) + '">' +
        '<td class="alias-cell">' + esc(alias) + '</td>' +
        '<td class="arrow-cell">\u2192</td>' +
        '<td class="model-cell">' + makeModelCell(alias, mappingModelValue(entry)) + '</td>' +
        '<td class="reasoning-cell">' + makeReasoningCell(mappingReasoningValue(entry)) + '</td>' +
        '<td>' + actionCell + '</td>' +
        '</tr>';
      }).join('');
      document.querySelectorAll('[data-remove]').forEach(btn => {
        btn.addEventListener('click', () => {
          if (isBuiltInAlias(btn.dataset.remove)) return;
          if (state.config) delete state.config.modelMap[btn.dataset.remove];
          state.aliases = state.aliases.filter(a => a !== btn.dataset.remove);
          renderMappings();
        });
      });
    }
    function applyModelToAliases(model) {
      if (!model) return;
      if (state.config) state.config.modelMap = readMappings();
      else state.config = { modelMap: {} };
      state.aliases.forEach(alias => {
        state.config.modelMap[alias] = model;
      });
      renderMappings();
    }
    async function load() {
      const data = await api('/api/bootstrap');
      state.config = data.config;
      state.aliases = Object.keys((state.config && state.config.modelMap) || {});
      state.builtInAliases = data.antigravityAliases || [];
      state.presets = data.presets || {};
      $('configPath').textContent = data.configPath;
      $('settingsPathHint').textContent = data.configPath;
      $('baseUrl').value = toBaseUrl(state.config.routerUrl || '');
      $('apiKey').value = state.config.apiKey || '';
      $('model').value = state.config.model || '';
      $('modelPrefix').value = state.config.modelPrefix || '';
      $('passthroughUnmapped').checked = state.config.alwaysIntercept !== true;
      $('mockModelList').checked = state.config.mockModelList !== false;
      renderNewAliasModelOptions();
      renderMappings();
      loadStatus();
    }
    async function checkKey() {
      $('checkBtn').disabled = true;
      showStatus('Testing endpoint and preparing auto-save\u2026', 'loading');
      try {
        const form = readForm();
        const result = await api('/api/check-key', { method: 'POST', body: JSON.stringify(form) });
        state.models = result.models;
        renderNewAliasModelOptions();
        const saved = await api('/api/config', { method: 'PUT', body: JSON.stringify(form) });
        state.config = saved.config;
        showStatus('\u2713 Loaded ' + result.models.length + ' models from ' + result.modelsUrl + ' and saved config', 'ok');
        renderMappings();
      } catch (e) {
        showStatus('\u2717 ' + e.message, 'err');
      } finally { $('checkBtn').disabled = false; }
    }
    async function saveMappingsAndReload() {
      $('saveMappingsBtn').disabled = true;
      showMappingStatus('Saving mapping and reloading proxy\u2026', 'loading');
      try {
        const result = await api('/api/config', { method: 'PUT', body: JSON.stringify(readForm()) });
        state.config = result.config;
        renderMappings();
        const reload = await api('/api/reload-proxy', { method: 'POST', body: JSON.stringify({}) });
        const reloadText = reload.reloaded ? 'Proxy reloaded' : 'Proxy was not running';
        showMappingStatus('\u2713 Mapping saved. ' + reloadText + '.', 'ok');
        loadStatus();
      } catch (e) {
        showMappingStatus('\u2717 ' + e.message, 'err');
      } finally {
        $('saveMappingsBtn').disabled = false;
      }
    }
    async function loadStatus() {
      try {
        const s = await api('/api/status');
        function setVal(id, val, cls) {
          const el = $(id); el.textContent = val;
          el.className = 'stat-value ' + (cls || 'neutral');
        }
        setVal('s-proxy', s.proxyListening ? 'Running' : 'Stopped', s.proxyListening ? 'ok' : 'err');
        setVal('s-dns',    s.dnsConfigured ? 'Active' : 'Not set',       s.dnsConfigured  ? 'ok'   : 'err');
        setVal('s-cert',   s.certExists    ? 'Generated' : 'Missing',    s.certExists     ? 'ok'   : 'err');
        setVal('s-trust',  s.certInstalled ? 'Trusted' : 'Not trusted',  s.certInstalled  ? 'ok'   : 'warn');
        setVal('s-node-trust', s.nodeTrustApplied ? 'Active' : (s.nodeTrustSupported ? 'Missing' : 'N/A'), s.nodeTrustApplied ? 'ok' : (s.nodeTrustSupported ? 'warn' : 'neutral'));
        setVal('s-ip',     s.redirectIp    || '\u2014',                      s.redirectIp ? 'ok' : 'neutral');
        setVal('s-models', s.mappedModels  + ' alias' + (s.mappedModels !== 1 ? 'es' : ''), s.mappedModels > 0 ? 'ok' : 'warn');
        setVal('s-router', s.routerUrl     || '\u2014',                      'neutral');
        setVal('s-autostart', s.autoStart && s.autoStart.enabled ? 'Enabled' : 'Disabled', s.autoStart && s.autoStart.enabled ? 'ok' : 'warn');
      } catch(e) { /* best-effort */ }
    }
    function setLogText(id, text) {
      const el = $(id);
      const value = (text || '').trim();
      el.textContent = value || 'No log entries yet.';
      el.classList.toggle('empty', !value);
      el.scrollTop = el.scrollHeight;
    }
    async function loadLogs() {
      try {
        const logs = await api('/api/logs');
        $('backendLogPath').textContent = logs.paths && logs.paths.backend ? logs.paths.backend : '\u2014';
        $('proxyLogPath').textContent = logs.paths && logs.paths.proxy ? logs.paths.proxy : '\u2014';
        setLogText('backendLog', logs.backend || '');
        setLogText('proxyLog', logs.proxy || '');
        showLogsStatus('Logs refreshed', 'ok');
      } catch (e) {
        showLogsStatus('\u2717 ' + e.message, 'err');
      }
    }
    async function clearLogsUi() {
      $('clearLogsBtn').disabled = true;
      try {
        await api('/api/logs/clear', { method: 'POST', body: JSON.stringify({}) });
        await loadLogs();
        showLogsStatus('Logs cleared', 'ok');
      } catch (e) {
        showLogsStatus('\u2717 ' + e.message, 'err');
      } finally {
        $('clearLogsBtn').disabled = false;
      }
    }
    function setSystemButtons(disabled) {
      $('startProxyBtn').disabled = disabled;
      $('stopProxyBtn').disabled = disabled;
      $('applyDnsBtn').disabled = disabled;
      $('removeDnsBtn').disabled = disabled;
      $('enableAutoStartBtn').disabled = disabled;
      $('disableAutoStartBtn').disabled = disabled;
    }
    async function startProxy() {
      setSystemButtons(true);
      showSystemStatus('Applying DNS, certificate, Antigravity trust, and starting proxy on port 443\u2026', 'loading');
      try {
        const result = await api('/api/start-proxy', {
          method: 'POST',
          body: JSON.stringify({})
        });
        const proxyText = result.restarted ? 'Proxy restarted on port 443' : (result.alreadyRunning ? 'Proxy already running' : 'Proxy started on port 443');
        const dnsText = result.dns && result.dns.added ? ', DNS active' : '';
        const certText = result.cert && result.cert.installed ? ', certificate trusted' : '';
        const trustText = result.nodeTrust && result.nodeTrust.applied ? ', Antigravity trust active' : '';
        const restartText = result.nodeTrust && result.nodeTrust.antigravityRunning
          ? '. Antigravity is currently running: quit and reopen it before verifying the account.'
          : (result.nodeTrust && result.nodeTrust.restartRequired ? '. Restart Antigravity if it is already open.' : '');
        showSystemStatus('\u2713 ' + proxyText + dnsText + certText + trustText + restartText, 'ok');
        loadStatus();
      } catch (e) {
        showSystemStatus('\u2717 ' + e.message, 'err');
      } finally {
        setSystemButtons(false);
      }
    }
    async function stopProxy() {
      setSystemButtons(true);
      showSystemStatus('Stopping proxy\u2026', 'loading');
      try {
        const result = await api('/api/stop-proxy', {
          method: 'POST',
          body: JSON.stringify({})
        });
        showSystemStatus(result.stopped ? '\u2713 Proxy stopped' : '\u2713 Proxy was not running', 'ok');
        loadStatus();
      } catch (e) {
        showSystemStatus('\u2717 ' + e.message, 'err');
      } finally {
        setSystemButtons(false);
      }
    }
    async function applyDns() {
      setSystemButtons(true);
      showSystemStatus('Applying DNS and certificate\u2026', 'loading');
      try {
        const result = await api('/api/apply-dns', {
          method: 'POST',
          body: JSON.stringify({})
        });
        const dnsText = result.dns.added ? 'DNS added' : 'DNS already active';
        const certText = result.cert.installed ? 'cert trusted' : 'cert already trusted';
        const trustText = result.nodeTrust && result.nodeTrust.applied ? ', Antigravity trust active' : '';
        showSystemStatus('\u2713 ' + dnsText + ', ' + certText + trustText, 'ok');
        loadStatus();
      } catch (e) {
        showSystemStatus('\u2717 ' + e.message, 'err');
      } finally {
        setSystemButtons(false);
      }
    }
    async function removeDns() {
      setSystemButtons(true);
      showSystemStatus('Removing DNS redirect\u2026', 'loading');
      try {
        const result = await api('/api/remove-dns', {
          method: 'POST',
          body: JSON.stringify({})
        });
        showSystemStatus(result.dns.removed ? '\u2713 DNS removed' : '\u2713 DNS was not active', 'ok');
        loadStatus();
      } catch (e) {
        showSystemStatus('\u2717 ' + e.message, 'err');
      } finally {
        setSystemButtons(false);
      }
    }
    async function enableAutoStartUi() {
      setSystemButtons(true);
      showSystemStatus('Enabling auto start\u2026', 'loading');
      try {
        const result = await api('/api/autostart/enable', { method: 'POST', body: JSON.stringify({}) });
        showSystemStatus('\u2713 Auto start enabled via ' + result.method, 'ok');
        loadStatus();
      } catch (e) {
        showSystemStatus('\u2717 ' + e.message, 'err');
      } finally {
        setSystemButtons(false);
      }
    }
    async function disableAutoStartUi() {
      setSystemButtons(true);
      showSystemStatus('Disabling auto start\u2026', 'loading');
      try {
        const result = await api('/api/autostart/disable', { method: 'POST', body: JSON.stringify({}) });
        showSystemStatus('\u2713 Auto start disabled', 'ok');
        loadStatus();
      } catch (e) {
        showSystemStatus('\u2717 ' + e.message, 'err');
      } finally {
        setSystemButtons(false);
      }
    }
    document.querySelectorAll('.tab-btn').forEach((btn) => {
      btn.addEventListener('click', () => switchTab(btn.dataset.tab));
    });
    $('checkBtn').addEventListener('click', checkKey);
    $('saveMappingsBtn').addEventListener('click', saveMappingsAndReload);
    $('refreshStatusBtn').addEventListener('click', loadStatus);
    $('refreshLogsBtn').addEventListener('click', loadLogs);
    $('clearLogsBtn').addEventListener('click', clearLogsUi);
    $('startProxyBtn').addEventListener('click', startProxy);
    $('stopProxyBtn').addEventListener('click', stopProxy);
    $('applyDnsBtn').addEventListener('click', applyDns);
    $('removeDnsBtn').addEventListener('click', removeDns);
    $('enableAutoStartBtn').addEventListener('click', enableAutoStartUi);
    $('disableAutoStartBtn').addEventListener('click', disableAutoStartUi);
    $('eyeBtn').addEventListener('click', () => {
      const inp = $('apiKey');
      inp.type = inp.type === 'password' ? 'text' : 'password';
    });
    $('newAliasModel').addEventListener('change', renderNewAliasModelOptions);
    $('addAliasBtn').addEventListener('click', () => {
      const alias = $('newAlias').value.trim();
      if (!alias) return;
      if (isBuiltInAlias(alias)) {
        showMappingStatus('Built-in Antigravity models cannot be created as custom models.', 'warn');
        return;
      }
      if (state.config) state.config.modelMap = readMappings();
      else state.config = { modelMap: {} };
      const selectedUpstream = $('newAliasModel').value;
      const upstream = selectedUpstream === '__custom__'
        ? $('newAliasModelCustom').value.trim()
        : selectedUpstream;
      const finalUpstream = upstream || DEFAULT_MODEL_PREFIX + alias;
      const reasoning = $('newAliasReasoning').value || '';
      state.config.modelMap[alias] = reasoning ? { model: finalUpstream, reasoning_effort: reasoning } : finalUpstream;
      if (!state.aliases.includes(alias)) state.aliases.push(alias);
      $('newAlias').value = '';
      $('newAliasModel').value = '';
      $('newAliasModelCustom').value = '';
      renderNewAliasModelOptions();
      $('newAliasReasoning').value = '';
      renderMappings();
    });
    load().catch(e => showStatus('\u2717 ' + e.message, 'err'));
  <\/script>
</body>
</html>`;
}

async function runGui(options) {
  const uiPort = Number(options.uiPort || 20245);
  const server = http.createServer(async (req, res) => {
    let url;
    try {
      url = new URL(req.url, `http://${req.headers.host || "127.0.0.1"}`);

      if (req.method === "GET" && url.pathname === "/") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
        res.end(guiHtml());
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/bootstrap") {
        sendJson(res, 200, {
          config: readConfig(),
          configPath: settingsPath(),
          bundledSettingsPath: bundledSettingsPath(),
          legacyConfigPath: configPath(),
          machine: machineId(),
          antigravityAliases: ANTIGRAVITY_ALIASES,
          presets: guiPresets(),
        });
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/logs") {
        sendJson(res, 200, readRecentLogs());
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/logs/clear") {
        clearLogs();
        appendLog("info", "Logs cleared from UI");
        sendJson(res, 200, { cleared: true, paths: logPaths() });
        return;
      }

      if (req.method === "PUT" && url.pathname === "/api/config") {
        const body = await readRequestJson(req);
        const current = readConfig();
        const modelMap = body.modelMap && typeof body.modelMap === "object" && !Array.isArray(body.modelMap)
          ? normalizeModelMap(body.modelMap)
          : current.modelMap;
        const next = {
          ...current,
          routerUrl: String(body.routerUrl || current.routerUrl).trim(),
          apiKey: String(body.apiKey || ""),
          model: String(body.model || "").trim(),
          modelPrefix: String(body.modelPrefix || "").trim(),
          alwaysIntercept: body.alwaysIntercept === true,
          mockModelList: body.mockModelList !== false,
          modelMap,
        };
        writeConfig(next);
        appendLog("info", "Config saved from UI", {
          routerUrl: next.routerUrl,
          model: next.model,
          modelPrefix: next.modelPrefix,
          alwaysIntercept: next.alwaysIntercept,
          mockModelList: next.mockModelList,
          mappedModels: Object.keys(next.modelMap || {}).length,
        });
        sendJson(res, 200, { config: next });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/check-key") {
        const body = await readRequestJson(req);
        const routerUrl = String(body.routerUrl || readConfig().routerUrl || "").trim();
        const apiKey = String(body.apiKey || "");
        if (!routerUrl) throw new Error("Missing endpoint");
        const result = await fetchAvailableModels(routerUrl, apiKey);
        appendLog("info", "Model list loaded from endpoint", { routerUrl, models: result.models ? result.models.length : 0 });
        sendJson(res, 200, result);
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/start-proxy") {
        const body = await readRequestJson(req);
        const cfg = readConfig();
        const targetHosts = targetHostsFrom(cfg);
        const sudoPassword = String(body.sudoPassword || "");
        const cert = await generateCert(targetHosts, { force: false });
        const certResult = await installCert(cert.cert, targetHosts[0], sudoPassword);
        const dnsResult = await addDNSEntries({
          targetHosts,
          remoteHost: cfg.remoteHost || options.remoteHost,
          remoteIp: cfg.remoteIp || options.remoteIp,
          sudoPassword,
        });
        const nodeTrust = await applyAntigravityNodeTrust(cert.cert);
        const port = Number(cfg.port || options.port || 443);
        const targetHost = primaryTargetHost(cfg);
        let restarted = false;
        appendLog("info", "Start Proxy & Trust requested", { port, targetHost, targetHosts, cert: certResult, dns: dnsResult });
        if (await checkProxyHealth(port, targetHost)) {
          await stopProxyByPort({ sudoPassword, port, targetHost });
          restarted = true;
        }
        const result = await startProxyDetached({
          sudoPassword,
          port,
          targetHost,
        });
        appendLog("info", "Proxy started from UI", { port, targetHost, restarted, alreadyRunning: result.alreadyRunning });
        sendJson(res, 200, { ...result, restarted, cert: certResult, dns: dnsResult, nodeTrust });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/stop-proxy") {
        const body = await readRequestJson(req);
        const cfg = readConfig();
        const sudoPassword = String(body.sudoPassword || "");
        const result = await stopProxyByPort({
          sudoPassword,
          port: Number(cfg.port || options.port || 443),
          targetHost: primaryTargetHost(cfg),
        });
        appendLog("info", "Stop proxy requested from UI", result);
        sendJson(res, 200, result);
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/reload-proxy") {
        const body = await readRequestJson(req);
        const cfg = readConfig();
        const targetHosts = targetHostsFrom(cfg);
        const sudoPassword = String(body.sudoPassword || "");
        const port = Number(cfg.port || options.port || 443);
        const targetHost = primaryTargetHost(cfg);
        appendLog("info", "Reload proxy requested from UI", { port, targetHost });
        if (!(await checkProxyHealth(port, targetHost))) {
          sendJson(res, 200, { reloaded: false, wasRunning: false, port });
          return;
        }

        await stopProxyByPort({ sudoPassword, port, targetHost });
        const cert = await generateCert(targetHosts, { force: false });
        const nodeTrust = await applyAntigravityNodeTrust(cert.cert);
        const result = await startProxyDetached({ sudoPassword, port, targetHost });
        appendLog("info", "Proxy reloaded from UI", { port, targetHost });
        sendJson(res, 200, { ...result, reloaded: true, wasRunning: true, nodeTrust });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/apply-dns") {
        const body = await readRequestJson(req);
        const cfg = readConfig();
        const targetHosts = targetHostsFrom(cfg);
        const targetHost = targetHosts[0];
        const sudoPassword = String(body.sudoPassword || "");
        const cert = await generateCert(targetHosts, { force: false });
        const certResult = await installCert(cert.cert, targetHost, sudoPassword);
        const nodeTrust = await applyAntigravityNodeTrust(cert.cert);
        const dnsResult = await addDNSEntries({
          targetHosts,
          remoteHost: cfg.remoteHost || options.remoteHost,
          remoteIp: cfg.remoteIp || options.remoteIp,
          sudoPassword,
        });
        appendLog("info", "DNS and certificate applied from UI", {
          targetHosts,
          cert: certResult,
          dns: dnsResult,
          nodeTrust,
        });
        sendJson(res, 200, { cert: certResult, dns: dnsResult, nodeTrust });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/apply-app-trust") {
        const cfg = readConfig();
        const targetHosts = targetHostsFrom(cfg);
        const cert = await generateCert(targetHosts, { force: false });
        const nodeTrust = await applyAntigravityNodeTrust(cert.cert);
        appendLog("info", "Antigravity Node trust applied from UI", { targetHosts, nodeTrust });
        sendJson(res, 200, { nodeTrust });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/remove-dns") {
        const body = await readRequestJson(req);
        const cfg = readConfig();
        const sudoPassword = String(body.sudoPassword || "");
        const dnsResult = await removeDNSEntries({
          targetHosts: targetHostsFrom(cfg),
          sudoPassword,
        });
        appendLog("info", "DNS removed from UI", { dns: dnsResult });
        sendJson(res, 200, { dns: dnsResult });
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/autostart") {
        sendJson(res, 200, await autoStartStatus());
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/autostart/enable") {
        const result = await enableAutoStart();
        appendLog("info", "Auto start enabled from UI", result);
        sendJson(res, 200, result);
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/autostart/disable") {
        const result = await disableAutoStart();
        appendLog("info", "Auto start disabled from UI", result);
        sendJson(res, 200, result);
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/status") {
        const cfg = readConfig();
        const { certPath } = certPaths();
        const certEx = certExists();
        const targetHosts = targetHostsFrom(cfg);
        const expectedIp = cfg.remoteIp || options.remoteIp || DEFAULT_REMOTE;
        const nodeTrust = certEx ? await checkAntigravityNodeTrust(certPath) : { supported: IS_MAC, applied: false, value: "" };
        const proxyListening = await checkProxyHealth(Number(cfg.port || options.port || 443), targetHosts[0]);
        const status = {
          proxyListening,
          dnsConfigured: dnsConfiguredForHosts(targetHosts, expectedIp),
          certExists: certEx,
          certInstalled: certEx ? await checkCertInstalled(certPath, targetHosts[0]) : false,
          nodeTrustSupported: nodeTrust.supported,
          nodeTrustApplied: nodeTrust.applied,
          nodeTrustValue: nodeTrust.value,
          redirectIp: targetHosts.map((host) => `${host}=${getRedirectIPs(host).join("/") || "-"}`).join(", "),
          routerUrl: cfg.routerUrl || "",
          mappedModels: Object.keys(cfg.modelMap || {}).length,
          machine: machineId(),
          autoStart: await autoStartStatus(),
        };
        sendJson(res, 200, status);
        return;
      }

      sendJson(res, 404, { error: "Not found" });
    } catch (error) {
      const requestId = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
      appendLog("error", "GUI API request failed", errorMeta(error, {
        requestId,
        method: req.method,
        path: url ? url.pathname : req.url,
      }));
      sendJson(res, 500, {
        error: error.message || String(error),
        requestId,
        logPaths: logPaths(),
      });
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(uiPort, "127.0.0.1", resolve);
  });

  const url = `http://127.0.0.1:${uiPort}/`;
  console.log(`GUI ready at ${url}`);
  appendLog("info", "GUI backend ready", { url });
  if (!options.noOpen) {
    try { openBrowser(url); } catch (error) { console.error(`Open browser failed: ${error.message}`); }
  }

  process.on("SIGTERM", () => { server.close(() => process.exit(0)); });
  process.on("SIGINT", () => { server.close(() => process.exit(0)); });
}

module.exports = {
  guiHtml,
  guiPresets,
  runGui,
};
