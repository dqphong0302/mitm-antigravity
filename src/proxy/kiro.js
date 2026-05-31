"use strict";

function isKiroProviderModel(modelName) {
  return /^(kr|kiro)\//i.test(String(modelName || ""));
}

function sanitizeKiroRequestBody(body) {
  if (!body || typeof body !== "object") return body;

  delete body.reasoning_effort;
  delete body.thinking;

  const requestBody = body.request && typeof body.request === "object" ? body.request : body;

  for (const cfg of [requestBody.generationConfig, body !== requestBody ? body.generationConfig : null]) {
    if (cfg && typeof cfg === "object") {
      delete cfg.thinkingConfig;
    }
  }

  delete requestBody.safetySettings;
  if (body !== requestBody) delete body.safetySettings;

  const allowedTopLevel = new Set([
    "model", "request", "contents", "messages",
    "userAgent", "stream", "system", "systemInstruction",
    "tools", "toolConfig", "tool_config",
    "generationConfig",
  ]);
  for (const key of Object.keys(body)) {
    if (!allowedTopLevel.has(key)) delete body[key];
  }

  if (requestBody !== body) delete requestBody.model;

  return body;
}

module.exports = {
  isKiroProviderModel,
  sanitizeKiroRequestBody,
};
