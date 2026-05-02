const http = require("http");
const fs = require("fs");

const {
  DEFAULT_REMOTE,
  IS_MAC,
  IS_WIN,
  MAPPABLE_ANTIGRAVITY_ALIASES,
} = require("../config/constants");
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
} = require("../config");
const { fetchAvailableModels, normalizeModelMap } = require("../models");
const { readRequestJson, sendJson } = require("../system/http");
const { appendLog, clearLogs, logPaths, readRecentLogs } = require("../system/logging");
const { openBrowser } = require("../system");
const {
  applyAntigravityNodeTrust,
  certExists,
  certPaths,
  checkAntigravityNodeTrust,
  checkCertInstalled,
  generateCert,
  installCert,
  uninstallCert,
  windowsBatchInstallCertAndHosts,
} = require("../cert");
const {
  addDNSEntries,
  applyDnsEntriesToHostsContent,
  dnsConfiguredForHosts,
  dnsEntriesForHosts,
  getRedirectIPs,
  readHostsFileContent,
  removeDNSEntries,
} = require("../dns");
const { HOSTS_FILE } = require("../config/constants");
const {
  autoStartStatus,
  checkProxyHealth,
  disableAutoStart,
  enableAutoStart,
  formatPortOwners,
  getPortOwners,
  startProxyDetached,
  stopProxyByPort,
} = require("../proxy/control");
const { guiHtml } = require("./template");
const { sendApiError, sendHtml, sendNotFound } = require("./api-utils");
const { createGuiRoutes, findGuiRoute } = require("./routes");

function guiPresets() {
  return {};
}

const STATUS_CACHE_MS = IS_WIN ? 5000 : 1500;
const AUTOSTART_CACHE_MS = IS_WIN ? 60000 : 10000;
let statusCache = { at: 0, key: "", value: null };
let autoStartCache = { at: 0, value: null };

function statusCacheKey(options, deep) {
  const cfg = readConfig();
  return JSON.stringify({
    deep: Boolean(deep),
    port: Number(cfg.port || options.port || 443),
    targetHost: primaryTargetHost(cfg),
    routerUrl: cfg.routerUrl || "",
    modelMap: cfg.modelMap || {},
    remoteIp: cfg.remoteIp || options.remoteIp || DEFAULT_REMOTE,
  });
}

function invalidateStatusCache() {
  statusCache = { at: 0, key: "", value: null };
  autoStartCache = { at: 0, value: null };
}

async function cachedAutoStartStatus(force = false) {
  const now = Date.now();
  if (!force && autoStartCache.value && now - autoStartCache.at < AUTOSTART_CACHE_MS) {
    return autoStartCache.value;
  }
  const value = await autoStartStatus();
  autoStartCache = { at: now, value };
  return value;
}

async function reloadProxyAfterConfigSave(previousConfig, nextConfig, body, options) {
  const port = Number(nextConfig.port || options.port || 443);
  const targetHost = primaryTargetHost(nextConfig);
  const proxy = { reloaded: false, wasRunning: false, port };
  if (!(await checkProxyHealth(port, targetHost))) return proxy;

  const sudoPassword = String(body.sudoPassword || "");
  await stopProxyByPort({ sudoPassword, port, targetHost });
  const result = await startProxyDetached({ sudoPassword, port, targetHost });
  appendLog("info", "Proxy reloaded after config save", {
    port,
    targetHost,
    changed: {
      routerUrl: previousConfig.routerUrl !== nextConfig.routerUrl,
      apiKey: previousConfig.apiKey !== nextConfig.apiKey,
      modelMap: JSON.stringify(previousConfig.modelMap || {}) !== JSON.stringify(nextConfig.modelMap || {}),
    },
  });
  return { ...result, reloaded: true, wasRunning: true };
}

