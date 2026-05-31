const { exec, spawn } = require("child_process");
const fs   = require("fs");
const os   = require("os");
const path = require("path");

const { IS_MAC, IS_WIN } = require("../config/constants");

function safeChildProcessEnv(env = process.env) {
  const next = { ...env };
  if (process.pkg) {
    // pkg injects PKG_EXECPATH into child_process calls. When a packaged
    // backend launches itself with CLI args, that makes "start" look like a
    // JS entrypoint path instead of an app command.
    next.PKG_EXECPATH = "";
  }
  return next;
}

function isRoot() {
  return typeof process.getuid === "function" && process.getuid() === 0;
}

function openBrowser(url) {
  const command = IS_WIN ? "cmd" : IS_MAC ? "open" : "xdg-open";
  const args = IS_WIN ? ["/c", "start", "", url] : [url];
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  child.unref();
}

// Mặc định maxBuffer của exec là 1MB → quá nhỏ cho lsof/netstat/ps trên máy
// nhiều connection (đặc biệt Windows với hàng nghìn TCP entries). Bump lên 16MB
// để tránh "stdout maxBuffer exceeded" gây fail random khi detect port.
const EXEC_DEFAULT_MAX_BUFFER = 16 * 1024 * 1024;

function execPromise(command, { timeout = 30_000, maxBuffer = EXEC_DEFAULT_MAX_BUFFER } = {}) {
  return new Promise((resolve, reject) => {
    exec(command, { timeout, maxBuffer, env: safeChildProcessEnv() }, (error, stdout, stderr) => {
      if (error) {
        // exec sẽ set error.killed=true khi timeout. Cho user thông báo rõ ràng
        // thay vì lỗi mơ hồ "Command failed".
        if (error.killed && error.signal) {
          reject(new Error(`Command timed out after ${timeout}ms (signal ${error.signal}): ${command.slice(0, 120)}`));
          return;
        }
        reject(new Error(stderr || error.message));
        return;
      }
      resolve(stdout);
    });
  });
}

