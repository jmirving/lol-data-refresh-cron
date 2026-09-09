import test from "node:test";
import assert from "node:assert/strict";

import {
  JobGraphError,
  JobStatus,
  ResultReason,
  daily,
  defineJob,
  eligibilityPolicy,
  everyInvocation,
  exitCodeForSummary,
  formatRunSummary,
  resolveExecutionOrder,
  runAndReport,
  runJobs,
  runProcess,
  selectedMonthDays,
  selectedWeekdays,
} from "../src/index.js";

const fixedDate = new Date("2026-09-09T12:00:00.000Z");
const fixedOptions = {
  clock: { now: () => new Date(fixedDate) },
  runId: "run-1",
  scheduledAt: new Date(fixedDate),
};

function job(id, options = {}) {
  return defineJob({
    id,
    dependencies: options.dependencies,
    enabled: options.enabled,
    eligibility: options.eligibility,
    timeoutMs: options.timeoutMs,
    execute: options.execute ?? (async () => ({ status: JobStatus.SUCCESS })),
  });
}

function statuses(summary) {
  return Object.fromEntries(summary.results.map((result) => [result.jobId, result.status]));
}

test("arbitrary job lists execute without scheduler changes", async () => {
  const jobs = [job("E"), job("C"), job("A"), job("D"), job("B")];
  const summary = await runJobs(jobs, fixedOptions);

  assert.deepEqual(summary.results.map((result) => result.jobId), ["A", "B", "C", "D", "E"]);
  assert.deepEqual(summary.counts, {
    SUCCESS: 5,
    SKIPPED: 0,
    FAILED: 0,
    SKIPPED_DEPENDENCY_FAILED: 0,
  });
});

test("dependencies execute first regardless of declaration order", async () => {
  const observed = [];
  const jobs = [
    job("C", { dependencies: ["B"], execute: async () => (observed.push("C"), { status: JobStatus.SUCCESS }) }),
    job("B", { dependencies: ["A"], execute: async () => (observed.push("B"), { status: JobStatus.SUCCESS }) }),
    job("A", { execute: async () => (observed.push("A"), { status: JobStatus.SUCCESS }) }),
  ];

  await runJobs(jobs, fixedOptions);
  assert.deepEqual(observed, ["A", "B", "C"]);
});

test("independent branches both complete", async () => {
  const summary = await runJobs([
    job("D", { dependencies: ["C"] }),
    job("B", { dependencies: ["A"] }),
    job("C"),
    job("A"),
  ], fixedOptions);

  assert.deepEqual(statuses(summary), { A: "SUCCESS", B: "SUCCESS", C: "SUCCESS", D: "SUCCESS" });
});

test("all-skipped runs are successful", async () => {
  const summary = await runJobs([
    job("A", { execute: async () => ({ status: JobStatus.SKIPPED, reason: "nothing changed" }) }),
    job("B", { eligibility: eligibilityPolicy("never", () => false) }),
  ], fixedOptions);

  assert.equal(summary.status, JobStatus.SUCCESS);
  assert.equal(exitCodeForSummary(summary), 0);
  assert.deepEqual(statuses(summary), { A: "SKIPPED", B: "SKIPPED" });
});

test("disabled jobs are explicit skips and are never invoked", async () => {
  let invoked = false;
  const summary = await runJobs([
    job("A", {
      enabled: false,
      execute: async () => {
        invoked = true;
        return { status: JobStatus.SUCCESS };
      },
    }),
  ], fixedOptions);

  assert.equal(invoked, false);
  assert.equal(summary.results[0].status, JobStatus.SKIPPED);
  assert.equal(summary.results[0].reasonCode, ResultReason.DISABLED);
});

test("one independent failure does not stop unrelated work", async () => {
  let unrelatedRan = false;
  const summary = await runJobs([
    job("A", { execute: async () => ({ status: JobStatus.FAILED, error: "synthetic failure" }) }),
    job("B", { execute: async () => {
      unrelatedRan = true;
      return { status: JobStatus.SUCCESS };
    } }),
  ], fixedOptions);

  assert.equal(unrelatedRan, true);
  assert.deepEqual(statuses(summary), { A: "FAILED", B: "SUCCESS" });
  assert.equal(exitCodeForSummary(summary), 1);
});

