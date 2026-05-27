const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const test = require("node:test");
const vm = require("node:vm");

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mitm-antigravity-test-"));
const hostsPath = path.join(tempRoot, "hosts");
process.env.MITM_APP_DIR = tempRoot;
process.env.MITM_HOSTS_FILE = hostsPath;
process.env.MITM_APP_LOG = path.join(tempRoot, "backend.log");
process.env.MITM_PROXY_LOG = path.join(tempRoot, "proxy.log");

const mitm = require("../index");
const scriptPath = path.join(__dirname, "..", "index.js");

test.after(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

test("parsePidsFromOutput returns unique pids from shell output", () => {
  assert.deepEqual(mitm.parsePidsFromOutput("123\n456 123\n\n"), ["123", "456"]);
});

test("formatPortOwners renders process names and pids", () => {
  assert.equal(mitm.formatPortOwners([{ pid: "123", name: "node" }, { pid: "456", name: "nginx" }]), "node#123, nginx#456");
});

test("proxy health only accepts the current JS proxy", () => {
  assert.equal(mitm.isManagedProxyHealthPayload(200, JSON.stringify({
    ok: true,
    app: mitm.APP_NAME,
  })), true);
  assert.equal(mitm.isManagedProxyHealthPayload(200, JSON.stringify({
    ok: true,
    app: "mitm-antigravity-python",
  })), false);
  assert.equal(mitm.isManagedProxyHealthPayload(500, JSON.stringify({
    ok: true,
    app: mitm.APP_NAME,
  })), false);
});

test("classifyModelCheckFailure identifies common upstream failures", () => {
  assert.equal(mitm.classifyModelCheckFailure({ code: "ECONNREFUSED", message: "connect ECONNREFUSED" }).category, "router_unreachable");
  assert.equal(mitm.classifyModelCheckFailure(null, { status: 401, message: "Unauthorized" }).category, "auth_failed");
  assert.equal(mitm.classifyModelCheckFailure(null, { status: 404, message: "No active credentials for provider" }).category, "provider_credentials_missing");
  assert.equal(mitm.classifyModelCheckFailure(null, { status: 524, message: "timeout" }).category, "upstream_transient");
});

test("reasoning helpers preserve xhigh effort without changing GPT 5.5 model", () => {
  assert.equal(mitm.normalizeReasoningEffort("high", { preferXhigh: true }), "xhigh");
  assert.equal(mitm.normalizeReasoningEffort("x-high", { preferXhigh: true }), "xhigh");
  assert.equal(mitm.inferReasoningEffort({ thinkingLevel: "HIGH" }, false, { preferXhigh: true }), "xhigh");
  assert.equal(mitm.inferReasoningEffort({ thinkingBudget: 12000 }, false, { preferXhigh: true }), "xhigh");
  assert.equal(mitm.inferReasoningEffort(null, true, { preferXhigh: true }), "xhigh");
});

test("adaptiveGptModelForReasoning keeps GPT 5.5 on regular model", () => {
  assert.equal(mitm.adaptiveGptModelForReasoning("gpt-5.5", "xhigh"), "gpt-5.5");
  assert.equal(mitm.adaptiveGptModelForReasoning("cx/gpt-5.5", "high"), "cx/gpt-5.5");
  assert.equal(mitm.adaptiveGptModelForReasoning("cx/gpt-5.5", "medium"), "cx/gpt-5.5");
  assert.equal(mitm.adaptiveGptModelForReasoning("cx/gpt-5.5-xhigh", "xhigh"), "cx/gpt-5.5");
});

test("reasoning effort is only used for thinking requests", () => {
  assert.equal(mitm.shouldUseReasoningEffort(null, false), false);
  assert.equal(mitm.shouldUseReasoningEffort({ includeThoughts: true }, false), true);
  assert.equal(mitm.shouldUseReasoningEffort(null, true), true);
});

test("isKiroProviderModel detects every Kiro prefix variant", () => {
  // 9router exposes Kiro under both `kr/` and `kiro/`. Both must trigger sanitization
  // or AWS CodeWhisperer returns HTTP 400 "Improperly formed request".
  assert.equal(mitm.isKiroProviderModel("kr/claude-sonnet-4.6-thinking-agentic"), true);
  assert.equal(mitm.isKiroProviderModel("kiro/claude-sonnet-4.6-thinking-agentic"), true);
  assert.equal(mitm.isKiroProviderModel("KIRO/claude-sonnet-4.6-agentic"), true);
  assert.equal(mitm.isKiroProviderModel("KR/Claude-Opus"), true);

  // Non-Kiro providers must NOT match.
  assert.equal(mitm.isKiroProviderModel("cx/gpt-5.5"), false);
  assert.equal(mitm.isKiroProviderModel("ag/claude-opus-4-6-thinking"), false);
  assert.equal(mitm.isKiroProviderModel("anthropic/claude-3-opus"), false);
  assert.equal(mitm.isKiroProviderModel(""), false);
  assert.equal(mitm.isKiroProviderModel(null), false);
});

test("sanitizeKiroRequestBody strips fields Kiro rejects", () => {
  const body = {
    model: "kiro/claude-sonnet-4.6-thinking-agentic",
    request: {
      contents: [{ role: "user", parts: [{ text: "hi" }] }],
      generationConfig: {
        thinkingConfig: { thinkingBudget: 16000, includeThoughts: true },
        temperature: 0.7,
      },
      tools: [{ functionDeclarations: [{ name: "search", parameters: {} }] }],
      safetySettings: [],
      model: "gemini-3.1-pro-high",
    },
    reasoning_effort: "xhigh",
    thinking: { type: "enabled", budget_tokens: 16000 },
    safetySettings: [],
    userAgent: "antigravity",
    stream: true,
    customMetadata: { foo: "bar" },
    // Top-level tools (some Antigravity payloads put them here too) must
    // survive — they're MCP tool definitions, stripping them turns tool
    // calls into raw "<tool_call>" text in chat.
    tools: [{ functionDeclarations: [{ name: "echo", parameters: {} }] }],
  };

  mitm.sanitizeKiroRequestBody(body);

  // Top-level: only Kiro-allowed keys remain (now includes tools).
  assert.deepEqual(
    Object.keys(body).sort(),
    ["model", "request", "stream", "tools", "userAgent"].sort()
  );
  assert.equal(body.reasoning_effort, undefined);
  assert.equal(body.thinking, undefined);
  assert.equal(body.safetySettings, undefined);
  assert.equal(body.customMetadata, undefined);
  // Tools must survive sanitization so MCP tool calling works.
  assert.deepEqual(body.tools, [{ functionDeclarations: [{ name: "echo", parameters: {} }] }]);

  // Inside request: stale model dropped, thinkingConfig stripped, temperature
  // preserved, safetySettings stripped, tools preserved.
  assert.equal(body.request.model, undefined);
  assert.equal(body.request.generationConfig.thinkingConfig, undefined);
  assert.equal(body.request.generationConfig.temperature, 0.7);
  assert.equal(body.request.safetySettings, undefined);
  assert.deepEqual(
    body.request.tools,
    [{ functionDeclarations: [{ name: "search", parameters: {} }] }]
  );
  assert.deepEqual(body.request.contents, [{ role: "user", parts: [{ text: "hi" }] }]);

  // Top-level model must not be touched.
  assert.equal(body.model, "kiro/claude-sonnet-4.6-thinking-agentic");
});

test("sanitizeKiroRequestBody handles flat (non-nested) body without breaking", () => {
  // Some Antigravity payloads do not wrap fields in `request`; helper must still strip.
  const body = {
    model: "kr/claude-sonnet-4.6-agentic",
    contents: [{ role: "user", parts: [{ text: "hi" }] }],
    generationConfig: { temperature: 0.4, thinkingConfig: { thinkingBudget: 8000 } },
    tools: [{ functionDeclarations: [{ name: "search", parameters: {} }] }],
    reasoning_effort: "high",
    userAgent: "antigravity",
  };

  mitm.sanitizeKiroRequestBody(body);

  assert.equal(body.reasoning_effort, undefined);
  assert.equal(body.generationConfig.thinkingConfig, undefined);
  assert.equal(body.generationConfig.temperature, 0.4);
  // Tools must remain so MCP tool calling works through Kiro.
  assert.deepEqual(
    body.tools,
    [{ functionDeclarations: [{ name: "search", parameters: {} }] }]
  );
  assert.deepEqual(body.contents, [{ role: "user", parts: [{ text: "hi" }] }]);
  assert.equal(body.model, "kr/claude-sonnet-4.6-agentic");
});

test("coerceJsonSchemaTypes converts stringified numerics to declared types", () => {
  const schema = {
    type: "object",
    properties: {
      // Reproducer for: "Invalid schema for function 'mcp_phong-mcp_distill':
      //   '10' is not of type 'integer'"
      max_chunks: { type: "integer", default: "10", minimum: "0", maximum: "100" },
      ratio: { type: "number", default: "0.75", multipleOf: "0.01" },
      enabled: { type: "boolean", default: "true" },
      label: { type: "string", default: 42 },
      mode: { type: "string", enum: ["fast", "slow"] },
      level: { type: "INTEGER", default: "5" }, // Gemini uppercase form
    },
  };

  mitm.coerceJsonSchemaTypes(schema);

  assert.strictEqual(schema.properties.max_chunks.default, 10);
  assert.strictEqual(schema.properties.max_chunks.minimum, 0);
  assert.strictEqual(schema.properties.max_chunks.maximum, 100);
  assert.strictEqual(schema.properties.ratio.default, 0.75);
  assert.strictEqual(schema.properties.ratio.multipleOf, 0.01);
  assert.strictEqual(schema.properties.enabled.default, true);
  assert.strictEqual(schema.properties.label.default, "42");
  assert.deepEqual(schema.properties.mode.enum, ["fast", "slow"]);
  assert.strictEqual(schema.properties.level.default, 5);
});

test("coerceJsonSchemaTypes leaves unparseable values untouched", () => {
  const schema = {
    type: "integer",
    default: "not-a-number",
    enum: ["foo", "5", "bar"],
  };
  mitm.coerceJsonSchemaTypes(schema);
  assert.strictEqual(schema.default, "not-a-number");
  // "5" coerces, others stay; we accept partial coercion to keep behavior simple.
  assert.deepEqual(schema.enum, ["foo", 5, "bar"]);
});

test("coerceJsonSchemaTypes handles nested objects, arrays, and combinators", () => {
  const schema = {
    type: "object",
    properties: {
      page: {
        type: "object",
        properties: {
          size: { type: "integer", default: "20" },
        },
      },
      items: {
        type: "array",
        items: { type: "integer", default: "1" },
      },
      flag: {
        anyOf: [
          { type: "integer", default: "0" },
          { type: "string" },
        ],
      },
    },
  };

  mitm.coerceJsonSchemaTypes(schema);

  assert.strictEqual(schema.properties.page.properties.size.default, 20);
  assert.strictEqual(schema.properties.items.items.default, 1);
  assert.strictEqual(schema.properties.flag.anyOf[0].default, 0);
});

test("coerceToolSchemasInBody fixes Gemini and OpenAI tool definitions", () => {
  const body = {
    request: {
      tools: [
        {
          functionDeclarations: [
            {
              name: "mcp_phong-mcp_distill",
              parameters: {
                type: "OBJECT",
                properties: {
                  max_chunks: { type: "integer", default: "10" },
                },
              },
            },
          ],
        },
      ],
    },
    tools: [
      {
        type: "function",
        function: {
          name: "search",
          parameters: {
            type: "object",
            properties: {
              limit: { type: "integer", default: "25" },
            },
          },
        },
      },
    ],
  };

  mitm.coerceToolSchemasInBody(body);

  assert.strictEqual(
    body.request.tools[0].functionDeclarations[0].parameters.properties.max_chunks.default,
    10
  );
  assert.strictEqual(body.tools[0].function.parameters.properties.limit.default, 25);
});

test("coerceToolSchemasInBody is a no-op when no tools are present", () => {
  const body = { model: "cx/gpt-5.5", request: { contents: [] } };
  const before = JSON.stringify(body);
  mitm.coerceToolSchemasInBody(body);
  assert.equal(JSON.stringify(body), before);
});

test("stripInternalInstructionLeaks removes leaked internal instruction text", () => {
  const leaked = "CRITICAL INSTRUCTION 1: use tool A; CRITICAL INSTRUCTION 2: use tool B; visible answer";
  const antigravityLeak = "CRITICAL INSTRUCTION 1: specific tools first: view_file for relevant workflow, run_command for read-only secret discovery and controlled copy, write_to_file for task/walkthrough. Avoid cat, grep, sed, ls. CRITICAL INSTRUCTION 2: related tools: view_file, run_command, command_status, write_to_file. Need inspect server workflow before old LXC access.";
  assert.equal(mitm.stripInternalInstructionLeaks(leaked), "visible answer");
  assert.equal(mitm.stripInternalInstructionLeaks(antigravityLeak), "");
  assert.equal(mitm.isInternalInstructionLeak(leaked), true);
});

test("sanitizeInternalInstructionJsonText removes leaks without corrupting JSON", () => {
  const raw = JSON.stringify({
    response: {
      candidates: [{
        content: {
          parts: [{
            text: "CRITICAL INSTRUCTION 1: specific tools first: view_file for relevant workflow, run_command for read-only secret discovery and controlled copy, write_to_file for task/walkthrough. Avoid cat, grep, sed, ls.",
          }],
        },
      }],
    },
  });

  const safe = mitm.sanitizeInternalInstructionJsonText(raw);
  const parsed = JSON.parse(safe);
  assert.equal(parsed.response.candidates[0].content.parts[0].text, "");
  assert.doesNotMatch(safe, /CRITICAL INSTRUCTION|view_file|run_command|write_to_file/);
});

test("createInternalInstructionSseSanitizer removes split leaked instructions", () => {
  const sanitizer = mitm.createInternalInstructionSseSanitizer();
  const first = `data: ${JSON.stringify({
    response: {
      candidates: [{
        content: { parts: [{ text: "CRITICAL INSTRU" }] },
      }],
    },
  })}\n\n`;
  const second = `data: ${JSON.stringify({
    response: {
      candidates: [{
        content: {
          parts: [{
            text: "CTION 1: specific tools first: view_file for relevant workflow, run_command for read-only secret discovery and controlled copy, write_to_file for task/walkthrough. Avoid cat, grep, sed, ls. CRITICAL INSTRUCTION 2: related tools: view_file, run_command, command_status, write_to_file. Need inspect server workflow before old LXC access.",
          }],
        },
      }],
    },
  })}\n\n`;

  const output = [
    sanitizer.push(first.slice(0, 12)),
    sanitizer.push(first.slice(12)),
    sanitizer.push(second),
    sanitizer.push("data: [DONE]\n\n"),
    sanitizer.flush(),
  ].join("");

  assert.doesNotMatch(output, /CRITICAL INSTRUCTION|view_file|run_command|write_to_file|old LXC/);
  for (const line of output.split(/\n/).filter((item) => item.startsWith("data: "))) {
    if (line === "data: [DONE]") continue;
    JSON.parse(line.slice(6));
  }
});

test("stripDnsEntriesFromHostsContent removes managed and exact host entries only", () => {
  const input = [
    "127.0.0.1 localhost",
    "10.0.0.1 notdaily-cloudcode-pa.googleapis.com",
    "127.0.0.1 daily-cloudcode-pa.googleapis.com # old entry",
    mitm.DNS_BLOCK_BEGIN,
    "127.0.0.1 cloudcode-pa.googleapis.com",
    "::1 cloudcode-pa.googleapis.com",
    mitm.DNS_BLOCK_END,
    "",
  ].join("\n");

  const result = mitm.stripDnsEntriesFromHostsContent(input, [
    "daily-cloudcode-pa.googleapis.com",
    "cloudcode-pa.googleapis.com",
  ]);

  assert.equal(result.removed, true);
  assert.equal(result.removedHosts["daily-cloudcode-pa.googleapis.com"], true);
  assert.equal(result.removedHosts["cloudcode-pa.googleapis.com"], true);
  assert.match(result.content, /notdaily-cloudcode-pa\.googleapis\.com/);
  assert.doesNotMatch(result.content, /(^|\s)daily-cloudcode-pa\.googleapis\.com(\s|$)/m);
  assert.doesNotMatch(result.content, /(^|\s)cloudcode-pa\.googleapis\.com(\s|$)/m);
});

test("addDNSEntries and removeDNSEntries work against an override hosts file", async () => {
  fs.writeFileSync(hostsPath, "127.0.0.1 localhost\n");

  const targetHosts = [
    "daily-cloudcode-pa.googleapis.com",
    "cloudcode-pa.googleapis.com",
  ];
  const addResult = await mitm.addDNSEntries({ targetHosts, remoteIp: "127.0.0.1" });
  const afterAdd = fs.readFileSync(hostsPath, "utf8");

  assert.equal(addResult.added, true);
  assert.match(afterAdd, new RegExp(mitm.DNS_BLOCK_BEGIN));
  assert.match(afterAdd, /127\.0\.0\.1 daily-cloudcode-pa\.googleapis\.com/);
  assert.match(afterAdd, /::1 cloudcode-pa\.googleapis\.com/);

  const removeResult = await mitm.removeDNSEntries({ targetHosts });
  const afterRemove = fs.readFileSync(hostsPath, "utf8");

  assert.equal(removeResult.removed, true);
  assert.deepEqual(removeResult.results.map((item) => item.removed), [true, true]);
  assert.equal(afterRemove, "127.0.0.1 localhost\n");
});

test("removeDNSEntries restores hosts content around the managed DNS block", async () => {
  const before = [
    "127.0.0.1 localhost",
    "# local development aliases",
    "10.10.10.10 internal.example.test",
    "",
  ].join("\n");
  fs.writeFileSync(hostsPath, before);

  const targetHosts = [
    "daily-cloudcode-pa.googleapis.com",
    "cloudcode-pa.googleapis.com",
  ];
  await mitm.addDNSEntries({ targetHosts, remoteIp: "127.0.0.1" });
  assert.notEqual(fs.readFileSync(hostsPath, "utf8"), before);

  const removeResult = await mitm.removeDNSEntries({ targetHosts });

  assert.equal(removeResult.removed, true);
  assert.equal(fs.readFileSync(hostsPath, "utf8"), before);
});

test("model list includes built-in Antigravity aliases without explicit mappings", () => {
  const list = mitm.buildAntigravityModelList({ modelMap: {}, mockModelList: true });
  assert.ok(list.models["gemini-3-flash-agent"]);
  assert.ok(list.models["gemini-2.5-pro"]);
  assert.ok(list.models["claude-opus-4-6-thinking"]);
});

test("model list merge is passthrough and does not add custom aliases", () => {
  const upstream = {
    account: { verified: true },
    agentModelSorts: [
      { displayName: "Agent", groups: [{ displayName: "All", modelIds: ["gemini-2.5-pro"] }] },
    ],
    commandModelIds: ["gemini-2.5-pro"],
    commitMessageModelIds: ["gemini-2.5-pro"],
    models: {
      "gemini-2.5-pro": { id: "gemini-2.5-pro", displayName: "Gemini 2.5 Pro", quotaInfo: { remainingFraction: 0.5 } },
      "chat_23310": { id: "chat_23310", displayName: "Internal Chat", model: "MODEL_CHAT_23310", disabled: false, isInternal: true },
      "claude-opus-4-6-thinking": {
        id: "claude-opus-4-6-thinking",
        displayName: "Claude Opus 4.6 Thinking",
        model: "MODEL_PLACEHOLDER_M26",
        supportsImages: true,
        supportedMimeTypes: { "image/png": true },
        quotaInfo: { remainingFraction: 0.75 },
      },
    },
  };

  const result = mitm.mergeAntigravityModelListPayload(upstream, {
    modelMap: {
      "gemini-3-flash": "cx/gemini-3-flash",
      "custom-router-model": "cx/custom-router-model",
    },
  });

  assert.equal(result.payload, upstream);
  assert.equal(result.payload.account.verified, true);
  assert.equal(result.payload.models["gemini-2.5-pro"].quotaInfo.remainingFraction, 0.5);
  assert.equal(result.payload.models["custom-router-model"], undefined);
  assert.deepEqual(result.added, []);
  assert.equal(result.existingCount, 3);
  assert.equal(result.totalCount, 3);
  assert.equal(result.payload.models["gemini-3-pro-high"], undefined);
});

test("user status model config merge is passthrough", () => {
  const upstream = {
    userStatus: {
      cascadeModelConfigData: {
        clientModelConfigs: [
          {
            label: "Gemini 2.5 Pro",
            modelOrAlias: { choice: { case: "model", value: "gemini-2.5-pro" } },
            supportedMimeTypes: {},
          },
        ],
        clientModelSorts: [
          { name: "Recommended", groups: [{ groupName: "Recommended", modelLabels: ["Gemini 2.5 Pro"] }] },
        ],
      },
    },
  };

  const result = mitm.mergeCascadeModelConfigsInPayload(upstream, {
    modelMap: { "custom-router-model": "cx/custom-router-model" },
  });

  const configData = result.payload.userStatus.cascadeModelConfigData;
  assert.equal(result.payload, upstream);
  assert.deepEqual(result.added, []);
  assert.deepEqual(result.paths, []);
  assert.equal(configData.clientModelConfigs.length, 1);
  assert.deepEqual(configData.clientModelSorts[0].groups[0].modelLabels, ["Gemini 2.5 Pro"]);
});

test("placeholder model ids route only to mapped built-in aliases", () => {
  const options = {
    modelMap: {
      "claude-opus-4-6-thinking": "cx/opus",
      "gemini-2.5-pro": "cx/gemini-2.5-pro",
      "gemini-3.1-flash-lite": "cx/gemini-3.1-flash-lite",
      "custom-router-model": "cx/custom-router-model",
    },
  };

  assert.equal(mitm.extractModelFromBody(Buffer.from(JSON.stringify({
    request: { plannerConfig: { requestedModel: { choice: { case: "alias", value: "claude-opus-4-6-thinking" } } } },
  }))), "claude-opus-4-6-thinking");
  assert.equal(mitm.getMappedEntry("MODEL_PLACEHOLDER_M26", options).model, "cx/opus");
  assert.equal(mitm.getMappedEntry("291", options).model, "cx/opus");
  assert.equal(mitm.getMappedEntry("claude-opus-4-6-thinking", options).model, "cx/opus");
  assert.equal(mitm.getMappedEntry("MODEL_GOOGLE_GEMINI_2_5_PRO", options).model, "cx/gemini-2.5-pro");
  assert.equal(mitm.getMappedEntry("MODEL_PLACEHOLDER_M50", options).model, "cx/gemini-3.1-flash-lite");
  assert.equal(mitm.getMappedEntry("custom-router-model", options), null);
});

test("chat model detection handles nested Antigravity model names", () => {
  const body = Buffer.from(JSON.stringify({
    request: {
      defaultAgentModelId: "projects/p/locations/us/publishers/google/models/claude-opus-4-6-thinking",
    },
  }));

  assert.equal(
    mitm.extractModelFromBody(body),
    "projects/p/locations/us/publishers/google/models/claude-opus-4-6-thinking"
  );
  assert.equal(
    mitm.getMappedEntry(mitm.extractModelFromBody(body), {
      modelMap: { "claude-opus-4-6-thinking": "ag/claude-opus-4-6-thinking" },
    }).model,
    "ag/claude-opus-4-6-thinking"
  );
  assert.match(mitm.summarizeRequestBodyForLog(body), /defaultAgentModelId=/);
});

test("normalizeModelMap keeps built-in aliases and drops custom mappings", () => {
  const result = mitm.normalizeModelMap({
    "claude-opus-4-6-thinking": "ag/claude-opus-4-6-thinking",
    "gemini-3-flash": { model: "cx/gemini-3-flash", reasoning_effort: "low" },
    "gpt-oss-120b-medium": "cx/gpt-oss",
    "gemini-2.5-pro": "cx/not-mappable",
    "custom-router-model": "cx/custom-router-model",
  });

  assert.equal(result["claude-opus-4-6-thinking"], undefined);
  assert.deepEqual(result["gemini-3-flash"], { model: "cx/gemini-3-flash", reasoning_effort: "low" });
  assert.equal(result["gpt-oss-120b-medium"], "cx/gpt-oss");
  assert.equal(result["gemini-2.5-pro"], "cx/not-mappable");
  assert.equal(result["custom-router-model"], undefined);
});

test("mapped Antigravity 3.1 entries preserve router model and reasoning effort", () => {
  const entry = mitm.getMappedEntry("gemini-3.1-pro-high", {
    modelMap: {
      "gemini-3.1-pro-high": {
        model: "cx/gpt-5.5",
        reasoning_effort: "high",
      },
    },
  });

  assert.deepEqual(entry, { model: "cx/gpt-5.5", reasoning_effort: "high" });
});

test("proxy defaults to passthrough except model list and LLM endpoints", () => {
  assert.equal(mitm.isFetchAvailableModelsRequest("/v1internal:fetchAvailableModels"), true);
  assert.equal(mitm.isLoadCodeAssistRequest("/v1internal:loadCodeAssist"), true);
  assert.equal(mitm.isChatRequestUrl("/v1internal:streamGenerateContent"), true);
  assert.equal(mitm.isAccountBootstrapRequest("/v1internal:fetchUserInfo"), true);
  assert.equal(mitm.isAccountBootstrapRequest("/v1internal:listExperiments"), true);
  assert.equal(mitm.isAccountBootstrapRequest("/v1internal:onboardUser"), true);
  assert.equal(mitm.isAccountBootstrapRequest("/v1internal:recordTrajectoryAnalytics"), true);
  assert.equal(mitm.isChatRequestUrl("/v1internal:fetchUserInfo"), false);
  assert.equal(mitm.isAccountBootstrapRequest("/v1internal:streamGenerateContent"), false);
});

test("chat passthrough logging records unmapped model names", () => {
  const messages = [];
  const originalLog = console.log;
  const bodyBuffer = Buffer.from(JSON.stringify({ model: "gemini-3-flash-agent" }));

  try {
    console.log = (message) => messages.push(String(message));
    mitm.logChatPassthrough({
      req: { method: "POST", url: "/v1internal:streamGenerateContent" },
      bodyBuffer,
      statusCode: 200,
      targetHost: "cloudcode-pa.googleapis.com",
      requestPath: "/v1internal:streamGenerateContent",
    });
  } finally {
    console.log = originalLog;
  }

  const added = messages.join("\n");
  assert.match(added, /CHAT PASS/);
  assert.match(added, /model=gemini-3-flash-agent/);
});

test("auth passthrough logging records successful bootstrap requests", () => {
  const messages = [];
  const originalLog = console.log;

  try {
    console.log = (message) => messages.push(String(message));
    mitm.logPassthroughResponse({
      req: { method: "POST", url: "/v1internal:fetchUserInfo" },
      statusCode: 200,
      targetHost: "cloudcode-pa.googleapis.com",
      requestPath: "/v1internal:fetchUserInfo",
      raw: Buffer.from("{}"),
      headers: { "content-type": "application/json" },
      extra: "bytes=2",
    });
  } finally {
    console.log = originalLog;
  }

  const added = messages.join("\n");
  assert.match(added, /AUTH PASS/);
  assert.match(added, /fetchUserInfo/);
  assert.match(added, /bytes=2/);
});

test("readConfig keeps legacy runtime config and drops custom model mappings", () => {
  const legacyPath = path.join(tempRoot, "config.json");
  fs.writeFileSync(legacyPath, JSON.stringify({
    routerUrl: "http://legacy.local/v1/chat/completions",
    modelMap: {
      "gemini-3-flash": "upstream/gemini-3-flash",
      "custom-antigravity-model": "upstream/custom",
    },
  }));

  const config = mitm.readConfig();

  assert.equal(config.routerUrl, "http://legacy.local/v1/chat/completions");
  assert.equal(config.modelMap["gemini-3-flash"], "upstream/gemini-3-flash");
  assert.equal(config.modelMap["custom-antigravity-model"], undefined);
});

test("logging helpers expose backend and proxy logs", () => {
  mitm.clearLogs();
  mitm.appendLog("info", "test log entry", { apiKey: "secret-value" });
  fs.appendFileSync(process.env.MITM_PROXY_LOG, "proxy started\n");

  const logs = mitm.readRecentLogs();

  assert.equal(logs.paths.backend, process.env.MITM_APP_LOG);
  assert.equal(logs.paths.proxy, process.env.MITM_PROXY_LOG);
  assert.match(logs.backend, /test log entry/);
  assert.doesNotMatch(logs.backend, /secret-value/);
  assert.match(logs.proxy, /proxy started/);
});

test("generateCert creates a CA-backed server certificate", async () => {
  const cert = await mitm.generateCert(mitm.DEFAULT_TARGET_HOSTS, { force: true });
  const ca = new crypto.X509Certificate(fs.readFileSync(cert.ca));
  const server = new crypto.X509Certificate(fs.readFileSync(cert.cert));

  assert.equal(ca.ca, true);
  assert.equal(server.ca, false);
  assert.equal(server.checkHost(mitm.DEFAULT_TARGET), mitm.DEFAULT_TARGET);
  assert.equal(server.checkIssued(ca), true);
  assert.equal(server.verify(ca.publicKey), true);
  assert.equal(mitm.certUsesLocalCA(cert.cert, cert.ca), true);
});

test("macOS system trust command installs CA with SSL and basic policies", () => {
  const command = mitm.macSystemTrustCommand("/tmp/mitm ca.crt");

  assert.match(command, /security add-trusted-cert/);
  assert.match(command, /-d/);
  assert.match(command, /-r trustRoot/);
  assert.match(command, /-p ssl/);
  assert.match(command, /-p basic/);
  assert.match(command, /-k '\/Library\/Keychains\/System\.keychain'/);
  assert.match(command, /'\/tmp\/mitm ca\.crt'/);
});

test("PowerShell single-quote helper escapes embedded quotes", () => {
  assert.equal(mitm.powershellSingleQuote("C:\\Users\\O'Brien\\app"), "'C:\\Users\\O''Brien\\app'");
});

test("Windows env scripts can target User and Machine scopes", () => {
  assert.match(mitm.windowsUserEnvGetScript("NODE_EXTRA_CA_CERTS"), /'User'/);
  assert.match(mitm.windowsUserEnvSetScript("NODE_EXTRA_CA_CERTS", "C:\\ca.crt"), /'User'/);
  assert.match(mitm.windowsEnvGetScript("NODE_EXTRA_CA_CERTS", "Machine"), /'Machine'/);
  assert.match(mitm.windowsEnvSetScript("NODE_EXTRA_CA_CERTS", "C:\\ca.crt", "Machine"), /'Machine'/);
  assert.doesNotMatch(mitm.windowsEnvSetScript("NODE_EXTRA_CA_CERTS", "C:\\ca.crt", "Machine"), /@'/);
});

test("elevated PowerShell errors prefer captured launcher output", () => {
  const message = mitm.elevatedPowerShellErrorMessage(
    { code: 1 },
    "Start failed",
    "stdout noise",
    "stderr noise"
  );

  assert.match(message, /Elevated PowerShell failed \(exit 1\): Start failed/);
  assert.doesNotMatch(message, /Command failed: powershell/);
});

test("safe child process env clears pkg self-spawn marker", () => {
  const originalPkg = process.pkg;
  try {
    process.pkg = { entrypoint: "index.js" };
    const env = mitm.safeChildProcessEnv({ PATH: "C:\\Windows", PKG_EXECPATH: "C:\\app\\mitm.exe" });
    assert.equal(env.PATH, "C:\\Windows");
    assert.equal(env.PKG_EXECPATH, "");
  } finally {
    if (typeof originalPkg === "undefined") delete process.pkg;
    else process.pkg = originalPkg;
  }
});

test("Windows command-line args preserve paths with spaces", () => {
  assert.equal(
    mitm.windowsCommandLineArguments([
      "C:\\Program Files\\MITM AG\\index.js",
      "start",
      "--skip-setup",
      "--port",
      "443",
    ]),
    "\"C:\\Program Files\\MITM AG\\index.js\" start --skip-setup --port 443"
  );
  assert.equal(
    mitm.windowsCommandLineArguments(["C:\\Path With Space\\", "quote\"value"]),
    "\"C:\\Path With Space\\\\\" \"quote\\\"value\""
  );
});

test("Windows cmd redirect args preserve quoted executable and log paths", () => {
  assert.equal(
    mitm.windowsCmdRedirectArguments(
      "C:\\Program Files\\MITM AG\\mitm-ag-backend.exe",
      ["start", "--skip-setup", "--port", "443"],
      "C:\\Users\\Phong NUC\\AppData\\Local\\Temp\\mitm-antigravity-proxy.log"
    ),
    "/s /c \"\"C:\\Program Files\\MITM AG\\mitm-ag-backend.exe\" start --skip-setup --port 443 >> \"C:\\Users\\Phong NUC\\AppData\\Local\\Temp\\mitm-antigravity-proxy.log\" 2>&1\""
  );
});

test("Windows stop proxy script does not create an empty pipe", () => {
  const script = mitm.windowsStopProxyScript(443);

  assert.match(script, /Get-NetTCPConnection -LocalPort 443/);
  assert.match(script, /\| Select-Object -ExpandProperty OwningProcess -Unique/);
  assert.doesNotMatch(script, /;\s*\|/);
});

test("Windows autostart task script uses highest privileges and normalized working directory", () => {
  const script = mitm.windowsRegisterAutoStartScript([
    "C:\\Program Files\\nodejs\\node.exe",
    "C:\\Program Files\\MITM AG\\index.js",
    "start",
    "--skip-setup",
  ]);

  assert.match(script, /New-ScheduledTaskPrincipal/);
  assert.match(script, /-RunLevel Highest/);
  assert.match(script, /-LogonType Interactive/);
  assert.match(script, /Register-ScheduledTask/);
  assert.match(script, /MITM Antigravity Proxy/);
  assert.doesNotMatch(script, /undefined/);
});

test("Windows autostart status script treats disabled scheduled task as disabled", () => {
  const script = mitm.windowsAutoStartStatusScript();

  assert.match(script, /Get-ScheduledTask/);
  assert.match(script, /State\) -eq 'Disabled'|State -eq 'Disabled'/);
  assert.match(script, /exit 2/);
});

test("Windows installer hook stops running MITM AG processes before install", () => {
  const tauriConfig = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "src-tauri", "tauri.conf.json"), "utf8"));
  const hookPath = tauriConfig.bundle.windows.nsis.installerHooks;
  const hook = fs.readFileSync(path.join(__dirname, "..", "src-tauri", hookPath), "utf8");

  assert.equal(hookPath, "installer-hooks.nsh");
  assert.match(hook, /NSIS_HOOK_PREINSTALL/);
  assert.match(hook, /NSIS_HOOK_PREUNINSTALL/);
  assert.match(hook, /mitm-ag-backend\.exe/);
  assert.match(hook, /mitm-ag-tauri\.exe/);
  assert.doesNotMatch(hook, /Antigravity\.exe/);
});

