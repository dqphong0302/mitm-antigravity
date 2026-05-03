const readline = require("readline");

const { PRIMARY_ANTIGRAVITY_ALIASES } = require("../config/constants");
const { readConfig, redactConfig, writeConfig } = require("../config");

function createPromptInterface(input = process.stdin, output = process.stdout) {
    return readline.createInterface({ input, output });
}

function askQuestion(rl, message) {
    return new Promise((resolve) => {
        rl.question(message, (answer) => resolve(String(answer || "").trim()));
    });
}

function maskSecret(value) {
    if (!value) return "not set";
    const text = String(value);
    if (text.length <= 10) return "********";
    return `${text.slice(0, 6)}...${text.slice(-4)}`;
}

function yesNoDefault(value, defaultValue = false) {
    const text = String(value || "").trim().toLowerCase();
    if (!text) return defaultValue;
    return ["y", "yes", "true", "1", "ok"].includes(text);
}

function applyWizardAnswers(current, answers) {
    const next = {
        ...current,
        modelMap: { ...(current.modelMap || {}) },
    };

    if (answers.routerUrl) next.routerUrl = answers.routerUrl;
    if (answers.apiKey) next.apiKey = answers.apiKey;
    if (answers.model) next.model = answers.model;
    if (typeof answers.alwaysIntercept === "boolean") next.alwaysIntercept = answers.alwaysIntercept;

    for (const [alias, model] of Object.entries(answers.modelMap || {})) {
        if (model) next.modelMap[alias] = model;
        else if (model === "") delete next.modelMap[alias];
    }

    return next;
}

async function runWizard(options = {}) {
    const input = options.input || process.stdin;
    const output = options.output || process.stdout;
    const rl = options.rl || createPromptInterface(input, output);
    const write = (line = "") => output.write(`${line}\n`);

    const current = readConfig();
    const answers = { modelMap: {} };

    write("\nMITM Antigravity Setup Wizard");
    write("--------------------------------");
    write("Press Enter to keep the current value shown in brackets.\n");

    const endpoint = await askQuestion(rl, `Upstream endpoint [${current.routerUrl || "not set"}]: `);
    answers.routerUrl = endpoint;

    const apiKey = await askQuestion(rl, `API key [${maskSecret(current.apiKey)}]: `);
    answers.apiKey = apiKey;

    const forcedModel = await askQuestion(rl, `Force all intercepted requests to model [${current.model || "none"}]: `);
    answers.model = forcedModel;

    write("\nModel mappings");
    write("Leave blank to keep the current mapping. Type '-' to clear a mapping.");
    for (const alias of PRIMARY_ANTIGRAVITY_ALIASES) {
        const currentMapping = current.modelMap?.[alias] || "";
        const value = await askQuestion(rl, `${alias} -> [${currentMapping || "pass through"}]: `);
        if (value === "-") answers.modelMap[alias] = "";
        else if (value) answers.modelMap[alias] = value;
    }

    const alwaysInterceptAnswer = await askQuestion(
        rl,
        `Always intercept when no explicit mapping exists? [${current.alwaysIntercept ? "y" : "N"}]: `
    );
    answers.alwaysIntercept = yesNoDefault(alwaysInterceptAnswer, Boolean(current.alwaysIntercept));

    const next = applyWizardAnswers(current, answers);
    write("\nConfiguration preview:");
    write(JSON.stringify(redactConfig(next), null, 2));

    const saveAnswer = await askQuestion(rl, "\nSave this configuration? [Y/n]: ");
    const shouldSave = !saveAnswer || yesNoDefault(saveAnswer, true);
    if (shouldSave) {
        writeConfig(next);
        write("Saved configuration.");
    } else {
        write("Skipped saving configuration.");
    }

    const openGuiAnswer = await askQuestion(rl, "Open GUI now? [y/N]: ");
    const openGui = yesNoDefault(openGuiAnswer, false);

    if (!options.rl) rl.close();

    return {
        config: next,
        saved: shouldSave,
        openGui,
    };
}

module.exports = {
    applyWizardAnswers,
    askQuestion,
    maskSecret,
    runWizard,
    yesNoDefault,
};