test("dependency failure blocks only transitive dependents", async () => {
  const invoked = [];
  const summary = await runJobs([
    job("C", { dependencies: ["B"], execute: async () => (invoked.push("C"), { status: JobStatus.SUCCESS }) }),
    job("D", { execute: async () => (invoked.push("D"), { status: JobStatus.SUCCESS }) }),
    job("B", { dependencies: ["A"], execute: async () => (invoked.push("B"), { status: JobStatus.SUCCESS }) }),
    job("A", { execute: async () => ({ status: JobStatus.FAILED, error: "boom" }) }),
  ], fixedOptions);

  assert.deepEqual(invoked, ["D"]);
  assert.deepEqual(statuses(summary), {
    A: "FAILED",
    B: "SKIPPED_DEPENDENCY_FAILED",
    C: "SKIPPED_DEPENDENCY_FAILED",
    D: "SUCCESS",
  });
  assert.equal(summary.results.find((result) => result.jobId === "B").reasonCode, ResultReason.DEPENDENCY_FAILED);
});

test("a normally skipped dependency does not block its dependent", async () => {
  const summary = await runJobs([
    job("B", { dependencies: ["A"] }),
    job("A", { execute: async () => ({ status: JobStatus.SKIPPED, reason: "up to date" }) }),
  ], fixedOptions);

  assert.deepEqual(statuses(summary), { A: "SKIPPED", B: "SUCCESS" });
});

test("fan-out executes each dependent after its prerequisite", async () => {
  const order = [];
  const makeObserved = (id, dependencies = []) => job(id, {
    dependencies,
    execute: async () => (order.push(id), { status: JobStatus.SUCCESS }),
  });

  await runJobs([
    makeObserved("C", ["A"]),
    makeObserved("B", ["A"]),
    makeObserved("A"),
  ], fixedOptions);

  assert.deepEqual(order, ["A", "B", "C"]);
});

test("fan-in waits for every prerequisite and exposes their results", async () => {
  let receivedDependencies;
  const summary = await runJobs([
    job("D", {
      dependencies: ["B", "C"],
      execute: async ({ dependencies }) => {
        receivedDependencies = dependencies;
        return { status: JobStatus.SUCCESS };
      },
    }),
    job("C", { dependencies: ["A"] }),
    job("B", { dependencies: ["A"] }),
    job("A"),
  ], fixedOptions);

  assert.equal(receivedDependencies.B.status, JobStatus.SUCCESS);
  assert.equal(receivedDependencies.C.status, JobStatus.SUCCESS);
  assert.deepEqual(summary.results.map((result) => result.jobId), ["A", "B", "C", "D"]);
});

test("summary formatting is deterministic across declaration order", async () => {
  const first = await runJobs([job("C"), job("A"), job("B")], fixedOptions);
  const second = await runJobs([job("B"), job("C"), job("A")], fixedOptions);

  assert.equal(formatRunSummary(first), formatRunSummary(second));
  assert.equal(formatRunSummary(first), [
    "run run-1: SUCCESS",
    "A: SUCCESS",
    "B: SUCCESS",
    "C: SUCCESS",
    "counts: SUCCESS=3 SKIPPED=0 SKIPPED_DEPENDENCY_FAILED=0 FAILED=0",
  ].join("\n"));
});

test("runAndReport returns the final exit code and emits one summary", async () => {
  const messages = [];
  const { exitCode } = await runAndReport([
    job("A", { execute: async () => ({ status: JobStatus.FAILED, error: "failed" }) }),
    job("B"),
  ], { ...fixedOptions, output: { log: (message) => messages.push(message) } });

  assert.equal(exitCode, 1);
  assert.equal(messages.length, 1);
  assert.match(messages[0], /A: FAILED \(failed\)/);
  assert.match(messages[0], /B: SUCCESS/);
});

test("process boundary sets zero for skips and non-zero for actual failures", async () => {
  const output = { log() {}, error() {} };
  const successfulProcess = {};
  const failedProcess = {};

  await runProcess([
    job("A", { execute: async () => ({ status: JobStatus.SKIPPED }) }),
  ], { ...fixedOptions, output, processLike: successfulProcess });
  await runProcess([
    job("A", { execute: async () => ({ status: JobStatus.FAILED, error: "failed" }) }),
  ], { ...fixedOptions, output, processLike: failedProcess });

  assert.equal(successfulProcess.exitCode, 0);
  assert.equal(failedProcess.exitCode, 1);
});

