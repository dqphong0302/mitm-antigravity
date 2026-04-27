const fs = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");

const {
  ANTIGRAVITY_ALIASES,
  DEFAULT_MODEL_PREFIX,
  LEGACY_DEFAULT_MODEL_MAP,
  MAPPABLE_ANTIGRAVITY_ALIASES,
} = require("./constants");
const { sendJson } = require("./http");

const ANTIGRAVITY_ALIAS_SET = new Set(ANTIGRAVITY_ALIASES);
const MAPPABLE_ALIAS_SET = new Set(MAPPABLE_ANTIGRAVITY_ALIASES);
const BUILTIN_MODEL_VALUE_ALIASES = new Map([
  ["MODEL_PLACEHOLDER_M37", "gemini-3.1-pro-high"],
  ["MODEL_PLACEHOLDER_M36", "gemini-3.1-pro-low"],
  ["MODEL_PLACEHOLDER_M18", "gemini-3-flash"],
  ["MODEL_PLACEHOLDER_M35", "claude-sonnet-4-6"],
  ["MODEL_PLACEHOLDER_M26", "claude-opus-4-6-thinking"],
  ["291", "claude-opus-4-6-thinking"],
  ["MODEL_OPENAI_GPT_OSS_120B_MEDIUM", "gpt-oss-120b-medium"],
  ["342", "gpt-oss-120b-medium"],
]);

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

function summarizeRequestBodyForLog(body) {
  const parsed = parseJsonBody(body);
  if (!parsed || typeof parsed !== "object") return `bodyBytes=${Buffer.isBuffer(body) ? body.length : String(body || "").length} body=unparseable`;
  const keys = Array.isArray(parsed) ? ["array"] : Object.keys(parsed).slice(0, 20);
  const models = collectModelCandidates(parsed)
    .map((item) => `${item.path}=${item.value}`)
    .slice(0, 8);
  return `bodyKeys=${keys.join(",") || "-"} modelCandidates=${models.join(",") || "-"}`;
}

function extractModelFromUrl(url) {
  const match = String(url).match(/\/models\/([^/:?]+):(generateContent|streamGenerateContent)/);
  return match ? decodeURIComponent(match[1]) : null;
}

function builtInAliasForModel(model) {
  const value = String(model || "").trim();
  const alias = modelAliasFromName(value);
  if (MAPPABLE_ALIAS_SET.has(value)) return value;
  if (MAPPABLE_ALIAS_SET.has(alias)) return alias;
  return BUILTIN_MODEL_VALUE_ALIASES.get(value) || BUILTIN_MODEL_VALUE_ALIASES.get(alias) || "";
}

function getMappedEntry(model, options) {
  if (!model) return null;
  if (options.model) return { model: options.model };

  const candidates = modelNameCandidates(model);
  if (options.modelMap) {
    for (const candidate of candidates) {
      if (MAPPABLE_ALIAS_SET.has(candidate) && options.modelMap[candidate]) {
        return normalizeMappingEntry(options.modelMap[candidate]);
      }
    }

    const prefixKey = Object.keys(options.modelMap).find((key) => {
      const target = normalizeMappingEntry(options.modelMap[key]);
      return MAPPABLE_ALIAS_SET.has(key)
        && target
        && candidates.some((candidate) => candidate.startsWith(key) || key.startsWith(candidate));
    });
    if (prefixKey) return normalizeMappingEntry(options.modelMap[prefixKey]);
  }

  try {
    const dbFile = path.join(os.homedir(), ".9router", "db.json");
    const db = JSON.parse(fs.readFileSync(dbFile, "utf-8"));
    const aliases = db.mitmAlias?.antigravity || {};
    for (const candidate of candidates) {
      if (MAPPABLE_ALIAS_SET.has(candidate) && aliases[candidate]) return normalizeMappingEntry(aliases[candidate]);
    }
    return null;
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
  };
  const base = names[alias] || alias;
  return mappedModel ? `${base} (${mappedModel})` : base;
}

