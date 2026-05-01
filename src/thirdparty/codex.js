/**
 * OpenAI Codex CLI – đọc/ghi ~/.codex/config.toml
 * Hỗ trợ: macOS, Windows, Linux
 */
const fs   = require("fs");
const os   = require("os");
const path = require("path");

function codexConfigDir() {
  return path.join(os.homedir(), ".codex");
}

function codexConfigPath() {
  return path.join(codexConfigDir(), "config.toml");
}

// ─── Minimal TOML parser ──────────────────────────────────────────────────────
// Chỉ xử lý: [section.nested], key = "value", # comment
function parseToml(content) {
  const obj = {};
  let current = obj;

  for (let line of String(content || "").split("\n")) {
    line = line.trim();
    if (!line || line.startsWith("#")) continue;

    const sectionMatch = line.match(/^\[([^\]]+)\]$/);
    if (sectionMatch) {
      current = obj;
      for (const part of sectionMatch[1].split(".")) {
        if (!current[part] || typeof current[part] !== "object") current[part] = {};
        current = current[part];
      }
      continue;
    }

    const eqIdx = line.indexOf("=");
    if (eqIdx > 0) {
      const key = line.slice(0, eqIdx).trim();
      let val   = line.slice(eqIdx + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) ||
          (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      current[key] = val;
    }
  }
  return obj;
}

// ─── Minimal TOML writer ──────────────────────────────────────────────────────
function tomlEscape(s) { return String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"'); }

function writeSection(obj, prefix, lines) {
  const scalars  = Object.entries(obj).filter(([, v]) => v === null || typeof v !== "object");
  const sections = Object.entries(obj).filter(([, v]) => v !== null && typeof v === "object");

  for (const [k, v] of scalars) lines.push(`${k} = "${tomlEscape(v)}"`);
  for (const [k, v] of sections) {
    const name = prefix ? `${prefix}.${k}` : k;
    lines.push(`\n[${name}]`);
    writeSection(v, name, lines);
  }
}

function stringifyToml(obj) {
  const lines = [];
  writeSection(obj, "", lines);
  return lines.join("\n").trimStart() + "\n";
}

// ─── Public API ───────────────────────────────────────────────────────────────
function readCodexConfig() {
  const p = codexConfigPath();
  try {
    if (!fs.existsSync(p)) return {};
    return parseToml(fs.readFileSync(p, "utf8"));
  } catch {
    return {};
  }
}

function getCodexSettings() {
  const config   = readCodexConfig();
  const provider = ((config.model_providers || {}).openai) || {};
  return {
    apiKey:     provider.api_key  || "",
    baseUrl:    provider.base_url || "",
    envKey:     provider.env_key  || "OPENAI_API_KEY",
    configPath: codexConfigPath(),
    exists:     fs.existsSync(codexConfigPath()),
  };
}

function saveCodexSettings({ apiKey, baseUrl }) {
  const config = readCodexConfig();
  if (!config.model_providers)          config.model_providers = {};
  if (!config.model_providers.openai)   config.model_providers.openai = {
    name:     "OpenAI",
    base_url: "https://api.openai.com/v1",
    env_key:  "OPENAI_API_KEY",
    wire_api: "chat",
  };

  const p = config.model_providers.openai;
  if (apiKey  !== undefined) apiKey  ? (p.api_key  = apiKey)  : delete p.api_key;
  if (baseUrl !== undefined) p.base_url = baseUrl || "https://api.openai.com/v1";

  fs.mkdirSync(codexConfigDir(), { recursive: true });
  fs.writeFileSync(codexConfigPath(), stringifyToml(config));
  return getCodexSettings();
}

module.exports = { codexConfigPath, getCodexSettings, saveCodexSettings };
