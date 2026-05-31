"use strict";

const SCHEMA_NUMERIC_KEYWORDS = new Set([
  "default", "const", "minimum", "maximum",
  "exclusiveMinimum", "exclusiveMaximum", "multipleOf",
]);
const SCHEMA_NUMERIC_LIST_KEYWORDS = new Set(["enum", "examples"]);
const SCHEMA_STRUCTURAL_KEYWORDS = new Set([
  "properties", "patternProperties", "definitions", "$defs",
]);
const SCHEMA_NESTED_LIST_KEYWORDS = new Set([
  "allOf", "anyOf", "oneOf", "prefixItems",
]);
const SCHEMA_NESTED_KEYWORDS = new Set([
  "items", "additionalProperties", "not", "if", "then", "else", "contains",
  "propertyNames", "unevaluatedItems", "unevaluatedProperties",
]);

function normalizeSchemaTypeName(value) {
  return String(value || "").trim().toLowerCase();
}

function coerceScalarToSchemaType(value, type) {
  if (value === null || value === undefined) return value;
  const normalizedType = normalizeSchemaTypeName(type);

  if (normalizedType === "integer") {
    if (typeof value === "number" && Number.isInteger(value)) return value;
    if (typeof value === "string" && /^-?\d+$/.test(value.trim())) {
      const parsed = Number(value.trim());
      if (Number.isInteger(parsed)) return parsed;
    }
    if (typeof value === "boolean") return value ? 1 : 0;
    return value;
  }

  if (normalizedType === "number") {
    if (typeof value === "number") return value;
    if (typeof value === "string" && /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(value.trim())) {
      const parsed = Number(value.trim());
      if (Number.isFinite(parsed)) return parsed;
    }
    if (typeof value === "boolean") return value ? 1 : 0;
    return value;
  }

  if (normalizedType === "boolean") {
    if (typeof value === "boolean") return value;
    if (typeof value === "string") {
      const lowered = value.trim().toLowerCase();
      if (lowered === "true") return true;
      if (lowered === "false") return false;
    }
    return value;
  }

  if (normalizedType === "string") {
    if (typeof value === "string") return value;
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    return value;
  }

  return value;
}

function coerceJsonSchemaTypes(node, depth = 0) {
  if (!node || depth > 32) return node;
  if (Array.isArray(node)) {
    for (const item of node) coerceJsonSchemaTypes(item, depth + 1);
    return node;
  }
  if (typeof node !== "object") return node;

  const declaredType = Array.isArray(node.type)
    ? node.type.find((t) => typeof t === "string")
    : node.type;

  if (declaredType) {
    for (const key of SCHEMA_NUMERIC_KEYWORDS) {
      if (key in node) node[key] = coerceScalarToSchemaType(node[key], declaredType);
    }
    for (const key of SCHEMA_NUMERIC_LIST_KEYWORDS) {
      if (Array.isArray(node[key])) {
        node[key] = node[key].map((item) => coerceScalarToSchemaType(item, declaredType));
      }
    }
  }

  for (const key of SCHEMA_STRUCTURAL_KEYWORDS) {
    const child = node[key];
    if (child && typeof child === "object" && !Array.isArray(child)) {
      for (const propValue of Object.values(child)) coerceJsonSchemaTypes(propValue, depth + 1);
    }
  }
  for (const key of SCHEMA_NESTED_LIST_KEYWORDS) {
    if (Array.isArray(node[key])) {
      for (const item of node[key]) coerceJsonSchemaTypes(item, depth + 1);
    }
  }
  for (const key of SCHEMA_NESTED_KEYWORDS) {
    const child = node[key];
    if (child && typeof child === "object") coerceJsonSchemaTypes(child, depth + 1);
  }

  return node;
}

function coerceToolSchemasInBody(body) {
  if (!body || typeof body !== "object") return body;
  const requestBody = body.request && typeof body.request === "object" ? body.request : body;

  const toolBuckets = [requestBody.tools, body.tools].filter(Array.isArray);
  for (const bucket of toolBuckets) {
    for (const tool of bucket) {
      if (!tool || typeof tool !== "object") continue;
      if (Array.isArray(tool.functionDeclarations)) {
        for (const decl of tool.functionDeclarations) {
          if (decl && decl.parameters) coerceJsonSchemaTypes(decl.parameters);
        }
      }
      if (tool.function && tool.function.parameters) {
        coerceJsonSchemaTypes(tool.function.parameters);
      }
      if (tool.parameters) coerceJsonSchemaTypes(tool.parameters);
    }
  }
  return body;
}

module.exports = {
  coerceJsonSchemaTypes,
  coerceToolSchemasInBody,
};
