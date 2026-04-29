const path = require("node:path");
const { spawn } = require("node:child_process");
const { app, BrowserWindow, dialog } = require("electron");

const DEFAULT_UI_PORT = 20245;
let backendProcess = null;
let mainWindow = null;

function repoRoot() {
  return path.resolve(__dirname, "..");
}

function backendEntrypoint() {
  return path.join(repoRoot(), "index.js");
}

function backendEnv() {
  return {
    ...process.env,
    MITM_ELECTRON: "1",
  };
}

function startBackend() {
  const uiPort = Number(process.env.MITM_UI_PORT || DEFAULT_UI_PORT);
  backendProcess = spawn(process.execPath, [backendEntrypoint(), "gui", "--no-open", "--ui-port", String(uiPort)], {
    cwd: repoRoot(),
    env: backendEnv(),
    stdio: ["ignore", "pipe", "pipe"],
  });

  backendProcess.stdout.on("data", (chunk) => process.stdout.write(`[backend] ${chunk}`));
  backendProcess.stderr.on("data", (chunk) => process.stderr.write(`[backend] ${chunk}`));
  backendProcess.once("exit", (code, signal) => {
    backendProcess = null;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("backend-exit", { code, signal });
    }
  });

  return { url: `http://127.0.0.1:${uiPort}/` };
}

async function waitForBackend(url, attempts = 80) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) return true;
    } catch {
      // Backend is still booting.
    }
    await new Promise((resolve) => setTimeout(resolve, 125));
  }
  return false;
}

async function createWindow(url) {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 1040,
    minHeight: 720,
    title: "MITM Antigravity",
    backgroundColor: "#0b1020",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  await mainWindow.loadURL(url);
}

async function main() {
  const { url } = startBackend();
  const ready = await waitForBackend(url);
  if (!ready) {
    await dialog.showMessageBox({
      type: "error",
      title: "Backend startup failed",
      message: "MITM Antigravity GUI backend did not become ready in time.",
      detail: `Expected backend URL: ${url}`,
    });
    app.quit();
    return;
  }

  await createWindow(url);
}

app.whenReady().then(main);

app.on("window-all-closed", () => {
  app.quit();
});

app.on("before-quit", () => {
  if (backendProcess && !backendProcess.killed) {
    backendProcess.kill("SIGTERM");
  }
});
