const fs = require("fs");
const os = require("os");
const path = require("path");

const { IS_MAC, IS_WIN } = require("../config/constants");
const { appDir, cliEntrypointPath, ensureAppDir, runtimeDir } = require("../config");
const {
    execPowerShell,
    execPromise,
    execWithSudo,
    powershellSingleQuote,
    shellQuote,
    windowsCommandLineArguments,
} = require("./");

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

function cliWorkingDirectory(dir = runtimeDir()) {
    if (dir.endsWith(".asar")) return path.dirname(dir);
    return dir;
}

function cliEnvironment(extra = {}) {
    const env = {
        HOME: os.homedir(),
        MITM_APP_DIR: appDir(),
        PATH: "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin",
    };
    return { ...env, ...extra };
}

function plistEnvironmentXml(env) {
    return Object.entries(env)
        .map(([key, value]) => `    <key>${xmlEscape(key)}</key>\n    <string>${xmlEscape(value)}</string>`)
        .join("\n");
}

function macProxyLaunchDaemonLabel() {
    return "com.phongdang.mitm-antigravity.proxy";
}

function macProxyLaunchDaemonPath() {
    return `/Library/LaunchDaemons/${macProxyLaunchDaemonLabel()}.plist`;
}

function macProxyLaunchDaemonPlist(commandParts, logPath, env = cliEnvironment({ MITM_PROXY_LOG: logPath })) {
    const argsXml = commandParts.map((part) => `    <string>${xmlEscape(part)}</string>`).join("\n");
    const envXml = plistEnvironmentXml(env);
    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xmlEscape(macProxyLaunchDaemonLabel())}</string>
  <key>ProgramArguments</key>
  <array>
${argsXml}
  </array>
  <key>WorkingDirectory</key>
  <string>${xmlEscape(cliWorkingDirectory())}</string>
  <key>EnvironmentVariables</key>
  <dict>
