#!/usr/bin/env node

const https = require("https");
const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const dns = require("dns");
const crypto = require("crypto");
const zlib = require("zlib");
const { exec, spawn } = require("child_process");
const { promisify } = require("util");

const DEFAULT_TARGET_HOSTS = [
  "daily-cloudcode-pa.googleapis.com",
  "cloudcode-pa.googleapis.com",
];
const DEFAULT_TARGET = DEFAULT_TARGET_HOSTS[0];
const DEFAULT_REMOTE = "127.0.0.1";
const DEFAULT_ROUTER_URL = "http://localhost:20128/v1/chat/completions";
const PRESET_9ROUTER_BASE_URL = "https://9router.phongdang.io.vn/v1";
const PRESET_9ROUTER_MODEL = "cx/gpt-5.5";
const PRESET_9ROUTER_PREFIX = "cx/";
const APP_NAME = "mitm-antigravity";
const ANTIGRAVITY_ALIASES = [
  "gemini-3.1-pro-high",
  "gemini-3.1-pro-low",
  "gemini-3-flash",
  "claude-sonnet-4-6",
  "claude-opus-4-6-thinking",
  "gpt-oss-120b-medium",
  "gemini-3-pro-high",
  "gemini-3-pro-low",
];

const IS_WIN = process.platform === "win32";
const IS_MAC = process.platform === "darwin";
const HOSTS_FILE = IS_WIN
  ? path.join(process.env.SystemRoot || "C:\\Windows", "System32", "drivers", "etc", "hosts")
  : "/etc/hosts";

const DEFAULT_CONFIG = {
  targetHost: DEFAULT_TARGET,
  targetHosts: DEFAULT_TARGET_HOSTS,
  remoteIp: DEFAULT_REMOTE,
  remoteHost: "",
  port: 443,
  routerUrl: DEFAULT_ROUTER_URL,
  apiKey: "",
  model: "",
  modelPrefix: "ag/",
  alwaysIntercept: false,
  mockModelList: true,
  modelMap: {},
  maxRetries: 5,
  retryDelay: 1000,
  retryBackoff: 1.5,
};

const LEGACY_DEFAULT_MODEL_MAP = Object.fromEntries(ANTIGRAVITY_ALIASES.map((alias) => [alias, PRESET_9ROUTER_MODEL]));

function isRoot() {
  return typeof process.getuid === "function" && process.getuid() === 0;
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const eqIndex = arg.indexOf("=");
      const key = eqIndex === -1 ? arg.slice(2) : arg.slice(2, eqIndex);
      const maybeValue = eqIndex === -1 ? undefined : arg.slice(eqIndex + 1);
      if (typeof maybeValue !== "undefined") {
        addArgValue(out, key, maybeValue);
      } else {
        const next = argv[i + 1];
        if (next && !next.startsWith("--")) {
          addArgValue(out, key, next);
          i += 1;
        } else {
          addArgValue(out, key, true);
        }
      }
    } else {
      out._.push(arg);
    }
  }
  return out;
}

function addArgValue(out, key, value) {
  if (typeof out[key] === "undefined") {
    out[key] = value;
  } else if (Array.isArray(out[key])) {
    out[key].push(value);
  } else {
    out[key] = [out[key], value];
  }
}

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
  --always-intercept=false  Require an Antigravity mapping, like 9router
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

function appDir() {
  return path.join(os.homedir(), `.${APP_NAME}`);
}

function configPath() {
  return path.join(appDir(), "config.json");
}

function runtimeDir() {
  if (process.pkg) return path.dirname(process.execPath);
  return path.dirname(__filename);
}

function bundledSettingsPath() {
  return path.join(runtimeDir(), "settings.json");
}

function settingsPath() {
  return path.join(appDir(), "settings.json");
}

function machineId() {
  return os.hostname() || "default";
}

function normalizeTargetHosts(value) {
  const raw = Array.isArray(value) ? value : (value ? String(value).split(/[,\s]+/) : []);
  return Array.from(new Set(raw.map((host) => String(host || "").trim()).filter(Boolean)));
}

function targetHostsFrom(config) {
  let hosts = [
    ...normalizeTargetHosts(config?.targetHosts),
    ...normalizeTargetHosts(config?.targetHost),
  ];
  if (hosts.length === 0) hosts = [...DEFAULT_TARGET_HOSTS];
  if (hosts.includes(DEFAULT_TARGET)) {
    hosts.push(...DEFAULT_TARGET_HOSTS);
  }
  return Array.from(new Set(hosts));
}

function primaryTargetHost(config) {
  return targetHostsFrom(config)[0] || DEFAULT_TARGET;
}

function ensureAppDir() {
  const dir = appDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function readJsonFile(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, "utf-8"));
}

function normalizeSettings(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { activeMachine: machineId(), machines: {} };
  }

  return {
    activeMachine: raw.activeMachine || machineId(),
    machines: raw.machines && typeof raw.machines === "object" && !Array.isArray(raw.machines)
      ? raw.machines
      : {},
  };
}

function readSettings() {
  const primary = readJsonFile(settingsPath());
  if (primary) return normalizeSettings(primary);
  return normalizeSettings(readJsonFile(bundledSettingsPath()));
}

function currentMachineConfig(settings) {
  const id = machineId();
  return settings.machines[id] || settings.machines[settings.activeMachine] || {};
}

function readConfig() {
  try {
    const legacyConfig = readJsonFile(configPath()) || {};
    const settings = readSettings();
    return mergeConfig(mergeConfig(DEFAULT_CONFIG, legacyConfig), currentMachineConfig(settings));
  } catch (error) {
    throw new Error(`Invalid config. settings=${settingsPath()} legacy=${configPath()}: ${error.message}`);
  }
}

function mergeConfig(base, override) {
  return {
    ...base,
    ...override,
    modelMap: normalizeModelMap({
      ...(base.modelMap || {}),
      ...(override.modelMap || {}),
    }),
  };
}

function writeConfig(config) {
  const settings = readSettings();
  const id = machineId();
  settings.activeMachine = id;
  settings.machines[id] = mergeConfig(DEFAULT_CONFIG, config);
  ensureAppDir();
  fs.writeFileSync(settingsPath(), `${JSON.stringify(settings, null, 2)}\n`);
}

function writeLegacyConfig(config) {
  ensureAppDir();
  fs.writeFileSync(configPath(), `${JSON.stringify(config, null, 2)}\n`);
}

function parsePrimitive(value) {
  if (value === "true") return true;
  if (value === "false") return false;
  if (value !== "" && !Number.isNaN(Number(value)) && /^-?\d+(\.\d+)?$/.test(value)) {
    return Number(value);
  }
  return value;
}

function parseInlineModelMap(value) {
  const map = {};
  const values = Array.isArray(value) ? value : [value];
  for (const item of values.filter(Boolean)) {
    for (const pair of String(item).split(",")) {
      const idx = pair.indexOf("=");
      if (idx <= 0) continue;
      const source = pair.slice(0, idx).trim();
      const target = pair.slice(idx + 1).trim();
      if (source && target) map[source] = target;
    }
  }
  return map;
}

function parseModelMapFile(modelMapFile) {
  if (!modelMapFile) return {};
  try {
    const map = readJsonFile(path.resolve(modelMapFile));
    if (!map || typeof map !== "object" || Array.isArray(map)) {
      throw new Error("model map must be a JSON object");
    }
    return map;
  } catch (error) {
    throw new Error(`Invalid model map file ${modelMapFile}: ${error.message}`);
  }
}

function normalizeMappingEntry(entry) {
  if (!entry) return null;
  if (typeof entry === "string") {
    const model = entry.trim();
    return model ? { model } : null;
  }
  if (typeof entry === "object" && !Array.isArray(entry)) {
    const model = String(entry.model || "").trim();
    const reasoningEffort = String(entry.reasoning_effort || "").trim();
    if (!model) return null;
    return reasoningEffort ? { model, reasoning_effort: reasoningEffort } : { model };
  }
  return null;
}

function mappingModel(entry) {
  const normalized = normalizeMappingEntry(entry);
  return normalized ? normalized.model : "";
}

function normalizeModelMap(modelMap) {
  if (!modelMap || typeof modelMap !== "object" || Array.isArray(modelMap)) return {};
  return stripLegacyDefaultMappings(Object.fromEntries(Object.entries(modelMap)
    .map(([key, value]) => [String(key).trim(), normalizeMappingEntry(value)])
    .filter(([key, value]) => key && value)
    .map(([key, value]) => [key, value.reasoning_effort ? value : value.model])));
}

function stripLegacyDefaultMappings(modelMap) {
  const entries = Object.entries(modelMap || {});
  if (entries.length !== ANTIGRAVITY_ALIASES.length) return modelMap || {};
  const isOnlyLegacyDefaults = ANTIGRAVITY_ALIASES.every((alias) => mappingModel(modelMap[alias]) === LEGACY_DEFAULT_MODEL_MAP[alias]);
  return isOnlyLegacyDefaults ? {} : modelMap;
}

