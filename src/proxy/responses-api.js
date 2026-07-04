"use strict";

// GPT / OpenAI Responses-API adapter.
//
// Antigravity speaks Gemini format; some upstream models (cx/gpt-*) speak the
// OpenAI Responses API (`input[]`, `output[]`). These helpers translate both
// directions and transform the streaming SSE back into Gemini-wrapped chunks.

const { MB, ensureBufferLimit } = require("./memory");
const { normalizeReasoningEffort } = require("./reasoning");
const {
  isInternalInstructionLeak,
  stripInternalInstructionLeaks,
} = require("./internal-instruction-sanitizer");
const { isResponseWritable, writeResponseChunk } = require("./stream-io");

const MAX_SSE_BUFFER_BYTES = 6 * MB;

/** GPT model names (or legacy cx/ prefix) → OpenAI Responses API instead of chat/completions */
function isGptResponsesModel(modelName) {
  const normalized = String(modelName || "").toLowerCase();
  return normalized.includes("gpt") || normalized.startsWith("cx/");
}

function thoughtPart(text) {
  if (!text || isInternalInstructionLeak(text)) return null;
  return { thought: true, text };
}

function chatCompletionsRouterUrl(routerUrl) {
  const raw = String(routerUrl || "").trim().replace(/\/+$/, "");
  if (raw.endsWith("/chat/completions")) return raw;
  if (raw.endsWith("/responses")) return `${raw.slice(0, -"/responses".length)}/chat/completions`;
  return `${raw}/chat/completions`;
}

/**
 * Chuyển Gemini-format request body → OpenAI Responses API body.
 * Responses API dùng `input[]` thay vì `messages[]`, role "model"→"assistant".
 */
function buildResponsesApiBody(geminiBody, reasoningEffort) {
  const requestBody = geminiBody.request && typeof geminiBody.request === "object"
    ? geminiBody.request
    : geminiBody;
  const {
    contents = [],
    systemInstruction,
    generationConfig = {},
    stream,
  } = requestBody;
  const model = geminiBody.model || requestBody.model;

  const input = [];

  // System instruction
  const sysParts = systemInstruction && systemInstruction.parts;
  if (sysParts && sysParts.length) {
    const sysText = sysParts.map((p) => p.text || "").filter(Boolean).join("\n");
    if (sysText) input.push({ role: "system", content: sysText });
  }

  // Conversation turns
  for (const turn of contents) {
    const role = turn.role === "model" ? "assistant" : (turn.role || "user");
    const parts = Array.isArray(turn.parts) ? turn.parts : [];
    const content = [];
    const text = parts
      .filter((p) => typeof p.text === "string" && p.thought !== true)
      .map((p) => p.text)
      .join("");
    if (text) content.push({ type: "input_text", text });
    for (const part of parts) {
      const inlineData = part.inlineData || part.inline_data;
      if (inlineData && inlineData.data && inlineData.mimeType) {
        content.push({
          type: "input_image",
          image_url: `data:${inlineData.mimeType};base64,${inlineData.data}`,
        });
      }
    }
    if (content.length === 1 && content[0].type === "input_text") input.push({ role, content: content[0].text });
    else if (content.length > 0) input.push({ role, content });
  }

  // Keep GPT 5.5 on the regular model. Do not auto-upgrade to gpt-5.5-xhigh.
  // reasoning.summary: "detailed" bắt buộc để nhận thinking text trong response.
  const effort = normalizeReasoningEffort(reasoningEffort, { preferXhigh: true }) || "xhigh";

  const result = {
    model,
    reasoning: { effort, summary: "detailed" },
    input,
    stream: stream !== undefined ? stream : undefined,
  };

  // Do not forward Gemini maxOutputTokens to /responses. The current 9router
  // Responses adapter rejects max_output_tokens for cx/gpt-* models.

  return result;
}

/**
 * Chuyển Responses API JSON response → Gemini candidates format.
 * Dùng cho non-streaming (Antigravity gọi :generateContent không có stream).
 */
