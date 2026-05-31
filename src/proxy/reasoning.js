"use strict";

function normalizeReasoningEffort(value, options = {}) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return "";
  if (raw === "xhigh" || raw === "x-high" || raw === "extra-high" || raw === "extra_high") return "xhigh";
  if (raw === "high") return options.preferXhigh ? "xhigh" : "high";
  if (raw === "medium" || raw === "med") return "medium";
  if (raw === "low") return "low";
  return "";
}

function inferReasoningEffort(thinkingCfg, isThinkingModel, options = {}) {
  const preferXhigh = options.preferXhigh !== false;
  if (thinkingCfg) {
    const budget = Number(thinkingCfg.thinkingBudget || 0);
    const level = String(thinkingCfg.thinkingLevel || "").toUpperCase();
    if (level === "HIGH" || budget >= 10000) return preferXhigh ? "xhigh" : "high";
    if (level === "MEDIUM" || budget >= 4000) return "medium";
    if (level === "LOW" || budget > 0) return "low";
    if (thinkingCfg.includeThoughts) return "medium";
  }
  return isThinkingModel ? (preferXhigh ? "xhigh" : "high") : "";
}

function adaptiveGptModelForReasoning(modelName) {
  const model = String(modelName || "").trim();
  if (!model) return model;
  return model.replace(/(^|[/@:+-])gpt-5\.5-xhigh$/i, "$1gpt-5.5");
}

function shouldUseReasoningEffort(thinkingCfg, isThinkingModel) {
  return Boolean(thinkingCfg || isThinkingModel);
}

module.exports = {
  adaptiveGptModelForReasoning,
  inferReasoningEffort,
  normalizeReasoningEffort,
  shouldUseReasoningEffort,
};
