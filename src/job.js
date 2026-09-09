import { everyInvocation } from "./cadence.js";

export function defineJob(definition) {
  if (!definition || typeof definition !== "object") {
    throw new TypeError("job definition must be an object");
  }

  const {
    id,
    enabled = true,
    dependencies = [],
    eligibility = everyInvocation(),
    timeoutMs,
    execute,
  } = definition;

  if (typeof id !== "string" || id.length === 0) {
    throw new TypeError("job id must be a non-empty string");
  }
  if (typeof enabled !== "boolean") {
    throw new TypeError(`job ${id} enabled must be a boolean`);
  }
  if (!Array.isArray(dependencies) || dependencies.some((value) => typeof value !== "string" || value.length === 0)) {
    throw new TypeError(`job ${id} dependencies must be an array of non-empty strings`);
  }
  if (new Set(dependencies).size !== dependencies.length) {
    throw new TypeError(`job ${id} has duplicate dependency IDs`);
  }
  if (!eligibility || typeof eligibility.evaluate !== "function") {
    throw new TypeError(`job ${id} eligibility must expose evaluate(context)`);
  }
  if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
    throw new TypeError(`job ${id} timeoutMs must be a positive number`);
  }
  if (typeof execute !== "function") {
    throw new TypeError(`job ${id} execute must be a function`);
  }

  return Object.freeze({
    id,
    enabled,
    dependencies: Object.freeze([...dependencies]),
    eligibility,
    timeoutMs,
    execute,
  });
}