function responsesApiToGeminiJson(responsesBody) {
  const output = responsesBody.output || [];
  const parts = [];

  for (const item of output) {
    if (item.type === "reasoning") {
      // summary là mảng {type:"summary_text", text:"..."}
      for (const s of item.summary || []) {
        const part = thoughtPart(s.text);
        if (part) parts.push(part);
      }
    } else if (item.type === "message") {
      for (const c of item.content || []) {
        if (c.type === "output_text" && c.text) {
          parts.push({ text: c.text });
        }
      }
    }
  }

  const usage = responsesBody.usage || {};
  return {
    candidates: [{
      content: { parts, role: "model" },
      finishReason: "STOP",
      index: 0,
    }],
    usageMetadata: {
      promptTokenCount:     usage.input_tokens  || 0,
      candidatesTokenCount: usage.output_tokens || 0,
      totalTokenCount:      usage.total_tokens  || 0,
    },
  };
}

/**
 * Transform streaming Responses API SSE → Gemini SSE.
 * Đọc từng chunk từ response.body, parse SSE events, emit Gemini format.
 *
 * Responses API events quan tâm:
 *   response.reasoning_summary_text.delta → thought:true part
 *   response.output_text.delta            → text part
 *   response.completed                    → finishReason:STOP + [DONE]
 */
async function transformResponsesApiStream(responseBody, res) {
  const reader = responseBody.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let finished = false;
  let outputText = "";

  async function emitGeminiText(text, finishReason) {
    if (!text) return;
    const candidate = {
      content: { parts: [{ text }], role: "model" },
    };
    if (finishReason) candidate.finishReason = finishReason;
    const chunk = JSON.stringify({
      response: {
        candidates: [candidate],
      },
    });
    await writeResponseChunk(res, `data: ${chunk}\n\n`, reader);
  }

  async function emitFinish() {
    if (finished) return;
    finished = true;
    // Buffer GPT Responses deltas into one Gemini chunk. Antigravity 1.107.0
    // can crash on empty/final-only chunks while consuming Gemini SSE. It also
    // expects an explicit stream sentinel on this internal Cloud Code path.
    await emitGeminiText(stripInternalInstructionLeaks(outputText) || " ", "STOP");
    await writeResponseChunk(res, "data: [DONE]\n\n", reader);
  }

  try {
    while (true) {
      if (res.writableEnded || res.destroyed) break;
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      ensureBufferLimit(Buffer.byteLength(buffer), MAX_SSE_BUFFER_BYTES, "Responses API SSE buffer");

      // SSE events được phân tách bởi "\n\n"
      const events = buffer.split("\n\n");
      buffer = events.pop(); // giữ phần chưa hoàn chỉnh

      for (const event of events) {
        // Tìm dòng "data: ..."
        const dataLine = event.split("\n").find((l) => l.startsWith("data:"));
        if (!dataLine) continue;

        const raw = dataLine.slice(5).trim();
        if (raw === "[DONE]" || raw === "null") continue;

        let parsed;
        try { parsed = JSON.parse(raw); } catch { continue; }

        const type = parsed.type || "";

        if (type === "response.reasoning_summary_text.delta") {
          // Do not stream reasoning summary as Gemini thought parts. Some
          // Antigravity builds crash while consuming thought-only stream chunks.
          continue;

        } else if (type === "response.output_text.delta") {
          const delta = parsed.delta || "";
          if (delta) outputText += delta;

        } else if (type === "response.completed") {
          await emitFinish();
        }
        // Các events khác (response.created, in_progress, v.v.) → bỏ qua
      }
    }
    if (!finished && !res.writableEnded && !res.destroyed) await emitFinish();
  } finally {
    reader.releaseLock();
  }
}

module.exports = {
  isGptResponsesModel,
  chatCompletionsRouterUrl,
  buildResponsesApiBody,
  responsesApiToGeminiJson,
  transformResponsesApiStream,
  thoughtPart,
};
