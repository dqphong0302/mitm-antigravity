const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const releaseDir = path.join(root, "release");
const target = process.argv[2] || (process.platform === "darwin" ? "mac" : "win");

function newestEntry(dir, predicate) {
    if (!fs.existsSync(dir)) {
        throw new Error(`Missing build output directory: ${dir}`);
    }

    const entries = fs.readdirSync(dir, { withFileTypes: true })
        .filter(predicate)
        .map((entry) => {
            const fullPath = path.join(dir, entry.name);
            return {
                fullPath,
                name: entry.name,
                mtimeMs: fs.statSync(fullPath).mtimeMs,
            };
        })
        .sort((a, b) => b.mtimeMs - a.mtimeMs);

    if (entries.length === 0) {
        throw new Error(`No matching artifact found in ${dir}`);
    }

    return entries[0];
}

function copyFileArtifact(source) {
    fs.mkdirSync(releaseDir, { recursive: true });
    const targetPath = path.join(releaseDir, path.basename(source));
    fs.copyFileSync(source, targetPath);
    console.log(`Copied artifact: ${targetPath}`);
}

function copyDirectoryArtifact(source) {
    fs.mkdirSync(releaseDir, { recursive: true });
    const targetPath = path.join(releaseDir, path.basename(source));
    fs.rmSync(targetPath, { recursive: true, force: true });
    fs.cpSync(source, targetPath, { recursive: true });
    console.log(`Copied artifact: ${targetPath}`);
}

if (target === "win" || target === "windows") {
    const nsisDir = path.join(root, "src-tauri", "target", "release", "bundle", "nsis");
    const artifact = newestEntry(nsisDir, (entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".exe"));
    copyFileArtifact(artifact.fullPath);
} else if (target === "mac" || target === "macos" || target === "darwin") {
    const macosDir = path.join(root, "src-tauri", "target", "release", "bundle", "macos");
    const artifact = newestEntry(macosDir, (entry) => entry.isDirectory() && entry.name.endsWith(".app"));
    copyDirectoryArtifact(artifact.fullPath);
} else {
    throw new Error(`Unknown artifact target: ${target}`);
}
