const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const defaultTarget = "x86_64-pc-windows-msvc";
const flavorConfigs = {
  bootstrapper: path.join("src-tauri", "tauri.windows.bootstrapper.conf.json"),
  offline: path.join("src-tauri", "tauri.windows.offline.conf.json"),
};

function executable(name) {
  return process.platform === "win32" ? `${name}.cmd` : name;
}

function targetFromArgs(args) {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--target" || arg === "-t") return args[i + 1] || "";
    if (arg.startsWith("--target=")) return arg.slice("--target=".length);
  }
  return "";
}

function flavorFromArgs(args) {
  const flavorIndex = args.findIndex((arg) => arg === "--flavor");
  if (flavorIndex >= 0) {
    const flavor = args[flavorIndex + 1] || "";
    args.splice(flavorIndex, 2);
    return flavor;
  }
  const inlineIndex = args.findIndex((arg) => arg.startsWith("--flavor="));
  if (inlineIndex >= 0) {
    const flavor = args[inlineIndex].slice("--flavor=".length);
    args.splice(inlineIndex, 1);
    return flavor;
  }
  return process.env.MITM_WINDOWS_INSTALLER_FLAVOR || "";
}

function configArgsForFlavor(flavor) {
  if (!flavor) return [];
  const configPath = flavorConfigs[flavor];
  if (!configPath) {
    throw new Error(`Unknown Windows installer flavor: ${flavor}. Use bootstrapper or offline.`);
  }
  return ["--config", configPath];
}

function pkgTargetFromTriple(target) {
  if (target.includes("aarch64-pc-windows")) return "win-arm64";
  return "win-x64";
}

const passthroughArgs = process.argv.slice(2);
const flavor = flavorFromArgs(passthroughArgs);
const target = process.env.MITM_TAURI_TARGET
  || process.env.CARGO_BUILD_TARGET
  || process.env.TAURI_TARGET_TRIPLE
  || targetFromArgs(passthroughArgs)
  || defaultTarget;
const hasTargetArg = Boolean(targetFromArgs(passthroughArgs));
const env = {
  ...process.env,
  CARGO_BUILD_TARGET: target,
  MITM_TAURI_TARGET: target,
  TAURI_TARGET_TRIPLE: target,
};

execFileSync(executable("node"), [path.join("scripts", "build-pkg.js"), pkgTargetFromTriple(target)], {
  cwd: root,
  env,
  stdio: "inherit",
});

const configArgs = configArgsForFlavor(flavor);
execFileSync(executable("npx"), [
  "tauri",
  "build",
  ...(hasTargetArg ? [] : ["--target", target]),
  ...configArgs,
  ...passthroughArgs,
], {
  cwd: root,
  env,
  stdio: "inherit",
});

if (flavor) {
  const bundleDir = path.join(root, "src-tauri", "target", target, "release", "bundle", "nsis");
  if (fs.existsSync(bundleDir)) {
    const marker = path.join(bundleDir, `installer-flavor-${flavor}.txt`);
    fs.writeFileSync(marker, `${flavor}\n`);
  }
}
