const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const forge = require("node-forge");

const { DEFAULT_TARGET, IS_MAC, IS_WIN } = require("../config/constants");
const { appDir, normalizeTargetHosts, targetHostsFrom } = require("../config");
const { execPowerShell, execPromise, execWithSudo, isWindowsElevated, powershellSingleQuote, shellQuote } = require("../system");

const MAC_SYSTEM_KEYCHAIN = "/Library/Keychains/System.keychain";
const NODE_EXTRA_CA_CERTS = "NODE_EXTRA_CA_CERTS";
const MAC_ANTIGRAVITY_PROCESS_PATTERN = "Antigravity( IDE| Tools)?\\.app/Contents/";

function macLoginKeychain() {
  return path.join(os.homedir(), "Library", "Keychains", "login.keychain-db");
}

function macTrustCommand(certPath, keychainPath, { admin = false } = {}) {
  return [
    "security add-trusted-cert",
    admin ? "-d" : "",
    "-r trustRoot",
    "-p ssl",
    "-p basic",
    `-k ${shellQuote(keychainPath)}`,
    shellQuote(certPath),
  ].filter(Boolean).join(" ");
}

function macSystemTrustCommand(certPath) {
  return macTrustCommand(certPath, MAC_SYSTEM_KEYCHAIN, { admin: true });
}

function macLoginTrustCommand(certPath) {
  return macTrustCommand(certPath, macLoginKeychain(), { admin: false });
}

function macCertTrustVerifyCommand(serverCertPath, targetHost = DEFAULT_TARGET) {
  return [
    "security verify-cert",
    `-c ${shellQuote(serverCertPath)}`,
    "-p ssl",
    `-s ${shellQuote(targetHost || DEFAULT_TARGET)}`,
    "-L",
  ].join(" ");
}

function certDir() {
  return path.join(appDir(), "cert");
}

function certPaths() {
  const dir = certDir();
  return {
    dir,
    caKeyPath: path.join(dir, "ca.key"),
    caCertPath: path.join(dir, "ca.crt"),
    keyPath: path.join(dir, "server.key"),
    certPath: path.join(dir, "server.crt"),
  };
}

function certExists() {
  const { caCertPath, certPath, keyPath } = certPaths();
  return fs.existsSync(caCertPath) && fs.existsSync(certPath) && fs.existsSync(keyPath);
}

function readCertificate(filePath) {
  return new crypto.X509Certificate(fs.readFileSync(filePath));
}

function certCoversHosts(certPath, targetHosts) {
  try {
    const cert = readCertificate(certPath);
    const san = cert.subjectAltName || "";
    return targetHosts.every((host) => {
      if (typeof cert.checkHost === "function") return cert.checkHost(host) === host;
      return san.includes(`DNS:${host}`);
    });
  } catch {
    return false;
  }
}

function certUsesLocalCA(certPath, caCertPath) {
  try {
    const cert = readCertificate(certPath);
    const ca = readCertificate(caCertPath);
    return ca.ca === true
      && cert.ca === false
      && cert.checkIssued(ca)
      && cert.verify(ca.publicKey);
  } catch {
    return false;
  }
}

function getCertFingerprint(certPath) {
  const pem = fs.readFileSync(certPath, "utf-8");
  const der = Buffer.from(pem.replace(/-----[^-]+-----/g, "").replace(/\s/g, ""), "base64");
  const hex = crypto.createHash("sha1").update(der).digest("hex").toUpperCase();
  // .match() có thể trả về null nếu hex rỗng – guard để tránh crash
  return (hex.match(/.{2}/g) ?? []).join(":");
}

function getPemFingerprints(filePath) {
  try {
    const pem = fs.readFileSync(filePath, "utf-8");
    const blocks = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) || [];
    return blocks.map((block) => {
      const cert = new crypto.X509Certificate(block);
      return cert.fingerprint.replace(/:/g, "").toUpperCase();
    });
  } catch {
    return [];
  }
}

async function getLaunchctlEnv(name) {
  if (!IS_MAC) return "";
  try {
    return (await execPromise(`launchctl getenv ${shellQuote(name)}`)).trim();
  } catch {
    return "";
  }
}

