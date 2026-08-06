const http = require("http");
const fs = require("fs");

const {
  DEFAULT_REMOTE,
  IS_MAC,
  IS_WIN,
  PRIMARY_ANTIGRAVITY_ALIASES,
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
  isPortListening,
  stopProxyByPort,
} = require("../proxy/control");
const { getProxyManager } = require("../proxy/manager");
const { guiHtml } = require("./template");
const { sendApiError, sendHtml, sendNotFound } = require("./api-utils");
const { createGuiRoutes, findGuiRoute } = require("./routes");
const { loadAccounts } = require("./quotas");
const os = require("os");
const path = require("path");

function guiPresets() {
  return {};
}

const STATUS_CACHE_MS = IS_WIN ? 5000 : 1500;
const AUTOSTART_CACHE_MS = IS_WIN ? 60000 : 10000;
let statusCache = { at: 0, key: "", value: null };
let autoStartCache = { at: 0, value: null };

async function tryApplyAntigravityNodeTrust(certPath) {
  try {
    return await applyAntigravityNodeTrust(certPath);
  } catch (error) {
    appendLog("warn", "Antigravity Node trust apply failed", {
      message: error && error.message ? error.message : String(error),
    });
    return {
      supported: IS_MAC || IS_WIN,
      applied: false,
      changed: false,
      restartRequired: false,
      value: "",
      error: error && error.message ? error.message : String(error),
    };
  }
}

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
  // Route through ProxyManager so embedded mode reloads in-process without
  // a full detached respawn (no UAC prompt, no port-conflict window).
  const result = await getProxyManager().reload({ config: nextConfig, sudoPassword });
  appendLog("info", "Proxy reloaded after config save", {
    port,
    targetHost,
    mode: result.mode,
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
async function applyWindowsSetup({ certCaPath, targetHost, targetHosts, remoteHost, remoteIp }) {
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
  const hostsChanged = nextContent !== currentContent;

  // Skip the elevated certutil step when the CA is already trusted, so a
  // fully-configured machine gets NO UAC prompt on a repeat Start/DNS click.
  // This mirrors applyMacSetup's `if (!certInstalled)` guard — previously the
  // Windows path always ran certutil -addstore (one UAC per click) while macOS
  // did not, which is exactly the "không ổn định" asymmetry. checkCertInstalled
  // is a non-elevated cert-store read, so it never prompts on its own.
  const certInstalled = await checkCertInstalled(certCaPath, targetHost || targetHosts[0]);

  // 1 elevated PowerShell: cert (nếu chưa trust) + hosts (nếu cần thay đổi).
  // Nếu cả hai đều không cần → batch helper bỏ qua, không pop UAC.
  await windowsBatchInstallCertAndHosts({
    certPath:     certCaPath,
    installCert:  !certInstalled,
    hostsContent: hostsChanged ? nextContent : null,
    hostsFile:    hostsChanged ? HOSTS_FILE : null,
  });

  return {
    cert: { installed: !certInstalled },
    dns:  { added: !replacedExisting, results: entries.map((e) => ({ targetHost: e.targetHost, added: true, ip: e.ip })) },
  };
}

// macOS: collapse cert trust + hosts write + DNS flush into ONE elevated script
// = exactly one osascript admin dialog per action (mirrors applyWindowsSetup).
// Previously these ran as three separate execWithSudo calls = three prompts,
// and a cancel mid-way left inconsistent state.
async function applyMacSetup({ certCaPath, targetHost, targetHosts, remoteHost, remoteIp, sudoPassword }) {
  const os = require("os");
  const path = require("path");
  const { resolveRemoteIP, macFlushDnsCommand } = require("../dns");
  const { checkCertInstalled, macSystemTrustCommand } = require("../cert");
  const { composeSudoBatch, execWithSudo, shellQuote } = require("../system");

  let ip = remoteIp;
  if (!ip && remoteHost) {
    const addrs = await resolveRemoteIP(remoteHost);
    ip = addrs[0];
  }
  if (!ip) ip = DEFAULT_REMOTE;

  const entries = dnsEntriesForHosts(targetHosts, ip);
  const currentContent = readHostsFileContent();
  const { content: nextContent, replacedExisting } = applyDnsEntriesToHostsContent(currentContent, entries);
  const hostsChanged = nextContent !== currentContent;

  const certInstalled = await checkCertInstalled(certCaPath, targetHost);

  const commands = [];
  // Running as root via osascript, so System.keychain trust succeeds without the
  // headless-context denial that the login-keychain fallback exists for.
  if (!certInstalled) commands.push(macSystemTrustCommand(certCaPath));

  let tempHosts = null;
  if (hostsChanged) {
    tempHosts = path.join(os.tmpdir(), `mitm-hosts-${process.pid}-${Date.now()}.tmp`);
    fs.writeFileSync(tempHosts, nextContent, { mode: 0o600 });
    commands.push(`cat ${shellQuote(tempHosts)} > ${shellQuote(HOSTS_FILE)}`);
    commands.push(macFlushDnsCommand());
  }

  if (commands.length > 0) {
    try {
      await execWithSudo(composeSudoBatch(commands), sudoPassword, { interactive: true });
    } finally {
      if (tempHosts) { try { fs.unlinkSync(tempHosts); } catch { /* best effort */ } }
    }
  }

  return {
    cert: { installed: !certInstalled },
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
    handleEvents: (req, res) => handleEvents(req, res, options),
    handleClearLogs,
    handleGetQuotas: (_req, res) => handleGetQuotas(res),
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
    antigravityAliases: PRIMARY_ANTIGRAVITY_ALIASES,
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

async function handleGetQuotas(res) {
  try {
    const dataDir = path.join(os.homedir(), ".antigravity_tools");
    const data = loadAccounts(dataDir);
    sendJson(res, 200, data);
  } catch (error) {
    sendJson(res, 500, { error: error.message });
  }
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
  } else if (IS_MAC) {
    ({ cert: certResult, dns: dnsResult } = await applyMacSetup({
      certCaPath: cert.ca,
      targetHost: targetHosts[0],
      targetHosts,
      remoteHost: cfg.remoteHost || options.remoteHost,
      remoteIp: cfg.remoteIp || options.remoteIp,
      sudoPassword,
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
  const nodeTrust = await tryApplyAntigravityNodeTrust(cert.ca);
  const port = Number(cfg.port || options.port || 443);
  const targetHost = primaryTargetHost(cfg);
  appendLog("info", "Proxy start requested", { port, targetHosts: targetHosts.length });
  // ProxyManager picks embedded vs detached automatically (privileged ports
  // and Windows still go detached; everything else can run in-process).
  const result = await getProxyManager().start({ config: cfg, sudoPassword });
  appendLog("info", "Proxy start from UI", {
    port,
    targetHost,
    mode: result.mode,
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
  const result = await getProxyManager().start({ config: cfg, sudoPassword });
  appendLog("info", "Proxy start-only from UI", {
    port,
    targetHost,
    mode: result.mode,
    alreadyRunning: result.alreadyRunning,
  });
  invalidateStatusCache();
  sendJson(res, 200, { ...result, restarted: false, setupSkipped: true });
}

async function handleStopProxy(req, res, options) {
  const body = await readRequestJson(req);
  const cfg = readConfig();
  const sudoPassword = String(body.sudoPassword || "");
  const result = await getProxyManager().stop({ config: cfg, sudoPassword });
  appendLog("info", "Proxy stop requested", {
    port: Number(cfg.port || options.port || 443),
    mode: result.mode,
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
  const targetHost = primaryTargetHost(cfg);
  // Owner probe is non-interactive so it never adds a prompt of its own; the
  // single admin/UAC prompt (if any) happens inside stopProxyByPort. On macOS
  // privileged ports the owner is hidden from non-root lsof, so we still attempt
  // the kill when the user explicitly asks even if the probe shows nothing.
  const owners = await getPortOwners(port, { sudoPassword, interactive: false });
  const ownerText = formatPortOwners(owners);
  const macPrivileged = IS_MAC && port < 1024;
  const healthy = await checkProxyHealth(port, targetHost);
  const wasListening = owners.length > 0
    || healthy
    || (!macPrivileged && await isPortListening(port, { sudoPassword, interactive: false }));
  appendLog("info", "Force-kill port requested", { port, owner: ownerText || "(none)" });
  if (!wasListening && !macPrivileged) {
    sendJson(res, 200, { killed: false, wasListening: false, port, owners: [] });
    return;
  }
  // stopProxyByPort handles LaunchDaemon bootout (macOS <1024) + kill PIDs in a
  // single elevated script (one prompt).
  const result = await stopProxyByPort({ sudoPassword, port, targetHost, force: true });
  appendLog("info", "Force-kill port done", { port, stopped: result.stopped, owner: ownerText });
  invalidateStatusCache();
  sendJson(res, 200, { killed: result.stopped, wasListening: wasListening || macPrivileged, port, owners, ownerText });
}

async function handleStopAndCleanup(req, res, options) {
  const body = await readRequestJson(req);
  const cfg = readConfig();
  const sudoPassword = String(body.sudoPassword || "");
  const port = Number(cfg.port || options.port || 443);
  const targetHosts = targetHostsFrom(cfg);
  // Stop via manager (handles embedded close + detached/LaunchDaemon teardown).
  // For full cleanup we also clear the LaunchDaemon plist so the proxy does not
  // auto-start after reboot — handled by stopProxyByPort with removePlist=true.
  const stop = await getProxyManager().stop({
    config: cfg,
    sudoPassword,
    removePlist: true,
  });
  if (!stop.stopped && await checkProxyHealth(port, primaryTargetHost(cfg))) {
    // Embedded was idle but a stray detached process exists – sweep it.
    await stopProxyByPort({
      sudoPassword,
      port,
      targetHost: primaryTargetHost(cfg),
      removePlist: true,
    });
  }
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

  const cert = await generateCert(targetHosts, { force: false, sudoPassword });
  const certResult = await installCert(cert.ca, targetHosts[0], sudoPassword);
  const nodeTrust = await tryApplyAntigravityNodeTrust(cert.ca);
  const result = await getProxyManager().reload({ config: cfg, sudoPassword });
  appendLog("info", "Proxy reloaded from UI", { port, targetHost, mode: result.mode });
  invalidateStatusCache();
  sendJson(res, 200, { ...result, reloaded: true, wasRunning: true, cert: certResult, nodeTrust });
}

async function handleApplyDns(req, res, options) {
  const body = await readRequestJson(req);
  const cfg = readConfig();
  const targetHosts = targetHostsFrom(cfg);
  const sudoPassword = String(body.sudoPassword || "");
  const cert = await generateCert(targetHosts, { force: false, sudoPassword });
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
  } else if (IS_MAC) {
    ({ cert: certResult, dns: dnsResult } = await applyMacSetup({
      certCaPath: cert.ca,
      targetHost: targetHosts[0],
      targetHosts,
      remoteHost: cfg.remoteHost || options.remoteHost,
      remoteIp: cfg.remoteIp || options.remoteIp,
      sudoPassword,
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
  const nodeTrust = await tryApplyAntigravityNodeTrust(cert.ca);
  let proxy = { reloaded: false, wasRunning: false, port };
  if (await checkProxyHealth(port, targetHost)) {
    proxy = {
      ...(await getProxyManager().reload({ config: cfg, sudoPassword })),
      reloaded: true,
      wasRunning: true,
    };
    appendLog("info", "Proxy reloaded after DNS and certificate apply", { port, targetHost, mode: proxy.mode });
  }
  invalidateStatusCache();
  sendJson(res, 200, { cert: certResult, dns: dnsResult, nodeTrust, proxy });
}

async function handleApplyAppTrust(res) {
  const cfg = readConfig();
  const targetHosts = targetHostsFrom(cfg);
  const cert = await generateCert(targetHosts, { force: false });
  const nodeTrust = await tryApplyAntigravityNodeTrust(cert.ca);
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
  const portOwners = shouldLoadPortOwners ? await getPortOwners(port, { interactive: false }) : [];
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
    proxyMode: getProxyManager().describe().mode,
    proxyLastError: getProxyManager().describe().lastError,
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
  if (!status.dnsConfigured) recommendations.push("DNS is not active. Use DNS when you want Antigravity traffic to use the proxy.");
  if (!status.proxyListening) recommendations.push("Proxy is not running. Use Start Proxy & Trust or Start Proxy Only depending on whether setup is already complete.");
  if (!status.certExists) recommendations.push("Managed CA certificate is missing or still uses the legacy format. Use DNS.");
  if (!status.certInstalled && status.certExists) recommendations.push("Certificate exists but is not trusted by the system. Use DNS.");
  if (status.nodeTrustSupported && !status.nodeTrustApplied) recommendations.push("Antigravity Node trust is missing. Use Enable Antigravity Cert, then restart Antigravity.");
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

// SSE stream of proxy state. Browsers reconnect automatically on close, so we
// stay simple: heartbeat every 15s + emit on every manager state transition.
function handleEvents(req, res, options) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });

  const manager = getProxyManager();
  let closed = false;

  const safeWrite = (event, payload) => {
    if (closed || res.writableEnded || res.destroyed) return;
    try {
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    } catch {
      cleanup();
    }
  };

  const onStatus = (payload) => safeWrite("status", { ...payload, at: Date.now() });
  const onError  = (error)   => safeWrite("error", { message: String(error?.message || error), at: Date.now() });

  const heartbeat = setInterval(() => safeWrite("ping", { at: Date.now() }), 15000);

  const cleanup = () => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    manager.off("status", onStatus);
    manager.off("error", onError);
    if (!res.writableEnded) {
      try { res.end(); } catch (_) { /* ignore */ }
    }
  };

  req.on("close", cleanup);
  req.on("error", cleanup);
  manager.on("status", onStatus);
  manager.on("error", onError);

  // Push current state immediately so a reconnecting client renders without
  // waiting for the next transition.
  collectGuiStatus(options, { deep: false, useCache: true })
    .then((status) => safeWrite("status", { ...status, ...manager.describe(), at: Date.now() }))
    .catch(() => { /* surfaced via /api/status normally */ });
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
  const sseClients = new Set();
  // Manager state changes happen out-of-band (proxy crash, signal, etc.).
  // Invalidate the cached /api/status payload so the next read reflects reality
  // even when the config object did not change.
  const manager = getProxyManager();
  const onManagerStatus = () => invalidateStatusCache();
  manager.on("status", onManagerStatus);
  manager.on("error", onManagerStatus);

  const server = http.createServer(async (req, res) => {
    try {
      // Tag SSE responses so we can close them when the server shuts down.
      const reqUrl = new URL(req.url, `http://${req.headers.host || "127.0.0.1"}`);
      if (reqUrl.pathname === "/api/events") {
        sseClients.add(res);
        res.on("close", () => sseClients.delete(res));
      }
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

  // Wrap server.close so we cleanly tear down SSE clients (which would
  // otherwise hold the server open forever on a graceful shutdown).
  const originalClose = server.close.bind(server);
  server.close = (callback) => {
    manager.off("status", onManagerStatus);
    manager.off("error", onManagerStatus);
    for (const res of sseClients) {
      try { res.end(); } catch (_) { /* ignore */ }
    }
    sseClients.clear();
    return originalClose(callback);
  };

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

  // Graceful shutdown: stop any embedded proxy first (so port is released and
  // SSE clients see a final idle status), then close the GUI HTTP server, then
  // exit. Detached proxies (LaunchDaemon, UAC child) keep running by design.
  const shutdown = async () => {
    try {
      const manager = getProxyManager();
      if (manager.describe().mode === "embedded") {
        await manager.stop({});
      }
    } catch (_) { /* ignore */ }
    server.close(() => process.exit(0));
    // Hard exit fallback in case close() hangs on lingering sockets.
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

module.exports = {
  guiHtml,
  guiPresets,
  runGui,
  startGuiServer,
};