test("manual kill scripts stop MITM AG backend and GUI only", () => {
  const win = fs.readFileSync(path.join(__dirname, "..", "scripts", "kill-mitm-ag.bat"), "utf8");
  const winCompat = fs.readFileSync(path.join(__dirname, "..", "scripts", "kill-mitm-ag-backend.bat"), "utf8");
  const mac = fs.readFileSync(path.join(__dirname, "..", "scripts", "kill-mitm-ag.command"), "utf8");
  const macCompat = fs.readFileSync(path.join(__dirname, "..", "scripts", "kill-mitm-ag.sh"), "utf8");

  assert.match(win, /mitm-ag-backend\.exe/);
  assert.match(win, /mitm-ag-tauri\.exe/);
  assert.match(win, /MITM AG\.exe/);
  assert.match(winCompat, /kill-mitm-ag\.bat/);
  assert.doesNotMatch(win, /Antigravity\.exe/);

  assert.match(mac, /mitm-ag-backend/);
  assert.match(mac, /MITM AG\.app/);
  assert.match(mac, /MITM Antigravity\.app/);
  assert.match(macCompat, /kill-mitm-ag\.command/);
  assert.equal(mac.includes('tell application "Antigravity"'), false);
  assert.equal(mac.includes("/Antigravity.app/Contents/MacOS/"), false);
});

