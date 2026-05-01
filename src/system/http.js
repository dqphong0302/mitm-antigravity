function collectBodyRaw(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function readRequestJson(req) {
  return collectBodyRaw(req).then((body) => {
    if (!body.length) return {};
    try {
      return JSON.parse(body.toString());
    } catch {
      throw new Error(`Invalid JSON in request body (${body.length} bytes)`);
    }
  });
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(payload));
}

module.exports = {
  collectBodyRaw,
  readRequestJson,
  sendJson,
};
