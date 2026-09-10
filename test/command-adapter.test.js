import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  JobStatus,
  ResultReason,
  createCommandAdapter,
  defineJob,
  runJobs,
} from "../src/index.js";

const fixture = fileURLToPath(new URL("./fixtures/command-fixture", import.meta.url));
const fixedDate = new Date("2026-09-09T12:00:00.000Z");
const runOptions = {
  clock: { now: () => new Date(fixedDate) },
  runId: "synthetic-run",
  scheduledAt: new Date(fixedDate),
};

function commandJob(configuration) {
  return defineJob({
    id: "A",
    execute: createCommandAdapter({
      command: process.execPath,
      ...configuration,
      env: { NODE_TEST_CONTEXT: null, ...(configuration.env ?? {}) },
    }),
  });
}

async function execute(configuration) {
  const summary = await runJobs([commandJob(configuration)], runOptions);
  return summary.results[0];
}

test("successful command maps to SUCCESS with process metadata", async () => {
  const result = await execute({ arguments: [fixture, "success"] });

  assert.equal(result.status, JobStatus.SUCCESS);
  assert.equal(result.metadata.command, process.execPath);
  assert.deepEqual(result.metadata.arguments, [fixture, "success"]);
  assert.equal(result.metadata.exitCode, 0);
  assert.equal(result.metadata.signal, null);
  assert.equal(result.metadata.timedOut, false);
  assert.equal(typeof result.metadata.durationMs, "number");
});

test("non-zero exit maps to FAILED and retains the exit code", async () => {
  const result = await execute({ arguments: [fixture, "exit", "23"] });

  assert.equal(result.status, JobStatus.FAILED);
  assert.equal(result.reasonCode, ResultReason.COMMAND_EXIT_NON_ZERO);
  assert.equal(result.error, "command exited with code 23");
  assert.equal(result.metadata.exitCode, 23);
});

test("stdout is captured exactly", async () => {
  const result = await execute({ arguments: [fixture, "streams", "stdout value", ""] });
  assert.equal(result.metadata.stdout, "stdout value");
});

test("stderr is captured exactly", async () => {
  const result = await execute({ arguments: [fixture, "streams", "", "stderr value"] });
  assert.equal(result.metadata.stderr, "stderr value");
});

test("arguments are passed without shell interpretation", async () => {
  const values = ["plain", "two words", "$NOT_EXPANDED", "\"quoted\""];
  const result = await execute({ arguments: [fixture, "arguments", ...values] });

  assert.deepEqual(JSON.parse(result.metadata.stdout), values);
});

test("explicit working directory is used", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "command-adapter-cwd-"));
  t.after(() => rm(directory, { recursive: true, force: true }));

  const result = await execute({ cwd: directory, arguments: [fixture, "cwd"] });

  assert.equal(await realpath(result.metadata.stdout), await realpath(directory));
  assert.equal(result.metadata.workingDirectory, directory);
});

test("parent environment is inherited", async (t) => {
  const name = "SYNTHETIC_ADAPTER_INHERITED";
  const previous = process.env[name];
  process.env[name] = "from-parent";
  t.after(() => {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  });

  const result = await execute({ arguments: [fixture, "env", name, "PATH"] });
  const environment = JSON.parse(result.metadata.stdout);

  assert.equal(environment[name], "from-parent");
  assert.equal(environment.PATH, process.env.PATH);
});

test("configured environment overrides parent values and can remove them", async (t) => {
  const overridden = "SYNTHETIC_ADAPTER_OVERRIDE";
  const removed = "SYNTHETIC_ADAPTER_REMOVE";
  const previousOverride = process.env[overridden];
  const previousRemove = process.env[removed];
  process.env[overridden] = "parent-value";
  process.env[removed] = "present";
  t.after(() => {
    if (previousOverride === undefined) delete process.env[overridden];
    else process.env[overridden] = previousOverride;
    if (previousRemove === undefined) delete process.env[removed];
    else process.env[removed] = previousRemove;
  });

  const result = await execute({
    env: { [overridden]: "configured-value", [removed]: null },
    arguments: [fixture, "env", overridden, removed, "ORCHESTRATOR_RUN_ID", "ORCHESTRATOR_JOB_ID"],
  });
  const environment = JSON.parse(result.metadata.stdout);

  assert.deepEqual(environment, {
    [overridden]: "configured-value",
    [removed]: null,
    ORCHESTRATOR_RUN_ID: "synthetic-run",
    ORCHESTRATOR_JOB_ID: "A",
  });
});