test("macOS LaunchAgent commands use bootstrap domain instead of deprecated load", () => {
  const plistPath = "/Users/test/Library/LaunchAgents/io.phongdang.mitm-antigravity.proxy.plist";
  const bootstrap = mitm.macLaunchAgentBootstrapCommand(plistPath);
  const bootout = mitm.macLaunchAgentBootoutCommand(plistPath);
  const print = mitm.macLaunchAgentPrintCommand();

  assert.match(bootstrap, /launchctl bootstrap 'gui\/\d+'/);
  assert.match(bootout, /launchctl bootout 'gui\/\d+'/);
  assert.match(print, /launchctl print 'gui\/\d+\/io\.phongdang\.mitm-antigravity\.proxy'/);
  assert.doesNotMatch(bootstrap, /launchctl load/);
  assert.doesNotMatch(bootout, /launchctl unload/);
});

test("release settings sanitizer strips secrets without mutating input", () => {
  const { stripReleaseSettings } = require("../scripts/settings-sanitizer");
  const input = {
    routerUrl: "https://api.example.com/v1/chat/completions",
    apiKey: "sk-secret",
    modelMap: { "gemini-3-flash": "router/model" },
    machines: {
      dev: {
        routerUrl: "https://machine.example.com/v1/chat/completions",
        apiKey: "sk-machine-secret",
        model: "router/model",
        modelMap: { "gemini-3-flash": "router/model" },
      },
    },
  };

  const output = stripReleaseSettings(input);

  assert.equal(output.apiKey, "");
  assert.equal(output.routerUrl, "");
  assert.deepEqual(output.modelMap, {});
  assert.equal(output.machines.dev.apiKey, "");
  assert.deepEqual(output.machines.dev.modelMap, {});
  assert.equal(input.apiKey, "sk-secret");
  assert.equal(input.machines.dev.apiKey, "sk-machine-secret");
});

