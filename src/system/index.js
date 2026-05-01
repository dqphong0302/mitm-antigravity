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

function execPromise(command, { timeout = 30_000 } = {}) {
  return new Promise((resolve, reject) => {
    exec(command, { timeout, env: safeChildProcessEnv() }, (error, stdout, stderr) => {
      if (error) reject(new Error(stderr || error.message));
      else resolve(stdout);
    });
  });
}

async function isWindowsElevated() {
  if (!IS_WIN) return false;
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

function execWithSudo(command, password) {
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

      child.on("close", (code) => {
        if (code === 0) resolve(stdout);
        else reject(new Error(stderr || `Exit code ${code}`));
      });

      child.stdin.write(`${password}\n`);
      child.stdin.end();
    });
  }

  if (IS_MAC) {
    const script = `do shell script ${JSON.stringify(command)} with administrator privileges`;
    return execPromise(`osascript -e ${shellQuote(script)}`);
  }

  return execPromise(`sudo sh -c ${shellQuote(command)}`);
}

function execPowerShell(script, { elevated = false } = {}) {
  // ── Non-elevated: stdout piped trực tiếp, timeout 30s ───────────────────
  if (!elevated) {
    const encoded = Buffer.from(script, "utf16le").toString("base64");
    const command = `powershell -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${encoded}`;
    return new Promise((resolve, reject) => {
      exec(command, { timeout: 30_000, env: safeChildProcessEnv() }, (error, stdout, stderr) => {
        if (error) reject(new Error(stderr || error.message));
        else resolve(stdout);
      });
    });
  }

  // ── Elevated (Verb RunAs): Start-Process không pipe stdout về process cha.
  // Dùng temp file để capture output rồi đọc lại sau khi script kết thúc.
  const outFile = path.join(os.tmpdir(), `mitm-ps-${process.pid}-${Date.now()}.txt`);
  const outFilePs = outFile.replace(/\\/g, "\\\\").replace(/'/g, "''");

  // Bọc script: toàn bộ output (kể cả error stream) ghi ra temp file
  const wrapped = [
    `$ErrorActionPreference = 'Continue'`,
    `try {`,
    `  $output = & { ${script} } 2>&1`,
    `  $output | Out-File -FilePath '${outFilePs}' -Encoding UTF8 -Force`,
    `} catch {`,
    `  $_ | Out-File -FilePath '${outFilePs}' -Encoding UTF8 -Force`,
    `  exit 1`,
    `}`,
  ].join("; ");

  const encoded = Buffer.from(wrapped, "utf16le").toString("base64");
  const powershellPath = path.join(
    process.env.SystemRoot || "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe"
  );
  const elevatedArgs = `-NoProfile -ExecutionPolicy Bypass -EncodedCommand ${encoded}`;
  const launcher = [
    `$psi = [System.Diagnostics.ProcessStartInfo]::new()`,
    `$psi.FileName = ${powershellSingleQuote(powershellPath)}`,
    `$psi.Arguments = ${powershellSingleQuote(elevatedArgs)}`,
    `$psi.UseShellExecute = $true`,
    `$psi.Verb = 'runas'`,
    `$psi.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden`,
    `$p = [System.Diagnostics.Process]::Start($psi)`,
    `$p.WaitForExit()`,
    `exit $p.ExitCode`,
  ].join("; ");
  const launcherEncoded = Buffer.from(launcher, "utf16le").toString("base64");
  const elevatedCmd = `powershell -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${launcherEncoded}`;

  return new Promise((resolve, reject) => {
    exec(elevatedCmd, { timeout: 120_000, env: safeChildProcessEnv() }, (error, stdout, stderr) => {
      let captured = "";
      try {
        if (fs.existsSync(outFile)) {
          captured = fs.readFileSync(outFile, "utf8");
          try { fs.unlinkSync(outFile); } catch { /* best effort */ }
        }
      } catch { /* ignore read error */ }

      if (error) {
        reject(new Error(`Elevated PowerShell failed: ${stderr || error.message}`));
      } else {
        resolve(captured || stdout);
      }
    });
  });
}

module.exports = {
  execPowerShell,
  execPromise,
  execWithSudo,
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
