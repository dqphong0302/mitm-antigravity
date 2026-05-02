const { execFileSync } = require("child_process");
const path = require("path");

const root = path.resolve(__dirname, "..");
const defaultTarget = "x86_64-pc-windows-msvc";

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

function pkgTargetFromTriple(target) {
  if (target.includes("aarch64-pc-windows")) return "win-arm64";
  return "win-x64";
}

const passthroughArgs = process.argv.slice(2);
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

execFileSync(executable("npx"), [
  "tauri",
  "build",
  ...(hasTargetArg ? [] : ["--target", target]),
  ...passthroughArgs,
], {
  cwd: root,
  env,
  stdio: "inherit",
});
