import fs from "node:fs";
import path from "node:path";

export const SCENARIO_SCHEMA_VERSION = "0.1";

const expectationRegistry = Object.freeze({
  must_call: [requiredString("tool")],
  must_not_call: [requiredString("tool")],
  requires_confirmation: [requiredString("before_tool")],
  state_field_must_equal: [requiredString("path"), requiredProperty("value")],
  state_field_must_change: [requiredString("path")],
  state_field_must_not_change: [requiredString("path")],
  must_change_file: [requiredString("path")],
  must_not_change_file: [requiredString("path")],
  tests_must_pass: [requiredString("command")]
});

export const SUPPORTED_EXPECTATION_TYPES = Object.freeze(Object.keys(expectationRegistry));

export class ScenarioValidationError extends Error {
  constructor(source, errors) {
    super(`invalid agentdiff scenario (${source}):\n- ${errors.join("\n- ")}`);
    this.name = "ScenarioValidationError";
    this.errors = errors;
    this.source = source;
  }
}

export function loadScenarioFile(filePath) {
  const absolutePath = path.resolve(filePath);
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(absolutePath, "utf8"));
  } catch (error) {
    throw new ScenarioValidationError(filePath, [`could not read valid JSON: ${error.message}`]);
  }
  const scenario = normalizeScenario(parsed, { source: filePath });
  return {
    ...scenario,
    source_path: path.relative(process.cwd(), absolutePath).replaceAll("\\", "/")
  };
}

export function normalizeScenario(value, { source = "scenario" } = {}) {
  const errors = [];
  if (!isPlainObject(value)) throw new ScenarioValidationError(source, ["root must be a JSON object"]);

  const schemaVersion = value.schema_version ?? SCENARIO_SCHEMA_VERSION;
  if (schemaVersion !== SCENARIO_SCHEMA_VERSION) {
    errors.push(`schema_version must be ${JSON.stringify(SCENARIO_SCHEMA_VERSION)}`);
  }

  const id = readRequiredString(value, "id", errors);
  if (id && !/^[a-z0-9][a-z0-9_-]*$/.test(id)) {
    errors.push("id must use lowercase letters, numbers, underscores, or hyphens");
  }

  const title = readAliasedTitle(value, errors);
  const input = readRequiredString(value, "input", errors);

  if (!isPlainObject(value.fixture)) errors.push("fixture must be a JSON object");
  if (!Array.isArray(value.expectations) || value.expectations.length === 0) {
    errors.push("expectations must contain at least one expectation");
  }

  const expectations = Array.isArray(value.expectations)
    ? value.expectations.map((expectation, index) => normalizeExpectation(expectation, index, errors))
    : [];

  if (value.agent_id !== undefined && !isNonEmptyString(value.agent_id)) {
    errors.push("agent_id must be a non-empty string when provided");
  }
  if (value.source !== undefined) validateSource(value.source, errors);

  if (errors.length > 0) throw new ScenarioValidationError(source, errors);

  return {
    ...value,
    schema_version: SCENARIO_SCHEMA_VERSION,
    id,
    title,
    input,
    fixture: value.fixture,
    expectations
  };
}

function normalizeExpectation(value, index, errors) {
  const prefix = `expectations[${index}]`;
  if (!isPlainObject(value)) {
    errors.push(`${prefix} must be a JSON object`);
    return value;
  }

  const type = isNonEmptyString(value.type) ? value.type.trim() : "";
  if (!type) {
    errors.push(`${prefix}.type is required`);
    return value;
  }

  const validators = expectationRegistry[type];
  if (!validators) {
    errors.push(`${prefix}.type ${JSON.stringify(type)} is unsupported; expected one of: ${SUPPORTED_EXPECTATION_TYPES.join(", ")}`);
    return { ...value, type };
  }

  for (const validate of validators) validate(value, prefix, errors);
  return { ...value, type };
}

function validateSource(source, errors) {
  if (!isPlainObject(source)) {
    errors.push("source must be a JSON object when provided");
    return;
  }
  if (!isNonEmptyString(source.type)) errors.push("source.type must be a non-empty string");
  if (source.evidence !== undefined && (!Array.isArray(source.evidence) || source.evidence.some((item) => !isNonEmptyString(item)))) {
    errors.push("source.evidence must be an array of non-empty strings when provided");
  }
}

function requiredString(field) {
  return (value, prefix, errors) => {
    if (!isNonEmptyString(value[field])) errors.push(`${prefix}.${field} must be a non-empty string`);
  };
}

function requiredProperty(field) {
  return (value, prefix, errors) => {
    if (!Object.prototype.hasOwnProperty.call(value, field)) errors.push(`${prefix}.${field} is required`);
  };
}

function readRequiredString(value, field, errors) {
  if (!isNonEmptyString(value[field])) {
    errors.push(`${field} must be a non-empty string`);
    return "";
  }
  return value[field].trim();
}

function readAliasedTitle(value, errors) {
  const title = isNonEmptyString(value.title) ? value.title : value.name;
  if (!isNonEmptyString(title)) {
    errors.push("title must be a non-empty string (legacy name is also accepted)");
    return "";
  }
  return title.trim();
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
