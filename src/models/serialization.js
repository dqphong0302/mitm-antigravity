const fs = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");

// Lazy require to avoid circular dependency with models.js
let _models;
function models() {
    if (!_models) _models = require("./");
    return _models;
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

function summarizeRequestBodyForLog(body) {
    const { parseJsonBody, collectModelCandidates } = models();
    const parsed = parseJsonBody(body);
    if (!parsed || typeof parsed !== "object") return `bodyBytes=${Buffer.isBuffer(body) ? body.length : String(body || "").length} body=unparseable`;
    const keys = Array.isArray(parsed) ? ["array"] : Object.keys(parsed).slice(0, 20);
    const modelCandidates = collectModelCandidates(parsed)
        .map((item) => `${item.path}=${item.value}`)
        .slice(0, 8);
    return `bodyKeys=${keys.join(",") || "-"} modelCandidates=${modelCandidates.join(",") || "-"}`;
}

module.exports = {
    decodeResponseBody,
    summarizeAntigravityModelsResponse,
    summarizeCascadeModelConfigs,
    summarizeRequestBodyForLog,
};