function windowsEnvGetScript(name, target = "User") {
  return `Write-Output ([Environment]::GetEnvironmentVariable(${powershellSingleQuote(name)}, ${powershellSingleQuote(target)}))`;
}

function windowsEnvSetScript(name, value, target = "User") {
  return `[Environment]::SetEnvironmentVariable(${powershellSingleQuote(name)}, ${powershellSingleQuote(value)}, ${powershellSingleQuote(target)})`;
}

function windowsUserEnvGetScript(name) {
  return windowsEnvGetScript(name, "User");
}

function windowsUserEnvSetScript(name, value) {
  return windowsEnvSetScript(name, value, "User");
}

async function getWindowsUserEnv(name) {
  if (!IS_WIN) return "";
  try {
    return (await execPowerShell(windowsUserEnvGetScript(name))).trim();
  } catch {
    return "";
  }
}

async function getWindowsMachineEnv(name) {
  if (!IS_WIN) return "";
  try {
    return (await execPowerShell(windowsEnvGetScript(name, "Machine"))).trim();
  } catch {
    return "";
  }
}

async function setWindowsUserEnv(name, value) {
  await execPowerShell(windowsUserEnvSetScript(name, value));
  process.env[name] = value;
}

async function setWindowsMachineEnv(name, value) {
  await execPowerShell(windowsEnvSetScript(name, value, "Machine"), { elevated: !(await isWindowsElevated()) });
  process.env[name] = value;
}

async function setWindowsNodeExtraCaCertsEnv(value) {
  const errors = [];
  try {
    await setWindowsUserEnv(NODE_EXTRA_CA_CERTS, value);
  } catch (error) {
    errors.push(`User=${error.message}`);
  }
  try {
    await setWindowsMachineEnv(NODE_EXTRA_CA_CERTS, value);
  } catch (error) {
    errors.push(`Machine=${error.message}`);
  }
  if (errors.length >= 2) {
    throw new Error(`Failed to set ${NODE_EXTRA_CA_CERTS}: ${errors.join("; ")}`);
  }
  process.env[NODE_EXTRA_CA_CERTS] = value;
}

async function getNodeExtraCaCertsEnv() {
  if (IS_MAC) return getLaunchctlEnv(NODE_EXTRA_CA_CERTS);
  if (IS_WIN) return (await getWindowsUserEnv(NODE_EXTRA_CA_CERTS)) || (await getWindowsMachineEnv(NODE_EXTRA_CA_CERTS));
  return "";
}

async function checkAntigravityNodeTrust(certPath) {
  if (!IS_MAC && !IS_WIN) {
    return { supported: false, applied: false, value: "" };
  }

  const values = IS_WIN
    ? [await getWindowsUserEnv(NODE_EXTRA_CA_CERTS), await getWindowsMachineEnv(NODE_EXTRA_CA_CERTS)]
    : [await getNodeExtraCaCertsEnv()];
  const fingerprint = getCertFingerprint(certPath).replace(/:/g, "").toUpperCase();
  const appliedValue = values.find((value) => value && getPemFingerprints(value).includes(fingerprint)) || "";
  const value = appliedValue || values.find(Boolean) || "";
  const applied = Boolean(appliedValue);
  return { supported: true, applied, value };
}

async function applyAntigravityNodeTrust(certPath) {
  if (!IS_MAC && !IS_WIN) {
    return { supported: false, applied: false, restartRequired: false };
  }

  const antigravityRunning = await isAntigravityRunning();
  const currentValue = await getNodeExtraCaCertsEnv();
  const status = await checkAntigravityNodeTrust(certPath);
  let nextValue = currentValue || certPath;

  if (currentValue && !status.applied) {
    const bundlePath = path.join(certDir(), "node-extra-ca-bundle.crt");
    const certPem = fs.readFileSync(certPath, "utf-8").trim();
    const existingPem = fs.existsSync(currentValue) ? fs.readFileSync(currentValue, "utf-8").trim() : "";
    fs.writeFileSync(bundlePath, `${existingPem ? `${existingPem}\n\n` : ""}${certPem}\n`);
    nextValue = bundlePath;
  }

  if (IS_MAC) await execPromise(`launchctl setenv ${NODE_EXTRA_CA_CERTS} ${shellQuote(nextValue)}`);
  else await setWindowsNodeExtraCaCertsEnv(nextValue);

  const nextStatus = await checkAntigravityNodeTrust(certPath);
  if (!nextStatus.applied) throw new Error(`Failed to apply ${NODE_EXTRA_CA_CERTS}`);

  return {
    supported: true,
    applied: true,
    changed: nextValue !== currentValue,
    value: nextValue,
    restartRequired: true,
    antigravityRunning,
  };
}

