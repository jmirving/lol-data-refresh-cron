import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";
import { JobStatus, ResultReason, workerStatuses } from "./result.js";

const DEFAULT_KILL_GRACE_MS = 100;

function requireNonEmptyString(value, name) {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
}

function validateConfiguration(configuration) {
  if (!configuration || typeof configuration !== "object") {
    throw new TypeError("command adapter configuration must be an object");
  }

  requireNonEmptyString(configuration.command, "command");

  const args = configuration.arguments ?? [];
  if (!Array.isArray(args) || args.some((argument) => typeof argument !== "string")) {
    throw new TypeError("arguments must be an array of strings");
  }
  if (configuration.cwd !== undefined) {
    requireNonEmptyString(configuration.cwd, "cwd");
  }
  if (configuration.env !== undefined) {
    if (!configuration.env || typeof configuration.env !== "object" || Array.isArray(configuration.env)) {
      throw new TypeError("env must be an object");
    }
    for (const [name, value] of Object.entries(configuration.env)) {
      requireNonEmptyString(name, "environment variable name");
      if (typeof value !== "string" && value !== null) {
        throw new TypeError(`environment override ${name} must be a string or null`);
      }
    }
  }
  if (configuration.timeoutMs !== undefined
    && (!Number.isFinite(configuration.timeoutMs) || configuration.timeoutMs <= 0)) {
    throw new TypeError("timeoutMs must be a positive number");
  }
  if (configuration.killGraceMs !== undefined
    && (!Number.isFinite(configuration.killGraceMs) || configuration.killGraceMs < 0)) {
    throw new TypeError("killGraceMs must be a non-negative number");
  }
  if (configuration.structuredOutput !== undefined && configuration.structuredOutput !== "json") {
    throw new TypeError('structuredOutput must be "json" when configured');
  }
}

function buildEnvironment(overrides, context) {
  const environment = {
    ...process.env,
    ORCHESTRATOR_RUN_ID: context.runId,
    ORCHESTRATOR_JOB_ID: context.jobId,
  };

  for (const [name, value] of Object.entries(overrides ?? {})) {
    if (value === null) delete environment[name];
    else environment[name] = value;
  }
  return environment;
}

