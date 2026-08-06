const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");


const {
  APP_NAME,
  DEFAULT_CONFIG,
  DEFAULT_TARGET,
  DEFAULT_TARGET_HOSTS,
} = require("./constants");
const { normalizeModelMap } = require("../models");

function appDir() {
  if (process.env.MITM_APP_DIR) return process.env.MITM_APP_DIR;
  return path.join(os.homedir(), `.${APP_NAME}`);
}

function configPath() {
  return path.join(appDir(), "config.json");
}

function runtimeDir() {
  if (process.pkg) return path.dirname(process.execPath);
  return path.resolve(__dirname, "..");
}

function cliEntrypointPath() {
  // Source mode: the runnable CLI entry is repo-root index.js (which calls
  // main()). runtimeDir() is src/, so the entry sits one level up. Pointing at
  // src/index.js would spawn a module that exits immediately — the detached
  // LaunchDaemon proxy then "crashes" with nothing listening on 443.
  return process.pkg ? process.execPath : path.resolve(runtimeDir(), "..", "index.js");
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
  let raw;
  try {
    raw = fs.readFileSync(filePath, "utf-8");
  } catch (err) {
    throw new Error(`Cannot read ${filePath}: ${err.message}`);
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`Invalid JSON in ${filePath}`);
  }
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

function readPrimarySettings() {
  return normalizeSettings(readJsonFile(settingsPath()));
}

function currentMachineConfig(settings) {
  const id = machineId();
  return settings.machines[id] || settings.machines[settings.activeMachine] || {};
}

function readConfig() {
  try {
    const legacyConfig = readJsonFile(configPath()) || {};
    const bundledSettings = normalizeSettings(readJsonFile(bundledSettingsPath()));
    const primarySettings = readJsonFile(settingsPath());
    const configWithBundledDefaults = mergeConfig(DEFAULT_CONFIG, currentMachineConfig(bundledSettings));
    const configWithLegacy = mergeConfig(configWithBundledDefaults, legacyConfig);
    if (!primarySettings) return configWithLegacy;
    return mergeConfig(configWithLegacy, currentMachineConfig(normalizeSettings(primarySettings)));
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
  const settings = readPrimarySettings();
  const id = machineId();
  settings.activeMachine = id;
  settings.machines[id] = mergeConfig(DEFAULT_CONFIG, config);
  ensureAppDir();
  fs.writeFileSync(settingsPath(), `${JSON.stringify(settings, null, 2)}\n`);
}

function encryptPassword(password, keyString) {
  const key = crypto.createHash("sha256").update(keyString).digest();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(password, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    iv: iv.toString("hex"),
    encrypted: encrypted.toString("hex"),
    tag: tag.toString("hex")
  };
}

function decryptPassword(data, keyString) {
  if (!data || !data.iv || !data.encrypted || !data.tag) return "";
  try {
    const key = crypto.createHash("sha256").update(keyString).digest();
    const iv = Buffer.from(data.iv, "hex");
    const tag = Buffer.from(data.tag, "hex");
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    return decipher.update(data.encrypted, "hex", "utf8") + decipher.final("utf8");
  } catch {
    return "";
  }
}

function saveSudoPassword(password) {
  if (!password) return;
  const key = machineId();
  const encryptedObj = encryptPassword(password, key);
  const config = readConfig();
  config.sudoPasswordCache = encryptedObj;
  writeConfig(config);
}

function getSudoPassword() {
  const config = readConfig();
  if (!config.sudoPasswordCache) return "";
  const key = machineId();
  return decryptPassword(config.sudoPasswordCache, key);
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

function redactConfig(config) {
  return {
    ...config,
    apiKey: config.apiKey ? `${String(config.apiKey).slice(0, 6)}...${String(config.apiKey).slice(-4)}` : "",
    sudoPasswordCache: config.sudoPasswordCache ? "[REDACTED]" : null,
  };
}


function exportConfig() {
  const config = readConfig();
  return {
    _format: "mitm-antigravity-config",
    _version: 1,
    _exportedAt: new Date().toISOString(),
    _machine: machineId(),
    routerUrl: config.routerUrl || "",
    apiKey: config.apiKey || "",
    model: config.model || "",
    alwaysIntercept: Boolean(config.alwaysIntercept),
    modelMap: config.modelMap || {},
  };
}

function importConfig(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("Invalid config: must be a JSON object");
  }
  const current = readConfig();
  const next = {
    ...current,
    routerUrl: typeof data.routerUrl === "string" ? data.routerUrl.trim() : current.routerUrl,
    apiKey: typeof data.apiKey === "string" ? data.apiKey : current.apiKey,
    model: typeof data.model === "string" ? data.model.trim() : current.model,
    alwaysIntercept: typeof data.alwaysIntercept === "boolean" ? data.alwaysIntercept : current.alwaysIntercept,
    modelMap: data.modelMap && typeof data.modelMap === "object" && !Array.isArray(data.modelMap)
      ? normalizeModelMap({ ...current.modelMap, ...data.modelMap })
      : current.modelMap,
  };
  writeConfig(next);
  return next;
}

module.exports = {
  appDir,
  bundledSettingsPath,
  cliEntrypointPath,
  configPath,
  currentMachineConfig,
  ensureAppDir,
  exportConfig,
  importConfig,
  machineId,
  mergeConfig,
  normalizeSettings,
  normalizeTargetHosts,
  parseModelMapFile,
  parsePrimitive,
  primaryTargetHost,
  readConfig,
  readJsonFile,
  readPrimarySettings,
  readSettings,
  redactConfig,
  runtimeDir,
  saveSudoPassword,
  getSudoPassword,
  settingsPath,
  targetHostsFrom,
  writeConfig,
  writeLegacyConfig,
};
