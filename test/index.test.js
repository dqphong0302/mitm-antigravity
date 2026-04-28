const assert = require("node:assert/strict");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const test = require("node:test");

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

test("classifyModelCheckFailure identifies common upstream failures", () => {
  assert.equal(mitm.classifyModelCheckFailure({ code: "ECONNREFUSED", message: "connect ECONNREFUSED" }).category, "router_unreachable");
  assert.equal(mitm.classifyModelCheckFailure(null, { status: 401, message: "Unauthorized" }).category, "auth_failed");
  assert.equal(mitm.classifyModelCheckFailure(null, { status: 404, message: "No active credentials for provider" }).category, "provider_credentials_missing");
  assert.equal(mitm.classifyModelCheckFailure(null, { status: 524, message: "timeout" }).category, "upstream_transient");
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
      "custom-router-model": "cx/custom-router-model",
    },
  };

  assert.equal(mitm.extractModelFromBody(Buffer.from(JSON.stringify({
    request: { plannerConfig: { requestedModel: { choice: { case: "alias", value: "claude-opus-4-6-thinking" } } } },
  }))), "claude-opus-4-6-thinking");
  assert.equal(mitm.getMappedEntry("MODEL_PLACEHOLDER_M26", options).model, "cx/opus");
  assert.equal(mitm.getMappedEntry("291", options).model, "cx/opus");
  assert.equal(mitm.getMappedEntry("claude-opus-4-6-thinking", options).model, "cx/opus");
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

test("normalizeModelMap keeps only the six mappable built-in aliases", () => {
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
  assert.equal(result["gemini-2.5-pro"], undefined);
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
    handleStopProxy() { },
    handleStopAndCleanup() { },
    handleReloadProxy() { },
    handleApplyDns() { },
    handleApplyAppTrust() { },
    handleRemoveDns() { },
    handleAutoStartStatus() { },
    handleEnableAutoStart() { },
    handleDisableAutoStart() { },
    handleStatus() { },
    handleClearLogs() { },
  };

  const routes = createGuiRoutes(handlers);

  assert.equal(findGuiRoute(routes, "GET", "/api/bootstrap").handler, handlers.handleBootstrap);
  assert.equal(findGuiRoute(routes, "POST", "/api/start-proxy").handler, handlers.handleStartProxy);
  assert.equal(findGuiRoute(routes, "POST", "/api/stop-and-cleanup").handler, handlers.handleStopAndCleanup);
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
