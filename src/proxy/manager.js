/**
 * ProxyManager – unified lifecycle controller for the MITM proxy.
 *
 * Two execution modes:
 *
 *   embedded:   The GUI process owns the proxy (runProxy in-process). Best when
 *               the GUI already runs with the privileges required for the port,
 *               or when the user picked an unprivileged port (>1024).
 *
 *   detached:   The GUI spawns the proxy as a separate process via the existing
 *               control.startProxyDetached path. Used when the GUI cannot bind
 *               privileged ports (Windows non-admin, macOS launchd-managed 443,
 *               Linux without root).
 *
 * The GUI always talks to a single ProxyManager instance, so route handlers
 * never need to know which mode is active.
 */

const { EventEmitter } = require("events");

const { primaryTargetHost } = require("../config");
const { appendLog } = require("../system/logging");
const {
  checkProxyHealth,
  getPortOwners,
  formatPortOwners,
  startProxyDetached,
  stopProxyByPort,
} = require("./control");
const { runProxy } = require("./");

const PRIVILEGED_PORT_LIMIT = 1024;

function buildRunOptions(config, overrides = {}) {
  // runProxy expects the same shape readConfig() produces.
  return {
    ...config,
    ...overrides,
    port: Number(overrides.port || config.port || 443),
  };
}

function canRunEmbedded(config) {
  // Anyone can bind ports > 1024. Privileged ports require root or admin.
  const port = Number(config.port || 443);
  if (port >= PRIVILEGED_PORT_LIMIT) return true;
  if (process.platform === "win32") return false; // Use detached + UAC
  if (process.platform === "darwin") return process.getuid && process.getuid() === 0;
  return process.getuid && process.getuid() === 0;
}

class ProxyManager extends EventEmitter {
  constructor() {
    super();
    this.mode = "idle";
    this.handle = null; // embedded: { server, close } from runProxy()
    this.lastConfig = null;
    this.lastError = null;
    // Serialize start/stop/reload so concurrent UI clicks cannot interleave
    // (e.g. two "Start Proxy" requests racing to call runProxy on the same port).
    this._opChain = Promise.resolve();
    this._exitHooked = false;
  }

  isRunning() {
    return this.mode !== "idle";
  }

  describe() {
    return {
      mode: this.mode,
      port: this.lastConfig ? Number(this.lastConfig.port || 443) : null,
      lastError: this.lastError ? String(this.lastError.message || this.lastError) : null,
    };
  }

  // Run an async operation while holding the lifecycle lock. Failures clear
  // the chain so the next request still runs.
  _serialize(fn) {
    const next = this._opChain.then(() => fn(), () => fn());
    this._opChain = next.catch(() => {});
    return next;
  }

  // Best-effort cleanup when the host process exits — prevents an embedded
  // listener from outliving the GUI when something kills it abruptly. We do
  // NOT call process.exit here so other shutdown hooks (GUI server close,
  // log flush, signal cascades to the OS) run normally.
  _ensureProcessExitHook() {
    if (this._exitHooked) return;
    this._exitHooked = true;
    process.once("exit", () => {
      if (this.mode === "embedded" && this.handle) {
        try { this.handle.server.close(); } catch (_) { /* ignore */ }
      }
    });
  }

  start(args) { return this._serialize(() => this._start(args || {})); }
  stop(args)  { return this._serialize(() => this._stop(args || {})); }
  reload(args){ return this._serialize(() => this._reload(args || {})); }