function fallbackModelListEntry(alias, mappedModel) {
  const resetTime = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  return {
    id: alias,
    name: alias,
    model: alias,
    displayName: modelDisplayName(alias, mappedModel),
    description: mappedModel ? `Routed to ${mappedModel}` : "Antigravity model",
    disabled: false,
    isInternal: false,
    supportsImages: false,
    supportsThinking: true,
    supportedMimeTypes: {},
    supportedGenerationMethods: ["generateContent", "streamGenerateContent"],
    quotaInfo: {
      remainingFraction: 1,
      resetTime,
    },
  };
}

function buildAntigravityModelList(options) {
  const modelMap = options.modelMap || {};
  const resetTime = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const models = {};

  for (const alias of ANTIGRAVITY_ALIASES) {
    const mappedModel = mappingModel(modelMap[alias]) || getMappedModel(alias, options) || "";
    models[alias] = fallbackModelListEntry(alias, mappedModel);
    models[alias].quotaInfo.resetTime = resetTime;
  }

  return { models };
}

function mergeAntigravityModelListPayload(payload) {
  const next = payload && typeof payload === "object" && !Array.isArray(payload)
    ? payload
    : {};
  const existingModels = next.models && typeof next.models === "object" && !Array.isArray(next.models)
    ? next.models
    : {};
  return {
    payload: next,
    added: [],
    existingCount: Object.keys(existingModels).length,
    totalCount: Object.keys(existingModels).length,
  };
}

function mergeCascadeModelConfigData(configData) {
  return { payload: configData, added: [], changed: false };
}

function mergeCascadeModelConfigsInPayload(payload) {
  return { payload, added: [], paths: [] };
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
      modelDetails: modelKeys.slice(0, 30).map((key) => ({
        key,
        displayName: data.models?.[key]?.displayName,
        model: data.models?.[key]?.model,
        disabled: data.models?.[key]?.disabled,
        isInternal: data.models?.[key]?.isInternal,
      })),
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

function summarizeCascadeModelConfigs(payload) {
  const summaries = [];

  function visit(value, pathParts) {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, pathParts.concat(String(index))));
      return;
    }
    if (Array.isArray(value.clientModelConfigs) || Array.isArray(value.clientModelSorts)) {
      summaries.push({
        path: pathParts.join(".") || "<root>",
        configs: Array.isArray(value.clientModelConfigs) ? value.clientModelConfigs.length : 0,
        sorts: Array.isArray(value.clientModelSorts) ? value.clientModelSorts.length : 0,
        labels: Array.isArray(value.clientModelConfigs)
          ? value.clientModelConfigs.map((config) => config?.label).filter(Boolean).slice(0, 30)
          : [],
      });
    }
    for (const [key, child] of Object.entries(value)) visit(child, pathParts.concat(key));
  }

  visit(payload, []);
  try {
    fs.writeFileSync(path.join(os.tmpdir(), "mitm-antigravity-cascade-models-summary.json"), `${JSON.stringify(summaries, null, 2)}\n`);
  } catch {
    // Summary file is best-effort debug output.
  }
  return summaries.map((item) => `${item.path}:configs=${item.configs} labels=${item.labels.join(",") || "-"}`).join(" | ") || "cascadeModels=-";
}

function normalizePrefix(prefix) {
  if (!prefix) return "";
  const lowered = String(prefix).toLowerCase();
  if (lowered === "false" || lowered === "0" || lowered === "none" || lowered === "off") return "";
  return prefix.endsWith("/") ? prefix : `${prefix}/`;
}

module.exports = {
  buildAntigravityModelList,
  builtInAliasForModel,
  decodeResponseBody,
  deriveModelsUrl,
  extractModelFromBody,
  extractModelFromUrl,
  fetchAvailableModels,
  getMappedEntry,
  getMappedModel,
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
  sendAntigravityModelList,
  stripLegacyDefaultMappings,
  summarizeAntigravityModelsResponse,
  summarizeCascadeModelConfigs,
  summarizeRequestBodyForLog,
};
