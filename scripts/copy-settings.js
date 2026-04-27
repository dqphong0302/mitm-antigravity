const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const source = path.join(root, "settings.json");
const targetDir = path.join(root, "dist");
const target = path.join(targetDir, "settings.json");

if (!fs.existsSync(source) || !fs.existsSync(targetDir)) process.exit(0);

const settings = JSON.parse(fs.readFileSync(source, "utf8"));
const includeSecrets = String(process.env.MITM_COPY_SETTINGS_WITH_SECRETS || "").toLowerCase() === "true";

if (settings.machines && typeof settings.machines === "object") {
  for (const machineConfig of Object.values(settings.machines)) {
    if (machineConfig && typeof machineConfig === "object") {
      if (!includeSecrets) {
        machineConfig.apiKey = "";
        machineConfig.routerUrl = "";
        machineConfig.model = "";
        machineConfig.modelPrefix = "ag/";
        machineConfig.modelMap = {};
      }
    }
  }
}

fs.writeFileSync(target, `${JSON.stringify(settings, null, 2)}\n`);
console.log(`Copied settings.json to ${target}${includeSecrets ? "" : " (apiKey stripped)"}`);
