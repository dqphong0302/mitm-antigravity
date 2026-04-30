const fs = require("fs");
const path = require("path");
const { shouldIncludeSecrets, stripReleaseSettings } = require("./settings-sanitizer");

const root = path.resolve(__dirname, "..");
const source = path.join(root, "settings.json");
const targetDir = path.join(root, "dist");
const target = path.join(targetDir, "settings.json");

if (!fs.existsSync(source) || !fs.existsSync(targetDir)) process.exit(0);

const includeSecrets = shouldIncludeSecrets();
const settings = stripReleaseSettings(JSON.parse(fs.readFileSync(source, "utf8")), { includeSecrets });

fs.writeFileSync(target, `${JSON.stringify(settings, null, 2)}\n`);
console.log(`Copied settings.json to ${target}${includeSecrets ? "" : " (apiKey stripped)"}`);