async function isWindowsElevated() {
  if (!IS_WIN) return false;
  // Primary: ask .NET whether the current token is in the Administrators role.
  // This is far more reliable than `net session`, which depends on the Server
  // service running and can throw for unrelated reasons (false "not elevated"
  // → spurious extra UAC prompts).
  try {
    const stdout = await execPowerShell(
      "[bool]([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)"
    );
    if (/true/i.test(stdout)) return true;
    if (/false/i.test(stdout)) return false;
  } catch {
    // Fall through to the legacy probe below.
  }
  try {
    await execPromise("net session");
    return true;
  } catch {
    return false;
  }
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function powershellSingleQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function compactProcessOutput(value) {
  return String(value || "").trim();
}

function elevatedPowerShellErrorMessage(error, captured, stdout, stderr) {
  const details = [
    compactProcessOutput(captured),
    compactProcessOutput(stderr),
    compactProcessOutput(stdout),
  ].filter(Boolean).join("\n");
  const exitText = error && typeof error.code !== "undefined" ? ` (exit ${error.code})` : "";
  const fallback = error && error.killed
    ? "Timed out waiting for the Windows administrator prompt or elevated PowerShell."
    : "No output captured. Approve the Windows administrator prompt, or run MITM Antigravity as administrator.";
  return `Elevated PowerShell failed${exitText}: ${details || fallback}`;
}

function windowsCommandLineArgument(value) {
  const text = String(value);
  if (text.length === 0) return "\"\"";
  if (!/[\s"]/.test(text)) return text;

  let result = "\"";
  let backslashes = 0;
  for (const char of text) {
    if (char === "\\") {
      backslashes += 1;
      continue;
    }
    if (char === "\"") {
      result += "\\".repeat(backslashes * 2 + 1);
      result += char;
      backslashes = 0;
      continue;
    }
    result += "\\".repeat(backslashes);
    result += char;
    backslashes = 0;
  }
  result += "\\".repeat(backslashes * 2);
  result += "\"";
  return result;
}

function windowsCommandLineArguments(args) {
  return args.map((arg) => windowsCommandLineArgument(arg)).join(" ");
}

function windowsCmdRedirectArguments(filePath, args, logPath) {
  const binary = `"${String(filePath).replace(/"/g, '""')}"`;
  const log = `"${String(logPath).replace(/"/g, '""')}"`;
  const argText = windowsCommandLineArguments(args || []);
  const command = `${binary}${argText ? ` ${argText}` : ""} >> ${log} 2>&1`;
  return `/s /c "${command}"`;
}

function execWithSudo(command, password, { interactive = true } = {}) {
  if (isRoot()) return execPromise(command);
  if (password) {
    return new Promise((resolve, reject) => {
      const child = spawn("sudo", ["-S", "sh", "-c", command], {
        stdio: ["pipe", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => { stdout += d; });
      child.stderr.on("data", (d) => { stderr += d; });

      child.on("error", (err) => reject(err));
      child.on("close", (code) => {
        if (code === 0) resolve(stdout);
        else reject(new Error(stderr || `Exit code ${code}`));
      });

      child.stdin.write(`${password}\n`);
      child.stdin.end();
    });
  }

  // No cached password and not root. Passive/background callers pass
  // interactive:false so they reject here instead of popping an admin dialog.
  // This is what stops macOS status-polling (port 443 owner lookup) from
  // spawning random osascript password prompts while the proxy is stopped.
  if (!interactive) {
    const error = new Error("Elevation required but skipped (non-interactive).");
    error.code = "ESUDO_NONINTERACTIVE";
    return Promise.reject(error);
  }

  if (IS_MAC) {
    const script = `do shell script ${JSON.stringify(command)} with administrator privileges`;
    // The native admin dialog blocks on user input. Keep a generous timeout so a
    // user typing their password isn't cut off by execPromise's 30s default
    // (which would kill osascript and make Stop/DNS buttons appear to "do nothing").
    return execPromise(`osascript -e ${shellQuote(script)}`, { timeout: 120_000 });
  }

  return execPromise(`sudo sh -c ${shellQuote(command)}`, { timeout: 120_000 });
}

// Join multiple shell commands into a single `&&` chain. Empty/whitespace
// fragments are dropped so optional steps can be conditionally included.
// Pure + exported for unit testing.
function composeSudoBatch(commands) {
  const list = (Array.isArray(commands) ? commands : [commands])
    .map((cmd) => String(cmd == null ? "" : cmd).trim())
    .filter(Boolean);
  return list.join(" && ");
}

// Run several privileged commands inside ONE elevated invocation = exactly one
// osascript dialog (macOS) or one `sudo -S` call (when a password is supplied).
// Used by the GUI to collapse cert+hosts+flush into a single prompt per action.
function execSudoBatch(commands, { sudoPassword = "", interactive = true } = {}) {
  const batch = composeSudoBatch(commands);
  if (!batch) return Promise.resolve("");
  return execWithSudo(batch, sudoPassword, { interactive });
}

function execPowerShell(script, { elevated = false, timeout } = {}) {
  // ── Non-elevated: stdout piped trực tiếp ────────────────────────────────
  if (!elevated) {
    const encoded = Buffer.from(script, "utf16le").toString("base64");
    const command = `powershell -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${encoded}`;
    const nonElevatedTimeout = Number.isFinite(Number(timeout)) ? Number(timeout) : 30_000;
    return new Promise((resolve, reject) => {
      exec(command, {
        timeout: nonElevatedTimeout,
        maxBuffer: EXEC_DEFAULT_MAX_BUFFER,
        env: safeChildProcessEnv(),
      }, (error, stdout, stderr) => {
        if (error) {
          if (error.killed && error.signal) {
            reject(new Error(`PowerShell timed out after ${nonElevatedTimeout}ms`));
            return;
          }
          reject(new Error(stderr || error.message));
          return;
        }
        resolve(stdout);
      });
    });
  }

  // ── Elevated (Verb RunAs): Start-Process không pipe stdout về process cha.
  // Viết script thật ra temp .ps1 để tránh lỗi Windows "command line is too long"
  // khi EncodedCommand bị phình lớn bởi UTF-16 + Base64 + nested launcher.
  const nonce = `${process.pid}-${Date.now()}`;
  const outFile = path.join(os.tmpdir(), `mitm-ps-${nonce}.txt`);
  const scriptFile = path.join(os.tmpdir(), `mitm-ps-${nonce}.ps1`);
  const outFilePs = powershellSingleQuote(outFile);
  const scriptFilePs = powershellSingleQuote(scriptFile);

  const wrapped = [
    `$ErrorActionPreference = 'Stop'`,
    `try {`,
    `  $global:LASTEXITCODE = 0`,
    `  $output = & { ${script} } 2>&1`,
    `  $exitCode = if ($LASTEXITCODE -is [int]) { $LASTEXITCODE } else { 0 }`,
    `  $output | Out-File -FilePath ${outFilePs} -Encoding UTF8 -Force`,
    `  if ($exitCode -ne 0) { exit $exitCode }`,
    `} catch {`,
    `  $_ | Out-String | Out-File -FilePath ${outFilePs} -Encoding UTF8 -Force`,
    `  exit 1`,
    `}`,
  ].join("; ");

  fs.writeFileSync(scriptFile, wrapped, "utf8");

  const powershellPath = path.join(
    process.env.SystemRoot || "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe"
  );
  const elevatedArgs = `-NoProfile -ExecutionPolicy Bypass -File ${scriptFilePs}`;
  const launcher = [
    `$ErrorActionPreference = 'Stop'`,
    `try {`,
    `  $psi = [System.Diagnostics.ProcessStartInfo]::new()`,
    `  $psi.FileName = ${powershellSingleQuote(powershellPath)}`,
    `  $psi.Arguments = ${powershellSingleQuote(elevatedArgs)}`,
    `  $psi.UseShellExecute = $true`,
    `  $psi.Verb = 'runas'`,
    `  $psi.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden`,
    `  $p = [System.Diagnostics.Process]::Start($psi)`,
    `  if ($null -eq $p) { throw 'Elevation was cancelled or failed to start.' }`,
    `  $p.WaitForExit()`,
    `  exit $p.ExitCode`,
    `} catch {`,
    `  $_ | Out-String | Out-File -FilePath ${outFilePs} -Encoding UTF8 -Force`,
    `  exit 1`,
    `}`,
  ].join("; ");
  const launcherEncoded = Buffer.from(launcher, "utf16le").toString("base64");
  const elevatedCmd = `powershell -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${launcherEncoded}`;

  const elevatedTimeout = Number.isFinite(Number(timeout)) ? Number(timeout) : 120_000;
  return new Promise((resolve, reject) => {
    exec(elevatedCmd, {
      timeout: elevatedTimeout,
      maxBuffer: EXEC_DEFAULT_MAX_BUFFER,
      env: safeChildProcessEnv(),
    }, (error, stdout, stderr) => {
      let captured = "";
      try {
        if (fs.existsSync(outFile)) {
          captured = fs.readFileSync(outFile, "utf8");
          try { fs.unlinkSync(outFile); } catch { /* best effort */ }
        }
      } catch { /* ignore read error */ }
      try { fs.unlinkSync(scriptFile); } catch { /* best effort */ }

      if (error) {
        reject(new Error(elevatedPowerShellErrorMessage(error, captured, stdout, stderr)));
      } else {
        resolve(captured || stdout);
      }
    });
  });
}

module.exports = {
  composeSudoBatch,
  execPowerShell,
  execPromise,
  execSudoBatch,
  execWithSudo,
  elevatedPowerShellErrorMessage,
  isWindowsElevated,
  isRoot,
  openBrowser,
  powershellSingleQuote,
  safeChildProcessEnv,
  shellQuote,
  windowsCmdRedirectArguments,
  windowsCommandLineArgument,
  windowsCommandLineArguments,
};