async function isAntigravityRunning() {
  if (IS_WIN) {
    try {
      const output = await execPowerShell([
        `Get-CimInstance Win32_Process`,
        `  | Where-Object { $_.Name -like '*Antigravity*' -or $_.ExecutablePath -like '*\\Antigravity\\*' }`,
        `  | Select-Object -First 1 -ExpandProperty ProcessId`,
      ].join(" "));
      return output.trim().length > 0;
    } catch {
      return false;
    }
  }

  if (!IS_MAC) return false;
  try {
    const output = await execPromise(`pgrep -f ${shellQuote(MAC_ANTIGRAVITY_PROCESS_PATTERN)} 2>/dev/null || true`);
    return output.trim().length > 0;
  } catch {
    return false;
  }
}

function canWriteCertPath(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      fs.accessSync(filePath, fs.constants.W_OK);
      return true;
    }
    fs.accessSync(path.dirname(filePath), fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

async function ensureWritableCertDir(sudoPassword) {
  const { dir, caCertPath, caKeyPath, certPath, keyPath } = certPaths();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    return;
  }

  const paths = [dir, caCertPath, caKeyPath, certPath, keyPath];
  if (paths.every(canWriteCertPath)) return;

  if (!IS_WIN && typeof process.getuid === "function" && typeof process.getgid === "function") {
    await execWithSudo(
      `chown -R ${Number(process.getuid())}:${Number(process.getgid())} ${shellQuote(dir)}`,
      sudoPassword
    );
    return;
  }

  throw new Error(`Certificate directory is not writable: ${dir}`);
}

function serialNumber() {
  return `01${forge.util.bytesToHex(forge.random.getBytesSync(15))}`;
}

function dateAfterYears(years) {
  const date = new Date();
  date.setFullYear(date.getFullYear() + years);
  return date;
}

function dateFiveMinutesAgo() {
  return new Date(Date.now() - 5 * 60 * 1000);
}

function createCaCertificate() {
  const pki = forge.pki;
  const keys = pki.rsa.generateKeyPair(2048);
  const cert = pki.createCertificate();
  const attrs = [
    { name: "commonName", value: "MITM Antigravity Local Root CA" },
    { name: "organizationName", value: "MITM Antigravity" },
  ];

  cert.publicKey = keys.publicKey;
  cert.serialNumber = serialNumber();
  cert.validity.notBefore = dateFiveMinutesAgo();
  cert.validity.notAfter = dateAfterYears(5);
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([
    { name: "basicConstraints", cA: true, critical: true },
    { name: "keyUsage", keyCertSign: true, cRLSign: true, critical: true },
    { name: "subjectKeyIdentifier" },
  ]);
  cert.sign(keys.privateKey, forge.md.sha256.create());

  return {
    keyPem: pki.privateKeyToPem(keys.privateKey),
    certPem: pki.certificateToPem(cert),
    cert,
    keys,
  };
}

function createServerCertificate(ca, targetHosts) {
  const pki = forge.pki;
  const keys = pki.rsa.generateKeyPair(2048);
  const cert = pki.createCertificate();
  const attrs = [
    { name: "commonName", value: targetHosts[0] },
    { name: "organizationName", value: "MITM Antigravity" },
  ];

  cert.publicKey = keys.publicKey;
  cert.serialNumber = serialNumber();
  cert.validity.notBefore = dateFiveMinutesAgo();
  cert.validity.notAfter = dateAfterYears(1);
  cert.setSubject(attrs);
  cert.setIssuer(ca.cert.subject.attributes);
  cert.setExtensions([
    { name: "basicConstraints", cA: false, critical: true },
    { name: "keyUsage", digitalSignature: true, keyEncipherment: true, critical: true },
    { name: "extKeyUsage", serverAuth: true },
    { name: "subjectAltName", altNames: targetHosts.map((host) => ({ type: 2, value: host })) },
  ]);
  cert.sign(ca.keys.privateKey, forge.md.sha256.create());

  return {
    keyPem: pki.privateKeyToPem(keys.privateKey),
    certPem: pki.certificateToPem(cert),
  };
}

