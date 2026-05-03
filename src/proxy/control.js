const fs = require("fs");
const https = require("https");
const os = require("os");
const path = require("path");

const { APP_NAME, DEFAULT_TARGET, IS_MAC, IS_WIN } = require("../config/constants");
const { appDir, runtimeDir } = require("../config");
const { appendLog, proxyLogPath } = require("../system/logging");
const {
  execPowerShell,
  execPromise,
  execWithSudo,
  isWindowsElevated,
  powershellSingleQuote,
  safeChildProcessEnv,
  shellQuote,
  windowsCommandLineArguments,
} = require("../system");

function normalizeProcessName(value) {
  const text = String(value || "").trim();
  return text || "unknown";
}
const {
  bootstrapMacProxyLaunchDaemon,
  bootoutMacProxyLaunchDaemon,
  macLaunchAgentBootstrapCommand,
  macLaunchAgentBootoutCommand,
  macLaunchAgentDomain,
  macLaunchAgentPrintCommand,
  macProxyLaunchDaemonLabel,
  macProxyLaunchDaemonPath,
  macProxyLaunchDaemonPlist,
  proxyStartCommandParts,
  proxyStartShellCommand,
  xmlEscape,
  autoStartCommandParts,
  autoStartLabel,
  autoStartName,
  autoStartPath,
  autoStartShellCommand,
  autoStartStatus,
  cliWorkingDirectory,
  disableAutoStart,
  enableAutoStart,
  isAutoStartEnabled,
  windowsAutoStartStatusScript,
  windowsRefreshAutoStartPath,
  windowsRegisterAutoStartScript,
} = require("../system/autostart");

async function isPortListening(port) {
  if (IS_WIN) {
    return (await pidsListeningOnPortWindows(port)).length > 0;
  }

  try {
    const output = await execPromise(`lsof -nP -iTCP:${Number(port)} -sTCP:LISTEN -t`);
    return output.trim().length > 0;
  } catch {
    return false;
  }
}

async function getPortOwners(port) {
  const pids = IS_WIN ? await pidsListeningOnPortWindows(port) : await pidsListeningOnPortUnix(port);
  if (pids.length === 0) return [];
  if (IS_WIN) return processDetailsWindows(pids);
  return processDetailsUnix(pids);
}

async function processDetailsUnix(pids) {
  if (pids.length === 0) return [];
  try {
    const stdout = await execPromise(`ps -o pid= -o comm= -p ${pids.map((pid) => shellQuote(pid)).join(",")}`);
    const byPid = new Map();
    for (const line of stdout.split(/\r?\n/)) {
      const match = line.trim().match(/^(\d+)\s+(.+)$/);
      if (match) byPid.set(match[1], normalizeProcessName(match[2]));
    }
    return pids.map((pid) => ({ pid, name: byPid.get(pid) || "unknown" }));
  } catch {
    return pids.map((pid) => ({ pid, name: "unknown" }));
  }
}

async function processDetailsWindows(pids) {
  if (pids.length === 0) return [];
  try {
    const ids = pids.map((pid) => Number(pid)).filter(Number.isFinite).join(",");
    const stdout = await execPowerShell(`Get-Process -Id ${ids} -ErrorAction SilentlyContinue | Select-Object Id,ProcessName | ConvertTo-Json -Compress`);
    const parsed = stdout.trim() ? JSON.parse(stdout) : [];
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    const byPid = new Map(rows.map((row) => [String(row.Id), normalizeProcessName(row.ProcessName)]));
    return pids.map((pid) => ({ pid, name: byPid.get(pid) || "unknown" }));
  } catch {
    return pids.map((pid) => ({ pid, name: "unknown" }));
  }
}

function formatPortOwners(owners) {
  return (owners || []).map((owner) => `${owner.name || "unknown"}#${owner.pid}`).join(", ");
}

function isManagedProxyHealthPayload(statusCode, rawBody) {
  if (statusCode !== 200) return false;
  try {
    const payload = JSON.parse(String(rawBody || ""));
    return Boolean(payload && payload.ok === true && payload.app === APP_NAME);
  } catch {
    return false;
  }
}

function checkProxyHealth(port, targetHost = DEFAULT_TARGET) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const req = https.request({
      hostname: "127.0.0.1",
      port: Number(port),
      path: "/_mitm_health",
      method: "GET",
      headers: { host: targetHost },
      servername: targetHost,
      rejectUnauthorized: false,
      timeout: 2000,
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => done(isManagedProxyHealthPayload(
        res.statusCode,
        Buffer.concat(chunks).toString("utf8")
      )));
    });
    req.on("timeout", () => {
      req.destroy();
      done(false);
    });
    req.on("error", () => done(false));
    req.end();
  });
}