function redactConfig(config) {
  return {
    ...config,
    apiKey: config.apiKey ? `${String(config.apiKey).slice(0, 6)}...${String(config.apiKey).slice(-4)}` : "",
  };
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

function readRequestJson(req) {
  return collectBodyRaw(req).then((body) => {
    if (!body.length) return {};
    return JSON.parse(body.toString());
  });
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(payload));
}

function deriveModelsUrl(routerUrl) {
  const url = new URL(routerUrl);
  let pathname = url.pathname.replace(/\/+$/, "");
  if (pathname.endsWith("/chat/completions")) {
    pathname = `${pathname.slice(0, -"/chat/completions".length)}/models`;
  } else if (pathname.endsWith("/responses")) {
    pathname = `${pathname.slice(0, -"/responses".length)}/models`;
  } else if (!pathname.endsWith("/models")) {
    pathname = `${pathname}/models`;
  }
  url.pathname = pathname;
  url.search = "";
  url.hash = "";
  return url.toString();
}

async function fetchAvailableModels(routerUrl, apiKey) {
  const modelsUrl = deriveModelsUrl(routerUrl);
  const headers = { Accept: "application/json" };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  const response = await fetch(modelsUrl, { method: "GET", headers });
  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }

  if (!response.ok) {
    const message = data?.error?.message || data?.message || text || `HTTP ${response.status}`;
    throw new Error(`Model check failed at ${modelsUrl}: ${message}`);
  }

  const rawModels = Array.isArray(data) ? data : data.data || data.models || [];
  const models = rawModels
    .map((model) => {
      if (typeof model === "string") return model;
      return model.id || model.name || model.model || "";
    })
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));

  return { modelsUrl, models };
}

function guiPresets() {
  return {
    router9: {
      baseUrl: PRESET_9ROUTER_BASE_URL,
      model: PRESET_9ROUTER_MODEL,
      modelPrefix: PRESET_9ROUTER_PREFIX,
    },
  };
}