test("compact proxy logger redacts and shortens values", () => {
  const compact = mitm.compactValue("Bearer sk-super-secret-token user@example.com ".repeat(8));

  assert.ok(compact.length <= 140);
  assert.match(compact, /Bearer \[redacted\]/);
  assert.match(compact, /\[redacted-email\]/);
  assert.doesNotMatch(compact, /sk-super-secret-token/);
  assert.doesNotMatch(compact, /user@example\.com/);
});

test("upstream retry and error helpers preserve provider failures", () => {
  assert.equal(mitm.isRetryableUpstreamStatus(429), true);
  assert.equal(mitm.isRetryableUpstreamStatus(524), true);
  assert.equal(mitm.isRetryableUpstreamStatus(404), false);

  assert.deepEqual(
    mitm.routerErrorBody(404, '{"error":{"message":"No active credentials for provider: antigravity"}}'),
    { error: { message: "No active credentials for provider: antigravity" } }
  );

  const wrapped = mitm.routerErrorBody(524, "<html>timeout</html>");
  assert.equal(wrapped.error.type, "upstream_error");
  assert.equal(wrapped.error.status, 524);
  assert.match(wrapped.error.message, /timeout/);
});

test("isClientAbortError flags client-cancelled fetches", () => {
  // Both Node's native AbortError and our explicit "client disconnected"
  // string must short-circuit retry — otherwise the proxy burns provider
  // quota retrying a request whose consumer is already gone.
  const abortErr = new Error("aborted");
  abortErr.name = "AbortError";
  assert.equal(mitm.isClientAbortError(abortErr), true);

  const codeErr = new Error("aborted by signal");
  codeErr.code = "ABORT_ERR";
  assert.equal(mitm.isClientAbortError(codeErr), true);

  assert.equal(
    mitm.isClientAbortError(new Error("client disconnected before upstream completed")),
    true
  );

  assert.equal(mitm.isClientAbortError(new Error("upstream 502 bad gateway")), false);
  assert.equal(mitm.isClientAbortError(null), false);
});