async function waitForProxyHealth(port, targetHost = DEFAULT_TARGET, attempts = 60) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await checkProxyHealth(port, targetHost)) return true;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

async function startProxyDetached({ sudoPassword, port, targetHost = DEFAULT_TARGET }) {
  if (await checkProxyHealth(port, targetHost)) {
    return { started: false, alreadyRunning: true, port };
  }

  if (await isPortListening(port)) {
    const owners = await getPortOwners(port);
    const ownerText = formatPortOwners(owners) || "unknown process";
    throw new Error(`Port ${port} is already in use by ${ownerText}`);
  }

  const logPath = proxyLogPath();
  appendLog("info", "Starting proxy process", {
    port,
    targetHost,
    logPath,
    execPath: process.execPath,
    pkg: Boolean(process.pkg),
    runtimeDir: runtimeDir(),
  });

  if (IS_WIN) {
    const { cliEntrypointPath } = require("../config");
    const windowsArgs = process.pkg
      ? ["start", "--skip-setup", "--port", String(Number(port))]
      : [cliEntrypointPath(), "start", "--skip-setup", "--port", String(Number(port))];
    if (await isWindowsElevated()) {
      const { spawn } = require("child_process");
      const out = fs.openSync(logPath, "a");
      try {
        const child = spawn(process.execPath, windowsArgs, {
          detached: true,
          stdio: ["ignore", out, out],
          cwd: runtimeDir(),
          env: safeChildProcessEnv(),
          windowsHide: true,
        });
        child.unref();
      } finally {
        fs.closeSync(out);
      }
    } else {
      const psScript = [
        `$psi = [System.Diagnostics.ProcessStartInfo]::new()`,
        `$psi.FileName = ${powershellSingleQuote(process.execPath)}`,
        `$psi.Arguments = ${powershellSingleQuote(windowsCommandLineArguments(windowsArgs))}`,
        `$psi.WorkingDirectory = ${powershellSingleQuote(runtimeDir())}`,
        `$psi.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden`,
        `$psi.UseShellExecute = $true`,
        `$psi.Verb = 'runas'`,
        `[System.Diagnostics.Process]::Start($psi) | Out-Null`,
      ].join("; ");
      await execPowerShell(psScript);
    }
  } else if (IS_MAC) {
    await bootstrapMacProxyLaunchDaemon({ sudoPassword, port, logPath });
  } else {
    const innerCommand = [
      `cd ${shellQuote(runtimeDir())}`,
      `HOME=${shellQuote(os.homedir())} MITM_APP_DIR=${shellQuote(appDir())} exec ${proxyStartShellCommand(["--port", String(port)])}`,
    ].join(" && ");
    const command = `nohup sh -c ${shellQuote(innerCommand)} >> ${shellQuote(logPath)} 2>&1 < /dev/null &`;
    await execWithSudo(command, sudoPassword);
  }

  if (!(await waitForProxyHealth(port, targetHost))) {
    throw new Error(`Proxy did not start on port ${port}. Check ${logPath}`);
  }

  return { started: true, alreadyRunning: false, port, logPath };
}

async function pidsListeningOnPortUnix(port) {
  try {
    const stdout = await execPromise(`lsof -ti tcp:${Number(port)} -sTCP:LISTEN 2>/dev/null || true`);
    return parsePidsFromOutput(stdout);
  } catch (_) {
    return [];
  }
}

function localAddressMatchesPort(localAddress, port) {
  const text = String(localAddress || "").trim();
  const expected = String(Number(port));
  if (!text) return false;
  if (text.endsWith(`:${expected}`)) return true;
  if (text.endsWith(`]:${expected}`)) return true;
  return false;
}

function parseWindowsNetstatPids(stdout, port) {
  const pids = [];
  for (const line of String(stdout || "").split(/\r?\n/)) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 5) continue;
    if (!/^TCP$/i.test(fields[0])) continue;
    if (!/^LISTENING$/i.test(fields[3])) continue;
    if (!localAddressMatchesPort(fields[1], port)) continue;
    const pid = fields[4];
    if (/^\d+$/.test(pid)) pids.push(pid);
  }
  return Array.from(new Set(pids));
}

