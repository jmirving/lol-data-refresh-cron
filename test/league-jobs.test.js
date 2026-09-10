import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { JobStatus, LeagueJobId, createJobs, resolveExecutionOrder, runJobs } from "../src/index.js";

const fixture = resolve(dirname(fileURLToPath(import.meta.url)), "fixtures/league-worker-fixture.js");

function fixtureExecutables() {
  return Object.fromEntries(Object.values(LeagueJobId).map((id) => [id, {
    command: process.execPath,
    arguments: [fixture, id],
    env: { NODE_TEST_CONTEXT: null },
  }]));
}

test("initial League graph declares only the two worker handoff dependencies", () => {
  const jobs = createJobs({ bindings: { workspaceRoot: ".work/test" } }, {
    executables: fixtureExecutables(),
  });
  assert.deepEqual(jobs.map(({ id, dependencies }) => ({ id, dependencies })), [
    { id: LeagueJobId.DDRAGON_SNAPSHOT, dependencies: [] },
    { id: LeagueJobId.DDRAGON_ARTIFACT, dependencies: [LeagueJobId.DDRAGON_SNAPSHOT] },
    { id: LeagueJobId.ORACLE_DOWNLOAD, dependencies: [] },
    { id: LeagueJobId.ORACLE_PROCESSOR, dependencies: [LeagueJobId.ORACLE_DOWNLOAD] },
  ]);
  assert.deepEqual(resolveExecutionOrder([...jobs].reverse()).map((job) => job.id), [
    LeagueJobId.DDRAGON_SNAPSHOT,
    LeagueJobId.DDRAGON_ARTIFACT,
    LeagueJobId.ORACLE_DOWNLOAD,
    LeagueJobId.ORACLE_PROCESSOR,
  ]);
});

test("all four configured workers execute through shared run-scoped ephemeral paths", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "league-job-graph-"));
  try {
    const runId = "local-container-fixture";
    const summary = await runJobs(createJobs({ bindings: { workspaceRoot } }, {
      executables: fixtureExecutables(),
      timeoutMs: 5_000,
    }), { runId });

    assert.equal(summary.status, JobStatus.SUCCESS);
    assert.deepEqual(summary.results.map((result) => [result.jobId, result.status]), [
      [LeagueJobId.DDRAGON_SNAPSHOT, JobStatus.SUCCESS],
      [LeagueJobId.DDRAGON_ARTIFACT, JobStatus.SUCCESS],
      [LeagueJobId.ORACLE_DOWNLOAD, JobStatus.SUCCESS],
      [LeagueJobId.ORACLE_PROCESSOR, JobStatus.SUCCESS],
    ]);

    const root = resolve(workspaceRoot, "runs", runId);
    assert.equal(
      await readFile(resolve(root, "ddragon/artifacts/champion-mapping.json"), "utf8"),
      "99.1.0-fixture\n",
    );
    assert.equal(
      await readFile(resolve(root, "oracle/processed/all/all_local-container-fixture.csv"), "utf8"),
      "gameid,year\n1,2026\n",
    );
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});
