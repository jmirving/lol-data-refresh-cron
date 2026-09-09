import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { createCommandAdapter } from "../src/command-adapter.js";
import { JobStatus } from "../src/result.js";

export const CHECK_GROUPS = Object.freeze([
  "plainCli",
  "structuredOutput",
  "failureMapping",
  "streams",
  "timeoutTermination",
  "idempotencyPathHandling",
]);

const SAFE_ENVIRONMENT = Object.freeze({
  CI: "true",
  DATABASE_URL: null,
  GOOGLE_APPLICATION_CREDENTIALS: null,
  GITHUB_TOKEN: null,
  GH_TOKEN: null,
  RENDER_API_KEY: null,
});

function context(jobId) {
  return Object.freeze({
    runId: "external-worker-conformance",
    runMetadata: Object.freeze({ profile: "test" }),
    scheduledAt: new Date("2026-09-09T12:00:00.000Z"),
    jobId,
    dependencies: Object.freeze({}),
  });
}

export async function invokeThroughCommandAdapter(configuration, jobId) {
  return createCommandAdapter({
    ...configuration,
    env: { ...SAFE_ENVIRONMENT, ...(configuration.env ?? {}) },
  })(context(jobId));
}

function failureMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

export async function runConfiguredCases(cases, options) {
  const outcomes = [];
  for (const testCase of cases) {
    if (testCase.violation) {
      outcomes.push({
        id: testCase.id,
        groups: [...testCase.groups],
        passed: false,
        violation: testCase.violation,
      });
      continue;
    }

    let result;
    try {
      result = await invokeThroughCommandAdapter({
        cwd: options.checkout,
        ...testCase.adapter,
      }, `${options.workerId}-${testCase.id}`);
      await testCase.assert(result);
      outcomes.push({
        id: testCase.id,
        groups: [...testCase.groups],
        passed: true,
        result,
      });
    } catch (error) {
      outcomes.push({
        id: testCase.id,
        groups: [...testCase.groups],
        passed: false,
        violation: failureMessage(error),
        result,
      });
    }
  }
  return outcomes;
}

async function pathExists(path) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function requireSuccess(configuration, jobId, description) {
  const result = await invokeThroughCommandAdapter(configuration, jobId);
  if (result.status !== JobStatus.SUCCESS) {
    const detail = result.metadata?.stderr?.trim() || result.error || result.reasonCode;
    throw new Error(`${description} failed: ${detail}`);
  }
  return result;
}

async function prepareCheckout(worker, checkoutRoot) {
  const checkout = resolve(checkoutRoot, worker.id);
  if (!await pathExists(checkout)) {
    await mkdir(checkoutRoot, { recursive: true });
    await requireSuccess({
      command: "git",
      arguments: ["clone", "--no-checkout", worker.repository, checkout],
    }, `${worker.id}-clone`, `clone ${worker.id}`);
    await requireSuccess({
      command: "git",
      arguments: ["-C", checkout, "fetch", "--depth=1", "origin", worker.revision],
    }, `${worker.id}-fetch`, `fetch ${worker.id} revision ${worker.revision}`);
    await requireSuccess({
      command: "git",
      arguments: ["-C", checkout, "checkout", "--detach", worker.revision],
    }, `${worker.id}-checkout`, `checkout ${worker.id} revision ${worker.revision}`);
  }

  const revision = await requireSuccess({
    command: "git",
    arguments: ["-C", checkout, "rev-parse", "HEAD"],
  }, `${worker.id}-revision`, `read ${worker.id} revision`);
  const actualRevision = revision.metadata.stdout.trim();
  if (actualRevision !== worker.revision) {
    throw new Error(`${worker.id} checkout revision is ${actualRevision}; expected ${worker.revision}`);
  }
  return checkout;
}

function summarizeGroups(outcomes) {
  return Object.fromEntries(CHECK_GROUPS.map((group) => {
    const relevant = outcomes.filter((outcome) => outcome.groups.includes(group));
    return [group, relevant.length > 0 && relevant.every((outcome) => outcome.passed)];
  }));
}

export async function runWorkerConformance(worker, options = {}) {
  let workspace;
  let fixture;
  try {
    const checkoutRoot = resolve(options.checkoutRoot ?? join(process.cwd(), ".work/conformance/checkouts"));
    const checkout = await prepareCheckout(worker, checkoutRoot);
    const build = worker.build(checkout);
    await requireSuccess({ cwd: checkout, ...build }, `${worker.id}-build`, `build ${worker.id}`);

    const workspaceParent = resolve(options.workspaceRoot ?? tmpdir());
    await mkdir(workspaceParent, { recursive: true });
    workspace = await mkdtemp(join(workspaceParent, `${worker.id}-`));
    fixture = await worker.prepare({ checkout, workspace });
    const cases = worker.cases({ checkout, workspace, fixture });
    const outcomes = await runConfiguredCases(cases, { checkout, workerId: worker.id });
    const checks = summarizeGroups(outcomes);
    return {
      worker: worker.name,
      id: worker.id,
      repository: worker.repository,
      revision: worker.revision,
      checks,
      overall: Object.values(checks).every(Boolean) ? "PASS" : "FAIL",
      outcomes,
    };
  } catch (error) {
    const violation = failureMessage(error);
    return {
      worker: worker.name,
      id: worker.id,
      repository: worker.repository,
      revision: worker.revision,
      checks: Object.fromEntries(CHECK_GROUPS.map((group) => [group, false])),
      overall: "FAIL",
      outcomes: [{ id: "setup", groups: [...CHECK_GROUPS], passed: false, violation }],
    };
  } finally {
    await fixture?.cleanup?.();
    if (workspace && !options.keepWorkspaces) {
      await rm(workspace, { recursive: true, force: true });
    }
  }
}

export async function runConformance(workers, options = {}) {
  const reports = [];
  for (const worker of workers) reports.push(await runWorkerConformance(worker, options));
  return reports;
}

function mark(value) {
  return value ? "PASS" : "FAIL";
}

export function formatConformanceReport(reports) {
  const headings = [
    "worker", "revision", "plain CLI", "structured output", "failure mapping",
    "stdout/stderr", "timeout/termination", "idempotency/paths", "overall",
  ];
  const rows = reports.map((report) => [
    report.worker,
    report.revision.slice(0, 12),
    mark(report.checks.plainCli),
    mark(report.checks.structuredOutput),
    mark(report.checks.failureMapping),
    mark(report.checks.streams),
    mark(report.checks.timeoutTermination),
    mark(report.checks.idempotencyPathHandling),
    report.overall,
  ]);
  const widths = headings.map((heading, index) => Math.max(
    heading.length,
    ...rows.map((row) => row[index].length),
  ));
  const line = (row) => row.map((value, index) => value.padEnd(widths[index])).join(" | ");
  const output = [line(headings), line(widths.map((width) => "-".repeat(width))), ...rows.map(line)];

  const violations = reports.flatMap((report) => report.outcomes
    .filter((outcome) => !outcome.passed)
    .map((outcome) => `${report.worker} [${outcome.id}]: ${outcome.violation}`));
  if (violations.length > 0) output.push("", "Contract violations:", ...violations.map((item) => `- ${item}`));
  return output.join("\n");
}
