const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  ANTIGRAVITY_ALIASES,
  DEFAULT_MODEL_PREFIX,
  LEGACY_DEFAULT_MODEL_MAP,
  MAPPABLE_ANTIGRAVITY_ALIASES,
} = require("../config/constants");

const ANTIGRAVITY_ALIAS_SET = new Set(ANTIGRAVITY_ALIASES);
const MAPPABLE_ALIAS_SET = new Set(MAPPABLE_ANTIGRAVITY_ALIASES);
const BUILTIN_MODEL_VALUE_ALIASES = new Map([
  // ── Gemini 3.1 placeholders ───────────────────────────────────────────────
  ["MODEL_PLACEHOLDER_M37", "gemini-3.1-pro-high"],
  ["MODEL_PLACEHOLDER_M36", "gemini-3.1-pro-low"],
  ["MODEL_PLACEHOLDER_M50", "gemini-3.1-flash-lite"],
  ["MODEL_PLACEHOLDER_M21", "gemini-3.1-flash-image"],
  ["MODEL_PLACEHOLDER_M18", "gemini-3-flash"],
  ["MODEL_PLACEHOLDER_M84", "gemini-3-flash-agent"],
  // M132: live server reports gemini-3-flash-agent → MODEL_PLACEHOLDER_M132
  // displayName "Gemini 3.5 Flash (High)" — same alias, different internal slot
  ["MODEL_PLACEHOLDER_M132", "gemini-3-flash-agent"],
  // M16: gemini-pro-agent → "Gemini 3.1 Pro (High)" — distinct slot from M37
  ["MODEL_PLACEHOLDER_M16", "gemini-pro-agent"],
  // ── Claude placeholders ───────────────────────────────────────────────────
  ["MODEL_PLACEHOLDER_M35", "claude-sonnet-4-6"],
  ["MODEL_PLACEHOLDER_M26", "claude-opus-4-6-thinking"],
  ["291", "claude-opus-4-6-thinking"],
  // ── Gemini 2.5 named constants ────────────────────────────────────────────
  ["MODEL_GOOGLE_GEMINI_2_5_PRO", "gemini-2.5-pro"],
  ["MODEL_GOOGLE_GEMINI_2_5_FLASH", "gemini-2.5-flash"],
  ["MODEL_GOOGLE_GEMINI_2_5_FLASH_THINKING", "gemini-2.5-flash-thinking"],
  ["MODEL_GOOGLE_GEMINI_2_5_FLASH_LITE", "gemini-2.5-flash-lite"],
  // ── GPT OSS ───────────────────────────────────────────────────────────────
  ["MODEL_OPENAI_GPT_OSS_120B_MEDIUM", "gpt-oss-120b-medium"],
  ["342", "gpt-oss-120b-medium"],
  // ── Tab / preview ─────────────────────────────────────────────────────────
  ["MODEL_PLACEHOLDER_M19", "tab_flash_lite_preview"],
  ["MODEL_PLACEHOLDER_M28", "tab_jump_flash_lite_preview"],
  // ── Gemini 3.5 placeholders (Antigravity 2.0) ─────────────────────────────
  ["MODEL_GOOGLE_GEMINI_3_5_FLASH", "gemini-3.5-flash"],
  ["MODEL_GOOGLE_GEMINI_3_5_FLASH_THINKING", "gemini-3.5-flash-thinking"],
  ["MODEL_GOOGLE_GEMINI_3_5_FLASH_LOW", "gemini-3.5-flash-low"],
  // M20: live server maps gemini-3.5-flash-low → MODEL_PLACEHOLDER_M20
  ["MODEL_PLACEHOLDER_M20", "gemini-3.5-flash-low"],
  // M187: gemini-3.5-flash-extra-low → "Gemini 3.5 Flash (Low)" — new tier in live model list
  ["MODEL_PLACEHOLDER_M187", "gemini-3.5-flash-extra-low"],
  ["MODEL_GOOGLE_GEMINI_3_5_PRO", "gemini-3.5-pro"],
  ["MODEL_GOOGLE_GEMINI_3_5_PRO_THINKING", "gemini-3.5-pro-thinking"],
  // Numeric IDs seen in agy 2.0 traffic (may expand as more are observed)
  ["400", "gemini-3.5-flash"],
  ["401", "gemini-3.5-flash-thinking"],
  ["402", "gemini-3.5-pro"],
  // ── Claude 4 short aliases (Antigravity 2.0) ──────────────────────────────
  ["MODEL_ANTHROPIC_CLAUDE_SONNET_4", "claude-sonnet-4"],
  ["MODEL_ANTHROPIC_CLAUDE_OPUS_4", "claude-opus-4"],
  ["MODEL_ANTHROPIC_CLAUDE_OPUS_4_THINKING", "claude-opus-4-thinking"],
  // ── Canonical name aliases ────────────────────────────────────────────────
  ["gemini-3.1-pro", "gemini-3.1-pro-high"],
  ["gemini-3.1-pro-preview", "gemini-3.1-pro-high"],
  ["gh/gemini-3.1-pro-preview", "gemini-3.1-pro-high"],
  ["gemini-pro-agent", "gemini-3.1-pro-high"],
  ["gemini-3-flash-agent", "gemini-3-flash"],
  // Antigravity 2.0 may send "gemini-3.5-flash" as the bare default
  ["gemini-3.5", "gemini-3.5-flash"],
  // Claude 4 short → versioned
  ["claude-sonnet-4", "claude-sonnet-4"],
  ["claude-opus-4", "claude-opus-4"],
]);