function openBrowser(url) {
  const command = IS_WIN ? "cmd" : IS_MAC ? "open" : "xdg-open";
  const args = IS_WIN ? ["/c", "start", "", url] : [url];
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  child.unref();
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
      display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px;
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
    .divider { height: 1px; background: var(--glass-border); margin: 4px 0 18px; }
    @media (max-width: 700px) {
      .grid { grid-template-columns: 1fr; }
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
    <nav class="tabs" aria-label="Main sections">
      <button class="tab-btn active" id="tabConfigBtn" data-tab="config" type="button">\u2699 Config</button>
      <button class="tab-btn" id="tabMappingBtn" data-tab="mapping" type="button">\uD83D\uDDFA Model Mapping</button>
      <button class="tab-btn" id="tabProxyBtn" data-tab="proxy" type="button">\uD83D\uDCE1 Proxy &amp; System</button>
    </nav>
    <section class="tab-panel active" id="tabConfigPanel" data-panel="config">
    <div class="card">
      <div class="card-header">
        <div class="card-title">\uD83D\uDD0C Endpoint &amp; Authentication</div>
        <button class="preset" id="presetBtn">\u26a1 Apply 9router</button>
      </div>
      <div class="divider"></div>
      <div class="grid">
        <label class="full">Base URL <span class="req">*</span>
          <input id="baseUrl" placeholder="https://9router.phongdang.io.vn/v1" autocomplete="off">
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
          <label for="passthroughUnmapped" style="flex-direction:row;color:var(--text);cursor:pointer;">Passthrough unmapped Antigravity models to Google</label>
        </div>
        <div class="full checkbox-row">
          <input type="checkbox" id="mockModelList">
          <label for="mockModelList" style="flex-direction:row;color:var(--text);cursor:pointer;">Expose custom aliases to Antigravity model list</label>
        </div>
      </div>
      <div class="row" style="margin-top:16px;">
        <button id="checkBtn">\uD83D\uDD0D Test &amp; Load Models</button>
        <button class="secondary" id="saveBtn">\uD83D\uDCBE Save Config</button>
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
          <th>Custom Antigravity model name</th>
          <th style="width:5%"></th>
          <th>Upstream model</th>
          <th style="width:140px;">Reasoning</th>
          <th style="width:80px;"></th>
        </tr></thead>
        <tbody id="mappingRows"></tbody>
      </table>
      <div class="new-alias-row" style="margin-top:16px;">
        <input id="newAlias" placeholder="Custom model name shown in Antigravity (e.g. my-gpt-5-high)">
        <input id="newAliasModel" placeholder="Upstream model (e.g. cx/gpt-5.5)">
        <select id="newAliasReasoning" style="max-width:170px;"><option value="">Default reasoning</option><option value="minimal">minimal</option><option value="low">low</option><option value="medium">medium</option><option value="high">high</option></select>
        <button class="secondary" id="addAliasBtn">+ Create custom model</button>
      </div>
      <div style="margin-top:10px;font-size:12px;color:var(--muted);">
        Custom models are saved to <span style="font-family:'JetBrains Mono',monospace;color:var(--accent2);" id="settingsPathHint">settings.json</span>.
        Unmapped built-in Antigravity models passthrough to Google by default. Create a custom model only when you want to route it to 9router/custom upstream.
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
      <div class="grid" style="margin-bottom:14px;">
        <label class="full">Sudo Password
          <div class="input-wrap">
            <input id="sudoPassword" type="password" autocomplete="off" placeholder="Required on macOS/Linux">
            <button class="eye-btn" id="sudoEyeBtn" title="Toggle visibility">\uD83D\uDC41</button>
          </div>
        </label>
      </div>
      <div class="row" style="margin-bottom:14px;">
        <button id="startProxyBtn">Start Proxy</button>
        <button class="secondary" id="stopProxyBtn">Stop Proxy</button>
        <button id="applyDnsBtn">\uD83D\uDEE1 Apply DNS &amp; Cert</button>
        <button class="secondary" id="applyTrustBtn">Apply Antigravity Trust</button>
        <button class="secondary" id="removeDnsBtn">\u2715 Remove DNS</button>
        <button class="secondary" id="enableAutoStartBtn">Enable Auto Start</button>
        <button class="secondary" id="disableAutoStartBtn">Disable Auto Start</button>
      </div>
      <div id="systemStatus" class="status" style="margin-bottom:14px;display:none;"></div>
      <div class="status-grid">
        <div class="stat-card"><div class="stat-label">Proxy Listener</div><div class="stat-value neutral" id="s-proxy">\u2014</div></div>
        <div class="stat-card"><div class="stat-label">DNS Redirect</div><div class="stat-value neutral" id="s-dns">\u2014</div></div>
        <div class="stat-card"><div class="stat-label">Certificate</div><div class="stat-value neutral" id="s-cert">\u2014</div></div>
        <div class="stat-card"><div class="stat-label">Cert Trusted</div><div class="stat-value neutral" id="s-trust">\u2014</div></div>
        <div class="stat-card"><div class="stat-label">Antigravity Trust</div><div class="stat-value neutral" id="s-node-trust">\u2014</div></div>
        <div class="stat-card"><div class="stat-label">Redirect IP</div><div class="stat-value neutral" id="s-ip">\u2014</div></div>
        <div class="stat-card"><div class="stat-label">Mapped Models</div><div class="stat-value neutral" id="s-models">\u2014</div></div>
        <div class="stat-card"><div class="stat-label">Router URL</div><div class="stat-value neutral" style="font-size:11px;word-break:break-all;" id="s-router">\u2014</div></div>
        <div class="stat-card"><div class="stat-label">Auto Start</div><div class="stat-value neutral" id="s-autostart">\u2014</div></div>
      </div>
    </section>
  </main>
  <script>
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
    function switchTab(tab) {
      document.querySelectorAll('.tab-btn').forEach((btn) => {
        btn.classList.toggle('active', btn.dataset.tab === tab);
      });
      document.querySelectorAll('.tab-panel').forEach((panel) => {
        panel.classList.toggle('active', panel.dataset.panel === tab);
      });
    }
    async function api(path, opts = {}) {
      const res = await fetch(path, { ...opts, headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) } });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Request failed');
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
    function renderMappings() {
      const map = (state.config && state.config.modelMap) || {};
      const aliases = Array.from(new Set(Object.keys(map).filter(Boolean)));
      $('mappingCount').textContent = aliases.length + ' custom' + (aliases.length !== 1 ? ' models' : ' model');
      if (aliases.length === 0) {
        $('mappingRows').innerHTML = '<tr class="empty-row"><td colspan="5">No custom models yet. Built-in Antigravity models will passthrough to Google unless you create an alias here.</td></tr>';
        return;
      }
      $('mappingRows').innerHTML = aliases.map(alias => {
        const entry = map[alias] || '';
        return '<tr data-alias="' + esc(alias) + '">' +
        '<td class="alias-cell">' + esc(alias) + '</td>' +
        '<td class="arrow-cell">\u2192</td>' +
        '<td class="model-cell">' + makeModelCell(alias, mappingModelValue(entry)) + '</td>' +
        '<td class="reasoning-cell">' + makeReasoningCell(mappingReasoningValue(entry)) + '</td>' +
        '<td><button class="danger" data-remove="' + esc(alias) + '">\u2715 Remove</button></td>' +
        '</tr>';
      }).join('');
      document.querySelectorAll('[data-remove]').forEach(btn => {
        btn.addEventListener('click', () => {
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
      renderMappings();
      loadStatus();
    }
    async function checkKey() {
      $('checkBtn').disabled = true;
      showStatus('Testing endpoint\u2026', 'loading');
      try {
        const result = await api('/api/check-key', { method: 'POST', body: JSON.stringify(readForm()) });
        state.models = result.models;
        showStatus('\u2713 Loaded ' + result.models.length + ' models from ' + result.modelsUrl, 'ok');
        if (state.config) state.config.modelMap = readMappings();
        renderMappings();
      } catch (e) {
        showStatus('\u2717 ' + e.message, 'err');
      } finally { $('checkBtn').disabled = false; }
    }
    async function save() {
      $('saveBtn').disabled = true;
      try {
        const result = await api('/api/config', { method: 'PUT', body: JSON.stringify(readForm()) });
        state.config = result.config;
        showStatus('\u2713 Config saved successfully', 'ok');
        renderMappings();
      } catch (e) {
        showStatus('\u2717 ' + e.message, 'err');
      } finally { $('saveBtn').disabled = false; }
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
    function setSystemButtons(disabled) {
      $('startProxyBtn').disabled = disabled;
      $('stopProxyBtn').disabled = disabled;
      $('applyDnsBtn').disabled = disabled;
      $('applyTrustBtn').disabled = disabled;
      $('removeDnsBtn').disabled = disabled;
      $('enableAutoStartBtn').disabled = disabled;
      $('disableAutoStartBtn').disabled = disabled;
    }
    async function startProxy() {
      setSystemButtons(true);
      showSystemStatus('Starting proxy on port 443\u2026', 'loading');
      try {
        const result = await api('/api/start-proxy', {
          method: 'POST',
          body: JSON.stringify({ sudoPassword: $('sudoPassword').value })
        });
        showSystemStatus(result.alreadyRunning ? '\u2713 Proxy already running' : '\u2713 Proxy started on port 443', 'ok');
        loadStatus();
      } catch (e) {
        showSystemStatus('\u2717 ' + e.message, 'err');
      } finally {
        $('sudoPassword').value = '';
        setSystemButtons(false);
      }
    }
    async function stopProxy() {
      setSystemButtons(true);
      showSystemStatus('Stopping proxy\u2026', 'loading');
      try {
        const result = await api('/api/stop-proxy', {
          method: 'POST',
          body: JSON.stringify({ sudoPassword: $('sudoPassword').value })
        });
        showSystemStatus(result.stopped ? '\u2713 Proxy stopped' : '\u2713 Proxy was not running', 'ok');
        loadStatus();
      } catch (e) {
        showSystemStatus('\u2717 ' + e.message, 'err');
      } finally {
        $('sudoPassword').value = '';
        setSystemButtons(false);
      }
    }
    async function applyDns() {
      setSystemButtons(true);
      showSystemStatus('Applying DNS and certificate\u2026', 'loading');
      try {
        const result = await api('/api/apply-dns', {
          method: 'POST',
          body: JSON.stringify({ sudoPassword: $('sudoPassword').value })
        });
        const dnsText = result.dns.added ? 'DNS added' : 'DNS already active';
        const certText = result.cert.installed ? 'cert trusted' : 'cert already trusted';
        const trustText = result.nodeTrust && result.nodeTrust.applied ? ', Antigravity trust active' : '';
        showSystemStatus('\u2713 ' + dnsText + ', ' + certText + trustText, 'ok');
        loadStatus();
      } catch (e) {
        showSystemStatus('\u2717 ' + e.message, 'err');
      } finally {
        $('sudoPassword').value = '';
        setSystemButtons(false);
      }
    }
    async function applyTrust() {
      setSystemButtons(true);
      showSystemStatus('Applying Antigravity Node trust\u2026', 'loading');
      try {
        const result = await api('/api/apply-app-trust', { method: 'POST', body: JSON.stringify({}) });
        showSystemStatus(result.nodeTrust.restartRequired ? '\u2713 Antigravity trust active. Restart Antigravity to reload models.' : '\u2713 Antigravity trust active.', 'ok');
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
          body: JSON.stringify({ sudoPassword: $('sudoPassword').value })
        });
        showSystemStatus(result.dns.removed ? '\u2713 DNS removed' : '\u2713 DNS was not active', 'ok');
        loadStatus();
      } catch (e) {
        showSystemStatus('\u2717 ' + e.message, 'err');
      } finally {
        $('sudoPassword').value = '';
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
    $('saveBtn').addEventListener('click', save);
    $('refreshStatusBtn').addEventListener('click', loadStatus);
    $('startProxyBtn').addEventListener('click', startProxy);
    $('stopProxyBtn').addEventListener('click', stopProxy);
    $('applyDnsBtn').addEventListener('click', applyDns);
    $('applyTrustBtn').addEventListener('click', applyTrust);
    $('removeDnsBtn').addEventListener('click', removeDns);
    $('enableAutoStartBtn').addEventListener('click', enableAutoStartUi);
    $('disableAutoStartBtn').addEventListener('click', disableAutoStartUi);
    $('eyeBtn').addEventListener('click', () => {
      const inp = $('apiKey');
      inp.type = inp.type === 'password' ? 'text' : 'password';
    });
    $('sudoEyeBtn').addEventListener('click', () => {
      const inp = $('sudoPassword');
      inp.type = inp.type === 'password' ? 'text' : 'password';
    });
    $('presetBtn').addEventListener('click', () => {
      const preset = state.presets.router9 || {};
      $('baseUrl').value = preset.baseUrl || 'https://9router.phongdang.io.vn/v1';
      $('modelPrefix').value = preset.modelPrefix || 'cx/';
      applyModelToAliases(preset.model || 'cx/gpt-5.5');
      if ($('apiKey').value.trim()) checkKey();
      else showStatus('9router preset applied. Enter API key, then test and load models.', 'warn');
    });
    $('addAliasBtn').addEventListener('click', () => {
      const alias = $('newAlias').value.trim();
      if (!alias) return;
      if (state.config) state.config.modelMap = readMappings();
      else state.config = { modelMap: {} };
      const upstream = $('newAliasModel').value.trim() || PRESET_9ROUTER_MODEL;
      const reasoning = $('newAliasReasoning').value || '';
      state.config.modelMap[alias] = reasoning ? { model: upstream, reasoning_effort: reasoning } : upstream;
      if (!state.aliases.includes(alias)) state.aliases.push(alias);
      $('newAlias').value = '';
      $('newAliasModel').value = '';
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
    try {
      const url = new URL(req.url, `http://${req.headers.host || "127.0.0.1"}`);

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
        sendJson(res, 200, { config: next });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/check-key") {
        const body = await readRequestJson(req);
        const routerUrl = String(body.routerUrl || readConfig().routerUrl || "").trim();
        const apiKey = String(body.apiKey || "");
        if (!routerUrl) throw new Error("Missing endpoint");
        const result = await fetchAvailableModels(routerUrl, apiKey);
        sendJson(res, 200, result);
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/start-proxy") {
        const body = await readRequestJson(req);
        const cfg = readConfig();
        const sudoPassword = String(body.sudoPassword || "");
        const result = await startProxyDetached({
          sudoPassword,
          port: Number(cfg.port || options.port || 443),
          targetHost: primaryTargetHost(cfg),
        });
        sendJson(res, 200, result);
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
        sendJson(res, 200, result);
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/apply-dns") {
        const body = await readRequestJson(req);
        const cfg = readConfig();
        const targetHosts = targetHostsFrom(cfg);
        const targetHost = targetHosts[0];
        const sudoPassword = String(body.sudoPassword || "");
        if (!IS_WIN && !isRoot() && !sudoPassword) throw new Error("Missing sudo password");
        const cert = await generateCert(targetHosts, { force: false });
        const certResult = await installCert(cert.cert, targetHost, sudoPassword);
        const nodeTrust = await applyAntigravityNodeTrust(cert.cert);
        const dnsResult = await addDNSEntries({
          targetHosts,
          remoteHost: cfg.remoteHost || options.remoteHost,
          remoteIp: cfg.remoteIp || options.remoteIp,
          sudoPassword,
        });
        sendJson(res, 200, { cert: certResult, dns: dnsResult, nodeTrust });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/apply-app-trust") {
        const cfg = readConfig();
        const targetHosts = targetHostsFrom(cfg);
        const cert = await generateCert(targetHosts, { force: false });
        const nodeTrust = await applyAntigravityNodeTrust(cert.cert);
        sendJson(res, 200, { nodeTrust });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/remove-dns") {
        const body = await readRequestJson(req);
        const cfg = readConfig();
        const sudoPassword = String(body.sudoPassword || "");
        if (!IS_WIN && !isRoot() && !sudoPassword) throw new Error("Missing sudo password");
        const dnsResult = await removeDNSEntries({
          targetHosts: targetHostsFrom(cfg),
          sudoPassword,
        });
        sendJson(res, 200, { dns: dnsResult });
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/autostart") {
        sendJson(res, 200, await autoStartStatus());
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/autostart/enable") {
        sendJson(res, 200, await enableAutoStart());
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/autostart/disable") {
        sendJson(res, 200, await disableAutoStart());
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
      sendJson(res, 500, { error: error.message || String(error) });
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(uiPort, "127.0.0.1", resolve);
  });

  const url = `http://127.0.0.1:${uiPort}/`;
  console.log(`GUI ready at ${url}`);
  if (!options.noOpen) {
    try { openBrowser(url); } catch (error) { console.error(`Open browser failed: ${error.message}`); }
  }

  process.on("SIGTERM", () => { server.close(() => process.exit(0)); });
  process.on("SIGINT", () => { server.close(() => process.exit(0)); });
}

function execPromise(command) {
  return new Promise((resolve, reject) => {
    exec(command, (error, stdout, stderr) => {
      if (error) reject(new Error(stderr || error.message));
      else resolve(stdout);
    });
  });
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function execWithSudo(command, password) {
  if (isRoot()) return execPromise(command);
  if (!password) return Promise.reject(new Error("Missing sudo password"));

  return new Promise((resolve, reject) => {
    const child = spawn("sudo", ["-S", "sh", "-c", command], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });

    child.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr || `Exit code ${code}`));
    });

    child.stdin.write(`${password}\n`);
    child.stdin.end();
  });
}

function execPowerShell(script, { elevated = false } = {}) {
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  const command = elevated
    ? `powershell -NoProfile -Command "Start-Process -FilePath powershell.exe -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-EncodedCommand','${encoded}') -Verb RunAs -Wait"`
    : `powershell -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${encoded}`;
  return new Promise((resolve, reject) => {
    exec(command, (error, stdout, stderr) => {
      if (error) reject(new Error(`Elevated command failed: ${error.message}\n${stderr}`));
      else resolve(stdout);
    });
  });
}

function certDir() {
  return path.join(appDir(), "cert");
}

function certPaths() {
  const dir = certDir();
  return {
    dir,
    keyPath: path.join(dir, "server.key"),
    certPath: path.join(dir, "server.crt"),
  };
}

function certExists() {
  const { keyPath, certPath } = certPaths();
  return fs.existsSync(keyPath) && fs.existsSync(certPath);
}

function certCoversHosts(certPath, targetHosts) {
  try {
    const cert = new crypto.X509Certificate(fs.readFileSync(certPath));
    const san = cert.subjectAltName || "";
    return targetHosts.every((host) => san.includes(`DNS:${host}`));
  } catch {
    return false;
  }
}

function getCertFingerprint(certPath) {
  const pem = fs.readFileSync(certPath, "utf-8");
  const der = Buffer.from(pem.replace(/-----[^-]+-----/g, "").replace(/\s/g, ""), "base64");
  return crypto.createHash("sha1").update(der).digest("hex").toUpperCase().match(/.{2}/g).join(":");
}

function getPemFingerprints(filePath) {
  try {
    const pem = fs.readFileSync(filePath, "utf-8");
    const blocks = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) || [];
    return blocks.map((block) => {
      const cert = new crypto.X509Certificate(block);
      return cert.fingerprint.replace(/:/g, "").toUpperCase();
    });
  } catch {
    return [];
  }
}

async function getLaunchctlEnv(name) {
  if (!IS_MAC) return "";
  try {
    return (await execPromise(`launchctl getenv ${shellQuote(name)}`)).trim();
  } catch {
    return "";
  }
}

async function checkAntigravityNodeTrust(certPath) {
  if (!IS_MAC) {
    return { supported: false, applied: true, value: "" };
  }

  const value = await getLaunchctlEnv("NODE_EXTRA_CA_CERTS");
  const fingerprint = getCertFingerprint(certPath).replace(/:/g, "").toUpperCase();
  const applied = Boolean(value && getPemFingerprints(value).includes(fingerprint));
  return { supported: true, applied, value };
}

async function applyAntigravityNodeTrust(certPath) {
  if (!IS_MAC) {
    return { supported: false, applied: false, restartRequired: false };
  }

  const currentValue = await getLaunchctlEnv("NODE_EXTRA_CA_CERTS");
  const status = await checkAntigravityNodeTrust(certPath);
  let nextValue = currentValue || certPath;

  if (currentValue && !status.applied) {
    const bundlePath = path.join(certDir(), "node-extra-ca-bundle.crt");
    const certPem = fs.readFileSync(certPath, "utf-8").trim();
    const existingPem = fs.existsSync(currentValue) ? fs.readFileSync(currentValue, "utf-8").trim() : "";
    fs.writeFileSync(bundlePath, `${existingPem ? `${existingPem}\n\n` : ""}${certPem}\n`);
    nextValue = bundlePath;
  }

  await execPromise(`launchctl setenv NODE_EXTRA_CA_CERTS ${shellQuote(nextValue)}`);
  const nextStatus = await checkAntigravityNodeTrust(certPath);
  if (!nextStatus.applied) throw new Error("Failed to apply NODE_EXTRA_CA_CERTS via launchctl");

  return {
    supported: true,
    applied: true,
    changed: nextValue !== currentValue,
    value: nextValue,
    restartRequired: true,
  };
}

async function isPortListening(port) {
  if (IS_WIN) {
    try {
      const output = await execPowerShell(
        `Get-NetTCPConnection -LocalPort ${Number(port)} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1`
      );
      return output.trim().length > 0;
    } catch {
      return false;
    }
  }

  try {
    const output = await execPromise(`lsof -nP -iTCP:${Number(port)} -sTCP:LISTEN -t`);
    return output.trim().length > 0;
  } catch {
    return false;
  }
}

function checkProxyHealth(port, targetHost = DEFAULT_TARGET) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const req = https.request({
      hostname: "127.0.0.1",
      port: Number(port),
      path: "/_mitm_health",
      method: "GET",
      headers: { host: targetHost },
      servername: targetHost,
      rejectUnauthorized: false,
      timeout: 2000,
    }, (res) => {
      res.resume();
      res.on("end", () => done(res.statusCode === 200));
    });
    req.on("timeout", () => {
      req.destroy();
      done(false);
    });
    req.on("error", () => done(false));
    req.end();
  });
}

