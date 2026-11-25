/**
 * Bounded recursive JSON Schema validator for tool call arguments.
 * Validates top-level and nested objects (`required`, `properties`, `additionalProperties`),
 * arrays (`items`, `minItems`, `maxItems`), `enum`, and numeric `minimum` / `maximum`
 * up to `MAX_SCHEMA_DEPTH` without external runtime dependencies.
 */

export const MAX_SCHEMA_DEPTH = 12;

const JSON_TYPES: Record<string, (value: unknown) => boolean> = {
  string: (value) => typeof value === "string",
  number: (value) => typeof value === "number" && Number.isFinite(value),
  integer: (value) => Number.isInteger(value),
  boolean: (value) => typeof value === "boolean",
  array: (value) => Array.isArray(value),
  object: (value) => typeof value === "object" && value !== null && !Array.isArray(value),
  null: (value) => value === null,
};

function isSchemaRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatExpectedType(type: string): string {
  if (type === "integer" || type === "array" || type === "object") return `an ${type}`;
  if (type === "null") return "null";
  return `a ${type}`;
}

function validateObject(
  obj: Record<string, unknown>,
  schema: Record<string, unknown>,
  prefix: string,
  depth: number,
): string | undefined {
  const required = Array.isArray(schema.required) ? schema.required : [];
  for (const key of required) {
    if (typeof key !== "string") continue;
    if (obj[key] === undefined) {
      const label = prefix === "" ? key : `${prefix}.${key}`;
      return `missing required argument "${label}"`;
    }
  }
  if (depth >= MAX_SCHEMA_DEPTH) return undefined;

  const properties = isSchemaRecord(schema.properties) ? schema.properties : undefined;
  const additional = isSchemaRecord(schema.additionalProperties) ? schema.additionalProperties : undefined;
  if (properties === undefined && additional === undefined) return undefined;

  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined) continue;
    const propSchema = properties !== undefined && isSchemaRecord(properties[key])
      ? properties[key]
      : (properties !== undefined && key in properties ? undefined : additional);
    if (propSchema === undefined) continue;
    const label = prefix === "" ? key : `${prefix}.${key}`;
    const problem = validateValue(value, propSchema, label, depth + 1);
    if (problem !== undefined) return problem;
  }
  return undefined;
}

function validateValue(
  value: unknown,
  schema: Record<string, unknown>,
  label: string,
  depth: number,
): string | undefined {
  if (typeof schema.type === "string") {
    const check = JSON_TYPES[schema.type];
    if (check !== undefined && !check(value)) {
      return `argument "${label}" must be ${formatExpectedType(schema.type)}`;
    }
  } else if (Array.isArray(schema.type)) {
    const known = schema.type.filter((item): item is string => typeof item === "string" && item in JSON_TYPES);
    if (known.length > 0 && !known.some((item) => JSON_TYPES[item]?.(value) === true)) {
      return `argument "${label}" must be ${known.map(formatExpectedType).join(" or ")}`;
    }
  }

  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    const matched = schema.enum.some((candidate) => Object.is(candidate, value));
    if (!matched) {
      return `argument "${label}" must be one of ${schema.enum.map((candidate) => JSON.stringify(candidate)).join(", ")}`;
    }
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    if (typeof schema.minimum === "number" && value < schema.minimum) {
      return `argument "${label}" must be >= ${schema.minimum}`;
    }
    if (typeof schema.maximum === "number" && value > schema.maximum) {
      return `argument "${label}" must be <= ${schema.maximum}`;
    }
  }

  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) {
      return `argument "${label}" must have at least ${schema.minItems} item(s)`;
    }
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) {
      return `argument "${label}" must have at most ${schema.maxItems} item(s)`;
    }
    if (depth < MAX_SCHEMA_DEPTH && isSchemaRecord(schema.items)) {
      for (let index = 0; index < value.length; index += 1) {
        const itemProblem = validateValue(value[index], schema.items, `${label}[${index}]`, depth + 1);
        if (itemProblem !== undefined) return itemProblem;
      }
    }
  } else if (isSchemaRecord(value)) {
    return validateObject(value, schema, label, depth);
  }

  return undefined;
}

/** Why `args` do not fit `parameters`, or `undefined` when they do (recursively up to depth 12). */
export function argumentProblem(
  parameters: Record<string, unknown>,
  args: Record<string, unknown>,
): string | undefined {
  if (!isSchemaRecord(args) || "__invalidJson" in args) {
    return "the arguments were not valid JSON";
  }
  return validateObject(args, parameters, "", 0);
}