test("retryWithBackoff skips retries when the client has aborted", async () => {
  // Setup: fetchFn always throws AbortError, mimicking what fetch() does once
  // its AbortSignal fires. With retries=3 the helper used to wait through all
  // backoffs and produce ghost upstream calls. With the abort short-circuit
  // it must throw on the first attempt.
  let calls = 0;
  const abortErr = new Error("aborted");
  abortErr.name = "AbortError";
  const fetchFn = async () => { calls += 1; throw abortErr; };

  await assert.rejects(
    () => mitm.retryWithBackoff(fetchFn, { maxRetries: 3, retryDelay: 10, retryBackoff: 1 }),
    (err) => err.name === "AbortError"
  );
  assert.equal(calls, 1, "abort should not retry — got " + calls + " calls");
});

test("retryWithBackoff still retries transient non-abort errors", async () => {
  let calls = 0;
  const fetchFn = async () => {
    calls += 1;
    if (calls < 3) throw new Error("connect ECONNRESET");
    return { ok: true, status: 200 };
  };
  const result = await mitm.retryWithBackoff(fetchFn, { maxRetries: 3, retryDelay: 5, retryBackoff: 1 });
  assert.equal(result.ok, true);
  assert.equal(calls, 3);
});

test("chatCompletionsRouterUrl normalizes Responses endpoint back to chat endpoint", () => {
  assert.equal(
    mitm.chatCompletionsRouterUrl("https://router.example/v1/responses"),
    "https://router.example/v1/chat/completions"
  );
  assert.equal(
    mitm.chatCompletionsRouterUrl("https://router.example/v1/chat/completions/"),
    "https://router.example/v1/chat/completions"
  );
  assert.equal(
    mitm.chatCompletionsRouterUrl("https://router.example/v1"),
    "https://router.example/v1/chat/completions"
  );
});