async function waitForProxyHealth(port, targetHost = DEFAULT_TARGET, attempts = 10) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await checkProxyHealth(port, targetHost)) return true;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

async function startProxyDetached({ sudoPassword, port, targetHost = DEFAULT_TARGET }) {
  if (await checkProxyHealth(port, targetHost)) {
    return { started: false, alreadyRunning: true, port };
  }

  if (await isPortListening(port)) {
    throw new Error(`Port ${port} is already in use by another service`);
  }

  if (!IS_WIN && !isRoot() && !sudoPassword) throw new Error("Missing sudo password");

  const logPath = path.join(os.tmpdir(), "mitm-antigravity-proxy.log");
  const nodeCommand = process.pkg
    ? shellQuote(process.execPath)
    : `${shellQuote(process.execPath)} ${shellQuote(__filename)}`;

  if (IS_WIN) {
    await execPowerShell(`Start-Process -FilePath '${process.execPath.replace(/'/g, "''")}' -ArgumentList 'start --skip-setup' -WorkingDirectory '${runtimeDir().replace(/'/g, "''")}'`, { elevated: true });
  } else if (IS_MAC) {
    const label = "com.phongdang.mitm-antigravity.proxy";
    await execPromise(`launchctl remove ${shellQuote(label)} >/dev/null 2>&1 || true`).catch(() => { });
    const innerCommand = [
      `cd ${shellQuote(runtimeDir())}`,
      `HOME=${shellQuote(os.homedir())} exec ${nodeCommand} start --skip-setup`,
    ].join(" && ");
    const command = `nohup /bin/sh -lc ${shellQuote(innerCommand)} >> ${shellQuote(logPath)} 2>&1 < /dev/null &`;
    await execWithSudo(command, sudoPassword);
  } else {
    const innerCommand = [
      `cd ${shellQuote(runtimeDir())}`,
      `HOME=${shellQuote(os.homedir())} exec ${nodeCommand} start --skip-setup`,
    ].join(" && ");
    const command = `nohup sh -c ${shellQuote(innerCommand)} >> ${shellQuote(logPath)} 2>&1 < /dev/null &`;
    await execWithSudo(command, sudoPassword);
  }

  if (!(await waitForProxyHealth(port, targetHost))) {
    throw new Error(`Proxy did not start on port ${port}. Check ${logPath}`);
  }

  return { started: true, alreadyRunning: false, port, logPath };
}

