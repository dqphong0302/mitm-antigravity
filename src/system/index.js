const { exec, spawn } = require("child_process");
const fs   = require("fs");
const os   = require("os");
const path = require("path");

const { IS_MAC, IS_WIN } = require("../config/constants");

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
    exec(command, { timeout }, (error, stdout, stderr) => {
      if (error) reject(new Error(stderr || error.message));
      else resolve(stdout);
    });
  });
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
      exec(command, { timeout: 30_000 }, (error, stdout, stderr) => {
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
  const elevatedCmd = `powershell -NoProfile -Command "Start-Process -FilePath powershell.exe -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-EncodedCommand','${encoded}') -Verb RunAs -Wait"`;

  return new Promise((resolve, reject) => {
    exec(elevatedCmd, { timeout: 120_000 }, (error, stdout, stderr) => {
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
  isRoot,
  openBrowser,
  powershellSingleQuote,
  shellQuote,
  windowsCommandLineArgument,
  windowsCommandLineArguments,
};
