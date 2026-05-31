#!/usr/bin/env node
"use strict";

const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const roots = ["index.js", "src", "scripts", "test"];
const ignoredDirs = new Set([
  ".git",
  "dist",
  "node_modules",
  "src-tauri/target",
  "target-gui-test",
]);

function relativePath(filePath) {
  return path.relative(root, filePath).split(path.sep).join("/");
}

function isIgnoredDir(filePath) {
  const rel = relativePath(filePath);
  return ignoredDirs.has(rel);
}

function collectJsFiles(entry, output = []) {
  const absolute = path.join(root, entry);
  if (!fs.existsSync(absolute)) return output;

  const stat = fs.statSync(absolute);
  if (stat.isDirectory()) {
    if (isIgnoredDir(absolute)) return output;
    for (const child of fs.readdirSync(absolute).sort()) {
      collectJsFiles(path.join(entry, child), output);
    }
    return output;
  }

  if (absolute.endsWith(".js")) output.push(relativePath(absolute));
  return output;
}

const files = Array.from(new Set(roots.flatMap((entry) => collectJsFiles(entry)))).sort();
for (const file of files) {
  const result = spawnSync(process.execPath, ["--check", file], {
    cwd: root,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    process.stdout.write(result.stdout || "");
    process.stderr.write(result.stderr || "");
    process.exit(result.status || 1);
  }
}

console.log(`Checked ${files.length} JavaScript files.`);
