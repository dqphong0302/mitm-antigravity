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

test("model list includes built-in Antigravity aliases without explicit mappings", () => {
  const list = mitm.buildAntigravityModelList({ modelMap: {}, mockModelList: true });
  assert.ok(list.models["gemini-3-flash-agent"]);
  assert.ok(list.models["gemini-2.5-pro"]);
  assert.ok(list.models["claude-opus-4-6-thinking"]);
});

test("merged model list preserves upstream account metadata and adds custom aliases", () => {
  const upstream = {
    account: { verified: true },
    agentModelSorts: [
      { displayName: "Agent", groups: [{ displayName: "All", modelIds: ["gemini-2.5-pro"] }] },
    ],
    commandModelIds: ["gemini-2.5-pro"],
    commitMessageModelIds: ["gemini-2.5-pro"],
    models: {
      "gemini-2.5-pro": { id: "gemini-2.5-pro", displayName: "Gemini 2.5 Pro", quotaInfo: { remainingFraction: 0.5 } },
    },
  };

  const result = mitm.mergeAntigravityModelListPayload(upstream, {
    modelMap: {
      "gemini-2.5-pro": "cx/override-should-not-replace-upstream",
      "custom-router-model": "cx/custom-router-model",
    },
  });

  assert.equal(result.payload.account.verified, true);
  assert.equal(result.payload.models["gemini-2.5-pro"].quotaInfo.remainingFraction, 0.5);
  assert.ok(result.payload.models["custom-router-model"]);
  assert.ok(result.added.includes("custom-router-model"));
  assert.equal(result.payload.models["custom-router-model"].model, "PLACEHOLDER_M0");
  assert.ok(result.payload.commandModelIds.includes("custom-router-model"));
  assert.ok(result.payload.commitMessageModelIds.includes("custom-router-model"));
  assert.ok(result.payload.agentModelSorts[0].groups.some((group) => group.modelIds.includes("custom-router-model")));
  assert.equal(result.payload.models["gemini-3-pro-high"], undefined);
});

test("merged user status model config data adds custom aliases to Antigravity dropdown", () => {
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
          { name: "Agent", groups: [{ groupName: "All", modelLabels: ["Gemini 2.5 Pro"] }] },
        ],
      },
    },
  };

  const result = mitm.mergeCascadeModelConfigsInPayload(upstream, {
    modelMap: { "custom-router-model": "cx/custom-router-model" },
  });

  const configData = result.payload.userStatus.cascadeModelConfigData;
  assert.ok(result.added.includes("custom-router-model (cx/custom-router-model)"));
  assert.ok(configData.clientModelConfigs.some((config) => {
    return config.label === "custom-router-model (cx/custom-router-model)"
      && config.modelOrAlias.choice.value === "PLACEHOLDER_M0";
  }));
  assert.ok(configData.clientModelSorts[0].groups.some((group) => {
    return group.groupName === "Custom" && group.modelLabels.includes("custom-router-model (cx/custom-router-model)");
  }));
});

test("custom placeholder model ids route back to mapped custom aliases", () => {
  const options = { modelMap: { "custom-router-model": "cx/custom-router-model" } };

  assert.equal(mitm.customModelEnumForAlias("custom-router-model", options), "PLACEHOLDER_M0");
  assert.equal(mitm.customAliasForModelEnum("PLACEHOLDER_M0", options), "custom-router-model");
  assert.equal(mitm.extractModelFromBody(Buffer.from(JSON.stringify({ model: "PLACEHOLDER_M0" }))), "PLACEHOLDER_M0");
  assert.equal(mitm.getMappedEntry("PLACEHOLDER_M0", options).model, "cx/custom-router-model");
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

test("normalizeModelMap removes generated built-in ag prefix mappings", () => {
  const result = mitm.normalizeModelMap({
    "claude-opus-4-6-thinking": "ag/claude-opus-4-6-thinking",
    "custom-router-model": "cx/custom-router-model",
  });

  assert.equal(result["claude-opus-4-6-thinking"], undefined);
  assert.equal(result["custom-router-model"], "cx/custom-router-model");
});

test("proxy defaults to passthrough except model list and LLM endpoints", () => {
  assert.equal(mitm.isFetchAvailableModelsRequest("/v1internal:fetchAvailableModels"), true);
  assert.equal(mitm.isChatRequestUrl("/v1internal:streamGenerateContent"), true);
  assert.equal(mitm.isAccountBootstrapRequest("/v1internal:fetchUserInfo"), true);
  assert.equal(mitm.isChatRequestUrl("/v1internal:fetchUserInfo"), false);
  assert.equal(mitm.isAccountBootstrapRequest("/v1internal:streamGenerateContent"), false);
});

test("readConfig keeps legacy runtime config over stripped bundled settings", () => {
  const legacyPath = path.join(tempRoot, "config.json");
  fs.writeFileSync(legacyPath, JSON.stringify({
    routerUrl: "http://legacy.local/v1/chat/completions",
    modelMap: { "custom-antigravity-model": "upstream/custom" },
  }));

  const config = mitm.readConfig();

  assert.equal(config.routerUrl, "http://legacy.local/v1/chat/completions");
  assert.equal(config.modelMap["custom-antigravity-model"], "upstream/custom");
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

test("config tab combines model loading and saving", () => {
  const html = mitm.guiHtml();

  assert.match(html, /Test, Load &amp; Save/);
  assert.doesNotMatch(html, /id="saveBtn"/);
  assert.match(html, /<select id="newAliasModel"/);
  assert.match(html, /Custom upstream model/);
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
