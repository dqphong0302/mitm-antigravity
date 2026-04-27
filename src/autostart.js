const fs = require("fs");
const os = require("os");
const path = require("path");

const { IS_MAC, IS_WIN } = require("./constants");
const { appDir, cliEntrypointPath, ensureAppDir, runtimeDir } = require("./config");
const { execPowerShell, execPromise, execWithSudo, shellQuote } = require("./system");

function xmlEscape(value) {
    return String(value || "").replace(/[<>&"']/g, (char) => ({
        "<": "&lt;",
        ">": "&gt;",
        "&": "&amp;",
        "\"": "&quot;",
        "'": "&apos;",
    }[char]));
}

function proxyStartCommandParts(extraArgs = []) {
    const base = process.pkg
        ? [process.execPath, "start", "--skip-setup"]
        : [process.execPath, cliEntrypointPath(), "start", "--skip-setup"];
    return [...base, ...extraArgs];
}

function proxyStartShellCommand(extraArgs = []) {
    return proxyStartCommandParts(extraArgs).map((part) => shellQuote(part)).join(" ");
}

function macProxyLaunchDaemonLabel() {
    return "com.phongdang.mitm-antigravity.proxy";
}

function macProxyLaunchDaemonPath() {
    return `/Library/LaunchDaemons/${macProxyLaunchDaemonLabel()}.plist`;
}

function macProxyLaunchDaemonPlist(commandParts, logPath) {
    const argsXml = commandParts.map((part) => `    <string>${xmlEscape(part)}</string>`).join("\n");
    const env = {
        HOME: os.homedir(),
        MITM_APP_DIR: appDir(),
        MITM_PROXY_LOG: logPath,
        PATH: "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin",
    };
    const envXml = Object.entries(env)
        .map(([key, value]) => `    <key>${xmlEscape(key)}</key>\n    <string>${xmlEscape(value)}</string>`)
        .join("\n");
    return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n<dict>\n  <key>Label</key>\n  <string>${xmlEscape(macProxyLaunchDaemonLabel())}</string>\n  <key>ProgramArguments</key>\n  <array>\n${argsXml}\n  </array>\n  <key>WorkingDirectory</key>\n  <string>${xmlEscape(runtimeDir())}</string>\n  <key>EnvironmentVariables</key>\n  <dict>\n${envXml}\n  </dict>\n  <key>RunAtLoad</key>\n  <true/>\n  <key>StandardOutPath</key>\n  <string>${xmlEscape(logPath)}</string>\n  <key>StandardErrorPath</key>\n  <string>${xmlEscape(logPath)}</string>\n</dict>\n</plist>\n`;
}

async function bootoutMacProxyLaunchDaemon(sudoPassword) {
    if (!IS_MAC) return;
    const plistPath = macProxyLaunchDaemonPath();
    const command = `/bin/launchctl bootout system ${shellQuote(plistPath)} >/dev/null 2>&1 || true`;
    await execWithSudo(command, sudoPassword);
}

async function bootstrapMacProxyLaunchDaemon({ sudoPassword, port, logPath }) {
    const commandParts = proxyStartCommandParts(["--port", String(port)]);
    const tempPlistPath = path.join(os.tmpdir(), `${macProxyLaunchDaemonLabel()}.${process.pid}.plist`);
    fs.writeFileSync(tempPlistPath, macProxyLaunchDaemonPlist(commandParts, logPath));

    const installCommand = [
        "set -e",
        "/bin/mkdir -p /Library/LaunchDaemons",
        `/bin/cp ${shellQuote(tempPlistPath)} ${shellQuote(macProxyLaunchDaemonPath())}`,
        `/usr/sbin/chown root:wheel ${shellQuote(macProxyLaunchDaemonPath())}`,
        `/bin/chmod 644 ${shellQuote(macProxyLaunchDaemonPath())}`,
        `/bin/launchctl bootout system ${shellQuote(macProxyLaunchDaemonPath())} >/dev/null 2>&1 || true`,
        `/bin/launchctl bootstrap system ${shellQuote(macProxyLaunchDaemonPath())}`,
    ].join("\n");

    try {
        await execWithSudo(installCommand, sudoPassword);
    } finally {
        fs.rmSync(tempPlistPath, { force: true });
    }
}

function autoStartLabel() {
    return "io.phongdang.mitm-antigravity.proxy";
}

function autoStartName() {
    return "MITM Antigravity Proxy";
}

function autoStartPath() {
    if (IS_MAC) return path.join(os.homedir(), "Library", "LaunchAgents", `${autoStartLabel()}.plist`);
    if (IS_WIN) return autoStartName();
    return path.join(appDir(), "mitm-antigravity.service");
}

function autoStartCommandParts() {
    return proxyStartCommandParts();
}

function autoStartShellCommand() {
    return proxyStartShellCommand();
}

async function isAutoStartEnabled() {
    if (IS_MAC) return fs.existsSync(autoStartPath());
    if (IS_WIN) {
        try {
            await execPowerShell(`Get-ScheduledTask -TaskName '${autoStartName().replace(/'/g, "''")}' -ErrorAction Stop | Out-Null`);
            return true;
        } catch (_) {
            return false;
        }
    }
    return fs.existsSync(autoStartPath());
}