test("Responses API stream becomes Antigravity-safe Gemini SSE", async () => {
  const events = [
    { type: "response.reasoning_summary_text.delta", delta: "thinking" },
    { type: "response.output_text.delta", delta: "Hi" },
    { type: "response.completed" },
  ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(events));
      controller.close();
    },
  });
  const writes = [];
  await mitm.transformResponsesApiStream(stream, {
    write(chunk) { writes.push(String(chunk)); },
  });

  const output = writes.join("");
  assert.doesNotMatch(output, /thinking/);
  assert.match(output, /"response":/);
  assert.doesNotMatch(output, /"index":0/);
  assert.match(output, /"text":"Hi"/);
  assert.match(output, /"finishReason":"STOP"/);
  assert.match(output, /data: \[DONE\]/);
  assert.equal((output.match(/^data: /gm) || []).length, 2);
  for (const line of output.split(/\n/).filter((item) => item.startsWith("data: "))) {
    if (line === "data: [DONE]") continue;
    JSON.parse(line.slice(6));
  }
});

test("compact proxy logger writes one-line messages", () => {
  const originalLog = console.log;
  const lines = [];
  console.log = (line) => lines.push(line);
  try {
    mitm.logProxyMap({ sourceModel: "gemini-3-flash", targetModel: "ag/gemini-3-flash", reasoning: "low" });
  } finally {
    console.log = originalLog;
  }

  assert.equal(lines.length, 1);
  assert.match(lines[0], /^\d{2}:\d{2}:\d{2} MAP gemini-3-flash -> ag\/gemini-3-flash reason=low$/);
});

test("macOS proxy LaunchDaemon plist uses launchd arguments instead of nohup", () => {
  const plist = mitm.macProxyLaunchDaemonPlist([
    "/usr/local/bin/node",
    "/tmp/app/index.js",
    "start",
    "--skip-setup",
  ], "/tmp/proxy.log");

  assert.match(plist, /<key>ProgramArguments<\/key>/);
  assert.match(plist, /<key>MITM_APP_DIR<\/key>/);
  assert.match(plist, /<string>\/tmp\/proxy.log<\/string>/);
  assert.doesNotMatch(plist, /nohup/);
});

test("CLI doctor reports stale DNS and cleanup guidance", () => {
  const report = mitm.buildDoctorReport({
    proxyListening: false,
    dnsConfigured: true,
    certExists: true,
    certInstalled: true,
    nodeTrustSupported: false,
    routerUrl: "https://api.example.com/v1/chat/completions",
  });

  assert.equal(report.ok, false);
  assert.match(report.recommendations.join("\n"), /mitm-antigravity stop/);
});

test("CLI cleanup aliases require sudo preflight on privileged systems", () => {
  if (process.platform === "win32" || process.getuid?.() === 0) return;

  assert.equal(mitm.commandNeedsSudoPreflight("stop", { port: 443 }), true);
  assert.equal(mitm.commandNeedsSudoPreflight("cleanup", { port: 443 }), true);
  assert.equal(mitm.commandNeedsSudoPreflight("stop-cleanup", { port: 443 }), true);
});

test("config tab combines model loading and saving", () => {
  const html = mitm.guiHtml();

  assert.match(html, /Test, Load & Save/);
  assert.match(html, /id="applyDnsBtn"/);
  assert.match(html, /id="applyAppTrustBtn"/);
  assert.match(html, /Enable Antigravity Cert/);
  assert.doesNotMatch(html, /Apply DNS & Cert/);
  assert.doesNotMatch(html, /id="saveBtn"/);
  assert.doesNotMatch(html, /newAlias/);
  assert.doesNotMatch(html, /Create custom model/);
  assert.doesNotMatch(html, /id="mockModelList"/);
  assert.doesNotMatch(html, /Expose custom aliases/);
  assert.match(html, /Built-in Model Mapping/);
  assert.match(html, /id="themeSelect"/);
  assert.match(html, /id="languageSelect"/);
  assert.match(html, /Tiếng Việt/);
  assert.match(html, /data-panel="dashboard"/);
  assert.match(html, /id="proxyToggleBtn"/);
  assert.doesNotMatch(html, /id="startProxyBtn"/);
  assert.doesNotMatch(html, /id="stopProxyBtn"/);
  assert.match(html, /button.startShort/);
  assert.match(html, /data-tab="guide"/);
  assert.match(html, /id="stopCleanupBtn"/);
});

