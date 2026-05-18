#!/usr/bin/env node
/**
 * Chẩn đoán "tại sao proxy passthrough thay vì intercept".
 *
 * Cách dùng:
 *   node scripts/diagnose-bypass.js
 *   node scripts/diagnose-bypass.js gemini-3-pro-high
 *
 * Kiểm tra theo thứ tự cùng logic với runProxy:
 *   1. Settings có routerUrl + apiKey hợp lệ?
 *   2. Cert đã generate?
 *   3. /etc/hosts đã redirect target hosts về 127.0.0.1?
 *   4. Proxy có đang listen + health-check pass?
 *   5. Mỗi model alias được extract & resolve về mapping gì?
 *   6. Có rơi vào trường hợp passthrough (auth bootstrap / bypass header / unmapped) không?
 */

const fs = require("fs");
const path = require("path");
const https = require("https");
const dns = require("dns");
const { promisify } = require("util");

const {
  ANTIGRAVITY_ALIASES,
  PRIMARY_ANTIGRAVITY_ALIASES,
  DEFAULT_TARGET_HOSTS,
  DEFAULT_CONFIG,
  HOSTS_FILE,
  LOOPBACK_IPV4,
  LOOPBACK_IPV6,
} = require("../src/config/constants");
const { readConfig } = require("../src/config");
const { certPaths, certExists } = require("../src/cert");
const { getMappedEntry, modelNameCandidates, builtInAliasForModel } = require("../src/models");
const { checkProxyHealth, isPortListening, getPortOwners, formatPortOwners } = require("../src/proxy/control");

const args = process.argv.slice(2);
const requestedModels = args.length > 0 ? args : PRIMARY_ANTIGRAVITY_ALIASES;

function section(title) {
  console.log(`\n=== ${title} ===`);
}
function ok(text) { console.log(`  ✅ ${text}`); }
function warn(text) { console.log(`  ⚠️  ${text}`); }
function bad(text) { console.log(`  ❌ ${text}`); }
function info(text) { console.log(`  • ${text}`); }