  async _start({ config, sudoPassword, prefer = "auto" } = {}) {
    if (this.mode === "embedded") {
      return { mode: "embedded", started: false, alreadyRunning: true };
    }

    const port = Number(config.port || 443);
    const targetHost = primaryTargetHost(config);

    // Reuse existing detached process if it answers our health probe.
    if (await checkProxyHealth(port, targetHost)) {
      this.mode = "detached";
      this.lastConfig = config;
      this.lastError = null;
      this.emit("status", { mode: "detached", running: true });
      return { mode: "detached", started: false, alreadyRunning: true, port };
    }

    const wantEmbedded = prefer === "embedded"
      || (prefer === "auto" && canRunEmbedded(config));

    if (wantEmbedded) {
      try {
        const handle = await runProxy(buildRunOptions(config));
        this._ensureProcessExitHook();
        this.handle = handle;
        this.mode = "embedded";
        this.lastConfig = config;
        this.lastError = null;
        appendLog("info", "Proxy started embedded", { port: handle.port });
        this.emit("status", { mode: "embedded", running: true });
        return { mode: "embedded", started: true, alreadyRunning: false, port: handle.port };
      } catch (error) {
        if (error.code !== "EADDRINUSE" && error.code !== "EACCES") {
          this.lastError = error;
          this.emit("error", error);
          throw error;
        }
        // Privileged-port denial → fall back to detached (will UAC / launchd).
        appendLog("warn", "Embedded proxy denied; falling back to detached", {
          code: error.code,
          message: error.message,
        });
      }
    }

    try {
      const result = await startProxyDetached({ sudoPassword, port, targetHost });
      this.mode = "detached";
      this.lastConfig = config;
      this.lastError = null;
      this.emit("status", { mode: "detached", running: true });
      return { ...result, mode: "detached" };
    } catch (error) {
      this.lastError = error;
      this.emit("error", error);
      throw error;
    }
  }

  async _stop({ config, sudoPassword, removePlist = false } = {}) {
    const cfg = config || this.lastConfig || {};
    const port = Number(cfg.port || 443);
    const targetHost = primaryTargetHost(cfg);

    if (this.mode === "embedded" && this.handle) {
      try { await this.handle.close(); } catch (_) { /* ignore */ }
      this.handle = null;
      this.mode = "idle";
      this.emit("status", { mode: "idle", running: false });
      appendLog("info", "Proxy stopped embedded", { port });
      return { stopped: true, wasRunning: true, port, mode: "embedded" };
    }

    const result = await stopProxyByPort({ sudoPassword, port, targetHost, removePlist });
    this.mode = "idle";
    this.emit("status", { mode: "idle", running: false });
    return { ...result, mode: "detached" };
  }

  async _reload({ config, sudoPassword } = {}) {
    if (this.mode === "embedded" && this.handle) {
      // In-place reload: tear the listener down, start a new one with the
      // updated config. Faster than a detached restart and no UAC prompt.
      try { await this.handle.close(); } catch (_) { /* ignore */ }
      this.handle = null;
      this.mode = "idle";
      try {
        const handle = await runProxy(buildRunOptions(config));
        this.handle = handle;
        this.mode = "embedded";
        this.lastConfig = config;
        this.lastError = null;
        appendLog("info", "Proxy reloaded embedded", { port: handle.port });
        this.emit("status", { mode: "embedded", running: true, reloaded: true });
        return { mode: "embedded", reloaded: true, wasRunning: true, port: handle.port };
      } catch (error) {
        // Reload failed mid-flight – we already closed the old listener, so
        // surface the error with manager state matching reality (idle).
        this.lastError = error;
        this.emit("error", error);
        throw error;
      }
    }

    await this._stop({ config, sudoPassword });
    return this._start({ config, sudoPassword });
  }

  async status({ config } = {}) {
    const cfg = config || this.lastConfig || {};
    const port = Number(cfg.port || 443);
    const targetHost = primaryTargetHost(cfg);
    const healthy = await checkProxyHealth(port, targetHost);
    const owners = healthy ? [] : await getPortOwners(port);
    return {
      mode: this.mode,
      running: healthy,
      port,
      portOwners: owners,
      portOwnerText: formatPortOwners(owners),
      lastError: this.lastError ? String(this.lastError.message || this.lastError) : null,
    };
  }
}

let singleton = null;
function getProxyManager() {
  if (!singleton) singleton = new ProxyManager();
  return singleton;
}

module.exports = {
  ProxyManager,
  canRunEmbedded,
  getProxyManager,
};