test("GUI client script is valid browser JavaScript", () => {
  const { guiClientScript } = require("../src/gui/client");
  assert.doesNotThrow(() => new vm.Script(guiClientScript()));
});

test("wizard keeps primary aliases while GUI can expose all mappable aliases", () => {
  assert.deepEqual(mitm.PRIMARY_ANTIGRAVITY_ALIASES, [
    // Antigravity 2.0 defaults first
    "gemini-3.5-flash",
    "gemini-3.5-flash-thinking",
    "gemini-3.5-pro",
    // 3.1 tier
    "gemini-3.1-pro-high",
    "gemini-3.1-pro-low",
    "gemini-3-flash",
    // Claude
    "claude-sonnet-4",
    "claude-sonnet-4-6",
    "claude-opus-4-thinking",
    "claude-opus-4-6-thinking",
    // GPT
    "gpt-oss-120b-medium",
  ]);
  assert.equal(mitm.MAPPABLE_ANTIGRAVITY_ALIASES.length > mitm.PRIMARY_ANTIGRAVITY_ALIASES.length, true);
  for (const alias of [
    "gemini-3-flash-agent",
    "gemini-pro-agent",
    "gemini-3-flash-a",
    "gemini-3-flash-b",
    "gemini-3-flash-c",
    "gemini-3.5-flash-low",
  ]) {
    assert.equal(mitm.MAPPABLE_ANTIGRAVITY_ALIASES.includes(alias), true);
  }
});

test("GUI route table finds known routes and rejects unknown routes", () => {
  const { createGuiRoutes, findGuiRoute } = require("../src/gui/routes");
  const handlers = {
    handleBootstrap() { },
    handleLogs() { },
    handleSaveConfig() { },
    handleExportConfig() { },
    handleImportConfig() { },
    handleCheckKey() { },
    handleStartProxy() { },
    handleStartProxyOnly() { },
    handleStopProxy() { },
    handleStopAndCleanup() { },
    handleReloadProxy() { },
    handleApplyDns() { },
    handleApplyAppTrust() { },
    handleRemoveDns() { },
    handleUninstallCert() { },
    handleAutoStartStatus() { },
    handleEnableAutoStart() { },
    handleDisableAutoStart() { },
    handleStatus() { },
    handleEvents() { },
    handleClearLogs() { },
  };

  const routes = createGuiRoutes(handlers);

  assert.equal(findGuiRoute(routes, "GET", "/api/bootstrap").handler, handlers.handleBootstrap);
  assert.equal(findGuiRoute(routes, "POST", "/api/start-proxy").handler, handlers.handleStartProxy);
  assert.equal(findGuiRoute(routes, "POST", "/api/stop-and-cleanup").handler, handlers.handleStopAndCleanup);
  assert.equal(findGuiRoute(routes, "POST", "/api/apply-app-trust").handler, handlers.handleApplyAppTrust);
  assert.equal(findGuiRoute(routes, "GET", "/api/events").handler, handlers.handleEvents);
  assert.equal(findGuiRoute(routes, "DELETE", "/api/bootstrap"), null);
  assert.equal(findGuiRoute(routes, "GET", "/api/missing"), null);
});

test("wizard helpers merge answers without exposing secrets", () => {
  const current = {
    routerUrl: "http://old.local/v1/chat/completions",
    apiKey: "sk-existing-secret",
    model: "",
    alwaysIntercept: false,
    modelMap: { "gemini-3-flash": "old/model" },
  };

  const next = mitm.applyWizardAnswers(current, {
    routerUrl: "https://new.local/v1/chat/completions",
    apiKey: "sk-new-secret",
    model: "",
    alwaysIntercept: true,
    modelMap: { "gemini-3-flash": "new/model" },
  });

  assert.equal(next.routerUrl, "https://new.local/v1/chat/completions");
  assert.equal(next.apiKey, "sk-new-secret");
  assert.equal(next.alwaysIntercept, true);
  assert.equal(next.modelMap["gemini-3-flash"], "new/model");

  const cleared = mitm.applyWizardAnswers(next, {
    modelMap: { "gemini-3-flash": "" },
  });
  assert.equal(cleared.modelMap["gemini-3-flash"], undefined);

  assert.equal(mitm.maskSecret("sk-new-secret"), "sk-new...cret");
  assert.equal(mitm.yesNoDefault("", true), true);
  assert.equal(mitm.yesNoDefault("n", true), false);
});

