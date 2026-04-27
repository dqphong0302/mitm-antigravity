const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { IS_MAC, IS_WIN } = require("./constants");
const { appDir, normalizeTargetHosts, targetHostsFrom } = require("./config");
const { execPowerShell, execPromise, execWithSudo, shellQuote } = require("./system");

function certDir() {
  return path.join(appDir(), "cert");
}

function certPaths() {
  const dir = certDir();
  return {
    dir,
    keyPath: path.join(dir, "server.key"),
    certPath: path.join(dir, "server.crt"),
  };
}

function certExists() {
  const { keyPath, certPath } = certPaths();
  return fs.existsSync(keyPath) && fs.existsSync(certPath);
}

function certCoversHosts(certPath, targetHosts) {
  try {
    const cert = new crypto.X509Certificate(fs.readFileSync(certPath));
    const san = cert.subjectAltName || "";
    return targetHosts.every((host) => san.includes(`DNS:${host}`));
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
    return { supported: false, applied: true, value: "" };
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

async function generateCert(targetHostOrHosts, { force = false } = {}) {
  const targetHosts = targetHostsFrom({ targetHosts: normalizeTargetHosts(targetHostOrHosts) });
  const targetHost = targetHosts[0];
  const { dir, keyPath, certPath } = certPaths();

  if (!force && fs.existsSync(keyPath) && fs.existsSync(certPath) && certCoversHosts(certPath, targetHosts)) {
    return { key: keyPath, cert: certPath, created: false };
  }

  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const selfsigned = require("selfsigned");
  const attrs = [{ name: "commonName", value: targetHost }];
  const notAfter = new Date();
  notAfter.setFullYear(notAfter.getFullYear() + 1);

  const pems = await selfsigned.generate(attrs, {
    keySize: 2048,
    algorithm: "sha256",
    notAfterDate: notAfter,
    extensions: [
      { name: "subjectAltName", altNames: targetHosts.map((host) => ({ type: 2, value: host })) },
    ],
  });

  fs.writeFileSync(keyPath, pems.private);
  fs.writeFileSync(certPath, pems.cert);

  return { key: keyPath, cert: certPath, created: true };
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

async function installCert(certPath, targetHost, sudoPassword) {
  const isInstalled = await checkCertInstalled(certPath, targetHost);
  if (isInstalled) return { installed: false };

  if (IS_WIN) {
    await execPowerShell(`certutil -addstore Root '${certPath.replace(/'/g, "''")}'`, { elevated: true });
  } else {
    if (!IS_MAC) throw new Error("Certificate install is only implemented for macOS and Windows.");
    const command = `security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain ${shellQuote(certPath)}`;
    await execWithSudo(command, sudoPassword);
  }

  return { installed: true };
}

async function uninstallCert(certPath, targetHost, sudoPassword) {
  const isInstalled = await checkCertInstalled(certPath, targetHost);
  if (!isInstalled) return { removed: false };

  if (IS_WIN) {
    const fingerprint = getCertFingerprint(certPath).replace(/:/g, "").toUpperCase();
    await execPowerShell(`certutil -delstore Root '${fingerprint}'`, { elevated: true });
  } else {
    if (!IS_MAC) throw new Error("Certificate uninstall is only implemented for macOS and Windows.");
    const fingerprint = getCertFingerprint(certPath).replace(/:/g, "");
    const command = `security delete-certificate -Z "${fingerprint}" /Library/Keychains/System.keychain`;
    await execWithSudo(command, sudoPassword);
  }

  return { removed: true };
}

module.exports = {
  applyAntigravityNodeTrust,
  certCoversHosts,
  certDir,
  certExists,
  certPaths,
  checkAntigravityNodeTrust,
  checkCertInstalled,
  generateCert,
  getCertFingerprint,
  getPemFingerprints,
  installCert,
  isAntigravityRunning,
  uninstallCert,
};