async function pidsListeningOnPortWindows(port) {
  const localPort = Number(port);
  try {
    const stdout = await execPowerShell(
      `Get-NetTCPConnection -LocalPort ${localPort} -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique`,
      { timeout: 10_000 }
    );
    const pids = parsePidsFromOutput(stdout);
    if (pids.length > 0) return pids;
  } catch (_) {
    // Fall through to netstat fallback below.
  }

  try {
    const stdout = await execPromise("netstat -ano -p tcp", { timeout: 10_000 });
    return parseWindowsNetstatPids(stdout, localPort);
  } catch (_) {
    return [];
  }
}

function parsePidsFromOutput(stdout) {
  return Array.from(new Set(String(stdout || "").split(/\s+/).map((pid) => pid.trim()).filter(Boolean)));
}

function windowsStopProxyScript(port) {
  return [
    `$p = Get-NetTCPConnection -LocalPort ${Number(port)} -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique`,
    `if ($p) { $p | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue } }`,
  ].join("; ");
}

async function killPidsUnix(pids, sudoPassword) {
  const command = `kill ${pids.map((pid) => shellQuote(pid)).join(" ")}`;
  try {
    await execPromise(command);
  } catch (error) {
    await execWithSudo(command, sudoPassword);
  }
}

// removePlist: truyền true khi muốn full cleanup (Stop & Remove DNS).
// Nếu false, chỉ stop cho session này – proxy vẫn auto-start sau reboot (via LaunchDaemon).
async function stopProxyByPort({ sudoPassword, port, targetHost = DEFAULT_TARGET, removePlist = false }) {
  if (!(await checkProxyHealth(port, targetHost)) && !(await isPortListening(port))) {
    return { stopped: false, wasRunning: false, port };
  }

  if (IS_WIN) {
    // Proxy chạy với admin token (Start-Process -Verb RunAs).
    // Get-NetTCPConnection từ non-elevated có thể thấy port, nhưng Stop-Process cần admin.
    // → Gộp find + kill vào 1 elevated script = 1 UAC prompt duy nhất.
    await execPowerShell(windowsStopProxyScript(port), { elevated: !(await isWindowsElevated()) });
  } else {
    if (IS_MAC && Number(port) < 1024 && fs.existsSync(macProxyLaunchDaemonPath())) {
      // removePlist=true (Stop & Remove DNS): xóa plist để proxy không auto-start sau reboot
      // removePlist=false (Stop Proxy tạm thời): giữ plist, proxy vẫn tự bật lại sau reboot
      await bootoutMacProxyLaunchDaemon(sudoPassword, { removePlist }).catch((error) => {
        appendLog("warn", "Failed to unload proxy LaunchDaemon before PID kill", { message: error.message });
      });
      for (let i = 0; i < 5; i += 1) {
        if (!(await isPortListening(port))) return { stopped: true, wasRunning: true, port };
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }
    const pids = await pidsListeningOnPortUnix(port);
    if (pids.length === 0) return { stopped: false, wasRunning: false, port };
    await killPidsUnix(pids, sudoPassword);
  }

  for (let i = 0; i < 10; i += 1) {
    if (!(await isPortListening(port))) return { stopped: true, wasRunning: true, port };
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  return { stopped: true, wasRunning: true, port, warning: `Port ${port} may still be shutting down` };
}

module.exports = {
  autoStartCommandParts,
  autoStartLabel,
  autoStartName,
  autoStartPath,
  autoStartShellCommand,
  autoStartStatus,
  cliWorkingDirectory,
  checkProxyHealth,
  disableAutoStart,
  enableAutoStart,
  macLaunchAgentBootstrapCommand,
  macLaunchAgentBootoutCommand,
  macLaunchAgentDomain,
  macLaunchAgentPrintCommand,
  macProxyLaunchDaemonLabel,
  macProxyLaunchDaemonPath,
  macProxyLaunchDaemonPlist,
  formatPortOwners,
  getPortOwners,
  isAutoStartEnabled,
  isPortListening,
  isManagedProxyHealthPayload,
  parsePidsFromOutput,
  pidsListeningOnPortUnix,
  pidsListeningOnPortWindows,
  processDetailsUnix,
  processDetailsWindows,
  startProxyDetached,
  stopProxyByPort,
  waitForProxyHealth,
  windowsStopProxyScript,
  windowsAutoStartStatusScript,
  windowsRefreshAutoStartPath,
  windowsRegisterAutoStartScript,
  xmlEscape,
};
