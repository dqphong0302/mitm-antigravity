function cloneJson(value) {
  return JSON.parse(JSON.stringify(value || {}));
}

function shouldIncludeSecrets(env = process.env) {
  return String(env.MITM_COPY_SETTINGS_WITH_SECRETS || "").toLowerCase() === "true";
}

function stripMachineSecrets(machine) {
  if (!machine || typeof machine !== "object") return;
  machine.apiKey = "";
  machine.routerUrl = "";
  machine.model = "";
  machine.modelPrefix = "";
  machine.mockModelList = false;
  machine.modelMap = {};
}

function stripReleaseSettings(settings, options = {}) {
  const output = cloneJson(settings);
  if (options.includeSecrets === true) return output;

  for (const machine of Object.values(output.machines || {})) {
    stripMachineSecrets(machine);
  }

  if (output.apiKey) output.apiKey = "";
  if (output.routerUrl) output.routerUrl = "";
  if (output.model) output.model = "";
  if (output.modelPrefix) output.modelPrefix = "";
  if (output.modelMap && typeof output.modelMap === "object") output.modelMap = {};
  if (typeof output.mockModelList !== "undefined") output.mockModelList = false;

  return output;
}

module.exports = {
  shouldIncludeSecrets,
  stripReleaseSettings,
};
