#!/usr/bin/env node
/**
 * Build pkg backend binaries with target-aware, cache-friendly behavior.
 * Usage: node scripts/build-pkg.js <target> [--force]
 * Targets: native | macos | macos-all | macos-arm64 | macos-x64 | win-x64 | win-arm64 | linux-x64 | linux-arm64 | all
 */

const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const distDir = path.join(root, "dist");

const PKG_TARGETS = {
  "macos-arm64": "node20-macos-arm64",
  "macos-x64": "node20-macos-x64",
  "win-x64": "node20-win-x64",
  "win-arm64": "node20-win-arm64",
  "linux-x64": "node20-linux-x64",
  "linux-arm64": "node20-linux-arm64",
};

const OUTPUT_NAMES = {
  "macos-arm64": "mitm-antigravity-macos-arm64",
  "macos-x64": "mitm-antigravity-macos-x64",
  "win-x64": "mitm-antigravity-win-x64.exe",
  "win-arm64": "mitm-antigravity-win-arm64.exe",
  "linux-x64": "mitm-antigravity-linux-x64",
  "linux-arm64": "mitm-antigravity-linux-arm64",
};

function nativeTarget() {
  const { platform, arch } = process;
  if (platform === "darwin") return arch === "arm64" ? "macos-arm64" : "macos-x64";
  if (platform === "win32") return arch === "arm64" ? "win-arm64" : "win-x64";
  if (platform === "linux") return arch === "arm64" ? "linux-arm64" : "linux-x64";
  throw new Error(`Unsupported native platform: ${platform}-${arch}`);
}

const AGGREGATE_TARGETS = {
  native: () => [nativeTarget()],
  macos: () => [nativeTarget().startsWith("macos-") ? nativeTarget() : "macos-arm64"],
  "macos-all": () => ["macos-arm64", "macos-x64"],
  windows: () => ["win-x64"],
  linux: () => ["linux-x64", "linux-arm64"],
  all: () => ["macos-arm64", "macos-x64", "win-x64", "linux-x64", "linux-arm64"],
};

const args = process.argv.slice(2);
const target = args.find((arg) => !arg.startsWith("--"));
const force = args.includes("--force");

function newestMtimeMs(paths) {
  let newest = 0;
  for (const entry of paths) {
    if (!fs.existsSync(entry)) continue;
    const stat = fs.statSync(entry);
    if (stat.isDirectory()) {
      for (const child of fs.readdirSync(entry)) {
        newest = Math.max(newest, newestMtimeMs([path.join(entry, child)]));
      }
    } else {
      newest = Math.max(newest, stat.mtimeMs);
    }
  }
  return newest;
}

function sourceMtimeMs() {
  return newestMtimeMs([
    path.join(root, "index.js"),
    path.join(root, "package.json"),
    path.join(root, "src"),
  ]);
}

function outputFresh(outputPath) {
  if (force || !fs.existsSync(outputPath)) return false;
  return fs.statSync(outputPath).mtimeMs >= sourceMtimeMs();
}

function formatSize(filePath) {
  const sizeKB = Math.round(fs.statSync(filePath).size / 1024);
  return `${sizeKB.toLocaleString()} KB`;
}

function buildOne(childTarget) {
  const pkgTarget = PKG_TARGETS[childTarget];
  const outputName = OUTPUT_NAMES[childTarget];
  if (!pkgTarget || !outputName) throw new Error(`Unknown target: ${childTarget}`);

  const outputPath = path.join(distDir, outputName);
  // @yao-pkg writes the generic binary using the *target* platform extension,
  // not the host platform. Cross-building win-x64 on macOS therefore produces
  // dist/mitm-antigravity.exe, not dist/mitm-antigravity.
  const genericOutputPaths = [
    path.join(distDir, "mitm-antigravity"),
    path.join(distDir, "mitm-antigravity.exe"),
  ];
  fs.mkdirSync(distDir, { recursive: true });

  if (outputFresh(outputPath)) {
    console.log(`Up to date: ${outputName} (${formatSize(outputPath)})`);
    return;
  }

  for (const genericOutputPath of genericOutputPaths) fs.rmSync(genericOutputPath, { force: true });
  fs.rmSync(outputPath, { force: true });

  const started = Date.now();
  console.log(`Building ${childTarget} → ${outputName}`);
  console.log(`pkg target: ${pkgTarget}`);

  try {
    execFileSync(process.execPath, [
      path.join(root, "node_modules", "@yao-pkg", "pkg", "lib-es5", "bin.js"),
      ".",
      "--targets",
      pkgTarget,
      "--out-path",
      "dist",
    ], { stdio: "inherit", cwd: root });
  } catch (_) {
    // pkg may exit non-zero on some platforms even when output is produced.
  }

  if (!fs.existsSync(outputPath)) {
    const producedGeneric = genericOutputPaths.find((genericOutputPath) => fs.existsSync(genericOutputPath));
    if (producedGeneric) fs.renameSync(producedGeneric, outputPath);
  }

  if (!fs.existsSync(outputPath)) {
    console.error(`ERROR: Expected binary not found: ${outputPath}`);
    try { console.error(`dist/ contents: ${fs.readdirSync(distDir).join(", ")}`); } catch {}
    process.exit(1);
  }

  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`Built: ${outputPath} (${formatSize(outputPath)}, ${elapsed}s)`);
}

if (!target || (!PKG_TARGETS[target] && !AGGREGATE_TARGETS[target])) {
  console.error("Usage: node scripts/build-pkg.js <target> [--force]");
  console.error(`Valid targets: ${[...Object.keys(PKG_TARGETS), ...Object.keys(AGGREGATE_TARGETS)].join(", ")}`);
  process.exit(1);
}

const targets = AGGREGATE_TARGETS[target] ? AGGREGATE_TARGETS[target]() : [target];
for (const childTarget of targets) buildOne(childTarget);
