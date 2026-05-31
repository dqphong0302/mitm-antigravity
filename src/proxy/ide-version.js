"use strict";

// ── Antigravity IDE Version Override ────────────────────────────────────────
//
// Rewrite Antigravity IDE markers so the upstream AG 2.x backend accepts the
// request regardless of the actual local IDE version.
//
// User-Agent header: antigravity/<old> → antigravity/<ANTIGRAVITY_IDE_VERSION>
// Body field:        metadata.ideVersion → <ANTIGRAVITY_IDE_VERSION>
//
// Without this, Google backend may reject requests from IDE versions it
// considers too old or too new, causing silent failures or 400 errors.
//
// Technique borrowed from decolua/9router's src/mitm/antigravityIdeVersion.js.

const ANTIGRAVITY_IDE_VERSION = "1.23.2";
const ANTIGRAVITY_IDE_VERSION_OVERRIDE_ENABLED = true;

/**
 * Check whether body.metadata looks like an Antigravity IDE payload that
 * should have its ideVersion rewritten.
 */
function shouldRewriteMetadata(metadata) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return false;
  if (String(metadata.ideName || "").toLowerCase() === "antigravity") return true;
  if (String(metadata.ideType || "").toUpperCase() === "ANTIGRAVITY") return true;
  return Object.prototype.hasOwnProperty.call(metadata, "ideVersion");
}

/**
 * Rewrite `antigravity/<version>` in User-Agent to the known-good version.
 */
function rewriteAntigravityUserAgent(userAgent, version) {
  if (typeof userAgent !== "string" || !userAgent.includes("antigravity/")) return userAgent;
  return userAgent.replace(/antigravity\/[^\s]+/, `antigravity/${version}`);
}

/**
 * Apply the IDE version override to a request's body buffer and headers.
 * Returns { bodyBuffer, headers, applied, version }.
 *
 * This is designed to be called in the passthrough path (before forwarding
 * to the real Google upstream) so the upstream sees a known-good IDE version.
 */
function applyAntigravityIdeVersionOverride(bodyBuffer, headers) {
  if (!ANTIGRAVITY_IDE_VERSION_OVERRIDE_ENABLED) {
    return { bodyBuffer, headers, applied: false, version: ANTIGRAVITY_IDE_VERSION };
  }

  const nextHeaders = { ...headers };
  const nextUserAgent = rewriteAntigravityUserAgent(nextHeaders["user-agent"], ANTIGRAVITY_IDE_VERSION);
  const userAgentChanged = nextUserAgent !== nextHeaders["user-agent"];
  if (userAgentChanged) nextHeaders["user-agent"] = nextUserAgent;

  try {
    const parsed = JSON.parse(bodyBuffer.toString());
    if (!shouldRewriteMetadata(parsed?.metadata)) {
      return { bodyBuffer, headers: nextHeaders, applied: userAgentChanged, version: ANTIGRAVITY_IDE_VERSION };
    }

    parsed.metadata.ideVersion = ANTIGRAVITY_IDE_VERSION;
    const nextBodyBuffer = Buffer.from(JSON.stringify(parsed));
    // Update content-length since body size changed
    nextHeaders["content-length"] = String(nextBodyBuffer.length);
    return { bodyBuffer: nextBodyBuffer, headers: nextHeaders, applied: true, version: ANTIGRAVITY_IDE_VERSION };
  } catch {
    return { bodyBuffer, headers: nextHeaders, applied: userAgentChanged, version: ANTIGRAVITY_IDE_VERSION };
  }
}

module.exports = {
  ANTIGRAVITY_IDE_VERSION,
  applyAntigravityIdeVersionOverride,
  rewriteAntigravityUserAgent,
  shouldRewriteMetadata,
};