async function main() {
  const options = readConfig();

  section("1. Settings");
  info(`routerUrl  = ${options.routerUrl || "(chưa set)"}`);
  info(`apiKey     = ${options.apiKey ? options.apiKey.slice(0, 6) + "..." : "(chưa set)"}`);
  info(`port       = ${options.port}`);
  info(`targetHosts= ${(options.targetHosts || DEFAULT_TARGET_HOSTS).join(", ")}`);
  info(`alwaysIntercept = ${options.alwaysIntercept || false}`);
  if (!options.routerUrl || options.routerUrl === DEFAULT_CONFIG.routerUrl) {
    warn("routerUrl đang là mặc định/localhost. Set router thật trong GUI Config.");
  }
  if (!options.apiKey) {
    warn("apiKey trống. Mọi request map sẽ fail Authorization → user có thể tưởng bị bypass.");
  }

  section("2. Cert");
  const cp = certPaths();
  if (certExists()) {
    ok(`Cert đã có: ${cp.certPath}`);
    info(`CA path  : ${cp.caCertPath}`);
  } else {
    bad(`Cert CHƯA generate. Chạy "node index.js setup" hoặc dùng GUI > Apply DNS & Cert.`);
  }

  section("3. /etc/hosts redirect");
  let hostsText = "";
  try {
    hostsText = fs.readFileSync(HOSTS_FILE, "utf8");
  } catch (err) {
    bad(`Không đọc được ${HOSTS_FILE}: ${err.message}`);
  }
  const remoteIp = options.remoteIp || LOOPBACK_IPV4;
  for (const host of options.targetHosts || DEFAULT_TARGET_HOSTS) {
    const v4 = new RegExp(`^\\s*${remoteIp.replace(/\./g, "\\.")}\\s+${host}(\\s|$)`, "m");
    const v6 = new RegExp(`^\\s*${LOOPBACK_IPV6}\\s+${host}(\\s|$)`, "m");
    const hasV4 = v4.test(hostsText);
    const hasV6 = v6.test(hostsText);
    if (hasV4 && hasV6) ok(`${host} → ${remoteIp} (v4) + ::1 (v6)`);
    else if (hasV4) warn(`${host} → ${remoteIp} (v4) NHƯNG thiếu ::1 (v6) → AAAA resolve sẽ đi thẳng Google`);
    else bad(`${host} KHÔNG có entry → Antigravity đi thẳng Google, KHÔNG qua proxy`);
  }

  section("4. Proxy listening");
  const port = Number(options.port || 443);
  const listening = await isPortListening(port);
  if (!listening) {
    bad(`Port ${port} KHÔNG ai listen. Proxy chưa start hoặc đã chết.`);
  } else {
    const owners = await getPortOwners(port);
    info(`Port ${port} đang listen: ${formatPortOwners(owners) || "unknown"}`);
    const targetHost = (options.targetHosts || DEFAULT_TARGET_HOSTS)[0];
    const healthy = await checkProxyHealth(port, targetHost);
    if (healthy) ok(`Health check pass: GET https://${targetHost}/_mitm_health → 200 + app=mitm-antigravity`);
    else bad(`Health check FAIL → process trên port ${port} không phải proxy này (proxy cũ/khác?)`);
  }

  section("5. DNS resolution check (Google Public DNS)");
  const resolver = new dns.Resolver();
  resolver.setServers(["8.8.8.8"]);
  const resolve4 = promisify(resolver.resolve4.bind(resolver));
  for (const host of options.targetHosts || DEFAULT_TARGET_HOSTS) {
    try {
      const ips = await resolve4(host);
      ok(`${host} → ${ips[0]} (real Google IP)`);
    } catch (err) {
      warn(`${host} resolve fail: ${err.message}`);
    }
  }

  section("6. Model mapping simulation");
  const modelMap = options.modelMap || {};
  const mapSize = Object.keys(modelMap).length;
  info(`modelMap có ${mapSize} entries: ${Object.keys(modelMap).join(", ") || "(rỗng)"}`);
  if (mapSize === 0 && !options.model && !options.alwaysIntercept) {
    bad("modelMap RỖNG + alwaysIntercept=false + không có --model → MỌI request sẽ passthrough!");
  }

  for (const requested of requestedModels) {
    console.log(`\n  Model "${requested}":`);
    const candidates = modelNameCandidates(requested);
    info(`  candidates = [${candidates.join(", ")}]`);
    const builtin = builtInAliasForModel(requested);
    if (builtin && builtin !== requested) info(`  builtInAlias = ${builtin}`);
    const entry = getMappedEntry(requested, options);
    if (entry) {
      ok(`  → MAP sang "${entry.model}"${entry.reasoning_effort ? ` (reasoning=${entry.reasoning_effort})` : ""}`);
    } else {
      bad(`  → PASSTHROUGH (không có alias nào trong [${candidates.join(", ")}] khớp với modelMap)`);
      // Gợi ý alias gần nhất
      const hint = candidates.find((c) => ANTIGRAVITY_ALIASES.includes(c));
      if (hint) info(`  Gợi ý: thêm entry "${hint}" vào modelMap qua GUI > Model Mapping`);
    }
  }

  section("Tóm tắt");
  info(`Nếu mục 3 báo ❌ → Antigravity bypass ở tầng DNS, log proxy sẽ TRỐNG`);
  info(`Nếu mục 4 báo ❌ → Antigravity nhận TLS reset, có thể tự fallback DNS thật`);
  info(`Nếu mục 6 báo ❌ → Request về proxy nhưng forward thẳng Google (log hiện "CHAT PASS")`);
  info(`Nếu tất cả ✅ mà vẫn bypass → check NODE_EXTRA_CA_CERTS:`);
  info(`  macOS  : launchctl getenv NODE_EXTRA_CA_CERTS`);
  info(`  Windows: $env:NODE_EXTRA_CA_CERTS (PowerShell)`);
  info(`Và RESTART Antigravity sau khi setup cert.`);
}

main().catch((err) => {
  console.error(`\nDiagnose failed: ${err.message}`);
  process.exit(1);
});
