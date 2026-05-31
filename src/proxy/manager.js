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
const { isWindowsElevated } = require("../system");

const PRIVILEGED_PORT_LIMIT = 1024;

// Require several consecutive failed health probes before auto-restarting, so a
// single transient miss (GC pause, brief socket hiccup) never triggers a
// restart — which on macOS could pop a background osascript admin prompt.
const HEALTH_MISS_THRESHOLD = 3;

// Pure decision helper (exported for tests). macOS detached proxies are managed
// by launchd (RunAtLoad + KeepAlive), so launchd relaunches them on crash with
// no admin prompt. App-driven restarts there would be both redundant and
// prompt-noisy, so we defer to launchd.
//
// Windows detached proxies are started with an admin token (Start-Process -Verb
// RunAs). When the GUI itself is NOT elevated, an app-driven restart would call
// stopProxyByPort + startProxyDetached, each of which raises a fresh UAC prompt
// — in the BACKGROUND, unprompted by the user, and repeated across retry
// backoff. That is exactly the "surprise admin prompt" instability we want to
// avoid, so we defer: the proxy stays down and the user re-Starts it manually
// (an expected, user-initiated prompt). An already-elevated GUI restarts
// silently, so it is allowed.
function shouldAutoRestart({ mode, platform, consecutiveMisses, elevated = false, threshold = HEALTH_MISS_THRESHOLD }) {
  if (mode === "idle") return false;
  if (Number(consecutiveMisses) < threshold) return false;
  if (platform === "darwin" && mode === "detached") return false;
  if (platform === "win32" && mode === "detached" && !elevated) return false;
  return true;
}

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
    this.restartAttempts = 0;
    this.restartTimer = null;
    this.monitorInterval = null;
    // Consecutive failed health probes; reset to 0 on any healthy probe.
    this._healthMisses = 0;
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
      this._stopMonitoring();
      if (this.mode === "embedded" && this.handle) {
        try { this.handle.server.close(); } catch (_) { /* ignore */ }
      }
    });
  }

  _startMonitoring(config, sudoPassword) {
    this._stopMonitoring();
    this._healthMisses = 0;
    this.monitorInterval = setInterval(async () => {
      if (this.mode === "idle") return;
      const port = Number(config.port || 443);
      const targetHost = primaryTargetHost(config);
      const healthy = await checkProxyHealth(port, targetHost);
      if (healthy) {
        this._healthMisses = 0;
        this.restartAttempts = 0;
        return;
      }
      this._healthMisses += 1;
      // isWindowsElevated() short-circuits to false off-Windows, so this is a
      // cheap no-op on macOS/Linux and only execs on Windows once we are past
      // the transient-miss threshold path.
      const elevated = await isWindowsElevated();
      if (!shouldAutoRestart({
        mode: this.mode,
        platform: process.platform,
        consecutiveMisses: this._healthMisses,
        elevated,
      })) {
        return;
      }
      appendLog("warn", `Proxy health check failed ${this._healthMisses}x. Triggering auto-restart...`);
      this._triggerRestart(config, sudoPassword);
    }, 10000);
    if (this.monitorInterval && typeof this.monitorInterval.unref === "function") {
      this.monitorInterval.unref();
    }
  }

  _stopMonitoring() {
    if (this.monitorInterval) {
      clearInterval(this.monitorInterval);
      this.monitorInterval = null;
    }
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
  }

  async _triggerRestart(config, sudoPassword) {
    if (this.restartTimer) return;
    if (this.restartAttempts >= 5) {
      appendLog("error", "Max restart attempts (5) reached. Giving up.");
      this.mode = "idle";
      this.emit("status", { mode: "idle", running: false });
      return;
    }

    const backoff = Math.min(5000 * Math.pow(2, this.restartAttempts), 60000);
    this.restartAttempts += 1;
    appendLog("info", `Scheduling proxy restart in ${backoff / 1000}s (Attempt ${this.restartAttempts}/5)...`);

    this.restartTimer = setTimeout(async () => {
      this.restartTimer = null;
      try {
        const port = Number(config.port || 443);
        const targetHost = primaryTargetHost(config);
        await stopProxyByPort({ sudoPassword, port, targetHost });
        
        await this._start({ config, sudoPassword });
        appendLog("info", "Proxy auto-restart successful.");
      } catch (err) {
        appendLog("error", `Proxy auto-restart attempt failed: ${err.message}`);
        this._triggerRestart(config, sudoPassword);
      }
    }, backoff);
    if (this.restartTimer && typeof this.restartTimer.unref === "function") {
      this.restartTimer.unref();
    }
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
      this._startMonitoring(config, sudoPassword);
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
        this._startMonitoring(config, sudoPassword);
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
      this._startMonitoring(config, sudoPassword);
      this.emit("status", { mode: "detached", running: true });
      return { ...result, mode: "detached" };
    } catch (error) {
      this.lastError = error;
      this.emit("error", error);
      throw error;
    }
  }

  async _stop({ config, sudoPassword, removePlist = false } = {}) {
    this._stopMonitoring();
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
  shouldAutoRestart,
};
