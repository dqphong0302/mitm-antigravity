const crypto = require("crypto");
const http = require("http");

const {
  DEFAULT_REMOTE,
  IS_MAC,
  MAPPABLE_ANTIGRAVITY_ALIASES,
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
const { guiHtml } = require("./gui/template");

function guiPresets() {
  return {};
}

function requestId() {
  return crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

async function handleBootstrap(res) {
  sendJson(res, 200, {
    config: readConfig(),
    configPath: settingsPath(),
    bundledSettingsPath: bundledSettingsPath(),
    legacyConfigPath: configPath(),
    machine: machineId(),
    antigravityAliases: MAPPABLE_ANTIGRAVITY_ALIASES,
    presets: guiPresets(),
  });
}

async function handleSaveConfig(req, res) {
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
    modelPrefix: "",
    alwaysIntercept: body.alwaysIntercept === true,
    mockModelList: false,
    modelMap,
  };
  writeConfig(next);
  appendLog("info", "Config saved from UI", {
    routerUrl: next.routerUrl,
    model: next.model,
    alwaysIntercept: next.alwaysIntercept,
    mappedModels: Object.keys(next.modelMap || {}).length,
  });
  sendJson(res, 200, { config: next });
}

async function handleCheckKey(req, res) {
  const body = await readRequestJson(req);
  const routerUrl = String(body.routerUrl || readConfig().routerUrl || "").trim();
  const apiKey = String(body.apiKey || "");
  if (!routerUrl) throw new Error("Missing endpoint");
  const result = await fetchAvailableModels(routerUrl, apiKey);
  appendLog("info", "Model list loaded from endpoint", {
    routerUrl,
    models: result.models ? result.models.length : 0,
  });
  sendJson(res, 200, result);
}

async function handleStartProxy(req, res, options) {
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
  const result = await startProxyDetached({ sudoPassword, port, targetHost });
  appendLog("info", "Proxy started from UI", {
    port,
    targetHost,
    restarted,
    alreadyRunning: result.alreadyRunning,
  });
  sendJson(res, 200, { ...result, restarted, cert: certResult, dns: dnsResult, nodeTrust });
}

async function handleStopProxy(req, res, options) {
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
}

async function handleReloadProxy(req, res, options) {
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
}

async function handleApplyDns(req, res, options) {
  const body = await readRequestJson(req);
  const cfg = readConfig();
  const targetHosts = targetHostsFrom(cfg);
  const sudoPassword = String(body.sudoPassword || "");
  const cert = await generateCert(targetHosts, { force: false });
  const certResult = await installCert(cert.cert, targetHosts[0], sudoPassword);
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
}

async function handleApplyAppTrust(res) {
  const cfg = readConfig();
  const targetHosts = targetHostsFrom(cfg);
  const cert = await generateCert(targetHosts, { force: false });
  const nodeTrust = await applyAntigravityNodeTrust(cert.cert);
  appendLog("info", "Antigravity Node trust applied from UI", { targetHosts, nodeTrust });
  sendJson(res, 200, { nodeTrust });
}

async function handleRemoveDns(req, res) {
  const body = await readRequestJson(req);
  const cfg = readConfig();
  const sudoPassword = String(body.sudoPassword || "");
  const dnsResult = await removeDNSEntries({
    targetHosts: targetHostsFrom(cfg),
    sudoPassword,
  });
  appendLog("info", "DNS removed from UI", { dns: dnsResult });
  sendJson(res, 200, { dns: dnsResult });
}

async function handleStatus(res, options) {
  const cfg = readConfig();
  const { certPath } = certPaths();
  const certEx = certExists();
  const targetHosts = targetHostsFrom(cfg);
  const expectedIp = cfg.remoteIp || options.remoteIp || DEFAULT_REMOTE;
  const nodeTrust = certEx ? await checkAntigravityNodeTrust(certPath) : { supported: IS_MAC, applied: false, value: "" };
  const proxyListening = await checkProxyHealth(Number(cfg.port || options.port || 443), targetHosts[0]);
  sendJson(res, 200, {
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
  });
}

async function routeGuiRequest(req, res, options) {
  const url = new URL(req.url, `http://${req.headers.host || "127.0.0.1"}`);

  if (req.method === "GET" && url.pathname === "/") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    res.end(guiHtml());
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/bootstrap") return handleBootstrap(res);
  if (req.method === "GET" && url.pathname === "/api/logs") return sendJson(res, 200, readRecentLogs());
  if (req.method === "PUT" && url.pathname === "/api/config") return handleSaveConfig(req, res);
  if (req.method === "POST" && url.pathname === "/api/check-key") return handleCheckKey(req, res);
  if (req.method === "POST" && url.pathname === "/api/start-proxy") return handleStartProxy(req, res, options);
  if (req.method === "POST" && url.pathname === "/api/stop-proxy") return handleStopProxy(req, res, options);
  if (req.method === "POST" && url.pathname === "/api/reload-proxy") return handleReloadProxy(req, res, options);
  if (req.method === "POST" && url.pathname === "/api/apply-dns") return handleApplyDns(req, res, options);
  if (req.method === "POST" && url.pathname === "/api/apply-app-trust") return handleApplyAppTrust(res);
  if (req.method === "POST" && url.pathname === "/api/remove-dns") return handleRemoveDns(req, res);
  if (req.method === "GET" && url.pathname === "/api/autostart") return sendJson(res, 200, await autoStartStatus());
  if (req.method === "POST" && url.pathname === "/api/autostart/enable") {
    const result = await enableAutoStart();
    appendLog("info", "Auto start enabled from UI", result);
    return sendJson(res, 200, result);
  }
  if (req.method === "POST" && url.pathname === "/api/autostart/disable") {
    const result = await disableAutoStart();
    appendLog("info", "Auto start disabled from UI", result);
    return sendJson(res, 200, result);
  }
  if (req.method === "GET" && url.pathname === "/api/status") return handleStatus(res, options);
  if (req.method === "POST" && url.pathname === "/api/logs/clear") {
    clearLogs();
    appendLog("info", "Logs cleared from UI");
    return sendJson(res, 200, { cleared: true, paths: logPaths() });
  }

  sendJson(res, 404, { error: "Not found" });
}

async function runGui(options) {
  const uiPort = Number(options.uiPort || 20245);
  const server = http.createServer(async (req, res) => {
    try {
      await routeGuiRequest(req, res, options);
    } catch (error) {
      const id = requestId();
      appendLog("error", "GUI API request failed", errorMeta(error, {
        requestId: id,
        method: req.method,
        path: req.url,
      }));
      sendJson(res, 500, {
        error: error.message || String(error),
        requestId: id,
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
    try {
      openBrowser(url);
    } catch (error) {
      console.error(`Open browser failed: ${error.message}`);
    }
  }

  process.on("SIGTERM", () => { server.close(() => process.exit(0)); });
  process.on("SIGINT", () => { server.close(() => process.exit(0)); });
}

module.exports = {
  guiHtml,
  guiPresets,
  runGui,
};
