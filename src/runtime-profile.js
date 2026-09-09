const bindingTypes = new Set(["string", "boolean", "integer", "string-array"]);
const secretDescriptorKeys = new Set(["environment", "required"]);

export class RuntimeProfileError extends Error {
  constructor(message) {
    super(message);
    this.name = "RuntimeProfileError";
  }
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireRecord(value, name) {
  if (!isRecord(value)) throw new RuntimeProfileError(`${name} must be an object`);
}

function requireIdentity(value, name) {
  if (typeof value !== "string" || !/^[a-z][a-z0-9-]*$/.test(value)) {
    throw new RuntimeProfileError(`${name} must use lowercase letters, numbers, and hyphens`);
  }
}

function requireKey(value, name) {
  if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(value)) {
    throw new RuntimeProfileError(`${name} must start with a letter and contain only letters, numbers, _, or -`);
  }
}

function requireOnlyKeys(value, allowedKeys, name) {
  const unsupportedKey = Reflect.ownKeys(value).find((key) => !allowedKeys.has(key));
  if (unsupportedKey !== undefined) {
    throw new RuntimeProfileError(`${name} has unsupported field: ${String(unsupportedKey)}`);
  }
}

function parseBoolean(value, name) {
  if (value === true || value === false) return value;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new RuntimeProfileError(`${name} must be true or false`);
}

function parseInteger(value, name) {
  const parsed = typeof value === "string" && /^-?\d+$/.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(parsed)) throw new RuntimeProfileError(`${name} must be a safe integer`);
  return parsed;
}

function parseStringArray(value, name) {
  const parsed = typeof value === "string" ? value.split(",").map((item) => item.trim()) : value;
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string" || item.length === 0)) {
    throw new RuntimeProfileError(`${name} must be an array of non-empty strings`);
  }
  return Object.freeze([...parsed]);
}

function parseBindingValue(value, type, name) {
  if (type === "string") {
    if (typeof value !== "string" || value.length === 0) {
      throw new RuntimeProfileError(`${name} must be a non-empty string`);
    }
    return value;
  }
  if (type === "boolean") return parseBoolean(value, name);
  if (type === "integer") return parseInteger(value, name);
  return parseStringArray(value, name);
}

function resolveEnvironmentValue(environment, name) {
  return Object.hasOwn(environment, name) ? environment[name] : undefined;
}

function resolveSource(descriptor, environment, name) {
  const hasValue = Object.hasOwn(descriptor, "value");
  const hasEnvironment = Object.hasOwn(descriptor, "environment");
  if (hasValue === hasEnvironment) {
    throw new RuntimeProfileError(`${name} must define exactly one of value or environment`);
  }
  if (hasEnvironment && (typeof descriptor.environment !== "string" || descriptor.environment.length === 0)) {
    throw new RuntimeProfileError(`${name} environment must be a non-empty string`);
  }
  return hasValue ? descriptor.value : resolveEnvironmentValue(environment, descriptor.environment);
}

function resolveBindings(definition, environment, profileIdentity) {
  const resolved = {};
  for (const [bindingName, descriptor] of Object.entries(definition)) {
    requireKey(bindingName, `binding name ${bindingName}`);
    requireRecord(descriptor, `binding ${bindingName}`);
    if (!bindingTypes.has(descriptor.type)) {
      throw new RuntimeProfileError(`binding ${bindingName} has unsupported type: ${descriptor.type}`);
    }
    if (descriptor.required !== undefined && typeof descriptor.required !== "boolean") {
      throw new RuntimeProfileError(`binding ${bindingName} required must be a boolean`);
    }
    const value = resolveSource(descriptor, environment, `binding ${bindingName}`);
    if (value === undefined || value === "") {
      if (descriptor.required === false) continue;
      throw new RuntimeProfileError(`profile ${profileIdentity} is missing required binding: ${bindingName}`);
    }
    resolved[bindingName] = parseBindingValue(value, descriptor.type, `binding ${bindingName}`);
  }
  return Object.freeze(resolved);
}

function resolveSecrets(definition, environment, profileIdentity) {
  const resolved = {};
  for (const [secretName, descriptor] of Object.entries(definition)) {
    requireKey(secretName, `secret name ${secretName}`);
    if (secretName === "toJSON") {
      throw new RuntimeProfileError("secret name toJSON is reserved");
    }
    requireRecord(descriptor, `secret ${secretName}`);
    requireOnlyKeys(descriptor, secretDescriptorKeys, `secret ${secretName}`);
    if (typeof descriptor.environment !== "string" || descriptor.environment.length === 0) {
      throw new RuntimeProfileError(`secret ${secretName} environment must be a non-empty string`);
    }
    if (descriptor.required !== undefined && typeof descriptor.required !== "boolean") {
      throw new RuntimeProfileError(`secret ${secretName} required must be a boolean`);
    }
    const value = resolveEnvironmentValue(environment, descriptor.environment);
    if (value === undefined || value === "") {
      if (descriptor.required === false) continue;
      throw new RuntimeProfileError(`profile ${profileIdentity} is missing required secret: ${secretName}`);
    }
    if (typeof value !== "string") {
      throw new RuntimeProfileError(`secret ${secretName} must resolve to a string`);
    }
    resolved[secretName] = value;
  }
  Object.defineProperty(resolved, "toJSON", {
    value: () => "[REDACTED]",
    enumerable: false,
  });
  return Object.freeze(resolved);
}

export const runtimeProfileDefinitions = Object.freeze({
  local: Object.freeze({
    bindings: Object.freeze({
      workspaceRoot: Object.freeze({ type: "string", value: ".work/local" }),
    }),
    secrets: Object.freeze({}),
  }),
  test: Object.freeze({
    bindings: Object.freeze({
      workspaceRoot: Object.freeze({ type: "string", value: ".work/test" }),
    }),
    secrets: Object.freeze({}),
  }),
  production: Object.freeze({
    bindings: Object.freeze({
      workspaceRoot: Object.freeze({ type: "string", environment: "ORCHESTRATOR_WORKSPACE_ROOT" }),
    }),
    secrets: Object.freeze({}),
  }),
});

export function loadRuntimeProfile(identity, options = {}) {
  requireIdentity(identity, "profile identity");
  const definitions = options.definitions ?? runtimeProfileDefinitions;
  const environment = options.environment ?? process.env;
  requireRecord(definitions, "profile definitions");
  requireRecord(environment, "environment");

  const definition = definitions[identity];
  if (definition === undefined) {
    throw new RuntimeProfileError(`unknown runtime profile: ${identity}`);
  }
  requireRecord(definition, `profile ${identity}`);
  const bindings = definition.bindings ?? {};
  const secrets = definition.secrets ?? {};
  requireRecord(bindings, `profile ${identity} bindings`);
  requireRecord(secrets, `profile ${identity} secrets`);

  return Object.freeze({
    identity,
    bindings: resolveBindings(bindings, environment, identity),
    secrets: resolveSecrets(secrets, environment, identity),
  });
}