function signalProcessTree(child, signal) {
  if (child.pid === undefined) return;

  try {
    if (process.platform === "win32") child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

function parseStructuredResult(stdout) {
  let payload;
  try {
    payload = JSON.parse(stdout);
  } catch (error) {
    throw new TypeError(`structured stdout is not valid JSON: ${error.message}`);
  }

  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new TypeError("structured stdout must be a JSON object");
  }
  if (payload.status !== undefined && !workerStatuses.has(payload.status)) {
    throw new TypeError("structured status must be SUCCESS, SKIPPED, or FAILED");
  }
  if (payload.reason !== undefined && typeof payload.reason !== "string") {
    throw new TypeError("structured reason must be a string");
  }
  if (payload.error !== undefined && typeof payload.error !== "string") {
    throw new TypeError("structured error must be a string");
  }
  if (payload.reasonCode !== undefined && typeof payload.reasonCode !== "string") {
    throw new TypeError("structured reasonCode must be a string");
  }
  if (payload.metadata !== undefined
    && (!payload.metadata || typeof payload.metadata !== "object" || Array.isArray(payload.metadata))) {
    throw new TypeError("structured metadata must be a JSON object");
  }
  return payload;
}

function processMetadata(configuration, outcome) {
  return {
    command: configuration.command,
    arguments: [...(configuration.arguments ?? [])],
    workingDirectory: configuration.cwd ?? process.cwd(),
    exitCode: outcome.exitCode,
    signal: outcome.signal,
    stdout: outcome.stdout,
    stderr: outcome.stderr,
    timedOut: outcome.timedOut,
    durationMs: outcome.durationMs,
  };
}

function mapOutcome(configuration, outcome) {
  const metadata = processMetadata(configuration, outcome);
  let structured;
  let structuredError;

  if (configuration.structuredOutput === "json") {
    try {
      structured = parseStructuredResult(outcome.stdout);
      if (structured.metadata !== undefined) metadata.structured = structured.metadata;
    } catch (error) {
      structuredError = error;
      metadata.structuredOutputError = error.message;
    }
  }

  if (outcome.timedOut) {
    return {
      status: JobStatus.FAILED,
      reasonCode: ResultReason.TIMEOUT,
      error: configuration.timeoutMs === undefined
        ? "command execution was aborted"
        : `command timed out after ${configuration.timeoutMs}ms`,
      metadata,
    };
  }
  if (outcome.spawnError) {
    return {
      status: JobStatus.FAILED,
      reasonCode: ResultReason.COMMAND_SPAWN_ERROR,
      error: outcome.spawnError.message,
      metadata,
    };
  }
  if (outcome.exitCode !== 0) {
    return {
      status: JobStatus.FAILED,
      reasonCode: ResultReason.COMMAND_EXIT_NON_ZERO,
      error: `command exited with code ${outcome.exitCode}`,
      metadata,
    };
  }
  if (structuredError) {
    return {
      status: JobStatus.FAILED,
      reasonCode: ResultReason.INVALID_STRUCTURED_OUTPUT,
      error: structuredError.message,
      metadata,
    };
  }

  return {
    status: structured?.status ?? JobStatus.SUCCESS,
    reasonCode: structured?.reasonCode,
    reason: structured?.reason,
    error: structured?.error,
    metadata,
  };
}

function executeCommand(configuration, context) {
  const startedAt = performance.now();
  const args = configuration.arguments ?? [];
  const killGraceMs = configuration.killGraceMs ?? DEFAULT_KILL_GRACE_MS;

  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(configuration.command, args, {
        cwd: configuration.cwd,
        env: buildEnvironment(configuration.env, context),
        shell: false,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (spawnError) {
      resolve(mapOutcome(configuration, {
        exitCode: null,
        signal: null,
        stdout: "",
        stderr: "",
        timedOut: false,
        spawnError,
        durationMs: Math.round(performance.now() - startedAt),
      }));
      return;
    }

    const stdout = [];
    const stderr = [];
    let spawnError;
    let timedOut = false;
    let closed = false;
    let closeOutcome;
    let terminationGraceElapsed = false;
    let timeoutHandle;
    let forceKillHandle;

    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", (error) => { spawnError = error; });

    const cleanup = () => {
      clearTimeout(timeoutHandle);
      clearTimeout(forceKillHandle);
      context.signal?.removeEventListener("abort", terminate);
    };

    const finish = () => {
      if (closed || closeOutcome === undefined) return;
      closed = true;
      cleanup();
      resolve(mapOutcome(configuration, {
        ...closeOutcome,
        exitCode: spawnError ? null : closeOutcome.exitCode,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        timedOut,
        spawnError,
        durationMs: Math.round(performance.now() - startedAt),
      }));
    };

    function terminate() {
      if (timedOut || closed) return;
      timedOut = true;
      signalProcessTree(child, "SIGTERM");
      forceKillHandle = setTimeout(() => {
        terminationGraceElapsed = true;
        signalProcessTree(child, "SIGKILL");
        finish();
      }, killGraceMs);
    }

    child.once("close", (exitCode, signal) => {
      closeOutcome = { exitCode, signal };
      if (!timedOut || terminationGraceElapsed) finish();
    });

    if (configuration.timeoutMs !== undefined) {
      timeoutHandle = setTimeout(terminate, configuration.timeoutMs);
    }
    if (context.signal) {
      if (context.signal.aborted) terminate();
      else context.signal.addEventListener("abort", terminate, { once: true });
    }
  });
}

export function createCommandAdapter(configuration) {
  validateConfiguration(configuration);
  const immutableConfiguration = Object.freeze({
    ...configuration,
    arguments: Object.freeze([...(configuration.arguments ?? [])]),
    env: configuration.env === undefined ? undefined : Object.freeze({ ...configuration.env }),
  });

  return (context) => executeCommand(immutableConfiguration, context);
}