// Windows: gộp cert install + hosts write + DNS flush vào 1 PowerShell elevated = 1 UAC prompt.
// Trả về { cert, dns } giống như installCert và addDNSEntries riêng lẻ.
async function applyWindowsSetup({ certCaPath, targetHosts, remoteHost, remoteIp }) {
  const { resolveRemoteIP } = require("../dns");
  // Tính IP cần redirect (nếu không có remoteIp, resolve từ remoteHost)
  let ip = remoteIp;
  if (!ip && remoteHost) {
    const addrs = await resolveRemoteIP(remoteHost);
    ip = addrs[0];
  }
  if (!ip) ip = require("../config/constants").DEFAULT_REMOTE;

  const entries    = dnsEntriesForHosts(targetHosts, ip);
  const currentContent = readHostsFileContent();
  const { content: nextContent, replacedExisting } = applyDnsEntriesToHostsContent(currentContent, entries);

  // 1 elevated PowerShell: cert + (hosts nếu cần thay đổi)
  const hostsChanged = nextContent !== currentContent;
  await windowsBatchInstallCertAndHosts({
    certPath:     certCaPath,
    hostsContent: hostsChanged ? nextContent : null,
    hostsFile:    hostsChanged ? HOSTS_FILE : null,
  });

  return {
    cert: { installed: true },
    dns:  { added: !replacedExisting, results: entries.map((e) => ({ targetHost: e.targetHost, added: true, ip: e.ip })) },
  };
}

