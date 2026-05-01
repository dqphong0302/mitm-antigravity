/**
 * Claude Code CLI – đọc/ghi ~/.claude/settings.json
 * Hỗ trợ: macOS, Windows, Linux
 */
const fs   = require("fs");
const os   = require("os");
const path = require("path");
const { IS_WIN } = require("../config/constants");

function claudeCodeConfigDir() {
  if (IS_WIN) {
    const appData = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
    // Kiểm tra cả 2 vị trí phổ biến trên Windows
    const winPath = path.join(appData, "Claude");
    if (fs.existsSync(winPath)) return winPath;
    return path.join(os.homedir(), ".claude");
  }
  return path.join(os.homedir(), ".claude");
}

function claudeCodeConfigPath() {
  return path.join(claudeCodeConfigDir(), "settings.json");
}

function readClaudeCodeConfig() {
  const p = claudeCodeConfigPath();
  try {
    if (!fs.existsSync(p)) return {};
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return {};
  }
}

function getClaudeCodeSettings() {
  const config = readClaudeCodeConfig();
  const env = (typeof config.env === "object" && config.env) ? config.env : {};
  return {
    apiKey:     env.ANTHROPIC_API_KEY  || "",
    baseUrl:    env.ANTHROPIC_BASE_URL || "",
    configPath: claudeCodeConfigPath(),
    exists:     fs.existsSync(claudeCodeConfigPath()),
  };
}

function saveClaudeCodeSettings({ apiKey, baseUrl }) {
  const config = readClaudeCodeConfig();
  if (!config.env || typeof config.env !== "object") config.env = {};

  if (apiKey  !== undefined) apiKey  ? (config.env.ANTHROPIC_API_KEY  = apiKey)  : delete config.env.ANTHROPIC_API_KEY;
  if (baseUrl !== undefined) baseUrl ? (config.env.ANTHROPIC_BASE_URL = baseUrl) : delete config.env.ANTHROPIC_BASE_URL;

  if (Object.keys(config.env).length === 0) delete config.env;

  fs.mkdirSync(claudeCodeConfigDir(), { recursive: true });
  fs.writeFileSync(claudeCodeConfigPath(), JSON.stringify(config, null, 2) + "\n");
  return getClaudeCodeSettings();
}

module.exports = { claudeCodeConfigPath, getClaudeCodeSettings, saveClaudeCodeSettings };