function writePrivateFile(filePath, content) {
  fs.writeFileSync(filePath, content, { mode: 0o600 });
  try { fs.chmodSync(filePath, 0o600); } catch { /* best effort */ }
}

async function generateCert(targetHostOrHosts, { force = false, sudoPassword = "" } = {}) {
  const targetHosts = targetHostsFrom({ targetHosts: normalizeTargetHosts(targetHostOrHosts) });
  const { caCertPath, caKeyPath, certPath, dir, keyPath } = certPaths();

  if (!force
    && fs.existsSync(keyPath)
    && fs.existsSync(certPath)
    && fs.existsSync(caCertPath)
    && certCoversHosts(certPath, targetHosts)
    && certUsesLocalCA(certPath, caCertPath)) {
    return { key: keyPath, cert: certPath, ca: caCertPath, created: false };
  }

  await ensureWritableCertDir(sudoPassword);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const ca = createCaCertificate();
  const server = createServerCertificate(ca, targetHosts);

  writePrivateFile(caKeyPath, ca.keyPem);
  fs.writeFileSync(caCertPath, ca.certPem);
  writePrivateFile(keyPath, server.keyPem);
  fs.writeFileSync(certPath, server.certPem);

  return { key: keyPath, cert: certPath, ca: caCertPath, created: true };
}

async function checkCertInstalled(certPath, targetHost) {
  if (IS_WIN) {
    try {
      const fingerprint = getCertFingerprint(certPath).replace(/:/g, "").toUpperCase();
      const output = await execPowerShell(
        `Get-ChildItem Cert:\\LocalMachine\\Root | Where-Object { $_.Thumbprint -eq '${fingerprint}' } | Select-Object -First 1`
      );
      return output.trim().length > 0;
    } catch {
      return false;
    }
  }

  if (!IS_MAC) return false;

  try {
    const { certPath: serverCertPath } = certPaths();
    if (!fs.existsSync(serverCertPath) || !certUsesLocalCA(serverCertPath, certPath)) return false;
    await execPromise(macCertTrustVerifyCommand(serverCertPath, targetHost));
    return true;
  } catch {
    return false;
  }
}

// Linux không có API keychain thống nhất (mỗi distro khác nhau).
// Thay vì crash, trả về { unsupported: true } để caller biết cần hướng dẫn thủ công.
function linuxCertHint() {
  return "On Linux, trust the CA manually: sudo cp <ca.crt> /usr/local/share/ca-certificates/ && sudo update-ca-certificates";
}

// Gộp cert install + hosts write + DNS flush thành 1 elevated script = 1 UAC prompt.
// hostsContent và hostsPath là optional: nếu truyền vào sẽ ghi hosts cùng lúc.
async function windowsBatchInstallCertAndHosts({ certPath, hostsContent, hostsFile }) {
  const tempHosts = hostsContent
    ? require("path").join(require("os").tmpdir(), `mitm-hosts-batch-${process.pid}-${Date.now()}.tmp`)
    : null;
  if (tempHosts) require("fs").writeFileSync(tempHosts, hostsContent, { mode: 0o600 });

  const ps = [
    // Cài cert vào LocalMachine\\Root
    `certutil -addstore Root '${certPath.replace(/'/g, "''")}' | Out-Null`,
  ];
  if (tempHosts && hostsFile) {
    ps.push(
      `Copy-Item -LiteralPath '${tempHosts.replace(/'/g, "''")}' -Destination '${hostsFile.replace(/'/g, "''")}' -Force`,
      `ipconfig /flushdns | Out-Null`,
      `Remove-Item -Path '${tempHosts.replace(/'/g, "''")}' -Force -ErrorAction SilentlyContinue`,
    );
  }
  await execPowerShell(ps.join("; "), { elevated: !(await isWindowsElevated()) });
  if (tempHosts) { try { require("fs").unlinkSync(tempHosts); } catch { /* best effort */ } }
}