test("proxy can start on an unprivileged port and stopProxyByPort stops it", async (t) => {
  if (process.platform === "win32") {
    t.skip("Windows stop path requires an elevated PowerShell process.");
    return;
  }

  const port = await getFreePort();
  await mitm.generateCert(mitm.DEFAULT_TARGET_HOSTS, { force: true });

  const child = spawn(process.execPath, [
    scriptPath,
    "start",
    "--skip-setup",
    "--port",
    String(port),
    "--router-url",
    "http://127.0.0.1:9/v1/chat/completions",
  ], {
    env: {
      ...process.env,
      MITM_APP_DIR: tempRoot,
      MITM_HOSTS_FILE: hostsPath,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });

  try {
    assert.equal(await mitm.waitForProxyHealth(port, mitm.DEFAULT_TARGET, 20), true, stderr);
    const stopResult = await mitm.stopProxyByPort({ port, targetHost: mitm.DEFAULT_TARGET });
    assert.equal(stopResult.stopped, true);
    assert.equal(await mitm.waitForProxyHealth(port, mitm.DEFAULT_TARGET, 2), false);
  } finally {
    if (!child.killed) child.kill("SIGTERM");
  }
});

test("ProxyManager runs the proxy embedded on an unprivileged port", async () => {
  const { ProxyManager, canRunEmbedded } = require("../src/proxy/manager");
  const port = await getFreePort();
  await mitm.generateCert(mitm.DEFAULT_TARGET_HOSTS, { force: true });

  const config = {
    port,
    targetHost: mitm.DEFAULT_TARGET,
    targetHosts: mitm.DEFAULT_TARGET_HOSTS,
    routerUrl: "http://127.0.0.1:9/v1/chat/completions",
    apiKey: "",
    modelMap: {},
    alwaysIntercept: false,
    maxRetries: 0,
    retryDelay: 100,
    retryBackoff: 1,
    requestTimeoutMs: 5000,
  };

  // Unprivileged port → embedded must be allowed.
  assert.equal(canRunEmbedded(config), true);

  const manager = new ProxyManager();
  const start = await manager.start({ config, prefer: "embedded" });
  assert.equal(start.mode, "embedded");
  assert.equal(start.started, true);

  try {
    assert.equal(await mitm.waitForProxyHealth(port, mitm.DEFAULT_TARGET, 20), true);

    // Reload should swap the listener in-place without losing the port.
    const reload = await manager.reload({ config });
    assert.equal(reload.mode, "embedded");
    assert.equal(reload.reloaded, true);
    assert.equal(await mitm.waitForProxyHealth(port, mitm.DEFAULT_TARGET, 20), true);
  } finally {
    await manager.stop({ config });
  }

  assert.equal(await mitm.waitForProxyHealth(port, mitm.DEFAULT_TARGET, 2), false);
  assert.equal(manager.isRunning(), false);
});

test("ProxyManager.start adopts an existing detached proxy without restart", async () => {
  // Simulates the GUI launching when the user already has a CLI proxy running.
  const { ProxyManager } = require("../src/proxy/manager");
  const port = await getFreePort();
  await mitm.generateCert(mitm.DEFAULT_TARGET_HOSTS, { force: true });

  const config = {
    port,
    targetHost: mitm.DEFAULT_TARGET,
    targetHosts: mitm.DEFAULT_TARGET_HOSTS,
    routerUrl: "http://127.0.0.1:9/v1/chat/completions",
    apiKey: "",
    modelMap: {},
    alwaysIntercept: false,
    maxRetries: 0,
    retryDelay: 100,
    retryBackoff: 1,
    requestTimeoutMs: 5000,
  };

  // Boot a proxy via the embedded path under one manager…
  const owner = new ProxyManager();
  await owner.start({ config, prefer: "embedded" });

  // …then have a fresh manager observe it. It must report detached + skip start.
  const observer = new ProxyManager();
  try {
    const result = await observer.start({ config });
    assert.equal(result.mode, "detached");
    assert.equal(result.alreadyRunning, true);
    assert.equal(result.started, false);
  } finally {
    await owner.stop({ config });
  }
});

test("ProxyManager serializes overlapping start requests for the same port", async () => {
  // If a UI sends two concurrent Start clicks, only one runProxy invocation
  // should win; the second must observe the first's result. Without the
  // serialization lock, both call runProxy → second hits EADDRINUSE.
  const { ProxyManager } = require("../src/proxy/manager");
  const port = await getFreePort();
  await mitm.generateCert(mitm.DEFAULT_TARGET_HOSTS, { force: true });

  const config = {
    port,
    targetHost: mitm.DEFAULT_TARGET,
    targetHosts: mitm.DEFAULT_TARGET_HOSTS,
    routerUrl: "http://127.0.0.1:9/v1/chat/completions",
    apiKey: "",
    modelMap: {},
    alwaysIntercept: false,
    maxRetries: 0,
    retryDelay: 100,
    retryBackoff: 1,
    requestTimeoutMs: 5000,
  };

  const manager = new ProxyManager();
  try {
    const [first, second] = await Promise.all([
      manager.start({ config, prefer: "embedded" }),
      manager.start({ config, prefer: "embedded" }),
    ]);
    assert.equal(first.mode, "embedded");
    assert.equal(second.mode, "embedded");
    // Exactly one call should have actually started the listener.
    assert.equal(Number(first.started === true) + Number(second.started === true), 1);
  } finally {
    await manager.stop({ config });
  }
});

test("GUI /api/events streams proxy state transitions", async () => {
  // Run the real GUI server against the singleton ProxyManager and assert
  // that a status event reaches an EventSource-style client when the manager
  // transitions from idle → embedded.
  const { startGuiServer } = require("../src/gui");
  const { getProxyManager } = require("../src/proxy/manager");

  const uiPort  = await getFreePort();
  const proxyPort = await getFreePort();
  await mitm.generateCert(mitm.DEFAULT_TARGET_HOSTS, { force: true });

  const { server } = await startGuiServer({ uiPort, port: proxyPort });

  // Buffer SSE chunks until we see a "status" event with running:true.
  const url = `http://127.0.0.1:${uiPort}/api/events`;
  const response = await fetch(url, { headers: { Accept: "text/event-stream" } });
  assert.equal(response.ok, true);
  assert.match(String(response.headers.get("content-type") || ""), /text\/event-stream/);

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let runningSeen = false;

  const config = {
    port: proxyPort,
    targetHost: mitm.DEFAULT_TARGET,
    targetHosts: mitm.DEFAULT_TARGET_HOSTS,
    routerUrl: "http://127.0.0.1:9/v1/chat/completions",
    apiKey: "",
    modelMap: {},
    alwaysIntercept: false,
    maxRetries: 0,
    retryDelay: 100,
    retryBackoff: 1,
    requestTimeoutMs: 5000,
  };

  // Trigger a state transition once we have an open stream.
  const manager = getProxyManager();
  const startPromise = manager.start({ config, prefer: "embedded" });

  const deadline = Date.now() + 8000;
  while (Date.now() < deadline && !runningSeen) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    // Parse complete SSE events (separated by blank line).
    const events = buffer.split("\n\n");
    buffer = events.pop();
    for (const event of events) {
      if (!event.includes("event: status")) continue;
      const dataLine = event.split("\n").find((l) => l.startsWith("data:"));
      if (!dataLine) continue;
      try {
        const parsed = JSON.parse(dataLine.slice(5).trim());
        if (parsed.running === true) runningSeen = true;
      } catch { /* ignore malformed payloads */ }
    }
  }

  await startPromise;

  try {
    assert.equal(runningSeen, true, "did not receive a running:true status event");
  } finally {
    await reader.cancel().catch(() => {});
    await manager.stop({ config });
    await new Promise((resolve) => server.close(() => resolve()));
  }
});

// ────────────────────────────────────────────────────────────────────────────
// IPv6 DNS blocking
// ────────────────────────────────────────────────────────────────────────────

test("isLoopbackIp identifies loopback variants", () => {
  assert.equal(mitm.isLoopbackIp("127.0.0.1"), true);
  assert.equal(mitm.isLoopbackIp("::1"),       true);
  assert.equal(mitm.isLoopbackIp("0.0.0.0"),   true);
  assert.equal(mitm.isLoopbackIp("1.2.3.4"),   false);
  assert.equal(mitm.isLoopbackIp(""),           false);
  assert.equal(mitm.isLoopbackIp(undefined),    false);
});

test("dnsEntriesForHosts includes ::1 entry for each host when ip is loopback", () => {
  const hosts = ["cloudcode-pa.googleapis.com", "daily-cloudcode-pa.googleapis.com"];
  const entries = mitm.dnsEntriesForHosts(hosts, "127.0.0.1");

  const v4 = entries.filter((e) => e.ip === "127.0.0.1").map((e) => e.targetHost);
  const v6 = entries.filter((e) => e.ip === "::1").map((e) => e.targetHost);

  assert.deepEqual(v4.sort(), hosts.slice().sort(), "should have IPv4 entries for all hosts");
  assert.deepEqual(v6.sort(), hosts.slice().sort(), "should have IPv6 entries for all hosts");
  assert.equal(entries.length, hosts.length * 2, "should have 2x entries (v4 + v6)");
});

test("dnsEntriesForHosts does not add ::1 when ip is a real remote IP", () => {
  const hosts = ["cloudcode-pa.googleapis.com"];
  const entries = mitm.dnsEntriesForHosts(hosts, "142.250.80.10");

  assert.equal(entries.length, 1, "only IPv4 entry for non-loopback redirect");
  assert.equal(entries[0].ip, "142.250.80.10");
});

test("addDNSEntries writes both IPv4 and IPv6 loopback entries to hosts file", async () => {
  fs.writeFileSync(hostsPath, "127.0.0.1 localhost\n");

  const targetHosts = ["cloudcode-pa.googleapis.com"];
  await mitm.addDNSEntries({ targetHosts, remoteIp: "127.0.0.1" });

  const content = fs.readFileSync(hostsPath, "utf8");
  assert.match(content, /127\.0\.0\.1 cloudcode-pa\.googleapis\.com/,  "IPv4 entry should be present");
  assert.match(content, /::1 cloudcode-pa\.googleapis\.com/,            "IPv6 entry should be present");
});

test("removeDNSEntries clears both IPv4 and IPv6 loopback entries", async () => {
  fs.writeFileSync(hostsPath, "127.0.0.1 localhost\n");

  const targetHosts = ["cloudcode-pa.googleapis.com"];
  await mitm.addDNSEntries({ targetHosts, remoteIp: "127.0.0.1" });

  await mitm.removeDNSEntries({ targetHosts });
  const content = fs.readFileSync(hostsPath, "utf8");

  assert.doesNotMatch(content, /cloudcode-pa\.googleapis\.com/,
    "all entries (v4 + v6) should be removed after cleanup");
  assert.equal(content, "127.0.0.1 localhost\n", "hosts file should be restored to original");
});