function createRouteHandlers(options) {
  return {
    handleBootstrap: (_req, res) => handleBootstrap(res),
    handleLogs: (_req, res) => sendJson(res, 200, readRecentLogs()),
    handleSaveConfig: (req, res) => handleSaveConfig(req, res, options),
    handleExportConfig: (_req, res) => handleExportConfig(res),
    handleImportConfig,
    handleCheckKey,
    handleStartProxy: (req, res) => handleStartProxy(req, res, options),
    handleStartProxyOnly: (req, res) => handleStartProxyOnly(req, res, options),
    handleStopProxy: (req, res) => handleStopProxy(req, res, options),
    handleStopAndCleanup: (req, res) => handleStopAndCleanup(req, res, options),
    handleReloadProxy: (req, res) => handleReloadProxy(req, res, options),
    handleForceKillPort: (req, res) => handleForceKillPort(req, res, options),
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
  const cfg = readConfig();
  sendJson(res, 200, {
    config: cfg,
    cachedModels: cfg.cachedModels || [],
    configPath: settingsPath(),
    bundledSettingsPath: bundledSettingsPath(),
    legacyConfigPath: configPath(),
    machine: machineId(),
    antigravityAliases: MAPPABLE_ANTIGRAVITY_ALIASES,
    presets: guiPresets(),
    // Platform info cho GUI biết có cần hiện ô nhập sudo password không
    platform: {
      isWin: IS_WIN,
      isMac: IS_MAC,
      isLinux: !IS_WIN && !IS_MAC,
      // Linux cần sudo password vì không có osascript dialog hay UAC
      needsSudoPassword: !IS_WIN && !IS_MAC,
    },
  });
}

async function handleSaveConfig(req, res, options) {
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
  const proxy = await reloadProxyAfterConfigSave(current, next, body, options);
  invalidateStatusCache();
  sendJson(res, 200, { config: next, proxy });
}

async function handleCheckKey(req, res) {
  const body = await readRequestJson(req);
  const routerUrl = String(body.routerUrl || readConfig().routerUrl || "").trim();
  const apiKey = String(body.apiKey || "");
  if (!routerUrl) throw new Error("Missing endpoint");
  try {
    const result = await fetchAvailableModels(routerUrl, apiKey);
    if (result.models && result.models.length > 0) {
      const cfg = readConfig();
      writeConfig({ ...cfg, cachedModels: result.models });
    }
    sendJson(res, 200, result);
  } catch (error) {
    if (error.category || error.hint || error.modelsUrl || error.status) {
      sendJson(res, 502, {
        error: error.message,
        category: error.category || "model_check_failed",
        hint: error.hint || "Check the router URL and provider configuration.",
        modelsUrl: error.modelsUrl || "",
        status: error.status || 0,
      });
      return;
    }
    throw error;
  }
}

async function handleStartProxy(req, res, options) {
  const body = await readRequestJson(req);
  const cfg = readConfig();
  const targetHosts = targetHostsFrom(cfg);
  const sudoPassword = String(body.sudoPassword || "");
  const cert = await generateCert(targetHosts, { force: false, sudoPassword });

  // Windows: gộp cert + DNS vào 1 UAC prompt duy nhất
  let certResult, dnsResult;
  if (IS_WIN) {
    ({ cert: certResult, dns: dnsResult } = await applyWindowsSetup({
      certCaPath: cert.ca,
      targetHosts,
      remoteHost: cfg.remoteHost || options.remoteHost,
      remoteIp: cfg.remoteIp || options.remoteIp,
    }));
  } else {
    certResult = await installCert(cert.ca, targetHosts[0], sudoPassword);
    dnsResult = await addDNSEntries({
      targetHosts,
      remoteHost: cfg.remoteHost || options.remoteHost,
      remoteIp: cfg.remoteIp || options.remoteIp,
      sudoPassword,
    });
  }
  const nodeTrust = await applyAntigravityNodeTrust(cert.ca);
  const port = Number(cfg.port || options.port || 443);
  const targetHost = primaryTargetHost(cfg);
  appendLog("info", "Proxy start requested", { port, targetHosts: targetHosts.length });
  // startProxyDetached handles ownership:
  //  - health check OK (our proxy)   → alreadyRunning: true, no restart
  //  - port busy by foreign process  → throws error with owner info
  //  - not running                   → start LaunchDaemon (macOS) / detached (others)
  const result = await startProxyDetached({ sudoPassword, port, targetHost });
  appendLog("info", "Proxy start from UI", {
    port,
    targetHost,
    alreadyRunning: result.alreadyRunning,
  });
  invalidateStatusCache();
  sendJson(res, 200, { ...result, restarted: false, cert: certResult, dns: dnsResult, nodeTrust });
}

async function handleStartProxyOnly(req, res, options) {
  const body = await readRequestJson(req);
  const cfg = readConfig();
  const sudoPassword = String(body.sudoPassword || "");
  const port = Number(cfg.port || options.port || 443);
  const targetHost = primaryTargetHost(cfg);
  appendLog("info", "Proxy-only start requested", { port, targetHost });
  // startProxyDetached handles ownership:
  //  - health check OK (our proxy)   → alreadyRunning: true, no restart
  //  - port busy by foreign process  → throws error with owner info
  //  - not running                   → start LaunchDaemon (macOS) / detached (others)
  const result = await startProxyDetached({ sudoPassword, port, targetHost });
  appendLog("info", "Proxy start-only from UI", {
    port,
    targetHost,
    alreadyRunning: result.alreadyRunning,
  });
  invalidateStatusCache();
  sendJson(res, 200, { ...result, restarted: false, setupSkipped: true });
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
  invalidateStatusCache();
  sendJson(res, 200, result);
}

// Kill bất kỳ process nào đang chiếm port proxy (không phân biệt có phải proxy của mình không).
// Hữu ích khi process lạ (nginx, caddy, …) chiếm cổng 443 trước khi khởi động MITM proxy.
async function handleForceKillPort(req, res, options) {
  const body = await readRequestJson(req);
  const cfg = readConfig();
  const sudoPassword = String(body.sudoPassword || "");
  const port = Number(cfg.port || options.port || 443);
  // Lấy thông tin process đang chiếm port trước khi kill để trả về cho UI
  const owners = await getPortOwners(port);
  const ownerText = formatPortOwners(owners);
  const wasListening = owners.length > 0;
  appendLog("info", "Force-kill port requested", { port, owner: ownerText || "(none)" });
  if (!wasListening) {
    sendJson(res, 200, { killed: false, wasListening: false, port, owners: [] });
    return;
  }
  // stopProxyByPort handles: LaunchDaemon bootout (macOS <1024) + kill PIDs
  const result = await stopProxyByPort({ sudoPassword, port, targetHost: primaryTargetHost(cfg) });
  appendLog("info", "Force-kill port done", { port, stopped: result.stopped, owner: ownerText });
  invalidateStatusCache();
  sendJson(res, 200, { killed: result.stopped, wasListening: true, port, owners, ownerText });
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
    removePlist: true,   // Full cleanup: xóa LaunchDaemon plist để proxy không tự bật lại sau reboot
  });
  const dns = await removeDNSEntries({ targetHosts, sudoPassword });
  appendLog("info", "Proxy stopped and DNS cleanup requested", {
    port,
    stopped: stop.stopped,
    dnsRemoved: dns.removed,
    targetHosts: targetHosts.length,
  });
  invalidateStatusCache();
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
  const cert = await generateCert(targetHosts, { force: false, sudoPassword });
  const certResult = await installCert(cert.ca, targetHosts[0], sudoPassword);
  const nodeTrust = await applyAntigravityNodeTrust(cert.ca);
  const result = await startProxyDetached({ sudoPassword, port, targetHost });
  appendLog("info", "Proxy reloaded from UI", { port, targetHost });
  invalidateStatusCache();
  sendJson(res, 200, { ...result, reloaded: true, wasRunning: true, cert: certResult, nodeTrust });
}

