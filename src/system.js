const { exec, spawn } = require("child_process");

const { IS_MAC, IS_WIN } = require("./constants");

function isRoot() {
  return typeof process.getuid === "function" && process.getuid() === 0;
}

function openBrowser(url) {
  const command = IS_WIN ? "cmd" : IS_MAC ? "open" : "xdg-open";
  const args = IS_WIN ? ["/c", "start", "", url] : [url];
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  child.unref();
}

function execPromise(command) {
  return new Promise((resolve, reject) => {
    exec(command, (error, stdout, stderr) => {
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
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  const command = elevated
    ? `powershell -NoProfile -Command "Start-Process -FilePath powershell.exe -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-EncodedCommand','${encoded}') -Verb RunAs -Wait"`
    : `powershell -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${encoded}`;
  return new Promise((resolve, reject) => {
    exec(command, (error, stdout, stderr) => {
      if (error) reject(new Error(`Elevated command failed: ${error.message}\n${stderr}`));
      else resolve(stdout);
    });
  });
}

module.exports = {
  execPowerShell,
  execPromise,
  execWithSudo,
  isRoot,
  isWindowsElevated,
  openBrowser,
  shellQuote,
};