const MODEL_SYNONYMS = {
  antigravity: {
    "gemini-default": "gemini-3.5-flash-low",
    "gemini-3.1-pro-high": "gemini-pro-agent",
    "gemini-3.5": "gemini-3.5-flash",
  },
};

const MODEL_PATTERNS = {
  antigravity: [
    { match: /flash.*low|low.*flash/i, alias: "gemini-3.5-flash-low" },
    { match: /pro.*low|low.*pro/i, alias: "gemini-3.1-pro-low" },
    { match: /opus/i, alias: "claude-opus-4-6-thinking" },
    { match: /sonnet/i, alias: "claude-sonnet-4-6" },
    { match: /pro.*high|high.*pro/i, alias: "gemini-3.1-pro-high" },
  ],
};


const MODEL_FIELD_NAMES = new Set([
  "model",
  "modelid",
  "model_id",
  "modelname",
  "model_name",
  "selectedmodel",
  "selected_model",
  "defaultagentmodelid",
  "default_agent_model_id",
  "targetmodel",
  "target_model",
]);

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
  const normalized = Object.fromEntries(Object.entries(modelMap)
    .map(([key, value]) => [String(key).trim(), normalizeMappingEntry(value)])
    .filter(([key, value]) => key && value));
  const stripped = stripLegacyDefaultMappings(normalized);
  return Object.fromEntries(Object.entries(stripped)
    .filter(([key, value]) => MAPPABLE_ALIAS_SET.has(key) && !isGeneratedBuiltInPrefixMapping(key, value))
    .map(([key, value]) => [key, value.reasoning_effort ? value : value.model]));
}

function isGeneratedBuiltInPrefixMapping(alias, entry) {
  const normalized = normalizeMappingEntry(entry);
  return Boolean(
    normalized
    && !normalized.reasoning_effort
    && ANTIGRAVITY_ALIAS_SET.has(alias)
    && normalized.model === `${DEFAULT_MODEL_PREFIX}${alias}`
  );
}

