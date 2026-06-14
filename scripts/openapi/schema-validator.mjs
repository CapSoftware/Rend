import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

export const OPENAPI_SPEC_PATH = path.resolve(
  process.cwd(),
  "docs/openapi/rend-public-api.openapi.json"
);

export async function loadOpenApiSpec(specPath = OPENAPI_SPEC_PATH) {
  return JSON.parse(await readFile(specPath, "utf8"));
}

export function resolveRef(spec, ref) {
  if (typeof ref !== "string" || !ref.startsWith("#/")) {
    throw new Error(`unsupported OpenAPI ref: ${ref}`);
  }

  return ref
    .slice(2)
    .split("/")
    .reduce((value, segment) => {
      const key = segment.replace(/~1/g, "/").replace(/~0/g, "~");
      if (!value || typeof value !== "object" || !(key in value)) {
        throw new Error(`unresolved OpenAPI ref: ${ref}`);
      }
      return value[key];
    }, spec);
}

export function dereference(spec, value) {
  if (value && typeof value === "object" && "$ref" in value) {
    return dereference(spec, resolveRef(spec, value.$ref));
  }
  return value;
}

export function responseSchema(spec, pathName, method, status, contentType = "application/json") {
  const operation = spec.paths?.[pathName]?.[method.toLowerCase()];
  if (!operation) throw new Error(`missing OpenAPI operation: ${method.toUpperCase()} ${pathName}`);

  let response = operation.responses?.[String(status)] ?? operation.responses?.default;
  response = dereference(spec, response);
  const content = response?.content?.[contentType];
  const schema = content?.schema;
  if (!schema) {
    throw new Error(
      `missing ${contentType} schema for ${method.toUpperCase()} ${pathName} ${status}`
    );
  }
  return schema;
}

export function assertMatchesResponseSchema(
  spec,
  pathName,
  method,
  status,
  value,
  contentType = "application/json"
) {
  const errors = validateSchema(spec, responseSchema(spec, pathName, method, status, contentType), value);
  assert.deepEqual(errors, [], `${method.toUpperCase()} ${pathName} ${status} schema mismatch`);
}

export function validateSchema(spec, schema, value, at = "$") {
  schema = dereference(spec, schema);
  const errors = [];

  if (!schema || typeof schema !== "object") return errors;

  if (schema.oneOf) {
    const matching = schema.oneOf.filter((candidate) => validateSchema(spec, candidate, value, at).length === 0);
    if (matching.length !== 1) {
      errors.push(`${at} must match exactly one schema in oneOf`);
    }
    return errors;
  }

  if (schema.anyOf) {
    const matching = schema.anyOf.some((candidate) => validateSchema(spec, candidate, value, at).length === 0);
    if (!matching) errors.push(`${at} must match at least one schema in anyOf`);
    return errors;
  }

  if (schema.allOf) {
    for (const candidate of schema.allOf) errors.push(...validateSchema(spec, candidate, value, at));
    return errors;
  }

  if ("const" in schema && value !== schema.const) {
    errors.push(`${at} must equal ${JSON.stringify(schema.const)}`);
    return errors;
  }

  if (schema.enum && !schema.enum.includes(value)) {
    errors.push(`${at} must be one of ${schema.enum.map((item) => JSON.stringify(item)).join(", ")}`);
    return errors;
  }

  const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  if (types.length > 0 && !types.some((type) => valueMatchesType(value, type))) {
    errors.push(`${at} must be ${types.join(" or ")}`);
    return errors;
  }

  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      errors.push(`${at} must have length >= ${schema.minLength}`);
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      errors.push(`${at} must have length <= ${schema.maxLength}`);
    }
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) {
      errors.push(`${at} must match /${schema.pattern}/`);
    }
  }

  if (typeof value === "number") {
    if (schema.type === "integer" && !Number.isInteger(value)) {
      errors.push(`${at} must be an integer`);
    }
    if (schema.minimum !== undefined && value < schema.minimum) {
      errors.push(`${at} must be >= ${schema.minimum}`);
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      errors.push(`${at} must be <= ${schema.maximum}`);
    }
  }

  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      errors.push(`${at} must contain at least ${schema.minItems} items`);
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      errors.push(`${at} must contain at most ${schema.maxItems} items`);
    }
    if (schema.items) {
      value.forEach((item, index) => {
        errors.push(...validateSchema(spec, schema.items, item, `${at}[${index}]`));
      });
    }
  }

  if (value && typeof value === "object" && !Array.isArray(value)) {
    const required = schema.required ?? [];
    for (const key of required) {
      if (!(key in value)) errors.push(`${at}.${key} is required`);
    }

    const properties = schema.properties ?? {};
    for (const [key, propertySchema] of Object.entries(properties)) {
      if (key in value) {
        errors.push(...validateSchema(spec, propertySchema, value[key], `${at}.${key}`));
      }
    }

    const extras = Object.keys(value).filter((key) => !(key in properties));
    if (schema.additionalProperties === false && extras.length > 0) {
      for (const key of extras) errors.push(`${at}.${key} is not allowed`);
    } else if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
      for (const key of extras) {
        errors.push(
          ...validateSchema(spec, schema.additionalProperties, value[key], `${at}.${key}`)
        );
      }
    }
  }

  return errors;
}

function valueMatchesType(value, type) {
  switch (type) {
    case "array":
      return Array.isArray(value);
    case "boolean":
      return typeof value === "boolean";
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "null":
      return value === null;
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "object":
      return Boolean(value && typeof value === "object" && !Array.isArray(value));
    case "string":
      return typeof value === "string";
    default:
      throw new Error(`unsupported JSON Schema type: ${type}`);
  }
}
