const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const forge = require("node-forge");

const { IS_MAC, IS_WIN } = require("../config/constants");
const { appDir, normalizeTargetHosts, targetHostsFrom } = require("../config");
const { execPowerShell, execPromise, execWithSudo, shellQuote } = require("../system");

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
  return crypto.createHash("sha1").update(der).digest("hex").toUpperCase().match(/.{2}/g).join(":");
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

async function checkAntigravityNodeTrust(certPath) {
  if (!IS_MAC) {
    return { supported: false, applied: false, value: "" };
  }

  const value = await getLaunchctlEnv("NODE_EXTRA_CA_CERTS");
  const fingerprint = getCertFingerprint(certPath).replace(/:/g, "").toUpperCase();
  const applied = Boolean(value && getPemFingerprints(value).includes(fingerprint));
  return { supported: true, applied, value };
}

async function applyAntigravityNodeTrust(certPath) {
  if (!IS_MAC) {
    return { supported: false, applied: false, restartRequired: false };
  }

  const antigravityRunning = await isAntigravityRunning();
  const currentValue = await getLaunchctlEnv("NODE_EXTRA_CA_CERTS");
  const status = await checkAntigravityNodeTrust(certPath);
  let nextValue = currentValue || certPath;

  if (currentValue && !status.applied) {
    const bundlePath = path.join(certDir(), "node-extra-ca-bundle.crt");
    const certPem = fs.readFileSync(certPath, "utf-8").trim();
    const existingPem = fs.existsSync(currentValue) ? fs.readFileSync(currentValue, "utf-8").trim() : "";
    fs.writeFileSync(bundlePath, `${existingPem ? `${existingPem}\n\n` : ""}${certPem}\n`);
    nextValue = bundlePath;
  }

  await execPromise(`launchctl setenv NODE_EXTRA_CA_CERTS ${shellQuote(nextValue)}`);
  const nextStatus = await checkAntigravityNodeTrust(certPath);
  if (!nextStatus.applied) throw new Error("Failed to apply NODE_EXTRA_CA_CERTS via launchctl");

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
  if (!IS_MAC) return false;
  try {
    const output = await execPromise("pgrep -f 'Antigravity.app/Contents/MacOS/Electron' 2>/dev/null || true");
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
    const fingerprint = getCertFingerprint(certPath).replace(/:/g, "");
    const keychains = [
      "/Library/Keychains/System.keychain",
      path.join(os.homedir(), "Library", "Keychains", "login.keychain-db"),
    ];
    for (const keychain of keychains) {
      try {
        await execPromise(`security find-certificate -a -Z ${shellQuote(keychain)} | grep -i "${fingerprint}"`);
        return true;
      } catch {
        // Continue checking other keychains.
      }
    }
    return false;
  } catch {
    return false;
  }
}

// Linux không có API keychain thống nhất (mỗi distro khác nhau).
// Thay vì crash, trả về { unsupported: true } để caller biết cần hướng dẫn thủ công.
function linuxCertHint() {
  return "On Linux, trust the CA manually: sudo cp <ca.crt> /usr/local/share/ca-certificates/ && sudo update-ca-certificates";
}

async function installCert(certPath, targetHost, sudoPassword) {
  const isInstalled = await checkCertInstalled(certPath, targetHost);
  if (isInstalled) return { installed: false };

  if (IS_WIN) {
    await execPowerShell(`certutil -addstore Root '${certPath.replace(/'/g, "''")}'`, { elevated: true });
    return { installed: true };
  }

  if (IS_MAC) {
    const command = `security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain ${shellQuote(certPath)}`;
    await execWithSudo(command, sudoPassword);
    return { installed: true };
  }

  // Linux – trả về unsupported thay vì throw để flow GUI tiếp tục
  return { installed: false, unsupported: true, hint: linuxCertHint() };
}

async function uninstallCert(certPath, targetHost, sudoPassword) {
  const isInstalled = await checkCertInstalled(certPath, targetHost);
  if (!isInstalled) return { removed: false };

  if (IS_WIN) {
    const fingerprint = getCertFingerprint(certPath).replace(/:/g, "").toUpperCase();
    await execPowerShell(`certutil -delstore Root '${fingerprint}'`, { elevated: true });
    return { removed: true };
  }

  if (IS_MAC) {
    const fingerprint = getCertFingerprint(certPath).replace(/:/g, "");
    const command = `security delete-certificate -Z "${fingerprint}" /Library/Keychains/System.keychain`;
    await execWithSudo(command, sudoPassword);
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
  uninstallCert,
};