async function handleApplyDns(req, res, options) {
  const body = await readRequestJson(req);
  const cfg = readConfig();
  const targetHosts = targetHostsFrom(cfg);
  const sudoPassword = String(body.sudoPassword || "");
  const cert = await generateCert(targetHosts, { force: false, sudoPassword });
  const nodeTrust = await applyAntigravityNodeTrust(cert.ca);
  const port = Number(cfg.port || options.port || 443);
  const targetHost = primaryTargetHost(cfg);

  // Windows: 1 UAC duy nhất cho cert + DNS
  let certResult, dnsResult;
  if (IS_WIN) {
    ({ cert: certResult, dns: dnsResult } = await applyWindowsSetup({
      certCaPath: cert.ca,
      targetHosts,
      remoteHost: cfg.remoteHost || options.remoteHost,
      remoteIp: cfg.remoteIp || options.remoteIp,
    }));
  } else {
    certResult = await installCert(cert.ca, targetHosts[0], sudoPassword);
    dnsResult = await addDNSEntries({
      targetHosts,
      remoteHost: cfg.remoteHost || options.remoteHost,
      remoteIp: cfg.remoteIp || options.remoteIp,
      sudoPassword,
    });
  }
  let proxy = { reloaded: false, wasRunning: false, port };
  if (await checkProxyHealth(port, targetHost)) {
    await stopProxyByPort({ sudoPassword, port, targetHost });
    proxy = {
      ...(await startProxyDetached({ sudoPassword, port, targetHost })),
      reloaded: true,
      wasRunning: true,
    };
    appendLog("info", "Proxy reloaded after DNS and certificate apply", { port, targetHost });
  }
  invalidateStatusCache();
  sendJson(res, 200, { cert: certResult, dns: dnsResult, nodeTrust, proxy });
}

async function handleApplyAppTrust(res) {
  const cfg = readConfig();
  const targetHosts = targetHostsFrom(cfg);
  const cert = await generateCert(targetHosts, { force: false });
  const nodeTrust = await applyAntigravityNodeTrust(cert.ca);
  invalidateStatusCache();
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
  invalidateStatusCache();
  sendJson(res, 200, { dns: dnsResult });
}

async function collectGuiStatus(options, { deep = false, useCache = true } = {}) {
  const key = statusCacheKey(options, deep);
  const now = Date.now();
  if (useCache && statusCache.value && statusCache.key === key && now - statusCache.at < STATUS_CACHE_MS) {
    return statusCache.value;
  }

  const cfg = readConfig();
  const { caCertPath } = certPaths();
  const certEx = certExists();
  const targetHosts = targetHostsFrom(cfg);
  const expectedIp = cfg.remoteIp || options.remoteIp || DEFAULT_REMOTE;
  const nodeTrust = certEx ? await checkAntigravityNodeTrust(caCertPath) : { supported: IS_MAC, applied: false, value: "" };
  const port = Number(cfg.port || options.port || 443);
  const proxyListening = await checkProxyHealth(port, targetHosts[0]);
  const shouldLoadPortOwners = deep || !proxyListening;
  const portOwners = shouldLoadPortOwners ? await getPortOwners(port) : [];
  const status = {
    proxyListening,
    dnsConfigured: dnsConfiguredForHosts(targetHosts, expectedIp),
    certExists: certEx,
    certInstalled: certEx ? await checkCertInstalled(caCertPath, targetHosts[0]) : false,
    nodeTrustSupported: nodeTrust.supported,
    nodeTrustApplied: nodeTrust.applied,
    nodeTrustValue: nodeTrust.value,
    redirectIp: targetHosts.map((host) => `${host}=${getRedirectIPs(host).join("/") || "-"}`).join(", "),
    routerUrl: cfg.routerUrl || "",
    mappedModels: Object.keys(cfg.modelMap || {}).length,
    machine: machineId(),
    autoStart: await cachedAutoStartStatus(deep),
    port,
    portOwners,
    portOwnerText: formatPortOwners(portOwners),
  };
  statusCache = { at: now, key, value: status };
  return status;
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
    { id: "portOwner", label: "Port Owner", ok: !status.portOwnerText || status.proxyListening, severity: status.portOwnerText && !status.proxyListening ? "err" : "ok" },
  ];
  const recommendations = [];
  if (status.dnsConfigured && !status.proxyListening) recommendations.push("DNS redirect is active while the proxy is stopped. Use Stop & Remove DNS before leaving the tool.");
  if (!status.dnsConfigured) recommendations.push("DNS is not active. Use Apply DNS & Cert when you want Antigravity traffic to use the proxy.");
  if (!status.proxyListening) recommendations.push("Proxy is not running. Use Start Proxy & Trust or Start Proxy Only depending on whether setup is already complete.");
  if (!status.certExists) recommendations.push("Managed CA certificate is missing or still uses the legacy format. Use Apply DNS & Cert.");
  if (!status.certInstalled && status.certExists) recommendations.push("Certificate exists but is not trusted by the system. Use Apply DNS & Cert.");
  if (status.nodeTrustSupported && !status.nodeTrustApplied) recommendations.push("Antigravity Node trust is missing. Use Apply DNS & Cert, then restart Antigravity.");
  if (!status.routerUrl) recommendations.push("Router URL is empty. Configure endpoint and authentication first.");
  if (status.mappedModels === 0) recommendations.push("No built-in models are mapped. Add model mappings or enable passthrough intentionally.");
  if (status.portOwnerText && !status.proxyListening) recommendations.push(`Port ${status.port || 443} is occupied by ${status.portOwnerText}. Stop that process before starting MITM Antigravity.`);
  if (recommendations.length === 0) recommendations.push("Everything looks healthy.");
  const hasError = checks.some((check) => check.severity === "err");
  const hasWarn = checks.some((check) => check.severity === "warn");
  return { summary: hasError ? "error" : (hasWarn ? "warning" : "healthy"), checks, recommendations };
}