function stripLegacyDefaultMappings(modelMap) {
  const entries = Object.entries(modelMap || {});
  if (entries.length !== ANTIGRAVITY_ALIASES.length) return modelMap || {};
  const isOnlyLegacyDefaults = ANTIGRAVITY_ALIASES.every((alias) => mappingModel(modelMap[alias]) === LEGACY_DEFAULT_MODEL_MAP[alias]);
  return isOnlyLegacyDefaults ? {} : modelMap;
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

function classifyModelCheckFailure(error, context = {}) {
  const status = Number(context.status || error?.status || 0);
  const code = String(error?.code || "");
  const message = String(context.message || error?.message || "");
  const lower = message.toLowerCase();

  if (["ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "EAI_AGAIN"].includes(code) || /fetch failed|connection refused|econnrefused|enotfound|eai_again/.test(lower)) {
    return {
      category: "router_unreachable",
      hint: "Router is not reachable. Start your local upstream/router and verify the Base URL.",
    };
  }
  if (status === 401 || status === 403) {
    return {
      category: "auth_failed",
      hint: "Authentication failed. Check the API key configured for this endpoint.",
    };
  }
  if (status === 404 && /credential|provider|account|no active/i.test(message)) {
    return {
      category: "provider_credentials_missing",
      hint: "Router is reachable, but the upstream provider/account credentials are not active.",
    };
  }
  if ([408, 429, 502, 503, 504, 524].includes(status) || /timeout|timed out|temporar|rate limit|cloudflare/.test(lower)) {
    return {
      category: "upstream_transient",
      hint: "Router or upstream provider returned a transient failure. Retry after checking provider status.",
    };
  }
  if (status === 404) {
    return {
      category: "models_endpoint_missing",
      hint: "The endpoint is reachable, but /models was not found. Check whether the Base URL includes the correct /v1 path.",
    };
  }
  return {
    category: status ? "http_error" : "unknown_error",
    hint: status ? `Endpoint returned HTTP ${status}. Check the router URL and provider configuration.` : "Model check failed. Check the router URL and logs.",
  };
}

function modelCheckErrorMessage(modelsUrl, failure, detail) {
  return `Model check failed (${failure.category}) at ${modelsUrl}: ${detail}. ${failure.hint}`;
}

async function fetchAvailableModels(routerUrl, apiKey) {
  const modelsUrl = deriveModelsUrl(routerUrl);
  const headers = { Accept: "application/json" };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  let response;
  try {
    response = await fetch(modelsUrl, { method: "GET", headers });
  } catch (error) {
    const failure = classifyModelCheckFailure(error);
    error.category = failure.category;
    error.hint = failure.hint;
    error.modelsUrl = modelsUrl;
    error.message = modelCheckErrorMessage(modelsUrl, failure, error.message || "network failure");
    throw error;
  }

  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }

  if (!response.ok) {
    const message = data?.error?.message || data?.message || text || `HTTP ${response.status}`;
    const failure = classifyModelCheckFailure(null, { status: response.status, message });
    const error = new Error(modelCheckErrorMessage(modelsUrl, failure, message));
    error.category = failure.category;
    error.hint = failure.hint;
    error.modelsUrl = modelsUrl;
    error.status = response.status;
    throw error;
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

function looksLikeModelId(value) {
  const text = String(value || "").trim();
  if (!text || text.length > 240) return false;
  if (/\s/.test(text)) return false;
  return /^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$/.test(text);
}

function normalizedModelFieldName(key) {
  return String(key || "").replace(/[-\s]/g, "_").toLowerCase();
}

function isModelFieldName(key) {
  const normalized = normalizedModelFieldName(key);
  return MODEL_FIELD_NAMES.has(normalized) || MODEL_FIELD_NAMES.has(normalized.replace(/_/g, ""));
}

function modelAliasFromName(model) {
  const text = String(model || "").trim();
  if (!text) return "";
  const withoutQuery = text.split("?")[0].replace(/:+$/, "");
  const parts = withoutQuery.split("/").filter(Boolean);
  return decodeURIComponent(parts[parts.length - 1] || withoutQuery);
}

function modelNameCandidates(model) {
  const values = [];
  const raw = String(model || "").trim();
  const alias = modelAliasFromName(raw);
  for (const item of [raw, alias, builtInAliasForModel(raw), builtInAliasForModel(alias)]) {
    if (item && !values.includes(item)) values.push(item);
  }
  return values;
}

function collectModelCandidates(value, pathPrefix = "", output = [], depth = 0) {
  if (!value || depth > 8) return output;
  if (Array.isArray(value)) {
    value.slice(0, 20).forEach((item, index) => collectModelCandidates(item, `${pathPrefix}[${index}]`, output, depth + 1));
    return output;
  }
  if (typeof value !== "object") return output;

  const choice = value.choice;
  if (choice && typeof choice === "object") {
    const caseName = String(choice.case || "").toLowerCase();
    if ((caseName === "model" || caseName === "alias")
      && (typeof choice.value === "string" || typeof choice.value === "number")
      && looksLikeModelId(choice.value)) {
      output.push({ path: `${pathPrefix ? `${pathPrefix}.` : ""}choice.${caseName}`, value: String(choice.value).trim() });
    }
  }

  for (const [key, child] of Object.entries(value)) {
    const pathKey = pathPrefix ? `${pathPrefix}.${key}` : key;
    if ((typeof child === "string" || typeof child === "number") && isModelFieldName(key) && looksLikeModelId(child)) {
      output.push({ path: pathKey, value: String(child).trim() });
    } else if (child && typeof child === "object") {
      collectModelCandidates(child, pathKey, output, depth + 1);
    }
  }
  return output;
}

function parseJsonBody(body) {
  try {
    const text = Buffer.isBuffer(body) ? body.toString("utf8") : String(body || "");
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

function extractModelFromBody(body) {
  const parsed = parseJsonBody(body);
  if (!parsed || typeof parsed !== "object") return null;
  if (typeof parsed.model === "string" && looksLikeModelId(parsed.model)) return parsed.model.trim();
  const candidates = collectModelCandidates(parsed);
  return candidates.length > 0 ? candidates[0].value : null;
}

function extractModelFromUrl(url) {
  const match = String(url).match(/\/models\/([^/:?]+):(generateContent|streamGenerateContent)/);
  return match ? decodeURIComponent(match[1]) : null;
}

function builtInAliasForModel(model) {
  const value = String(model || "").trim();
  const alias = modelAliasFromName(value);
  const builtin = BUILTIN_MODEL_VALUE_ALIASES.get(value) || BUILTIN_MODEL_VALUE_ALIASES.get(alias);
  if (builtin) return builtin;
  if (MAPPABLE_ALIAS_SET.has(value)) return value;
  if (MAPPABLE_ALIAS_SET.has(alias)) return alias;
  return "";
}

/**
 * Parse a minimal subset of TOML: only top-level key = "value" string pairs.
 * Sufficient for reading antigravity config.toml model mapping fields.
 * Does NOT handle tables, arrays, multi-line strings, or numbers.
 */
function parseTomlStringPairs(text) {
  const result = {};
  for (const line of String(text || "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("[")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const rawVal = trimmed.slice(eq + 1).trim();
    // Only handle quoted strings
    const quoted = /^"((?:[^"\\]|\\.)*)"/.exec(rawVal);
    if (quoted) {
      result[key] = quoted[1].replace(/\\"/g, '"').replace(/\\\\/g, "\\");
    }
  }
  return result;
}

/**
 * Read agy 2.0 model aliases from ~/.config/antigravity/config.toml.
 * The file may contain entries like:
 *   [model_aliases]
 *   "gemini-3.5-flash" = "kr/claude-sonnet-4.6-agentic"
 * We do a best-effort parse — failures are silently ignored.
 */
function readAgyConfigAliases() {
  try {
    const tomlPath = path.join(os.homedir(), ".config", "antigravity", "config.toml");
    if (!fs.existsSync(tomlPath)) return {};
    const text = fs.readFileSync(tomlPath, "utf-8");
    // Find [model_aliases] section and parse until next section
    const sectionMatch = /\[model_aliases\]([\s\S]*?)(?=\n\[|$)/.exec(text);
    if (!sectionMatch) return {};
    return parseTomlStringPairs(sectionMatch[1]);
  } catch {
    return {};
  }
}

function getMappedEntry(model, options) {
  if (!model) return null;
  if (options.model) return { model: options.model };

  const candidates = modelNameCandidates(model);
  const extendedCandidates = [...candidates];
  for (const candidate of candidates) {
    const synonym = MODEL_SYNONYMS.antigravity[candidate];
    if (synonym && !extendedCandidates.includes(synonym)) {
      extendedCandidates.push(synonym);
    }
    for (const pattern of MODEL_PATTERNS.antigravity) {
      if (pattern.match.test(candidate)) {
        if (!extendedCandidates.includes(pattern.alias)) {
          extendedCandidates.push(pattern.alias);
        }
      }
    }
  }

  if (options.modelMap) {
    for (const candidate of extendedCandidates) {
      if (MAPPABLE_ALIAS_SET.has(candidate) && options.modelMap[candidate]) {
        return normalizeMappingEntry(options.modelMap[candidate]);
      }
    }

    const prefixKey = Object.keys(options.modelMap).find((key) => {
      const target = normalizeMappingEntry(options.modelMap[key]);
      return MAPPABLE_ALIAS_SET.has(key)
        && target
        && extendedCandidates.some((candidate) => candidate.startsWith(key) || key.startsWith(candidate));
    });
    if (prefixKey) return normalizeMappingEntry(options.modelMap[prefixKey]);
  }

  // ~/.9router/db.json — 9router desktop app config
  try {
    const dbFile = path.join(os.homedir(), ".9router", "db.json");
    const db = JSON.parse(fs.readFileSync(dbFile, "utf-8"));
    const aliases = db.mitmAlias?.antigravity || {};
    for (const candidate of extendedCandidates) {
      if (MAPPABLE_ALIAS_SET.has(candidate) && aliases[candidate]) return normalizeMappingEntry(aliases[candidate]);
    }
  } catch {
    // not available — fall through
  }

  // ~/.config/antigravity/config.toml — agy 2.0 CLI config
  try {
    const agyAliases = readAgyConfigAliases();
    for (const candidate of extendedCandidates) {
      if (agyAliases[candidate]) return normalizeMappingEntry(agyAliases[candidate]);
    }
  } catch {
    // best effort
  }

  return null;
}

function getMappedModel(model, options) {
  const entry = getMappedEntry(model, options);
  return entry ? entry.model : null;
}

function normalizePrefix(prefix) {
  if (!prefix) return "";
  const lowered = String(prefix).toLowerCase();
  if (lowered === "false" || lowered === "0" || lowered === "none" || lowered === "off") return "";
  return prefix.endsWith("/") ? prefix : `${prefix}/`;
}

// Re-export from split modules for backward compatibility.
const {
  buildAntigravityModelList,
  mergeAntigravityModelListPayload,
  mergeCascadeModelConfigData,
  mergeCascadeModelConfigsInPayload,
  modelDisplayName,
  sendAntigravityModelList,
} = require("./list");

const {
  decodeResponseBody,
  summarizeAntigravityModelsResponse,
  summarizeCascadeModelConfigs,
  summarizeRequestBodyForLog,
} = require("./serialization");

module.exports = {
  buildAntigravityModelList,
  builtInAliasForModel,
  classifyModelCheckFailure,
  collectModelCandidates,
  decodeResponseBody,
  deriveModelsUrl,
  extractModelFromBody,
  extractModelFromUrl,
  fetchAvailableModels,
  getMappedEntry,
  getMappedModel,
  looksLikeModelId,
  mappingModel,
  modelAliasFromName,
  modelNameCandidates,
  modelDisplayName,
  mergeAntigravityModelListPayload,
  mergeCascadeModelConfigData,
  mergeCascadeModelConfigsInPayload,
  normalizeMappingEntry,
  normalizeModelMap,
  normalizePrefix,
  parseInlineModelMap,
  parseJsonBody,
  parseTomlStringPairs,
  readAgyConfigAliases,
  sendAntigravityModelList,
  stripLegacyDefaultMappings,
  summarizeAntigravityModelsResponse,
  summarizeCascadeModelConfigs,
  summarizeRequestBodyForLog,
};