test("timeout maps to FAILED and captures partial process details", async () => {
  const result = await execute({
    arguments: [fixture, "wait", "5000"],
    timeoutMs: 20,
    killGraceMs: 20,
  });

  assert.equal(result.status, JobStatus.FAILED);
  assert.equal(result.reasonCode, ResultReason.TIMEOUT);
  assert.equal(result.metadata.timedOut, true);
  assert.equal(result.metadata.exitCode, null);
  assert.match(result.metadata.signal, /^SIG/);
  assert.ok(result.metadata.durationMs >= 20);
  assert.ok(result.metadata.durationMs < 1000);
});

test("timeout terminates descendants that ignore graceful termination", {
  skip: process.platform === "win32" ? "POSIX process-group assertion" : false,
}, async () => {
  const result = await execute({
    arguments: [fixture, "descendant"],
    timeoutMs: 40,
    killGraceMs: 30,
  });
  const descendantPid = Number(result.metadata.stdout.trim());

  assert.equal(result.status, JobStatus.FAILED);
  assert.equal(result.metadata.timedOut, true);
  assert.ok(Number.isInteger(descendantPid));
  assert.throws(() => process.kill(descendantPid, 0), (error) => error?.code === "ESRCH");
});

test("structured JSON controls generic result fields and contributes metadata", async () => {
  const payload = {
    status: JobStatus.SKIPPED,
    reasonCode: "NO_WORK",
    reason: "synthetic input is unchanged",
    metadata: { itemCount: 4, artifact: "synthetic.json" },
  };
  const result = await execute({
    arguments: [fixture, "structured", JSON.stringify(payload)],
    structuredOutput: "json",
  });

  assert.equal(result.status, JobStatus.SKIPPED);
  assert.equal(result.reasonCode, "NO_WORK");
  assert.equal(result.reason, "synthetic input is unchanged");
  assert.deepEqual(result.metadata.structured, payload.metadata);
  assert.equal(result.metadata.exitCode, 0);
});

test("malformed configured structured output fails predictably while preserving output", async () => {
  const result = await execute({
    arguments: [fixture, "structured", "{not-json"],
    structuredOutput: "json",
  });

  assert.equal(result.status, JobStatus.FAILED);
  assert.equal(result.reasonCode, ResultReason.INVALID_STRUCTURED_OUTPUT);
  assert.match(result.error, /structured stdout is not valid JSON/);
  assert.equal(result.metadata.stdout, "{not-json");
  assert.match(result.metadata.structuredOutputError, /structured stdout is not valid JSON/);
});

test("plain output is never parsed unless structured output is enabled", async () => {
  const result = await execute({ arguments: [fixture, "structured", "{not-json"] });
  assert.equal(result.status, JobStatus.SUCCESS);
  assert.equal(result.metadata.stdout, "{not-json");
});

test("the adapter maps identical process outcomes deterministically", async () => {
  const first = await execute({ arguments: [fixture, "streams", "same-output", "same-error"] });
  const second = await execute({ arguments: [fixture, "streams", "same-output", "same-error"] });
  const withoutDuration = (result) => ({
    status: result.status,
    reasonCode: result.reasonCode,
    reason: result.reason,
    error: result.error,
    metadata: { ...result.metadata, durationMs: 0 },
  });

  assert.deepEqual(withoutDuration(first), withoutDuration(second));
});

test("spawn failures map into the job result contract", async () => {
  const result = await runJobs([
    defineJob({
      id: "A",
      execute: createCommandAdapter({ command: "/definitely/not/a/synthetic/program" }),
    }),
  ], runOptions);

  assert.equal(result.results[0].status, JobStatus.FAILED);
  assert.equal(result.results[0].reasonCode, ResultReason.COMMAND_SPAWN_ERROR);
  assert.equal(result.results[0].metadata.exitCode, null);
});
