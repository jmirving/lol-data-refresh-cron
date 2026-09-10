import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { formatConformanceReport, runConfiguredCases } from "../conformance/harness.js";
import { workerDefinitions } from "../conformance/workers.js";

test("external worker definitions pin immutable commit revisions", () => {
  assert.equal(workerDefinitions.length, 4);
  for (const worker of workerDefinitions) {
    assert.match(worker.revision, /^[0-9a-f]{40}$/);
    assert.match(worker.repository, /^https:\/\/github\.com\/jmirving\/.+\.git$/);
    assert.doesNotMatch(worker.revision, /main|master/);
  }
});

test("Docker packaging uses the conformance-tested worker revisions", async () => {
  const dockerfile = await readFile(new URL("../Dockerfile", import.meta.url), "utf8");
  const argumentByWorker = {
    "oracle-downloader": "ORACLE_DOWNLOADER_REVISION",
    "oracle-processor": "ORACLE_PROCESSOR_REVISION",
    "ddragon-snapshot": "DDRAGON_SNAPSHOT_REVISION",
    "ddragon-artifact-builder": "DDRAGON_ARTIFACT_REVISION",
  };

  for (const worker of workerDefinitions) {
    const declaration = `ARG ${argumentByWorker[worker.id]}=${worker.revision}`;
    assert.equal(dockerfile.split(declaration).length - 1, 2,
      `${worker.id} pin must match in the build and runtime stages`);
  }
});

test("configured violations identify the exact contract case without an invocation", async () => {
  const outcomes = await runConfiguredCases([{
    id: "worker-defect",
    groups: ["plainCli"],
    violation: "fixture source cannot be configured",
  }], { checkout: process.cwd(), workerId: "synthetic" });

  assert.deepEqual(outcomes.map((outcome) => outcome.passed), [false]);
  assert.match(outcomes[0].violation, /cannot be configured/);
});

test("human-readable reports include pinned revisions and violations", () => {
  const report = formatConformanceReport([{
    worker: "Synthetic worker",
    revision: "0123456789abcdef",
    checks: {
      plainCli: true,
      structuredOutput: false,
      failureMapping: true,
      streams: true,
      timeoutTermination: true,
      idempotencyPathHandling: false,
    },
    overall: "FAIL",
    outcomes: [{ id: "structured", passed: false, violation: "invalid JSON" }],
  }]);

  assert.match(report, /Synthetic worker/);
  assert.match(report, /0123456789ab/);
  assert.match(report, /Synthetic worker \[structured\]: invalid JSON/);
});