async function installCert(certPath, targetHost, sudoPassword) {
  const isInstalled = await checkCertInstalled(certPath, targetHost);
  if (isInstalled) return { installed: false };

  if (IS_WIN) {
    await execPowerShell(`certutil -addstore Root '${certPath.replace(/'/g, "''")}'`, { elevated: !(await isWindowsElevated()) });
    return { installed: true };
  }

  if (IS_MAC) {
    const systemCommand = macSystemTrustCommand(certPath);
    try {
      await execWithSudo(systemCommand, sudoPassword);
      return { installed: true, keychain: "system", trustPolicies: ["ssl", "basic"] };
    } catch (systemError) {
      // Some packaged GUI contexts (LaunchServices / elevated relaunch / no TTY)
      // cannot display the administrator prompt, yielding:
      //   SecTrustSettingsSetTrustSettings: authorization denied since no user interaction was possible
      // Fallback to the user's login keychain. Antigravity and Node run in the
      // user session, so this still fixes TLS trust for the app without admin UI.
      try {
        await execPromise(macLoginTrustCommand(certPath));
        return {
          installed: true,
          keychain: "login",
          fallbackFromSystem: true,
          trustPolicies: ["ssl", "basic"],
          systemKeychainError: systemError.message,
        };
      } catch (loginError) {
        throw new Error(
          [
            "Failed to trust the certificate in macOS keychains.",
            "System keychain could not show an administrator prompt; login keychain fallback also failed.",
            "Open MITM AG normally (not from a headless shell), approve the admin prompt, or run CLI with --password.",
            `System keychain error: ${systemError.message}`,
            `Login keychain error: ${loginError.message}`,
          ].join("\n")
        );
      }
    }
  }

  // Linux – trả về unsupported thay vì throw để flow GUI tiếp tục
  return { installed: false, unsupported: true, hint: linuxCertHint() };
}

async function uninstallCert(certPath, targetHost, sudoPassword) {
  const isInstalled = await checkCertInstalled(certPath, targetHost);
  if (!isInstalled) return { removed: false };

  if (IS_WIN) {
    const fingerprint = getCertFingerprint(certPath).replace(/:/g, "").toUpperCase();
    await execPowerShell(`certutil -delstore Root '${fingerprint}'`, { elevated: !(await isWindowsElevated()) });
    return { removed: true };
  }

  if (IS_MAC) {
    const fingerprint = getCertFingerprint(certPath).replace(/:/g, "");
    const loginCommand = `security delete-certificate -Z "${fingerprint}" ${shellQuote(macLoginKeychain())}`;
    try {
      await execPromise(loginCommand);
    } catch {
      // Certificate may only exist in System.keychain.
    }
    const command = `security delete-certificate -Z "${fingerprint}" ${shellQuote(MAC_SYSTEM_KEYCHAIN)}`;
    try {
      await execWithSudo(command, sudoPassword);
    } catch {
      // User keychain removal is enough for the non-admin GUI install path.
    }
    return { removed: true };
  }

  // Linux – không thể uninstall tự động
  return { removed: false, unsupported: true, hint: linuxCertHint() };
}

module.exports = {
  applyAntigravityNodeTrust,
  certCoversHosts,
  certDir,
  certExists,
  certPaths,
  certUsesLocalCA,
  checkAntigravityNodeTrust,
  checkCertInstalled,
  generateCert,
  getCertFingerprint,
  getPemFingerprints,
  installCert,
  isAntigravityRunning,
  macCertTrustVerifyCommand,
  macLoginTrustCommand,
  macSystemTrustCommand,
  uninstallCert,
  windowsBatchInstallCertAndHosts,
  windowsEnvGetScript,
  windowsEnvSetScript,
  windowsUserEnvGetScript,
  windowsUserEnvSetScript,
};
