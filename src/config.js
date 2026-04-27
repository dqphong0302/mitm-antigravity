const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  APP_NAME,
  DEFAULT_CONFIG,
  DEFAULT_TARGET,
  DEFAULT_TARGET_HOSTS,
} = require("./constants");
const { normalizeModelMap } = require("./models");

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
  return process.pkg ? process.execPath : path.join(runtimeDir(), "index.js");
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
  };
}

module.exports = {
  appDir,
  bundledSettingsPath,
  cliEntrypointPath,
  configPath,
  currentMachineConfig,
  ensureAppDir,
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
  settingsPath,
  targetHostsFrom,
  writeConfig,
  writeLegacyConfig,
};