async function pidsListeningOnPortUnix(port) {
  try {
    const { stdout } = await execPromise(`lsof -ti tcp:${Number(port)} -sTCP:LISTEN 2>/dev/null || true`);
    return Array.from(new Set(stdout.split(/\s+/).map((pid) => pid.trim()).filter(Boolean)));
  } catch (_) {
    return [];
  }
}

async function pidsListeningOnPortWindows(port) {
  try {
    const { stdout } = await execPowerShell(`Get-NetTCPConnection -LocalPort ${Number(port)} -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique`);
    return Array.from(new Set(stdout.split(/\s+/).map((pid) => pid.trim()).filter(Boolean)));
  } catch (_) {
    return [];
  }
}

async function stopProxyByPort({ sudoPassword, port, targetHost = DEFAULT_TARGET }) {
  if (!(await checkProxyHealth(port, targetHost)) && !(await isPortListening(port))) {
    return { stopped: false, wasRunning: false, port };
  }

  if (!IS_WIN && !isRoot() && !sudoPassword) throw new Error("Missing sudo password");

  if (IS_WIN) {
    const pids = await pidsListeningOnPortWindows(port);
    if (pids.length === 0) return { stopped: false, wasRunning: false, port };
    await execPowerShell(pids.map((pid) => `Stop-Process -Id ${pid} -Force`).join("; "), { elevated: true });
  } else {
    const pids = await pidsListeningOnPortUnix(port);
    if (pids.length === 0) return { stopped: false, wasRunning: false, port };
    await execWithSudo(`kill ${pids.map((pid) => shellQuote(pid)).join(" ")}`, sudoPassword);
  }

  for (let i = 0; i < 10; i += 1) {
    if (!(await isPortListening(port))) return { stopped: true, wasRunning: true, port };
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  return { stopped: true, wasRunning: true, port, warning: `Port ${port} may still be shutting down` };
}

function autoStartLabel() {
  return "io.phongdang.mitm-antigravity.proxy";
}

function autoStartName() {
  return "MITM Antigravity Proxy";
}

function autoStartPath() {
  if (IS_MAC) return path.join(os.homedir(), "Library", "LaunchAgents", `${autoStartLabel()}.plist`);
  if (IS_WIN) return autoStartName();
  return path.join(appDir(), "mitm-antigravity.service");
}

function autoStartCommandParts() {
  if (process.pkg) return [process.execPath, "start", "--skip-setup"];
  return [process.execPath, __filename, "start", "--skip-setup"];
}

function autoStartShellCommand() {
  return autoStartCommandParts().map((part) => shellQuote(part)).join(" ");
}

async function isAutoStartEnabled() {
  if (IS_MAC) return fs.existsSync(autoStartPath());
  if (IS_WIN) {
    try {
      await execPowerShell(`Get-ScheduledTask -TaskName '${autoStartName().replace(/'/g, "''")}' -ErrorAction Stop | Out-Null`);
      return true;
    } catch (_) {
      return false;
    }
  }
  return fs.existsSync(autoStartPath());
}

async function autoStartStatus() {
  return {
    supported: IS_MAC || IS_WIN || !IS_WIN,
    enabled: await isAutoStartEnabled(),
    method: IS_MAC ? "macOS LaunchAgent" : (IS_WIN ? "Windows Scheduled Task" : "Linux user systemd"),
    path: autoStartPath(),
  };
}

async function enableAutoStart() {
  ensureAppDir();
  const commandParts = autoStartCommandParts();
  if (IS_MAC) {
    const plistPath = autoStartPath();
    fs.mkdirSync(path.dirname(plistPath), { recursive: true });
    const argsXml = commandParts.map((part) => `    <string>${xmlEscape(part)}</string>`).join("\n");
    const plist = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n<dict>\n  <key>Label</key>\n  <string>${xmlEscape(autoStartLabel())}</string>\n  <key>ProgramArguments</key>\n  <array>\n${argsXml}\n  </array>\n  <key>WorkingDirectory</key>\n  <string>${xmlEscape(runtimeDir())}</string>\n  <key>RunAtLoad</key>\n  <true/>\n  <key>StandardOutPath</key>\n  <string>${xmlEscape(path.join(appDir(), "autostart.log"))}</string>\n  <key>StandardErrorPath</key>\n  <string>${xmlEscape(path.join(appDir(), "autostart.err.log"))}</string>\n</dict>\n</plist>\n`;
    fs.writeFileSync(plistPath, plist);
    await execPromise(`launchctl unload ${shellQuote(plistPath)} >/dev/null 2>&1 || true`);
    await execPromise(`launchctl load ${shellQuote(plistPath)}`);
    return { enabled: true, method: "macOS LaunchAgent", path: plistPath };
  }

  if (IS_WIN) {
    const command = commandParts[0];
    const args = commandParts.slice(1).join(" ");
    await execPowerShell(`$action = New-ScheduledTaskAction -Execute '${command.replace(/'/g, "''")}' -Argument '${args.replace(/'/g, "''")}' -WorkingDirectory '${runtimeDir().replace(/'/g, "''")}'; $trigger = New-ScheduledTaskTrigger -AtLogOn; Register-ScheduledTask -TaskName '${autoStartName().replace(/'/g, "''")}' -Action $action -Trigger $trigger -Description 'Start MITM Antigravity proxy after login' -Force | Out-Null`, { elevated: true });
    return { enabled: true, method: "Windows Scheduled Task", path: autoStartName() };
  }

  const servicePath = autoStartPath();
  const service = `[Unit]\nDescription=MITM Antigravity Proxy\nAfter=network-online.target\n\n[Service]\nType=simple\nWorkingDirectory=${runtimeDir()}\nExecStart=${autoStartShellCommand()}\nRestart=on-failure\nRestartSec=5\n\n[Install]\nWantedBy=default.target\n`;
  fs.writeFileSync(servicePath, service);
  await execPromise(`mkdir -p ${shellQuote(path.join(os.homedir(), ".config", "systemd", "user"))} && cp ${shellQuote(servicePath)} ${shellQuote(path.join(os.homedir(), ".config", "systemd", "user", "mitm-antigravity.service"))} && systemctl --user daemon-reload && systemctl --user enable mitm-antigravity.service`);
  return { enabled: true, method: "Linux user systemd", path: servicePath };
}

async function disableAutoStart() {
  if (IS_MAC) {
    const plistPath = autoStartPath();
    await execPromise(`launchctl unload ${shellQuote(plistPath)} >/dev/null 2>&1 || true`).catch(() => { });
    if (fs.existsSync(plistPath)) fs.unlinkSync(plistPath);
    return { enabled: false, method: "macOS LaunchAgent", path: plistPath };
  }

  if (IS_WIN) {
    await execPowerShell(`Unregister-ScheduledTask -TaskName '${autoStartName().replace(/'/g, "''")}' -Confirm:$false -ErrorAction SilentlyContinue`, { elevated: true });
    return { enabled: false, method: "Windows Scheduled Task", path: autoStartName() };
  }

  await execPromise(`systemctl --user disable --now mitm-antigravity.service >/dev/null 2>&1 || true`).catch(() => { });
  const systemdPath = path.join(os.homedir(), ".config", "systemd", "user", "mitm-antigravity.service");
  if (fs.existsSync(systemdPath)) fs.unlinkSync(systemdPath);
  if (fs.existsSync(autoStartPath())) fs.unlinkSync(autoStartPath());
  return { enabled: false, method: "Linux user systemd", path: autoStartPath() };
}

function xmlEscape(value) {
  return String(value || "").replace(/[<>&"']/g, (char) => ({
    "<": "&lt;",
    ">": "&gt;",
    "&": "&amp;",
    "\"": "&quot;",
    "'": "&apos;",
  }[char]));
}

async function generateCert(targetHostOrHosts, { force = false } = {}) {
  const targetHosts = targetHostsFrom({ targetHosts: normalizeTargetHosts(targetHostOrHosts) });
  const targetHost = targetHosts[0];
  const { dir, keyPath, certPath } = certPaths();

  if (!force && fs.existsSync(keyPath) && fs.existsSync(certPath) && certCoversHosts(certPath, targetHosts)) {
    return { key: keyPath, cert: certPath, created: false };
  }

  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const selfsigned = require("selfsigned");
  const attrs = [{ name: "commonName", value: targetHost }];
  const notAfter = new Date();
  notAfter.setFullYear(notAfter.getFullYear() + 1);

  const pems = await selfsigned.generate(attrs, {
    keySize: 2048,
    algorithm: "sha256",
    notAfterDate: notAfter,
    extensions: [
      { name: "subjectAltName", altNames: targetHosts.map((host) => ({ type: 2, value: host })) },
    ],
  });

  fs.writeFileSync(keyPath, pems.private);
  fs.writeFileSync(certPath, pems.cert);

  return { key: keyPath, cert: certPath, created: true };
}

