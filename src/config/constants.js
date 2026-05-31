const path = require("path");

const DEFAULT_TARGET_HOSTS = [
  // Antigravity IDE + agy CLI 1.x primary hosts
  "daily-cloudcode-pa.googleapis.com",
  "cloudcode-pa.googleapis.com",
  "daily-cloudaicompanion.googleapis.com",
  "cloudaicompanion.googleapis.com",
  "daily-cloudaicompanion.sandbox.googleapis.com",
  "cloudaicompanion.sandbox.googleapis.com",
  "daily-cloudcode-pa.sandbox.googleapis.com",
  "cloudcode-pa.sandbox.googleapis.com",
  // Antigravity 2.0 / agy CLI new hosts
  "autopush-cloudaicompanion.sandbox.googleapis.com",
  "staging-cloudaicompanion.sandbox.googleapis.com",
];
const DEFAULT_TARGET = DEFAULT_TARGET_HOSTS[0];

// Loopback constants – dùng chung cho cả DNS và proxy để tránh magic strings
const LOOPBACK_IPV4 = "127.0.0.1";
const LOOPBACK_IPV6 = "::1";

const DEFAULT_REMOTE = LOOPBACK_IPV4;
const DEFAULT_ROUTER_URL = "http://localhost:20128/v1/chat/completions";
const DEFAULT_MODEL_PREFIX = "ag/";
const APP_NAME = "mitm-antigravity";
const ANTIGRAVITY_ALIASES = [
  // ── Gemini 2.5 (legacy) ──────────────────────────────────────────────────
  "gemini-2.5-pro",
  "gemini-2.5-flash",
  "gemini-2.5-flash-thinking",
  "gemini-2.5-flash-lite",
  // ── Gemini 3 Flash ───────────────────────────────────────────────────────
  "gemini-3-flash",
  "gemini-3-flash-agent",
  "gemini-3-flash-a",
  "gemini-3-flash-b",
  "gemini-3-flash-c",
  // ── Gemini 3 Pro ─────────────────────────────────────────────────────────
  "gemini-3-pro-high",
  "gemini-3-pro-low",
  // ── Gemini 3.1 ───────────────────────────────────────────────────────────
  "gemini-3.1-pro-high",
  "gemini-3.1-pro-low",
  "gemini-3.1-flash-lite",
  "gemini-3.1-flash-image",
  // ── Gemini 3.5 (Antigravity 2.0 default) ─────────────────────────────────
  "gemini-3.5-flash",
  "gemini-3.5-flash-thinking",
  "gemini-3.5-flash-low",
  "gemini-3.5-flash-extra-low",   // live: MODEL_PLACEHOLDER_M187, "Gemini 3.5 Flash (Low)"
  "gemini-3.5-pro",
  "gemini-3.5-pro-thinking",
  // ── Claude ───────────────────────────────────────────────────────────────
  "claude-sonnet-4-6",
  "claude-opus-4-6-thinking",
  // Antigravity 2.0 short aliases
  "claude-sonnet-4",
  "claude-opus-4",
  "claude-opus-4-thinking",
  // ── GPT / OSS ────────────────────────────────────────────────────────────
  "gpt-oss-120b-medium",
  // ── Tab / preview ────────────────────────────────────────────────────────
  "tab_flash_lite_preview",
  "tab_jump_flash_lite_preview",
  // ── Agent aliases ─────────────────────────────────────────────────────────
  "gemini-pro-agent",
];
const PRIMARY_ANTIGRAVITY_ALIASES = [
  // Main Antigravity models shown in GUI mapping table.
  // Hide legacy 2.5 aliases; advanced aliases still work through config/import/CLI.
  // Gemini 3.5 tiers
  "gemini-3.5-flash",
  "gemini-3.5-flash-thinking",
  "gemini-3.5-flash-low",
  "gemini-3.5-flash-extra-low",
  "gemini-3.5-pro",
  "gemini-3.5-pro-thinking",
  // Gemini 3.1 / 3.x
  "gemini-3.1-pro-high",
  "gemini-3.1-pro-low",
  "gemini-3.1-flash-lite",
  "gemini-3.1-flash-image",
  "gemini-3-flash",
  // Agent aliases
  "gemini-pro-agent",
  "gemini-3-flash-agent",
  // Claude / GPT
  "claude-sonnet-4-6",
  "claude-opus-4-6-thinking",
  "gpt-oss-120b-medium",
];
const MAPPABLE_ANTIGRAVITY_ALIASES = [...ANTIGRAVITY_ALIASES];

const IS_WIN = process.platform === "win32";
const IS_MAC = process.platform === "darwin";
const HOSTS_FILE = process.env.MITM_HOSTS_FILE || (IS_WIN
  ? path.join(process.env.SystemRoot || "C:\\Windows", "System32", "drivers", "etc", "hosts")
  : "/etc/hosts");
const DNS_BLOCK_BEGIN = "# BEGIN ANTIGRAVITY_PROXY";
const DNS_BLOCK_END = "# END ANTIGRAVITY_PROXY";

const DEFAULT_CONFIG = {
  targetHost: DEFAULT_TARGET,
  targetHosts: DEFAULT_TARGET_HOSTS,
  remoteIp: DEFAULT_REMOTE,
  remoteHost: "",
  port: 443,
  routerUrl: DEFAULT_ROUTER_URL,
  apiKey: "",
  model: "",
  modelPrefix: "",
  alwaysIntercept: false,
  mockModelList: false,
  modelMap: {},
  maxRetries: 5,
  retryDelay: 1000,
  retryBackoff: 1.5,
  requestTimeoutMs: 10 * 60 * 1000,
  streamIdleTimeoutMs: 2 * 60 * 1000,
  sudoPasswordCache: null,
};


const LEGACY_DEFAULT_MODEL_MAP = Object.fromEntries(ANTIGRAVITY_ALIASES.map((alias) => [alias, "cx/gpt-5.5"]));

module.exports = {
  ANTIGRAVITY_ALIASES,
  APP_NAME,
  DEFAULT_CONFIG,
  DEFAULT_MODEL_PREFIX,
  DEFAULT_REMOTE,
  DEFAULT_ROUTER_URL,
  DEFAULT_TARGET,
  DEFAULT_TARGET_HOSTS,
  DNS_BLOCK_BEGIN,
  DNS_BLOCK_END,
  HOSTS_FILE,
  IS_MAC,
  IS_WIN,
  LEGACY_DEFAULT_MODEL_MAP,
  LOOPBACK_IPV4,
  LOOPBACK_IPV6,
  MAPPABLE_ANTIGRAVITY_ALIASES,
  PRIMARY_ANTIGRAVITY_ALIASES,
};
