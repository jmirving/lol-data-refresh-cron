import { randomUUID } from "node:crypto";
import { resolveExecutionOrder } from "./graph.js";
import { JobStatus, ResultReason, errorSummary, workerStatuses } from "./result.js";
import { exitCodeForSummary, formatRunSummary } from "./summary.js";

const systemClock = { now: () => new Date() };

function timestamp(clock) {
  const value = clock.now();
  if (!(value instanceof Date) || Number.isNaN(value.valueOf())) {
    throw new TypeError("clock.now() must return a valid Date");
  }
  return value;
}

function finishResult(clock, base, details) {
  const endedAt = timestamp(clock);
  return Object.freeze({
    ...base,
    ...details,
    endedAt: endedAt.toISOString(),
    durationMs: Math.max(0, endedAt.valueOf() - new Date(base.startedAt).valueOf()),
  });
}

function skippedResult(clock, job, reasonCode, reason, status = JobStatus.SKIPPED) {
  const startedAt = timestamp(clock).toISOString();
  return finishResult(clock, { jobId: job.id, startedAt }, { status, reasonCode, reason });
}

function failedResult(clock, job, startedAt, reasonCode, error) {
  return finishResult(clock, { jobId: job.id, startedAt }, {
    status: JobStatus.FAILED,
    reasonCode,
    error: errorSummary(error),
  });
}

async function invoke(job, context) {
  if (job.timeoutMs === undefined) return job.execute(context);

  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      const error = new Error(`timed out after ${job.timeoutMs}ms`);
      error.code = ResultReason.TIMEOUT;
      reject(error);
    }, job.timeoutMs);
  });

  try {
    return await Promise.race([
      job.execute({ ...context, signal: controller.signal }),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function normalizeEligibility(value) {
  if (typeof value === "boolean") return { eligible: value };
  if (value && typeof value === "object" && typeof value.eligible === "boolean") return value;
  throw new TypeError("eligibility policy must return a boolean or { eligible, reason? }");
}

function normalizeWorkerResult(value) {
  if (!value || typeof value !== "object" || !workerStatuses.has(value.status)) {
    const error = new TypeError("execute must return a result with status SUCCESS, SKIPPED, or FAILED");
    error.code = ResultReason.INVALID_RESULT;
    throw error;
  }
  return value;
}

export async function runJobs(jobs, options = {}) {
  const order = resolveExecutionOrder(jobs);
  const clock = options.clock ?? systemClock;
  const runId = options.runId ?? randomUUID();
  const scheduledAt = options.scheduledAt ?? timestamp(clock);
  if (!(scheduledAt instanceof Date) || Number.isNaN(scheduledAt.valueOf())) {
    throw new TypeError("scheduledAt must be a valid Date");
  }
  const runStartedAt = timestamp(clock);
  const runMetadata = Object.freeze({ ...(options.runMetadata ?? {}) });
  const results = [];
  const resultById = new Map();

  for (const job of order) {
    let result;
    if (!job.enabled) {
      result = skippedResult(clock, job, ResultReason.DISABLED, "job is disabled");
    } else {
      const blockedBy = job.dependencies.filter((dependencyId) => {
        const status = resultById.get(dependencyId).status;
        return status === JobStatus.FAILED || status === JobStatus.SKIPPED_DEPENDENCY_FAILED;
      });

      if (blockedBy.length > 0) {
        result = skippedResult(
          clock,
          job,
          ResultReason.DEPENDENCY_FAILED,
          `blocked by failed dependencies: ${blockedBy.join(", ")}`,
          JobStatus.SKIPPED_DEPENDENCY_FAILED,
        );
      } else {
        const startedAt = timestamp(clock).toISOString();
        const context = Object.freeze({
          runId,
          runMetadata,
          scheduledAt: new Date(scheduledAt),
          jobId: job.id,
          dependencies: Object.freeze(Object.fromEntries(
            job.dependencies.map((id) => [id, resultById.get(id)]),
          )),
        });

        try {
          const eligibility = normalizeEligibility(await job.eligibility.evaluate(context));
          if (!eligibility.eligible) {
            result = finishResult(clock, { jobId: job.id, startedAt }, {
              status: JobStatus.SKIPPED,
              reasonCode: ResultReason.NOT_ELIGIBLE,
              reason: eligibility.reason ?? "job is not eligible for this invocation",
            });
          } else {
            const workerResult = normalizeWorkerResult(await invoke(job, context));
            result = finishResult(clock, { jobId: job.id, startedAt }, {
              status: workerResult.status,
              reasonCode: workerResult.reasonCode,
              reason: workerResult.reason,
              error: workerResult.error,
              metadata: workerResult.metadata,
            });
          }
        } catch (error) {
          result = failedResult(
            clock,
            job,
            startedAt,
            error?.code ?? ResultReason.EXECUTION_ERROR,
            error,
          );
        }
      }
    }

    results.push(result);
    resultById.set(job.id, result);
  }

  const endedAt = timestamp(clock);
  const counts = Object.fromEntries(Object.values(JobStatus).map((status) => [status, 0]));
  for (const result of results) counts[result.status] += 1;
  const summary = {
    runId,
    status: results.some((result) => result.status === JobStatus.FAILED)
      ? JobStatus.FAILED
      : JobStatus.SUCCESS,
    scheduledAt: scheduledAt.toISOString(),
    startedAt: runStartedAt.toISOString(),
    endedAt: endedAt.toISOString(),
    durationMs: Math.max(0, endedAt.valueOf() - runStartedAt.valueOf()),
    counts: Object.freeze(counts),
    results: Object.freeze(results),
    runMetadata,
  };
  return Object.freeze(summary);
}

export async function runAndReport(jobs, options = {}) {
  const summary = await runJobs(jobs, options);
  const output = options.output ?? console;
  output.log(formatRunSummary(summary));
  return { summary, exitCode: exitCodeForSummary(summary) };
}