async function checkCertInstalled(certPath, targetHost) {
  if (IS_WIN) {
    try {
      const fingerprint = getCertFingerprint(certPath).replace(/:/g, "").toUpperCase();
      const output = await execPowerShell(
        `Get-ChildItem Cert:\\LocalMachine\\Root | Where-Object { $_.Thumbprint -eq '${fingerprint}' } | Select-Object -First 1`
      );
      return output.trim().length > 0;
    } catch {
      return false;
    }
  }

  if (!IS_MAC) return false;

  try {
    const fingerprint = getCertFingerprint(certPath).replace(/:/g, "");
    const keychains = [
      "/Library/Keychains/System.keychain",
      path.join(os.homedir(), "Library", "Keychains", "login.keychain-db"),
    ];
    for (const keychain of keychains) {
      try {
        await execPromise(`security find-certificate -a -Z ${shellQuote(keychain)} | grep -i "${fingerprint}"`);
        return true;
      } catch {
        // Continue checking other keychains.
      }
    }
    return false;
  } catch {
    return false;
  }
}

async function installCert(certPath, targetHost, sudoPassword) {
  const isInstalled = await checkCertInstalled(certPath, targetHost);
  if (isInstalled) return { installed: false };

  if (IS_WIN) {
    await execPowerShell(`certutil -addstore Root '${certPath.replace(/'/g, "''")}'`, { elevated: true });
  } else {
    if (!IS_MAC) throw new Error("Certificate install is only implemented for macOS and Windows.");
    const command = `security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain ${shellQuote(certPath)}`;
    await execWithSudo(command, sudoPassword);
  }

  return { installed: true };
}

async function uninstallCert(certPath, targetHost, sudoPassword) {
  const isInstalled = await checkCertInstalled(certPath, targetHost);
  if (!isInstalled) return { removed: false };

  if (IS_WIN) {
    const fingerprint = getCertFingerprint(certPath).replace(/:/g, "").toUpperCase();
    await execPowerShell(`certutil -delstore Root '${fingerprint}'`, { elevated: true });
  } else {
    if (!IS_MAC) throw new Error("Certificate uninstall is only implemented for macOS and Windows.");
    const fingerprint = getCertFingerprint(certPath).replace(/:/g, "");
    const command = `security delete-certificate -Z "${fingerprint}" /Library/Keychains/System.keychain`;
    await execWithSudo(command, sudoPassword);
  }

  return { removed: true };
}

function checkDNSEntry(targetHost) {
  try {
    const hostsContent = fs.readFileSync(HOSTS_FILE, "utf8");
    return hostsContent.split(/\r?\n/).some((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) return false;
      return trimmed.split(/\s+/).slice(1).includes(targetHost);
    });
  } catch {
    return false;
  }
}

function getRedirectIP(targetHost) {
  try {
    const hostsContent = fs.readFileSync(HOSTS_FILE, "utf8");
    const lines = hostsContent.split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const parts = trimmed.split(/\s+/);
      if (!parts.slice(1).includes(targetHost)) continue;
      if (parts.length >= 2) return parts[0];
    }
  } catch {
    return null;
  }
  return null;
}

function getRedirectIPs(targetHost) {
  try {
    const hostsContent = fs.readFileSync(HOSTS_FILE, "utf8");
    const ips = [];
    for (const line of hostsContent.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const parts = trimmed.split(/\s+/);
      if (parts.slice(1).includes(targetHost) && parts[0]) ips.push(parts[0]);
    }
    return Array.from(new Set(ips));
  } catch {
    return [];
  }
}

function checkHostsEntry(targetHost, ip) {
  try {
    const hostsContent = fs.readFileSync(HOSTS_FILE, "utf8");
    return hostsContent.split(/\r?\n/).some((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) return false;
      const parts = trimmed.split(/\s+/);
      return parts[0] === ip && parts.slice(1).includes(targetHost);
    });
  } catch {
    return false;
  }
}

function dnsEntriesForHosts(targetHosts, ip) {
  const entries = targetHosts.map((targetHost) => ({ ip, targetHost }));
  if (ip === "127.0.0.1" || ip === "0.0.0.0") {
    entries.push(...targetHosts.map((targetHost) => ({ ip: "::1", targetHost })));
  }
  return entries;
}

function dnsConfiguredForHosts(targetHosts, ip) {
  return dnsEntriesForHosts(targetHosts, ip).every((entry) => checkHostsEntry(entry.targetHost, entry.ip));
}

function resolveRemoteIP(remoteHost) {
  const resolver = new dns.Resolver();
  resolver.setServers(["8.8.8.8"]);
  const resolve4 = promisify(resolver.resolve4.bind(resolver));
  return resolve4(remoteHost);
}

async function addDNSEntry({ targetHost, remoteHost, remoteIp, sudoPassword }) {
  if (checkDNSEntry(targetHost)) {
    return { added: false, ip: getRedirectIP(targetHost) || null };
  }

  let ip = remoteIp;
  if (!ip) {
    const addresses = await resolveRemoteIP(remoteHost);
    ip = addresses[0];
  }

  const entry = `${ip} ${targetHost}`;

  if (IS_WIN) {
    await execPowerShell(`Add-Content -Path '${HOSTS_FILE.replace(/'/g, "''")}' -Value '${entry.replace(/'/g, "''")}'`, { elevated: true });
    await execPowerShell("ipconfig /flushdns", { elevated: true });
  } else {
    await execWithSudo(`printf '\\n%s\\n' ${shellQuote(entry)} >> ${shellQuote(HOSTS_FILE)}`, sudoPassword);
    await flushDns(sudoPassword);
  }

  return { added: true, ip };
}

async function addDNSEntries({ targetHosts, remoteHost, remoteIp, sudoPassword }) {
  if (!IS_WIN) {
    let ip = remoteIp;
    if (!ip) {
      const addresses = await resolveRemoteIP(remoteHost);
      ip = addresses[0];
    }

    const entries = dnsEntriesForHosts(targetHosts, ip);
    const activeBefore = entries.every((entry) => checkHostsEntry(entry.targetHost, entry.ip));
    const block = [
      "# BEGIN ANTIGRAVITY_PROXY",
      ...entries.map((entry) => `${entry.ip} ${entry.targetHost}`),
      "# END ANTIGRAVITY_PROXY",
    ].join("\n");
    const hostList = targetHosts.join(",");
    const script = [
      "set -e",
      "tmp=$(mktemp)",
      `awk -v hosts=${shellQuote(hostList)} 'BEGIN { n=split(hosts, h, ","); skip=0 }`,
      `$0 == "# BEGIN ANTIGRAVITY_PROXY" { skip=1; next }`,
      `$0 == "# END ANTIGRAVITY_PROXY" { skip=0; next }`,
      `skip { next }`,
      `{ for (i=1; i<=n; i++) if (h[i] != "" && index($0, h[i]) > 0) next; print }' ${shellQuote(HOSTS_FILE)} > "$tmp"`,
      `printf '\\n%s\\n' ${shellQuote(block)} >> "$tmp"`,
      `cat "$tmp" > ${shellQuote(HOSTS_FILE)}`,
      `rm "$tmp"`,
    ].join("\n");

    await execWithSudo(script, sudoPassword);
    await flushDns(sudoPassword);

    return {
      added: !activeBefore,
      results: entries.map((entry) => ({ targetHost: entry.targetHost, added: !activeBefore, ip: entry.ip })),
    };
  }

  const results = [];
  for (const targetHost of targetHosts) {
    results.push({
      targetHost,
      ...(await addDNSEntry({ targetHost, remoteHost, remoteIp, sudoPassword })),
    });
  }
  return {
    added: results.some((result) => result.added),
    results,
  };
}

async function removeDNSEntry({ targetHost, sudoPassword }) {
  if (!checkDNSEntry(targetHost)) return { removed: false };

  if (IS_WIN) {
    const psScript = `$p='${HOSTS_FILE.replace(/'/g, "''")}'; $h='${targetHost.replace(/'/g, "''")}'; (Get-Content $p) | Where-Object { -not ($_.Trim() -match '^[^#\\s]+\\s+.*\\b' + [regex]::Escape($h) + '\\b') } | Set-Content $p`;
    await execPowerShell(psScript, { elevated: true });
    await execPowerShell("ipconfig /flushdns", { elevated: true });
  } else {
    const script = `tmp=$(mktemp) && awk 'BEGIN{h=${shellQuote(targetHost)}} /^#/ || NF < 2 {print; next} {keep=1; for (i=2;i<=NF;i++) if ($i==h) keep=0; if (keep) print}' ${shellQuote(HOSTS_FILE)} > "$tmp" && cat "$tmp" > ${shellQuote(HOSTS_FILE)} && rm "$tmp"`;
    await execWithSudo(script, sudoPassword);
    await flushDns(sudoPassword);
  }

  return { removed: true };
}

