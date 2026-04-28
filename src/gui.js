const http = require("http");

const {
  DEFAULT_REMOTE,
  IS_MAC,
  MAPPABLE_ANTIGRAVITY_ALIASES,
} = require("./constants");
const {
  bundledSettingsPath,
  configPath,
  exportConfig,
  importConfig,
  machineId,
  primaryTargetHost,
  readConfig,
  settingsPath,
  targetHostsFrom,
  writeConfig,
} = require("./config");
const { fetchAvailableModels, normalizeModelMap } = require("./models");
const { readRequestJson, sendJson } = require("./http");
const { appendLog, clearLogs, logPaths, readRecentLogs } = require("./logging");
const { openBrowser } = require("./system");
const {
  applyAntigravityNodeTrust,
  certExists,
  certPaths,
  checkAntigravityNodeTrust,
  checkCertInstalled,
  generateCert,
  installCert,
  uninstallCert,
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
const { sendApiError, sendHtml, sendNotFound } = require("./gui/api-utils");
const { createGuiRoutes, findGuiRoute } = require("./gui/routes");

function guiPresets() {
  return {};
}

function createRouteHandlers(options) {
  return {
    handleBootstrap: (_req, res) => handleBootstrap(res),
    handleLogs: (_req, res) => sendJson(res, 200, readRecentLogs()),
    handleSaveConfig,
    handleExportConfig: (_req, res) => handleExportConfig(res),
    handleImportConfig,
    handleCheckKey,
    handleStartProxy: (req, res) => handleStartProxy(req, res, options),
    handleStartProxyOnly: (req, res) => handleStartProxyOnly(req, res, options),
    handleStopProxy: (req, res) => handleStopProxy(req, res, options),
    handleStopAndCleanup: (req, res) => handleStopAndCleanup(req, res, options),
    handleReloadProxy: (req, res) => handleReloadProxy(req, res, options),
    handleApplyDns: (req, res) => handleApplyDns(req, res, options),
    handleApplyAppTrust: (_req, res) => handleApplyAppTrust(res),
    handleRemoveDns,
    handleUninstallCert,
    handleDoctor: (_req, res) => handleDoctor(res, options),
    handleAutoStartStatus: async (_req, res) => sendJson(res, 200, await autoStartStatus()),
    handleEnableAutoStart,
    handleDisableAutoStart,
    handleStatus: (_req, res) => handleStatus(res, options),
    handleClearLogs,
  };
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
  appendLog("info", "Proxy start requested", { port, targetHosts: targetHosts.length });
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

async function handleStartProxyOnly(req, res, options) {
  const body = await readRequestJson(req);
  const cfg = readConfig();
  const sudoPassword = String(body.sudoPassword || "");
  const port = Number(cfg.port || options.port || 443);
  const targetHost = primaryTargetHost(cfg);
  let restarted = false;
  appendLog("info", "Proxy-only start requested", { port, targetHost });
  if (await checkProxyHealth(port, targetHost)) {
    await stopProxyByPort({ sudoPassword, port, targetHost });
    restarted = true;
  }
  const result = await startProxyDetached({ sudoPassword, port, targetHost });
  appendLog("info", "Proxy started without setup from UI", {
    port,
    targetHost,
    restarted,
    alreadyRunning: result.alreadyRunning,
  });
  sendJson(res, 200, { ...result, restarted, setupSkipped: true });
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
  appendLog("info", "Proxy stop requested", {
    port: Number(cfg.port || options.port || 443),
    stopped: result.stopped,
  });
  sendJson(res, 200, result);
}

async function handleStopAndCleanup(req, res, options) {
  const body = await readRequestJson(req);
  const cfg = readConfig();
  const sudoPassword = String(body.sudoPassword || "");
  const port = Number(cfg.port || options.port || 443);
  const targetHosts = targetHostsFrom(cfg);
  const stop = await stopProxyByPort({
    sudoPassword,
    port,
    targetHost: primaryTargetHost(cfg),
  });
  const dns = await removeDNSEntries({ targetHosts, sudoPassword });
  appendLog("info", "Proxy stopped and DNS cleanup requested", {
    port,
    stopped: stop.stopped,
    dnsRemoved: dns.removed,
    targetHosts: targetHosts.length,
  });
  sendJson(res, 200, { stop, dns });
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
  appendLog("info", "DNS/cert applied", {
    targetHosts: targetHosts.length,
    dnsAdded: dnsResult.added,
    certInstalled: certResult.installed,
    nodeTrustApplied: nodeTrust.applied,
  });
  sendJson(res, 200, { cert: certResult, dns: dnsResult, nodeTrust });
}

async function handleApplyAppTrust(res) {
  const cfg = readConfig();
  const targetHosts = targetHostsFrom(cfg);
  const cert = await generateCert(targetHosts, { force: false });
  const nodeTrust = await applyAntigravityNodeTrust(cert.cert);
  appendLog("info", "App trust applied", { targetHosts: targetHosts.length, applied: nodeTrust.applied });
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
  appendLog("info", "DNS removed", { removed: dnsResult.removed });
  sendJson(res, 200, { dns: dnsResult });
}

async function collectGuiStatus(options) {
  const cfg = readConfig();
  const { certPath } = certPaths();
  const certEx = certExists();
  const targetHosts = targetHostsFrom(cfg);
  const expectedIp = cfg.remoteIp || options.remoteIp || DEFAULT_REMOTE;
  const nodeTrust = certEx ? await checkAntigravityNodeTrust(certPath) : { supported: IS_MAC, applied: false, value: "" };
  const proxyListening = await checkProxyHealth(Number(cfg.port || options.port || 443), targetHosts[0]);
  return {
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
}

function buildDoctorReport(status) {
  const checks = [
    { id: "proxy", label: "Proxy Listener", ok: status.proxyListening, severity: status.proxyListening ? "ok" : "warn" },
    { id: "dns", label: "DNS Redirect", ok: status.dnsConfigured, severity: status.dnsConfigured ? "ok" : "warn" },
    { id: "cert", label: "Certificate Generated", ok: status.certExists, severity: status.certExists ? "ok" : "warn" },
    { id: "trust", label: "System Certificate Trust", ok: status.certInstalled, severity: status.certInstalled ? "ok" : "warn" },
    { id: "nodeTrust", label: "Antigravity Node Trust", ok: status.nodeTrustSupported ? status.nodeTrustApplied : true, severity: status.nodeTrustSupported && !status.nodeTrustApplied ? "warn" : "ok" },
    { id: "router", label: "Router URL", ok: Boolean(status.routerUrl), severity: status.routerUrl ? "ok" : "err" },
    { id: "mapping", label: "Model Mapping", ok: status.mappedModels > 0, severity: status.mappedModels > 0 ? "ok" : "warn" },
  ];
  const recommendations = [];
  if (status.dnsConfigured && !status.proxyListening) recommendations.push("DNS redirect is active while the proxy is stopped. Use Stop & Remove DNS before leaving the tool.");
  if (!status.dnsConfigured) recommendations.push("DNS is not active. Use Apply DNS & Cert when you want Antigravity traffic to use the proxy.");
  if (!status.proxyListening) recommendations.push("Proxy is not running. Use Start Proxy & Trust or Start Proxy Only depending on whether setup is already complete.");
  if (!status.certInstalled && status.certExists) recommendations.push("Certificate exists but is not trusted by the system. Use Apply DNS & Cert.");
  if (status.nodeTrustSupported && !status.nodeTrustApplied) recommendations.push("Antigravity Node trust is missing. Use Apply DNS & Cert, then restart Antigravity.");
  if (!status.routerUrl) recommendations.push("Router URL is empty. Configure endpoint and authentication first.");
  if (status.mappedModels === 0) recommendations.push("No built-in models are mapped. Add model mappings or enable passthrough intentionally.");
  if (recommendations.length === 0) recommendations.push("Everything looks healthy.");
  const hasError = checks.some((check) => check.severity === "err");
  const hasWarn = checks.some((check) => check.severity === "warn");
  return { summary: hasError ? "error" : (hasWarn ? "warning" : "healthy"), checks, recommendations };
}

async function handleStatus(res, options) {
  sendJson(res, 200, await collectGuiStatus(options));
}

async function handleDoctor(res, options) {
  const status = await collectGuiStatus(options);
  const report = buildDoctorReport(status);
  appendLog("info", "Doctor report requested from UI", { summary: report.summary });
  sendJson(res, 200, { status, ...report });
}

async function handleUninstallCert(req, res) {
  const body = await readRequestJson(req);
  const cfg = readConfig();
  const { certPath } = certPaths();
  const sudoPassword = String(body.sudoPassword || "");
  const result = certExists()
    ? await uninstallCert(certPath, primaryTargetHost(cfg), sudoPassword)
    : { removed: false };
  appendLog("info", "Certificate uninstall requested from UI", { removed: result.removed });
  sendJson(res, 200, { cert: result });
}

async function handleEnableAutoStart(_req, res) {
  const result = await enableAutoStart();
  appendLog("info", "Auto start enabled", { method: result.method, enabled: result.enabled });
  sendJson(res, 200, result);
}

async function handleDisableAutoStart(_req, res) {
  const result = await disableAutoStart();
  appendLog("info", "Auto start disabled", { method: result.method, enabled: result.enabled });
  sendJson(res, 200, result);
}

async function handleClearLogs(_req, res) {
  clearLogs();
  appendLog("info", "Logs cleared from UI");
  sendJson(res, 200, { cleared: true, paths: logPaths() });
}

async function routeGuiRequest(req, res, options) {
  const url = new URL(req.url, `http://${req.headers.host || "127.0.0.1"}`);

  if (req.method === "GET" && url.pathname === "/") {
    sendHtml(res, guiHtml());
    return;
  }

  const routes = createGuiRoutes(createRouteHandlers(options));
  const route = findGuiRoute(routes, req.method, url.pathname);
  if (!route) {
    sendNotFound(res);
    return;
  }

  await route.handler(req, res);
}

async function handleExportConfig(res) {
  const exported = exportConfig();
  appendLog("info", "Config exported from UI", {
    routerUrl: exported.routerUrl,
    mappedModels: Object.keys(exported.modelMap || {}).length,
  });
  sendJson(res, 200, exported);
}

async function handleImportConfig(req, res) {
  const body = await readRequestJson(req);
  const imported = importConfig(body);
  appendLog("info", "Config imported from UI", {
    routerUrl: imported.routerUrl,
    mappedModels: Object.keys(imported.modelMap || {}).length,
  });
  sendJson(res, 200, { config: imported });
}

async function runGui(options) {
  const uiPort = Number(options.uiPort || 20245);
  const server = http.createServer(async (req, res) => {
    try {
      await routeGuiRequest(req, res, options);
    } catch (error) {
      sendApiError(req, res, error);
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
