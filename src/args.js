function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const eqIndex = arg.indexOf("=");
      const key = eqIndex === -1 ? arg.slice(2) : arg.slice(2, eqIndex);
      const maybeValue = eqIndex === -1 ? undefined : arg.slice(eqIndex + 1);
      if (typeof maybeValue !== "undefined") {
        addArgValue(out, key, maybeValue);
      } else {
        const next = argv[i + 1];
        if (next && !next.startsWith("--")) {
          addArgValue(out, key, next);
          i += 1;
        } else {
          addArgValue(out, key, true);
        }
      }
    } else {
      out._.push(arg);
    }
  }
  return out;
}

function addArgValue(out, key, value) {
  if (typeof out[key] === "undefined") {
    out[key] = value;
  } else if (Array.isArray(out[key])) {
    out[key].push(value);
  } else {
    out[key] = [out[key], value];
  }
}

module.exports = {
  addArgValue,
  parseArgs,
};