async function handleStatus(res, options) {
  sendJson(res, 200, await collectGuiStatus(options, { deep: false, useCache: true }));
}

async function handleDoctor(res, options) {
  const status = await collectGuiStatus(options, { deep: true, useCache: false });
  const report = buildDoctorReport(status);
  sendJson(res, 200, { status, ...report });
}

async function handleUninstallCert(req, res) {
  const body = await readRequestJson(req);
  const cfg = readConfig();
  const { caCertPath, certPath } = certPaths();
  const sudoPassword = String(body.sudoPassword || "");
  const trustCertPath = certExists() ? caCertPath : certPath;
  const result = fs.existsSync(trustCertPath)
    ? await uninstallCert(trustCertPath, primaryTargetHost(cfg), sudoPassword)
    : { removed: false };
  invalidateStatusCache();
  sendJson(res, 200, { cert: result });
}

async function handleEnableAutoStart(_req, res) {
  const result = await enableAutoStart();
  invalidateStatusCache();
  sendJson(res, 200, result);
}

async function handleDisableAutoStart(_req, res) {
  const result = await disableAutoStart();
  invalidateStatusCache();
  sendJson(res, 200, result);
}

async function handleClearLogs(_req, res) {
  clearLogs();
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
  invalidateStatusCache();
  sendJson(res, 200, { config: imported });
}


async function startGuiServer(options = {}) {
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
  console.log(`GUI server started: ${url}`);
  appendLog("info", "GUI backend ready", { url });

  // NOTE: windowsRefreshAutoStartPath đã bị bỏ khỏi đây vì nó trigger UAC mỗi lần
  // người dùng mở app (rất khó chịu). Path của Scheduled Task được refresh tự động
  // khi user click "Enable Auto Start" lại sau khi cập nhật app.

  return { server, url, port: uiPort };
}

async function runGui(options) {
  const { server, url } = await startGuiServer(options);

  // In URL ra console để user biết truy cập đâu khi browser không tự mở
  console.log(`\nMITM Antigravity GUI: ${url}`);
  console.log("Press Ctrl+C to stop the GUI server.\n");

  if (!options.noOpen) {
    try {
      openBrowser(url);
    } catch (error) {
      console.error(`Open browser failed: ${error.message}`);
      console.error(`Please open manually: ${url}`);
    }
  }

  process.on("SIGTERM", () => { server.close(() => process.exit(0)); });
  process.on("SIGINT", () => { server.close(() => process.exit(0)); });
}

module.exports = {
  guiHtml,
  guiPresets,
  runGui,
  startGuiServer,
};