async function removeDNSEntries({ targetHosts, sudoPassword }) {
  if (!IS_WIN) {
    const hadAny = targetHosts.some(checkDNSEntry);
    const hostList = targetHosts.join(",");
    const script = [
      "set -e",
      "tmp=$(mktemp)",
      `awk -v hosts=${shellQuote(hostList)} 'BEGIN { n=split(hosts, h, ","); skip=0 }`,
      `$0 == "# BEGIN ANTIGRAVITY_PROXY" { skip=1; next }`,
      `$0 == "# END ANTIGRAVITY_PROXY" { skip=0; next }`,
      `skip { next }`,
      `{ for (i=1; i<=n; i++) if (h[i] != "" && index($0, h[i]) > 0) next; print }' ${shellQuote(HOSTS_FILE)} > "$tmp"`,
      `cat "$tmp" > ${shellQuote(HOSTS_FILE)}`,
      `rm "$tmp"`,
    ].join("\n");

    await execWithSudo(script, sudoPassword);
    await flushDns(sudoPassword);

    return {
      removed: hadAny,
      results: targetHosts.map((targetHost) => ({ targetHost, removed: hadAny })),
    };
  }

  const results = [];
  for (const targetHost of targetHosts) {
    results.push({
      targetHost,
      ...(await removeDNSEntry({ targetHost, sudoPassword })),
    });
  }
  return {
    removed: results.some((result) => result.removed),
    results,
  };
}

async function flushDns(sudoPassword) {
  if (IS_MAC) {
    await execWithSudo("dscacheutil -flushcache && killall -HUP mDNSResponder || true", sudoPassword);
    return;
  }
  await execWithSudo("systemd-resolve --flush-caches 2>/dev/null || resolvectl flush-caches 2>/dev/null || true", sudoPassword);
}

