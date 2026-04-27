const {
  DEFAULT_MODEL_PREFIX,
  DEFAULT_REMOTE,
  DEFAULT_TARGET,
  DEFAULT_TARGET_HOSTS,
  IS_WIN,
} = require("./constants");
const { parseArgs } = require("./args");
const {
  bundledSettingsPath,
  configPath,
  machineId,
  normalizeTargetHosts,
  parseModelMapFile,
  parsePrimitive,
  primaryTargetHost,
  readConfig,
  redactConfig,
  settingsPath,
  targetHostsFrom,
  writeConfig,
} = require("./config");
const { isRoot } = require("./system");
const { normalizePrefix, parseInlineModelMap } = require("./models");
const { runGui } = require("./gui");
const {
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
const { checkProxyHealth, stopProxyByPort } = require("./proxy-control");
const { runProxy } = require("./proxy");

function printHelp() {
  console.log(`
Usage:
  mitm-antigravity [start|setup|stop|status|gui|config|uninstall-cert] [options]
  mitm-antigravity config [list|path|init|set key=value ...]

Options:
  --target-host       Target hostname (default: ${DEFAULT_TARGET})
  --target-hosts      Comma-separated target hostnames (default: ${DEFAULT_TARGET_HOSTS.join(",")})
  --remote-ip         IP to map in /etc/hosts (default: ${DEFAULT_REMOTE})
  --remote-host       Host to resolve for IP (optional)
  --password          Sudo password (macOS/Linux only; not required if run with sudo)
  --force-cert        Regenerate cert even if one exists
  --skip-setup        Start proxy without touching cert or hosts
  --port              Local port for proxy (default: 443)
  --router-url        Upstream URL for intercepted chat requests
  --endpoint          Alias for --router-url
  --api-key           Optional Bearer token for upstream
  --model             Force all intercepted requests to this upstream model
  --always-intercept  Intercept chat endpoints even without model mapping (default: false)
  --always-intercept=false  Require an explicit Antigravity mapping before intercepting
  --mock-model-list   Return mapped Antigravity aliases for fetchAvailableModels
  --mock-model-list=false  Passthrough Antigravity model list to Google
  --model-prefix      Prefix to apply when no mapping (default: ag/)
  --model-map-file    JSON map file: { "modelA": "modelB" }
  --map               Add mapping source=target. Can be repeated
  --max-retries       Maximum retry attempts for 503 errors (default: 5)
  --retry-delay       Initial retry delay in ms (default: 1000)
  --retry-backoff     Backoff multiplier for retries (default: 1.5)
  --ui-port           Local GUI port (default: 20245)
  --no-open           Do not open browser for GUI
  --help              Show help

Examples:
  mitm-antigravity config set routerUrl=https://api.example.com/v1/chat/completions apiKey=sk-...
  mitm-antigravity start --endpoint https://api.example.com/v1/chat/completions --model ag/gemini-3-flash
  mitm-antigravity start --map gemini-3-flash=ag/gemini-3-flash --map claude-sonnet-4-6=ag/claude-sonnet-4-6
`);
}

function commandNeedsSudoPreflight(cmd, options) {
  if (IS_WIN || isRoot()) return false;
  if (cmd === "setup" || cmd === "uninstall-cert") return true;
  if (cmd === "start") return !options.skipSetup || Number(options.port || 443) < 1024;
  return false;
}

async function handleConfigCommand(args) {
  const action = args._[1] || "list";
  if (action === "path") {
    console.log(settingsPath());
    return;
  }

  if (action === "paths") {
    console.log(JSON.stringify({
      settingsPath: settingsPath(),
      bundledSettingsPath: bundledSettingsPath(),
      legacyConfigPath: configPath(),
      machine: machineId(),
    }, null, 2));
    return;
  }

  if (action === "init") {
    if (!fs.existsSync(settingsPath())) writeConfig(readConfig());
    console.log(JSON.stringify(redactConfig(readConfig()), null, 2));
    return;
  }

  if (action === "list") {
    console.log(JSON.stringify(redactConfig(readConfig()), null, 2));
    return;
  }

  if (action === "set") {
    const current = readConfig();
    for (const pair of args._.slice(2)) {
      const idx = pair.indexOf("=");
      if (idx <= 0) throw new Error(`Invalid config assignment: ${pair}`);
      const key = pair.slice(0, idx);
      const value = pair.slice(idx + 1);
      if (key.startsWith("modelMap.")) {
        const modelName = key.slice("modelMap.".length);
        current.modelMap = current.modelMap || {};
        current.modelMap[modelName] = value;
      } else {
        current[key] = parsePrimitive(value);
      }
    }
    writeConfig(current);
    console.log(JSON.stringify(redactConfig(current), null, 2));
    return;
  }

  throw new Error(`Unknown config command: ${action}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0] || "start";

  if (args.help || cmd === "--help" || cmd === "help") {
    printHelp();
    return;
  }

  if (cmd === "config") {
    await handleConfigCommand(args);
    return;
  }

  const savedConfig = readConfig();
  const modelMapFile = args["model-map-file"] || process.env.MITM_MODEL_MAP_FILE || "";
  const cliModelMap = parseInlineModelMap(args.map);
  const fileModelMap = parseModelMapFile(modelMapFile);
  const options = {
    targetHost: args["target-host"] || process.env.MITM_TARGET_HOST || savedConfig.targetHost,
    targetHosts: normalizeTargetHosts(args["target-hosts"] || process.env.MITM_TARGET_HOSTS || savedConfig.targetHosts || savedConfig.targetHost),
    remoteHost: args["remote-host"] || process.env.MITM_REMOTE_HOST || savedConfig.remoteHost || null,
    remoteIp: args["remote-ip"] || process.env.MITM_REMOTE_IP || savedConfig.remoteIp,
    sudoPassword: args.password || process.env.MITM_SUDO_PASSWORD || "",
    forceCert: !!args["force-cert"],
    skipSetup: args["skip-setup"] === true || String(process.env.MITM_SKIP_SETUP || "").toLowerCase() === "true",
    port: Number(args.port || process.env.LOCAL_PORT || savedConfig.port),
    routerUrl: args["router-url"] || args.endpoint || process.env.ROUTER_URL || process.env.MITM_ENDPOINT || savedConfig.routerUrl,
    apiKey: args["api-key"] || process.env.ROUTER_API_KEY || savedConfig.apiKey || "",
    model: args.model || process.env.MITM_MODEL || savedConfig.model || "",
    alwaysIntercept: savedConfig.alwaysIntercept === true,
    mockModelList: savedConfig.mockModelList === true,
    modelPrefix: normalizePrefix(args["model-prefix"] || process.env.MITM_MODEL_PREFIX || savedConfig.modelPrefix),
    modelMap: {
      ...(savedConfig.modelMap || {}),
      ...fileModelMap,
      ...cliModelMap,
    },
    maxRetries: Number(args["max-retries"] || process.env.MITM_MAX_RETRIES || savedConfig.maxRetries),
    retryDelay: Number(args["retry-delay"] || process.env.MITM_RETRY_DELAY || savedConfig.retryDelay),
    retryBackoff: Number(args["retry-backoff"] || process.env.MITM_RETRY_BACKOFF || savedConfig.retryBackoff),
    uiPort: Number(args["ui-port"] || process.env.MITM_UI_PORT || 20245),
    noOpen: args["no-open"] === true || String(process.env.MITM_NO_OPEN || "").toLowerCase() === "true",
  };

  if (typeof args["always-intercept"] !== "undefined") {
    const val = args["always-intercept"];
    if (val === true) options.alwaysIntercept = true;
    else if (val === "false" || val === "0") options.alwaysIntercept = false;
    else options.alwaysIntercept = true;
  } else if (typeof process.env.MITM_ALWAYS_INTERCEPT !== "undefined") {
    const envVal = String(process.env.MITM_ALWAYS_INTERCEPT).toLowerCase();
    options.alwaysIntercept = envVal === "1" || envVal === "true" || envVal === "yes";
  }

  if (typeof args["mock-model-list"] !== "undefined") {
    const val = args["mock-model-list"];
    if (val === "false" || val === "0") options.mockModelList = false;
    else options.mockModelList = true;
  } else if (typeof process.env.MITM_MOCK_MODEL_LIST !== "undefined") {
    const envVal = String(process.env.MITM_MOCK_MODEL_LIST).toLowerCase();
    options.mockModelList = envVal === "1" || envVal === "true" || envVal === "yes";
  }

  if (cmd === "gui" || cmd === "ui") {
    await runGui(options);
    return;
  }

  if (commandNeedsSudoPreflight(cmd, options)) {
    if (!options.sudoPassword) {
      console.error("Missing sudo password. Re-run with --password or MITM_SUDO_PASSWORD, or run with sudo.");
      process.exitCode = 1;
      return;
    }
  }

  if (cmd === "status") {
    const { certPath } = certPaths();
    const targetHosts = targetHostsFrom(options);
    const certEx = certExists();
    const nodeTrust = certEx ? await checkAntigravityNodeTrust(certPath) : { supported: IS_MAC, applied: false, value: "" };
    const proxyListening = await checkProxyHealth(Number(options.port || 443), targetHosts[0]);
    const status = {
      running: proxyListening,
      proxyListening,
      dnsConfigured: dnsConfiguredForHosts(targetHosts, options.remoteIp || DEFAULT_REMOTE),
      certExists: certEx,
      certInstalled: certEx ? await checkCertInstalled(certPath, targetHosts[0]) : false,
      nodeTrustSupported: nodeTrust.supported,
      nodeTrustApplied: nodeTrust.applied,
      nodeTrustValue: nodeTrust.value,
      redirectIp: Object.fromEntries(targetHosts.map((host) => [host, getRedirectIPs(host)])),
      settingsPath: settingsPath(),
      bundledSettingsPath: bundledSettingsPath(),
      legacyConfigPath: configPath(),
      machine: machineId(),
      targetHosts,
      routerUrl: options.routerUrl,
      model: options.model || null,
      mappedModels: Object.keys(options.modelMap || {}).length,
    };
    console.log(JSON.stringify(status, null, 2));
    return;
  }

  if (cmd === "uninstall-cert") {
    const { certPath } = certPaths();
    const result = await uninstallCert(certPath, primaryTargetHost(options), options.sudoPassword);
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (cmd === "stop") {
    const proxy = await stopProxyByPort({ port: options.port, targetHost: primaryTargetHost(options), sudoPassword: options.sudoPassword });
    const dns = await removeDNSEntries({ targetHosts: targetHostsFrom(options), sudoPassword: options.sudoPassword });
    console.log(JSON.stringify({ proxy, dns }, null, 2));
    return;
  }

  if (cmd === "setup") {
    const targetHosts = targetHostsFrom(options);
    const cert = await generateCert(targetHosts, { force: options.forceCert });
    const certResult = await installCert(cert.cert, targetHosts[0], options.sudoPassword);
    const dnsResult = await addDNSEntries({
      targetHosts,
      remoteHost: options.remoteHost,
      remoteIp: options.remoteIp,
      sudoPassword: options.sudoPassword,
    });
    console.log(JSON.stringify({
      cert: certResult,
      dns: dnsResult,
      targetHosts,
    }, null, 2));
    return;
  }

  if (cmd !== "start") {
    console.error(`Unknown command: ${cmd}`);
    printHelp();
    process.exitCode = 1;
    return;
  }

  const targetHosts = targetHostsFrom(options);
  if (!options.skipSetup) {
    await generateCert(targetHosts, { force: options.forceCert });
    const { certPath } = certPaths();
    await installCert(certPath, targetHosts[0], options.sudoPassword);
    await addDNSEntries({
      targetHosts,
      remoteHost: options.remoteHost,
      remoteIp: options.remoteIp,
      sudoPassword: options.sudoPassword,
    });
  }

  await runProxy(options);
}

module.exports = {
  commandNeedsSudoPreflight,
  handleConfigCommand,
  main,
  printHelp,
};
