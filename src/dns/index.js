const dns = require("dns");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { promisify } = require("util");

const {
  APP_NAME,
  DNS_BLOCK_BEGIN,
  DNS_BLOCK_END,
  HOSTS_FILE,
  IS_MAC,
  IS_WIN,
  LOOPBACK_IPV4,
  LOOPBACK_IPV6,
} = require("../config/constants");
const { normalizeTargetHosts } = require("../config");
const { execPowerShell, execWithSudo, isRoot, shellQuote } = require("../system");

function usingCustomHostsFile() {
  return Boolean(process.env.MITM_HOSTS_FILE);
}

function readHostsFileContent() {
  return fs.readFileSync(HOSTS_FILE, "utf8");
}

function canWriteHostsDirectly() {
  if (isRoot()) return true;
  try {
    fs.accessSync(HOSTS_FILE, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

async function writeHostsFileContent(content, sudoPassword) {
  if (canWriteHostsDirectly()) {
    fs.writeFileSync(HOSTS_FILE, content);
    return;
  }

  const tempPath = path.join(os.tmpdir(), `${APP_NAME}-hosts-${process.pid}-${Date.now()}.tmp`);
  fs.writeFileSync(tempPath, content, { mode: 0o600 });
  try {
    if (IS_WIN) {
      // Gộp copy + ipconfig /flushdns vào 1 elevated script = 1 UAC prompt
      const psScript = [
        `Copy-Item -LiteralPath '${tempPath.replace(/'/g, "''")}' -Destination '${HOSTS_FILE.replace(/'/g, "''")}' -Force`,
        `ipconfig /flushdns | Out-Null`,
      ].join("; ");
      await execPowerShell(psScript, { elevated: true });
      return;
    }
    await execWithSudo(`cat ${shellQuote(tempPath)} > ${shellQuote(HOSTS_FILE)}`, sudoPassword);
  } finally {
    try { fs.unlinkSync(tempPath); } catch { /* best effort cleanup */ }
  }
}

function splitHostsContent(content) {
  const text = String(content || "");
  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  const hadTrailingNewline = /\r?\n$/.test(text);
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  if (hadTrailingNewline) lines.pop();
  return { lines, newline, hadTrailingNewline };
}

function joinHostsContent(lines, newline, hadTrailingNewline = true) {
  const content = lines.join(newline);
  return hadTrailingNewline || content ? `${content}${newline}` : "";
}

function normalizeHostList(targetHosts) {
  return Array.from(new Set(normalizeTargetHosts(targetHosts)));
}

function hostsLineParts(line) {
  const body = String(line || "").split("#")[0].trim();
  if (!body) return [];
  return body.split(/\s+/);
}

function hostsLineTargetMatches(line, targetHosts) {
  const hostSet = new Set(normalizeHostList(targetHosts));
  if (hostSet.size === 0) return [];
  const parts = hostsLineParts(line);
  if (parts.length < 2) return [];
  return parts.slice(1).filter((host) => hostSet.has(host));
}

function stripDnsEntriesFromHostsContent(content, targetHosts) {
  const { lines, newline, hadTrailingNewline } = splitHostsContent(content);
  const removedHosts = Object.fromEntries(normalizeHostList(targetHosts).map((host) => [host, false]));
  const kept = [];
  let inManagedBlock = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === DNS_BLOCK_BEGIN) {
      if (kept.length > 0 && kept[kept.length - 1].trim() === "") kept.pop();
      inManagedBlock = true;
      continue;
    }

    if (trimmed === DNS_BLOCK_END) {
      inManagedBlock = false;
      continue;
    }

    const matches = hostsLineTargetMatches(line, targetHosts);
    if (inManagedBlock || matches.length > 0) {
      for (const host of matches) removedHosts[host] = true;
      continue;
    }

    kept.push(line);
  }

  return {
    content: joinHostsContent(kept, newline, hadTrailingNewline),
    removed: Object.values(removedHosts).some(Boolean),
    removedHosts,
  };
}

function applyDnsEntriesToHostsContent(content, entries) {
  const targetHosts = entries.map((entry) => entry.targetHost);
  const stripped = stripDnsEntriesFromHostsContent(content, targetHosts);
  const { lines, newline } = splitHostsContent(stripped.content);
  while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();

  const block = [
    DNS_BLOCK_BEGIN,
    ...entries.map((entry) => `${entry.ip} ${entry.targetHost}`),
    DNS_BLOCK_END,
  ];
  const nextLines = lines.length > 0 ? [...lines, "", ...block] : block;
  return {
    content: joinHostsContent(nextLines, newline, true),
    replacedExisting: stripped.removed,
  };
}

function checkDNSEntry(targetHost) {
  try {
    return readHostsFileContent().split(/\r?\n/).some((line) => hostsLineTargetMatches(line, [targetHost]).length > 0);
  } catch {
    return false;
  }
}

function getRedirectIP(targetHost) {
  try {
    const hostsContent = readHostsFileContent();
    const lines = hostsContent.split("\n");
    for (const line of lines) {
      const parts = hostsLineParts(line);
      if (!parts.slice(1).includes(targetHost)) continue;
      if (parts.length >= 2) return parts[0];
    }
  } catch {
    return null;
  }
  return null;
}

function getRedirectIPs(targetHost) {
  try {
    const hostsContent = readHostsFileContent();
    const ips = [];
    for (const line of hostsContent.split("\n")) {
      const parts = hostsLineParts(line);
      if (parts.slice(1).includes(targetHost) && parts[0]) ips.push(parts[0]);
    }
    return Array.from(new Set(ips));
  } catch {
    return [];
  }
}

function checkHostsEntry(targetHost, ip) {
  try {
    return readHostsFileContent().split(/\r?\n/).some((line) => {
      const parts = hostsLineParts(line);
      return parts[0] === ip && parts.slice(1).includes(targetHost);
    });
  } catch {
    return false;
  }
}

// Trả về true nếu ip là địa chỉ loopback (IPv4 hoặc IPv6).
// Dùng để quyết định có cần thêm entry IPv6 song song hay không.
function isLoopbackIp(ip) {
  return ip === LOOPBACK_IPV4 || ip === LOOPBACK_IPV6 || ip === "0.0.0.0";
}

// Tạo danh sách entry cho /etc/hosts.
// Google publish cả A lẫn AAAA records, nên khi redirect về loopback
// cần chặn cả IPv4 (127.0.0.1) và IPv6 (::1) – nếu không client có thể
// dùng kết nối IPv6 để bypass proxy.
function dnsEntriesForHosts(targetHosts, ip) {
  const ipv4Entries = targetHosts.map((targetHost) => ({ ip, targetHost }));
  if (!isLoopbackIp(ip)) return ipv4Entries;
  // Luôn thêm ::1 song song khi redirect về loopback
  const ipv6Entries = targetHosts.map((targetHost) => ({ ip: LOOPBACK_IPV6, targetHost }));
  return [...ipv4Entries, ...ipv6Entries];
}

function dnsConfiguredForHosts(targetHosts, ip) {
  return dnsEntriesForHosts(targetHosts, ip).every((entry) => checkHostsEntry(entry.targetHost, entry.ip));
}

// Resolve hostname → IP sử dụng Google Public DNS (8.8.8.8) để bypass
// /etc/hosts redirect (tránh vòng lặp khi hosts file đang được chỉnh sửa).
// Thử IPv4 trước; nếu không có A record thì fallback sang AAAA.
async function resolveRemoteIP(remoteHost) {
  const resolver = new dns.Resolver();
  resolver.setServers(["8.8.8.8"]);
  const resolve4 = promisify(resolver.resolve4.bind(resolver));
  const resolve6 = promisify(resolver.resolve6.bind(resolver));
  try {
    const addrs = await resolve4(remoteHost);
    if (!addrs || addrs.length === 0) throw new Error("empty A record");
    return addrs;
  } catch {
    const addrs = await resolve6(remoteHost);
    if (!addrs || addrs.length === 0) throw new Error(`Cannot resolve ${remoteHost}: no A or AAAA record`);
    return addrs;
  }
}

async function addDNSEntry({ targetHost, remoteHost, remoteIp, sudoPassword }) {
  if (checkDNSEntry(targetHost)) {
    return { added: false, ip: getRedirectIP(targetHost) || null };
  }

  let ip = remoteIp;
  if (!ip) {
    const addresses = await resolveRemoteIP(remoteHost);
    ip = addresses[0];   // safe: resolveRemoteIP throws nếu array rỗng
  }

  const entry = `${ip} ${targetHost}`;

  if (IS_WIN) {
    await execPowerShell(`Add-Content -Path '${HOSTS_FILE.replace(/'/g, "''")}' -Value '${entry.replace(/'/g, "''")}'`, { elevated: true });
    await execPowerShell("ipconfig /flushdns", { elevated: true });
  } else {
    await execWithSudo(`printf '\\n%s\\n' ${shellQuote(entry)} >> ${shellQuote(HOSTS_FILE)}`, sudoPassword);
    await flushDns(sudoPassword);
  }

  return { added: true, ip };
}

async function addDNSEntries({ targetHosts, remoteHost, remoteIp, sudoPassword }) {
  let ip = remoteIp;
  if (!ip) {
    const addresses = await resolveRemoteIP(remoteHost);
    ip = addresses[0];   // safe: resolveRemoteIP throws nếu array rỗng
  }

  const entries = dnsEntriesForHosts(targetHosts, ip);
  const activeBefore = entries.every((entry) => checkHostsEntry(entry.targetHost, entry.ip));
  const currentContent = readHostsFileContent();
  const next = applyDnsEntriesToHostsContent(currentContent, entries);

  if (next.content !== currentContent) {
    await writeHostsFileContent(next.content, sudoPassword);
    await flushDns(sudoPassword);
  }

  return {
    added: !activeBefore,
    results: entries.map((entry) => ({ targetHost: entry.targetHost, added: !activeBefore, ip: entry.ip })),
  };
}

async function removeDNSEntry({ targetHost, sudoPassword }) {
  if (!checkDNSEntry(targetHost)) return { removed: false };

  if (IS_WIN) {
    const psScript = `$p='${HOSTS_FILE.replace(/'/g, "''")}'; $h='${targetHost.replace(/'/g, "''")}'; (Get-Content $p) | Where-Object { -not ($_.Trim() -match '^[^#\\s]+\\s+.*\\b' + [regex]::Escape($h) + '\\b') } | Set-Content $p`;
    await execPowerShell(psScript, { elevated: true });
    await execPowerShell("ipconfig /flushdns", { elevated: true });
  } else {
    const script = `tmp=$(mktemp) && awk 'BEGIN{h=${shellQuote(targetHost)}} /^#/ || NF < 2 {print; next} {keep=1; for (i=2;i<=NF;i++) if ($i==h) keep=0; if (keep) print}' ${shellQuote(HOSTS_FILE)} > "$tmp" && cat "$tmp" > ${shellQuote(HOSTS_FILE)} && rm "$tmp"`;
    await execWithSudo(script, sudoPassword);
    await flushDns(sudoPassword);
  }

  return { removed: true };
}

async function removeDNSEntries({ targetHosts, sudoPassword }) {
  const currentContent = readHostsFileContent();
  const next = stripDnsEntriesFromHostsContent(currentContent, targetHosts);

  if (next.content !== currentContent) {
    await writeHostsFileContent(next.content, sudoPassword);
    await flushDns(sudoPassword);
  }

  return {
    removed: next.removed,
    results: targetHosts.map((targetHost) => ({ targetHost, removed: Boolean(next.removedHosts[targetHost]) })),
  };
}

async function flushDns(sudoPassword) {
  if (usingCustomHostsFile()) return;
  if (IS_WIN) {
    // Windows: flushdns đã được gộp vào writeHostsFileContent (1 UAC prompt duy nhất).
    // Gọi thêm ở đây sẽ tạo thêm UAC không cần thiết → skip.
    return;
  }
  if (IS_MAC) {
    await execWithSudo("dscacheutil -flushcache && killall -HUP mDNSResponder || true", sudoPassword);
    return;
  }
  await execWithSudo("systemd-resolve --flush-caches 2>/dev/null || resolvectl flush-caches 2>/dev/null || true", sudoPassword);
}

module.exports = {
  addDNSEntries,
  addDNSEntry,
  applyDnsEntriesToHostsContent,
  checkDNSEntry,
  checkHostsEntry,
  dnsConfiguredForHosts,
  dnsEntriesForHosts,
  flushDns,
  getRedirectIP,
  getRedirectIPs,
  hostsLineParts,
  hostsLineTargetMatches,
  isLoopbackIp,
  readHostsFileContent,
  removeDNSEntries,
  removeDNSEntry,
  resolveRemoteIP,
  stripDnsEntriesFromHostsContent,
};