function collectBodyRaw(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function extractModelFromBody(body) {
  try {
    return JSON.parse(body.toString()).model || null;
  } catch {
    return null;
  }
}

function extractModelFromUrl(url) {
  const match = String(url).match(/\/models\/([^/:?]+):(generateContent|streamGenerateContent)/);
  return match ? decodeURIComponent(match[1]) : null;
}

function getMappedEntry(model, options) {
  if (!model) return null;
  if (options.model) return { model: options.model };
  if (options.modelMap && options.modelMap[model]) return normalizeMappingEntry(options.modelMap[model]);

  if (options.modelMap) {
    const prefixKey = Object.keys(options.modelMap).find((key) => {
      const target = normalizeMappingEntry(options.modelMap[key]);
      return key && target && (model.startsWith(key) || key.startsWith(model));
    });
    if (prefixKey) return normalizeMappingEntry(options.modelMap[prefixKey]);
  }

  try {
    const dbFile = path.join(os.homedir(), ".9router", "db.json");
    const db = JSON.parse(fs.readFileSync(dbFile, "utf-8"));
    const aliases = db.mitmAlias?.antigravity || {};
    if (aliases[model]) return normalizeMappingEntry(aliases[model]);
    const prefixKey = Object.keys(aliases).find((key) => {
      const target = normalizeMappingEntry(aliases[key]);
      return key && target && (model.startsWith(key) || key.startsWith(model));
    });
    return prefixKey ? normalizeMappingEntry(aliases[prefixKey]) : null;
  } catch {
    return null;
  }
}

function getMappedModel(model, options) {
  const entry = getMappedEntry(model, options);
  return entry ? entry.model : null;
}


function modelDisplayName(alias, mappedModel) {
  const names = {
    "gemini-3.1-pro-high": "Gemini 3.1 Pro High",
    "gemini-3.1-pro-low": "Gemini 3.1 Pro Low",
    "gemini-3-flash": "Gemini 3 Flash",
    "claude-sonnet-4-6": "Claude Sonnet 4.6",
    "claude-opus-4-6-thinking": "Claude Opus 4.6 Thinking",
    "gpt-oss-120b-medium": "GPT OSS 120B Medium",
    "gemini-3-pro-high": "Gemini 3 Pro High",
    "gemini-3-pro-low": "Gemini 3 Pro Low",
  };
  const base = names[alias] || alias;
  return mappedModel ? `${base} (${mappedModel})` : base;
}

function buildAntigravityModelList(options) {
  const modelMap = options.modelMap || {};
  const aliases = Array.from(new Set([
    ...Object.keys(modelMap),
    ...(options.mockModelList === false ? ANTIGRAVITY_ALIASES : []),
  ].filter(Boolean)));
  const resetTime = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const models = {};

  for (const alias of aliases) {
    const mappedModel = mappingModel(modelMap[alias]) || getMappedModel(alias, options) || "";
    models[alias] = {
      id: alias,
      name: alias,
      model: alias,
      displayName: modelDisplayName(alias, mappedModel),
      description: mappedModel ? `Routed to ${mappedModel}` : "Routed by MITM Antigravity",
      isInternal: false,
      supportedGenerationMethods: ["generateContent", "streamGenerateContent"],
      quotaInfo: {
        remainingFraction: 1,
        resetTime,
      },
    };
  }

  return { models };
}

function sendAntigravityModelList(res, options) {
  const payload = buildAntigravityModelList(options);
  sendJson(res, 200, payload);
}

function decodeResponseBody(raw, headers = {}) {
  const encoding = String(headers["content-encoding"] || "").toLowerCase();
  if (encoding.includes("gzip")) return zlib.gunzipSync(raw);
  if (encoding.includes("br")) return zlib.brotliDecompressSync(raw);
  if (encoding.includes("deflate")) return zlib.inflateSync(raw);
  return raw;
}

function summarizeAntigravityModelsResponse(raw, headers = {}) {
  try {
    const decoded = decodeResponseBody(raw, headers);
    const data = JSON.parse(decoded.toString("utf8"));
    const modelKeys = data?.models && typeof data.models === "object"
      ? Object.keys(data.models)
      : [];
    const visible = modelKeys.filter((key) => data.models?.[key]?.isInternal !== true);
    const summary = {
      topLevelKeys: data && typeof data === "object" ? Object.keys(data).sort() : [],
      modelCount: modelKeys.length,
      visibleCount: visible.length,
      modelKeys: modelKeys.slice(0, 30),
      visibleKeys: visible.slice(0, 30),
      contentEncoding: headers["content-encoding"] || null,
      hasError: Boolean(data?.error),
      errorCode: data?.error?.code || data?.code || null,
      errorStatus: data?.error?.status || data?.status || null,
    };
    try {
      fs.writeFileSync(path.join(os.tmpdir(), "mitm-antigravity-models-summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
    } catch {
      // Summary file is best-effort debug output.
    }
    return `models=${summary.modelCount} visible=${summary.visibleCount} keys=${summary.visibleKeys.join(",") || summary.modelKeys.join(",") || "-"}`;
  } catch (error) {
    return `unparseable=${error.message}`;
  }
}

function normalizePrefix(prefix) {
  if (!prefix) return "";
  const lowered = String(prefix).toLowerCase();
  if (lowered === "false" || lowered === "0" || lowered === "none" || lowered === "off") return "";
  return prefix.endsWith("/") ? prefix : `${prefix}/`;
}

const ROUTER_STRIP_HEADERS = new Set([
  "host",
  "content-length",
  "connection",
  "transfer-encoding",
  "content-type",
  "authorization",
]);

function buildRouterHeaders(clientHeaders, apiKey) {
  const headers = { "Content-Type": "application/json" };
  for (const [key, value] of Object.entries(clientHeaders || {})) {
    if (ROUTER_STRIP_HEADERS.has(key.toLowerCase())) continue;
    if (Array.isArray(value)) headers[key] = value.join(", ");
    else if (typeof value !== "undefined") headers[key] = String(value);
  }
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  return headers;
}

function shouldBypassIntercept(req) {
  const legacySource = String(req.headers["x-9router-source"] || "").toLowerCase();
  const routerSource = String(req.headers["x-request-source"] || "").toLowerCase();
  return legacySource === "9router" || routerSource === "local";
}

function safeRequestPath(reqUrl) {
  try {
    return new URL(reqUrl, "https://local.invalid").pathname;
  } catch {
    return String(reqUrl || "").split("?")[0];
  }
}

async function retryWithBackoff(fetchFn, options) {
  const maxRetries = Number(options.maxRetries || 0);
  const retryDelay = Number(options.retryDelay || 1000);
  const retryBackoff = Number(options.retryBackoff || 1);
  let lastError;
  let lastResponse;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetchFn();
      lastResponse = response;

      // If response is not ok and it's a 503, retry
      if (!response.ok && (response.status === 503 || response.status === 502 || response.status === 504)) {
        if (attempt < maxRetries) {
          const waitMs = retryDelay * Math.pow(retryBackoff, attempt);
          console.log(`Retry ${attempt + 1}/${maxRetries} after HTTP ${response.status} (waiting ${(waitMs / 1000).toFixed(1)}s)...`);
          await new Promise(resolve => setTimeout(resolve, waitMs));
          continue;
        }
      }

      // Success or non-503 error - return response
      return response;
    } catch (error) {
      lastError = error;
      if (attempt < maxRetries) {
        const waitMs = retryDelay * Math.pow(retryBackoff, attempt);
        console.log(`Retry ${attempt + 1}/${maxRetries} after error (waiting ${(waitMs / 1000).toFixed(1)}s)...`);
        await new Promise(resolve => setTimeout(resolve, waitMs));
      }
    }
  }

  // All retries exhausted - return the last response or throw error
  if (lastResponse) return lastResponse;
  throw lastError || new Error('Max retries exceeded');
}

async function runProxy(options) {
  const targetHosts = targetHostsFrom(options);
  const cert = certPaths();
  const sslOptions = {
    key: fs.readFileSync(cert.keyPath),
    cert: fs.readFileSync(cert.certPath),
  };

  const CHAT_URL_PATTERNS = [":generateContent", ":streamGenerateContent"];

  const cachedTargetIPs = new Map();
  async function resolveTargetIP(targetHost) {
    if (cachedTargetIPs.has(targetHost)) return cachedTargetIPs.get(targetHost);
    const resolver = new dns.Resolver();
    resolver.setServers(["8.8.8.8"]);
    const resolve4 = promisify(resolver.resolve4.bind(resolver));
    const addresses = await resolve4(targetHost);
    cachedTargetIPs.set(targetHost, addresses[0]);
    return addresses[0];
  }

  async function passthrough(req, res, bodyBuffer) {
    const requestHost = String(req.headers.host || "").split(":")[0];
    const targetHost = targetHosts.includes(requestHost) ? requestHost : primaryTargetHost(options);
    const targetIP = await resolveTargetIP(targetHost);
    const requestPath = safeRequestPath(req.url);

    const forwardReq = https.request({
      hostname: targetIP,
      port: 443,
      path: req.url,
      method: req.method,
      headers: { ...req.headers, host: targetHost },
      servername: targetHost,
      rejectUnauthorized: false,
    }, (forwardRes) => {
      if (req.url.includes(":fetchAvailableModels")) {
        const chunks = [];
        forwardRes.on("data", (chunk) => {
          chunks.push(chunk);
          res.write(chunk);
        });
        forwardRes.on("end", () => {
          const raw = Buffer.concat(chunks);
          const modelSummary = summarizeAntigravityModelsResponse(raw, forwardRes.headers);
          console.log(`PASS ${forwardRes.statusCode} ${req.method} ${targetHost}${requestPath} bytes=${raw.length} ${modelSummary}`);
          res.end();
        });
        res.writeHead(forwardRes.statusCode, forwardRes.headers);
        return;
      }

      console.log(`PASS ${forwardRes.statusCode} ${req.method} ${targetHost}${requestPath}`);
      res.writeHead(forwardRes.statusCode, forwardRes.headers);
      forwardRes.pipe(res);
    });

    forwardReq.on("error", (err) => {
      console.error(`Passthrough error: ${err.message}`);
      if (!res.headersSent) res.writeHead(502);
      res.end("Bad Gateway");
    });

    if (bodyBuffer.length > 0) forwardReq.write(bodyBuffer);
    forwardReq.end();
  }

  async function intercept(req, res, bodyBuffer, mappedEntry) {
    try {
      const body = JSON.parse(bodyBuffer.toString());
      const originalModel = body.model;
      if (mappedEntry && mappedEntry.model) body.model = mappedEntry.model;
      if (mappedEntry && mappedEntry.reasoning_effort) body.reasoning_effort = mappedEntry.reasoning_effort;

      const headers = buildRouterHeaders(req.headers, options.apiKey);

      const startTime = Date.now();
      const response = await retryWithBackoff(
        () => fetch(options.routerUrl, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
        }),
        {
          maxRetries: options.maxRetries,
          retryDelay: options.retryDelay,
          retryBackoff: options.retryBackoff,
        }
      );

      if (!response.ok) {
        const errText = await response.text().catch(() => "");
        throw new Error(`Upstream ${response.status}: ${errText}`);
      }

      const contentType = response.headers.get("content-type") || "application/json";
      const responseHeaders = {
        "Content-Type": contentType,
        "Cache-Control": response.headers.get("cache-control") || "no-cache",
      };
      if (contentType.includes("text/event-stream")) {
        responseHeaders.Connection = "keep-alive";
        responseHeaders["X-Accel-Buffering"] = "no";
      }
      res.writeHead(response.status, responseHeaders);

      if (!response.body) {
        res.end(await response.text().catch(() => ""));
        return;
      }

      const reader = response.body.getReader();

      while (true) {
        const { done, value } = await reader.read();
        if (done) { res.end(); break; }
        res.write(Buffer.from(value));
      }

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      const loggedModel = mappedEntry && mappedEntry.model ? mappedEntry.model : originalModel;
      const reasoning = mappedEntry && mappedEntry.reasoning_effort ? ` reasoning_effort=${mappedEntry.reasoning_effort}` : "";
      console.log(`OK ${loggedModel || "unknown"}${reasoning} - ${elapsed}s`);
    } catch (error) {
      console.error(`ERROR ${error.message}`);
      if (!res.headersSent) res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: error.message, type: "mitm_error" } }));
    }
  }

  const server = https.createServer(sslOptions, async (req, res) => {
    const requestUrl = new URL(req.url, `https://${req.headers.host || targetHosts[0]}`);
    if (req.method === "GET" && requestUrl.pathname === "/_mitm_health") {
      sendJson(res, 200, {
        ok: true,
        app: APP_NAME,
        targetHosts,
        routerUrl: options.routerUrl,
        mappedModels: Object.keys(options.modelMap || {}).length,
      });
      return;
    }

    const bodyBuffer = await collectBodyRaw(req);

    if (shouldBypassIntercept(req)) {
      return passthrough(req, res, bodyBuffer);
    }

    if (options.mockModelList === true && req.url.includes(":fetchAvailableModels")) {
      console.log(`MODELS ${req.method} ${String(req.headers.host || "").split(":")[0]}${safeRequestPath(req.url)} -> ${Object.keys(options.modelMap || {}).length} aliases`);
      sendAntigravityModelList(res, options);
      return;
    }

    const isChatRequest = CHAT_URL_PATTERNS.some(p => req.url.includes(p));
    if (!isChatRequest) return passthrough(req, res, bodyBuffer);

    const model = extractModelFromBody(bodyBuffer) || extractModelFromUrl(req.url);
    const mappedEntry = getMappedEntry(model, options);
    const mappedModel = mappedEntry ? mappedEntry.model : null;
    let effectiveEntry = mappedEntry;

    if (!effectiveEntry && options.modelPrefix && model && !model.includes("/")) {
      effectiveEntry = { model: `${options.modelPrefix}${model}` };
    }

    if (!options.alwaysIntercept && !mappedEntry) return passthrough(req, res, bodyBuffer);

    const effectiveModel = effectiveEntry && effectiveEntry.model;
    if (effectiveModel) {
      const reasoning = effectiveEntry.reasoning_effort ? ` + reasoning_effort=${effectiveEntry.reasoning_effort}` : "";
      console.log(`${model} -> ${effectiveModel}${reasoning}`);
    } else console.log(`${model || "unknown"} -> (no mapping)`);

    return intercept(req, res, bodyBuffer, effectiveEntry);
  });

  server.listen(options.port, () => {
    console.log(`MITM ready on :${options.port} -> ${options.routerUrl}`);
  });

  server.on("error", (error) => {
    if (error.code === "EADDRINUSE") {
      console.error(`Port ${options.port} already in use`);
    } else if (error.code === "EACCES") {
      console.error(`Permission denied for port ${options.port}`);
    } else {
      console.error(error.message);
    }
    process.exit(1);
  });

  process.on("SIGTERM", () => { server.close(() => process.exit(0)); });
  process.on("SIGINT", () => { server.close(() => process.exit(0)); });
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

  if (!IS_WIN && !isRoot() && (cmd === "start" || cmd === "setup" || cmd === "stop" || cmd === "uninstall-cert")) {
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

main().catch((err) => {
  console.error(err.message || String(err));
  process.exit(1);
});