test("graph validation errors set a non-zero process exit without invoking jobs", async () => {
  let invoked = false;
  const processLike = {};
  const errors = [];

  const summary = await runProcess([
    job("A", { dependencies: ["B"], execute: async () => {
      invoked = true;
      return { status: JobStatus.SUCCESS };
    } }),
  ], {
    ...fixedOptions,
    processLike,
    output: { log() {}, error: (message) => errors.push(message) },
  });

  assert.equal(summary, undefined);
  assert.equal(invoked, false);
  assert.equal(processLike.exitCode, 1);
  assert.deepEqual(errors, ["job A has unknown dependency: B"]);
});

test("graph validation rejects duplicates, missing dependencies, and cycles before execution", async () => {
  let invoked = false;
  const executable = { execute: async () => {
    invoked = true;
    return { status: JobStatus.SUCCESS };
  } };

  assert.throws(() => resolveExecutionOrder([job("A"), job("A")]), /duplicate job ID: A/);
  assert.throws(() => resolveExecutionOrder([job("A", { dependencies: ["Z"] })]), /unknown dependency: Z/);
  await assert.rejects(
    runJobs([
      job("A", { ...executable, dependencies: ["B"] }),
      job("B", { ...executable, dependencies: ["A"] }),
    ], fixedOptions),
    JobGraphError,
  );
  assert.equal(invoked, false);
});

test("cadence policies use injected UTC schedule context without domain assumptions", async () => {
  const wednesday = new Date("2026-09-09T23:00:00.000Z");
  const thursday = new Date("2026-09-10T01:00:00.000Z");
  const policies = [everyInvocation(), daily(), selectedWeekdays([3]), selectedMonthDays([9])];

  for (const eligibility of policies) {
    const summary = await runJobs([job("A", { eligibility })], { ...fixedOptions, scheduledAt: wednesday });
    assert.equal(summary.results[0].status, JobStatus.SUCCESS);
  }

  const summary = await runJobs([
    job("A", { eligibility: selectedWeekdays([3]) }),
    job("B", { eligibility: selectedMonthDays([9]) }),
  ], { ...fixedOptions, scheduledAt: thursday });
  assert.deepEqual(statuses(summary), { A: "SKIPPED", B: "SKIPPED" });
});

test("job result metadata is preserved", async () => {
  const metadata = { artifacts: ["artifact-1"], checksum: "abc123", metrics: { rows: 12 } };
  const summary = await runJobs([
    job("A", { execute: async () => ({ status: JobStatus.SUCCESS, metadata }) }),
  ], fixedOptions);

  assert.deepEqual(summary.results[0].metadata, metadata);
  assert.equal(summary.results[0].startedAt, fixedDate.toISOString());
  assert.equal(summary.results[0].durationMs, 0);
});

test("generic run metadata is exposed to jobs and the final summary", async () => {
  let receivedMetadata;
  const runMetadata = { profile: "test" };
  const summary = await runJobs([
    job("A", { execute: async (context) => {
      receivedMetadata = context.runMetadata;
      return { status: JobStatus.SUCCESS };
    } }),
  ], { ...fixedOptions, runMetadata });

  assert.deepEqual(receivedMetadata, runMetadata);
  assert.equal(receivedMetadata, summary.runMetadata);
  assert.equal(Object.isFrozen(summary.runMetadata), true);
});

test("thrown errors and invalid worker results are actual failures", async () => {
  const summary = await runJobs([
    job("A", { execute: async () => { throw new Error("synthetic exception"); } }),
    job("B", { execute: async () => undefined }),
  ], fixedOptions);

  assert.deepEqual(statuses(summary), { A: "FAILED", B: "FAILED" });
  assert.equal(summary.results[0].reasonCode, ResultReason.EXECUTION_ERROR);
  assert.equal(summary.results[1].reasonCode, ResultReason.INVALID_RESULT);
});

test("job timeouts become failures and abort cooperative adapters", async () => {
  let aborted = false;
  const summary = await runJobs([
    job("A", {
      timeoutMs: 5,
      execute: ({ signal }) => new Promise(() => {
        signal.addEventListener("abort", () => { aborted = true; });
      }),
    }),
  ], fixedOptions);

  assert.equal(aborted, true);
  assert.equal(summary.results[0].status, JobStatus.FAILED);
  assert.equal(summary.results[0].reasonCode, ResultReason.TIMEOUT);
});