${envXml}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>Crashed</key>
    <true/>
    <key>NetworkState</key>
    <true/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>5</integer>
  <key>StandardOutPath</key>
  <string>${xmlEscape(logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(logPath)}</string>
</dict>
</plist>
`;
}

// removePlist: nếu true, xóa plist khỏi /Library/LaunchDaemons/ để proxy không
// tự khởi động lại sau reboot. Dùng cho "Stop & Remove DNS" (full cleanup).
// Nếu false (mặc định), chỉ unload proxy cho session này – sau reboot vẫn tự bật lại.
async function bootoutMacProxyLaunchDaemon(sudoPassword, { removePlist = false } = {}) {
    if (!IS_MAC) return;
    const plistPath = macProxyLaunchDaemonPath();
    const steps = [
        `/bin/launchctl bootout system ${shellQuote(plistPath)} >/dev/null 2>&1 || true`,
    ];
    if (removePlist) {
        // Xóa plist để launchd không tự load lại sau reboot
        steps.push(`/bin/rm -f ${shellQuote(plistPath)}`);
    }
    await execWithSudo(steps.join(" && "), sudoPassword);
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

function macLaunchAgentDomain() {
    const uid = typeof process.getuid === "function" ? process.getuid() : 501;
    return `gui/${uid}`;
}

function macLaunchAgentBootstrapCommand(plistPath = autoStartPath()) {
    return `/bin/launchctl bootstrap ${shellQuote(macLaunchAgentDomain())} ${shellQuote(plistPath)}`;
}

function macLaunchAgentBootoutCommand(plistPath = autoStartPath()) {
    return `/bin/launchctl bootout ${shellQuote(macLaunchAgentDomain())} ${shellQuote(plistPath)} >/dev/null 2>&1 || true`;
}

function macLaunchAgentPrintCommand() {
    return `/bin/launchctl print ${shellQuote(`${macLaunchAgentDomain()}/${autoStartLabel()}`)} >/dev/null 2>&1`;
}

function windowsAutoStartStatusScript() {
    const taskName = powershellSingleQuote(autoStartName());
    return `$task = Get-ScheduledTask -TaskName ${taskName} -ErrorAction Stop; if ($task.State -eq 'Disabled') { exit 2 }`;
}

function windowsRegisterAutoStartScript(commandParts = autoStartCommandParts()) {
    const command = commandParts[0];
    const args = windowsCommandLineArguments(commandParts.slice(1));
    // Register-ScheduledTask -Force: cập nhật path mới nếu task đã tồn tại (e.g. sau update app)
    return [
        `$action = New-ScheduledTaskAction -Execute ${powershellSingleQuote(command)} -Argument ${powershellSingleQuote(args)} -WorkingDirectory ${powershellSingleQuote(cliWorkingDirectory())}`,
        `$trigger = New-ScheduledTaskTrigger -AtLogOn`,
        `$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Highest`,
        `$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit 00:00:00 -MultipleInstances IgnoreNew`,
        `Register-ScheduledTask -TaskName ${powershellSingleQuote(autoStartName())} -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description 'Start MITM Antigravity proxy after login' -Force | Out-Null`,
    ].join("; ");
}

// Cập nhật Scheduled Task với binary path hiện tại (gọi khi app khởi động nếu autostart đang bật).
// Tránh task cũ trỏ sai path sau khi cài bản mới.
async function windowsRefreshAutoStartPath() {
    if (!IS_WIN) return;
    const enabled = await isAutoStartEnabled();
    if (!enabled) return;
    try {
        await execPowerShell(windowsRegisterAutoStartScript(), { elevated: true });
    } catch {
        // Best-effort: không fail hard nếu không refresh được
    }
}

async function isAutoStartEnabled() {
    if (IS_MAC) {
        if (!fs.existsSync(autoStartPath())) return false;
        try {
            await execPromise(macLaunchAgentPrintCommand());
            return true;
        } catch (_) {
            return false;
        }
    }
    if (IS_WIN) {
        try {
            await execPowerShell(windowsAutoStartStatusScript());
            return true;
        } catch (_) {
            return false;
        }
    }
    return fs.existsSync(autoStartPath());
}

async function autoStartStatus() {
    return {
        supported: IS_MAC || IS_WIN,
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
        const envXml = plistEnvironmentXml(cliEnvironment());
        const plist = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n<dict>\n  <key>Label</key>\n  <string>${xmlEscape(autoStartLabel())}</string>\n  <key>ProgramArguments</key>\n  <array>\n${argsXml}\n  </array>\n  <key>WorkingDirectory</key>\n  <string>${xmlEscape(cliWorkingDirectory())}</string>\n  <key>EnvironmentVariables</key>\n  <dict>\n${envXml}\n  </dict>\n  <key>RunAtLoad</key>\n  <true/>\n  <key>StandardOutPath</key>\n  <string>${xmlEscape(path.join(appDir(), "autostart.log"))}</string>\n  <key>StandardErrorPath</key>\n  <string>${xmlEscape(path.join(appDir(), "autostart.err.log"))}</string>\n</dict>\n</plist>\n`;
        fs.writeFileSync(plistPath, plist);
        await execPromise(macLaunchAgentBootoutCommand(plistPath));
        await execPromise(macLaunchAgentBootstrapCommand(plistPath));
        if (!(await isAutoStartEnabled())) throw new Error("Failed to enable macOS LaunchAgent");
        return { enabled: true, method: "macOS LaunchAgent", path: plistPath };
    }

    if (IS_WIN) {
        await execPowerShell(windowsRegisterAutoStartScript(commandParts), { elevated: true });
        return { enabled: true, method: "Windows Scheduled Task", path: autoStartName() };
    }

    const servicePath = autoStartPath();
    const service = `[Unit]\nDescription=MITM Antigravity Proxy\nAfter=network-online.target\n\n[Service]\nType=simple\nWorkingDirectory=${cliWorkingDirectory()}\nExecStart=${autoStartShellCommand()}\nRestart=on-failure\nRestartSec=5\n\n[Install]\nWantedBy=default.target\n`;
    fs.writeFileSync(servicePath, service);
    await execPromise(`mkdir -p ${shellQuote(path.join(os.homedir(), ".config", "systemd", "user"))} && cp ${shellQuote(servicePath)} ${shellQuote(path.join(os.homedir(), ".config", "systemd", "user", "mitm-antigravity.service"))} && systemctl --user daemon-reload && systemctl --user enable mitm-antigravity.service`);
    return { enabled: true, method: "Linux user systemd", path: servicePath };
}

async function disableAutoStart() {
    if (IS_MAC) {
        const plistPath = autoStartPath();
        await execPromise(macLaunchAgentBootoutCommand(plistPath)).catch(() => { });
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
    cliEnvironment,
    cliWorkingDirectory,
    disableAutoStart,
    enableAutoStart,
    isAutoStartEnabled,
    macLaunchAgentBootstrapCommand,
    macLaunchAgentBootoutCommand,
    macLaunchAgentDomain,
    macLaunchAgentPrintCommand,
    macProxyLaunchDaemonLabel,
    macProxyLaunchDaemonPath,
    macProxyLaunchDaemonPlist,
    proxyStartCommandParts,
    proxyStartShellCommand,
    windowsAutoStartStatusScript,
    windowsRefreshAutoStartPath,
    windowsRegisterAutoStartScript,
    xmlEscape,
};
