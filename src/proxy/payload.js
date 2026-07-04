"use strict";

// Pure payload inspection + repair helpers for Antigravity/Gemini request
// bodies: a compact one-line summarizer for logs, and thought-signature
// synthesis required by Google's schema validation on replayed tool calls.

const crypto = require("crypto");

function summarizePartTypes(parts) {
  if (!Array.isArray(parts)) return [];
  return parts.map((part) => {
    if (!part || typeof part !== "object") return typeof part;
    return Object.keys(part).sort().join("+") || "empty";
  });
}

function syntheticThoughtSignatureForFunctionCall(part) {
  const name = part && part.functionCall && part.functionCall.name ? String(part.functionCall.name) : "functionCall";
  const args = part && part.functionCall && part.functionCall.args ? JSON.stringify(part.functionCall.args) : "";
  return crypto
    .createHash("sha256")
    .update(`mitm-antigravity:${name}:${args}`)
    .digest("base64");
}

function ensureFunctionCallThoughtSignaturesInContents(contents) {
  if (!Array.isArray(contents)) return 0;
  let added = 0;
  for (const turn of contents) {
    if (!turn || !Array.isArray(turn.parts)) continue;
    for (const part of turn.parts) {
      if (!part || typeof part !== "object") continue;
      if (!part.functionCall || part.thoughtSignature) continue;
      part.thoughtSignature = syntheticThoughtSignatureForFunctionCall(part);
      added += 1;
    }
  }
  return added;
}

function summarizeAntigravityPayload(body) {
  const requestBody = body && body.request && typeof body.request === "object" ? body.request : body;
  const contents = Array.isArray(requestBody?.contents) ? requestBody.contents : [];
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const nestedMessages = Array.isArray(requestBody?.messages) ? requestBody.messages : [];
  const tools = [
    ...(Array.isArray(body?.tools) ? body.tools : []),
    ...(Array.isArray(requestBody?.tools) ? requestBody.tools : []),
  ];
  let partCount = 0;
  let textChars = 0;
  const roleCounts = {};
  const partTypeCounts = {};
  const toolNames = [];
  for (const turn of contents) {
    if (turn && turn.role) {
      const role = String(turn.role);
      roleCounts[role] = (roleCounts[role] || 0) + 1;
    }
    const parts = Array.isArray(turn?.parts) ? turn.parts : [];
    partCount += parts.length;
    for (const type of summarizePartTypes(parts)) partTypeCounts[type] = (partTypeCounts[type] || 0) + 1;
    for (const part of parts) {
      if (part && typeof part.text === "string") textChars += part.text.length;
    }
  }
  for (const tool of tools) {
    if (!tool || typeof tool !== "object") continue;
    if (Array.isArray(tool.functionDeclarations)) {
      for (const decl of tool.functionDeclarations) {
        if (decl && decl.name) toolNames.push(String(decl.name));
      }
    } else if (tool.function && tool.function.name) {
      toolNames.push(String(tool.function.name));
    }
  }
  const compactCounts = (counts) => Object.entries(counts)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}:${value}`)
    .join("|") || "-";
  return [
    `contents=${contents.length}`,
    `parts=${partCount}`,
    `textChars=${textChars}`,
    `messages=${messages.length}`,
    `requestMessages=${nestedMessages.length}`,
    `tools=${tools.length}`,
    `roleCounts=${compactCounts(roleCounts)}`,
    `partTypeCounts=${compactCounts(partTypeCounts)}`,
    `toolNames=${toolNames.slice(0, 8).join(",") || "-"}`,
    `topKeys=${Object.keys(body || {}).sort().join(",") || "-"}`,
    `requestKeys=${Object.keys(requestBody || {}).sort().join(",") || "-"}`,
  ].join(" ");
}

module.exports = {
  summarizePartTypes,
  syntheticThoughtSignatureForFunctionCall,
  ensureFunctionCallThoughtSignaturesInContents,
  summarizeAntigravityPayload,
};