async function autoStartStatus() {
    return {
        supported: IS_MAC || IS_WIN || !IS_WIN,
        enabled: await isAutoStartEnabled(),
        method: IS_MAC ? "macOS LaunchAgent" : (IS_WIN ? "Windows Scheduled Task" : "Linux user systemd"),
        path: autoStartPath(),
    };
}

async function enableAutoStart() {
    ensureAppDir();
    const commandParts = autoStartCommandParts();
    if (IS_MAC) {
        const plistPath = autoStartPath();
        fs.mkdirSync(path.dirname(plistPath), { recursive: true });
        const argsXml = commandParts.map((part) => `    <string>${xmlEscape(part)}</string>`).join("\n");
        const plist = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n<dict>\n  <key>Label</key>\n  <string>${xmlEscape(autoStartLabel())}</string>\n  <key>ProgramArguments</key>\n  <array>\n${argsXml}\n  </array>\n  <key>WorkingDirectory</key>\n  <string>${xmlEscape(runtimeDir())}</string>\n  <key>RunAtLoad</key>\n  <true/>\n  <key>StandardOutPath</key>\n  <string>${xmlEscape(path.join(appDir(), "autostart.log"))}</string>\n  <key>StandardErrorPath</key>\n  <string>${xmlEscape(path.join(appDir(), "autostart.err.log"))}</string>\n</dict>\n</plist>\n`;
        fs.writeFileSync(plistPath, plist);
        await execPromise(`launchctl unload ${shellQuote(plistPath)} >/dev/null 2>&1 || true`);
        await execPromise(`launchctl load ${shellQuote(plistPath)}`);
        return { enabled: true, method: "macOS LaunchAgent", path: plistPath };
    }

    if (IS_WIN) {
        const command = commandParts[0];
        const args = commandParts.slice(1).join(" ");
        await execPowerShell(`$action = New-ScheduledTaskAction -Execute '${command.replace(/'/g, "''")}' -Argument '${args.replace(/'/g, "''")}' -WorkingDirectory '${runtimeDir().replace(/'/g, "''")}'; $trigger = New-ScheduledTaskTrigger -AtLogOn; Register-ScheduledTask -TaskName '${autoStartName().replace(/'/g, "''")}' -Action $action -Trigger $trigger -Description 'Start MITM Antigravity proxy after login' -Force | Out-Null`, { elevated: true });
        return { enabled: true, method: "Windows Scheduled Task", path: autoStartName() };
    }

    const servicePath = autoStartPath();
    const service = `[Unit]\nDescription=MITM Antigravity Proxy\nAfter=network-online.target\n\n[Service]\nType=simple\nWorkingDirectory=${runtimeDir()}\nExecStart=${autoStartShellCommand()}\nRestart=on-failure\nRestartSec=5\n\n[Install]\nWantedBy=default.target\n`;
    fs.writeFileSync(servicePath, service);
    await execPromise(`mkdir -p ${shellQuote(path.join(os.homedir(), ".config", "systemd", "user"))} && cp ${shellQuote(servicePath)} ${shellQuote(path.join(os.homedir(), ".config", "systemd", "user", "mitm-antigravity.service"))} && systemctl --user daemon-reload && systemctl --user enable mitm-antigravity.service`);
    return { enabled: true, method: "Linux user systemd", path: servicePath };
}

async function disableAutoStart() {
    if (IS_MAC) {
        const plistPath = autoStartPath();
        await execPromise(`launchctl unload ${shellQuote(plistPath)} >/dev/null 2>&1 || true`).catch(() => { });
        if (fs.existsSync(plistPath)) fs.unlinkSync(plistPath);
        return { enabled: false, method: "macOS LaunchAgent", path: plistPath };
    }

    if (IS_WIN) {
        await execPowerShell(`Unregister-ScheduledTask -TaskName '${autoStartName().replace(/'/g, "''")}' -Confirm:$false -ErrorAction SilentlyContinue`, { elevated: true });
        return { enabled: false, method: "Windows Scheduled Task", path: autoStartName() };
    }

    await execPromise(`systemctl --user disable --now mitm-antigravity.service >/dev/null 2>&1 || true`).catch(() => { });
    const systemdPath = path.join(os.homedir(), ".config", "systemd", "user", "mitm-antigravity.service");
    if (fs.existsSync(systemdPath)) fs.unlinkSync(systemdPath);
    if (fs.existsSync(autoStartPath())) fs.unlinkSync(autoStartPath());
    return { enabled: false, method: "Linux user systemd", path: autoStartPath() };
}

module.exports = {
    autoStartCommandParts,
    autoStartLabel,
    autoStartName,
    autoStartPath,
    autoStartShellCommand,
    autoStartStatus,
    bootoutMacProxyLaunchDaemon,
    bootstrapMacProxyLaunchDaemon,
    disableAutoStart,
    enableAutoStart,
    isAutoStartEnabled,
    macProxyLaunchDaemonLabel,
    macProxyLaunchDaemonPath,
    macProxyLaunchDaemonPlist,
    proxyStartCommandParts,
    proxyStartShellCommand,
    xmlEscape,
};
