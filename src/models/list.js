const fs = require("fs");
const os = require("os");
const path = require("path");

const { ANTIGRAVITY_ALIASES } = require("../config/constants");
const { sendJson } = require("../system/http");

// Lazy require to avoid circular dependency with models.js
let _models;
function models() {
    if (!_models) _models = require("./");
    return _models;
}

function modelDisplayName(alias, mappedModel) {
    const names = {
        // ── Gemini 2.5 (legacy) ──────────────────────────────────────────────
        "gemini-2.5-pro": "Gemini 2.5 Pro",
        "gemini-2.5-flash": "Gemini 2.5 Flash",
        "gemini-2.5-flash-thinking": "Gemini 2.5 Flash Thinking",
        "gemini-2.5-flash-lite": "Gemini 2.5 Flash Lite",
        // ── Gemini 3 Flash ───────────────────────────────────────────────────
        "gemini-3-flash": "Gemini 3 Flash",
        "gemini-3-flash-agent": "Gemini 3 Flash Agent",
        "gemini-3-flash-a": "Gemini 3 Flash A",
        "gemini-3-flash-b": "Gemini 3 Flash B",
        "gemini-3-flash-c": "Gemini 3 Flash C",
        // ── Gemini 3 Pro ─────────────────────────────────────────────────────
        "gemini-3-pro-high": "Gemini 3 Pro High",
        "gemini-3-pro-low": "Gemini 3 Pro Low",
        // ── Gemini 3.1 ───────────────────────────────────────────────────────
        "gemini-3.1-pro-high": "Gemini 3.1 Pro High",
        "gemini-3.1-pro-low": "Gemini 3.1 Pro Low",
        "gemini-3.1-flash-lite": "Gemini 3.1 Flash Lite",
        "gemini-3.1-flash-image": "Gemini 3.1 Flash Image",
        // ── Gemini 3.5 (Antigravity 2.0 default) ─────────────────────────────
        "gemini-3.5-flash": "Gemini 3.5 Flash",
        "gemini-3.5-flash-thinking": "Gemini 3.5 Flash Thinking",
        "gemini-3.5-flash-low": "Gemini 3.5 Flash Low",
        "gemini-3.5-flash-extra-low": "Gemini 3.5 Flash Extra Low",
        "gemini-3.5-pro": "Gemini 3.5 Pro",
        "gemini-3.5-pro-thinking": "Gemini 3.5 Pro Thinking",
        // ── Claude 4.6 (versioned) ────────────────────────────────────────────
        "claude-sonnet-4-6": "Claude Sonnet 4.6",
        "claude-opus-4-6-thinking": "Claude Opus 4.6 Thinking",
        // ── Claude 4 short aliases (Antigravity 2.0) ──────────────────────────
        "claude-sonnet-4": "Claude Sonnet 4",
        "claude-opus-4": "Claude Opus 4",
        "claude-opus-4-thinking": "Claude Opus 4 Thinking",
        // ── GPT / OSS ────────────────────────────────────────────────────────
        "gpt-oss-120b-medium": "GPT OSS 120B Medium",
        // ── Tab / preview ─────────────────────────────────────────────────────
        "tab_flash_lite_preview": "Tab Flash Lite Preview",
        "tab_jump_flash_lite_preview": "Tab Jump Flash Lite Preview",
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
    const { mappingModel, getMappedModel } = models();
    const modelMap = options.modelMap || {};
    const resetTime = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const entries = {};

    for (const alias of ANTIGRAVITY_ALIASES) {
        const mapped = mappingModel(modelMap[alias]) || getMappedModel(alias, options) || "";
        entries[alias] = fallbackModelListEntry(alias, mapped);
        entries[alias].quotaInfo.resetTime = resetTime;
    }

    return { models: entries };
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

module.exports = {
    buildAntigravityModelList,
    fallbackModelListEntry,
    mergeAntigravityModelListPayload,
    mergeCascadeModelConfigData,
    mergeCascadeModelConfigsInPayload,
    modelDisplayName,
    sendAntigravityModelList,
};
