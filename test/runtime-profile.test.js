import test from "node:test";
import assert from "node:assert/strict";

import { runCli, selectProfileIdentity } from "../src/cli.js";
import {
  JobStatus,
  RuntimeProfileError,
  defineJob,
  formatRunSummary,
  loadRuntimeProfile,
  runJobs,
} from "../src/index.js";

const fixedOptions = {
  clock: { now: () => new Date("2026-09-09T12:00:00.000Z") },
  runId: "profile-run",
  scheduledAt: new Date("2026-09-09T12:00:00.000Z"),
};

test("built-in local, test, and production profiles construct valid bindings", () => {
  assert.deepEqual(loadRuntimeProfile("local", { environment: {} }).bindings, {
    workspaceRoot: ".work/local",
  });
  assert.deepEqual(loadRuntimeProfile("test", { environment: {} }).bindings, {
    workspaceRoot: ".work/test",
  });
  assert.deepEqual(loadRuntimeProfile("production", {
    environment: { ORCHESTRATOR_WORKSPACE_ROOT: "/var/lib/lol-refresh" },
  }).bindings, { workspaceRoot: "/var/lib/lol-refresh" });
});

test("unknown profiles fail before configuration is constructed", () => {
  assert.throws(
    () => loadRuntimeProfile("staging", { environment: {} }),
    (error) => error instanceof RuntimeProfileError && error.message === "unknown runtime profile: staging",
  );
});

test("missing required bindings fail with profile and binding identity", () => {
  assert.throws(
    () => loadRuntimeProfile("production", { environment: {} }),
    /profile production is missing required binding: workspaceRoot/,
  );
});

test("binding types are parsed and malformed values fail validation", () => {
  const definitions = {
    test: {
      bindings: {
        publishEnabled: { type: "boolean", environment: "PUBLISH_ENABLED" },
        retries: { type: "integer", value: 3 },
        branches: { type: "string-array", value: ["main", "backup"] },
      },
    },
  };
  const profile = loadRuntimeProfile("test", {
    definitions,
    environment: { PUBLISH_ENABLED: "false" },
  });

  assert.deepEqual(profile.bindings, {
    publishEnabled: false,
    retries: 3,
    branches: ["main", "backup"],
  });
  assert.throws(
    () => loadRuntimeProfile("test", {
      definitions,
      environment: { PUBLISH_ENABLED: "sometimes" },
    }),
    /binding publishEnabled must be true or false/,
  );
});

test("secrets resolve only from environment and are redacted from serialization and summaries", async () => {
  const secretValue = "not-for-output";
  const profile = loadRuntimeProfile("test", {
    definitions: {
      test: {
        bindings: {},
        secrets: { publicationToken: { environment: "PUBLICATION_TOKEN" } },
      },
    },
    environment: { PUBLICATION_TOKEN: secretValue },
  });
  const summary = await runJobs([], {
    ...fixedOptions,
    runMetadata: { profile: profile.identity },
  });

  assert.equal(profile.secrets.publicationToken, secretValue);
  assert.doesNotMatch(JSON.stringify(profile), new RegExp(secretValue));
  assert.deepEqual(summary.runMetadata, { profile: "test" });
  assert.doesNotMatch(JSON.stringify(summary), new RegExp(secretValue));
  assert.doesNotMatch(formatRunSummary(summary), new RegExp(secretValue));
  assert.throws(
    () => loadRuntimeProfile("test", {
      definitions: { test: { secrets: { token: { value: secretValue } } } },
      environment: {},
    }),
    /secret token has unsupported field: value/,
  );
  assert.throws(
    () => loadRuntimeProfile("test", {
      definitions: {
        test: {
          secrets: {
            token: { environment: "PUBLICATION_TOKEN", value: secretValue },
          },
        },
      },
      environment: { PUBLICATION_TOKEN: secretValue },
    }),
    /secret token has unsupported field: value/,
  );
  assert.throws(
    () => loadRuntimeProfile("test", {
      definitions: {
        test: {
          secrets: {
            token: { environment: "PUBLICATION_TOKEN", description: "publish credential" },
          },
        },
      },
      environment: { PUBLICATION_TOKEN: secretValue },
    }),
    /secret token has unsupported field: description/,
  );
  assert.throws(
    () => loadRuntimeProfile("test", {
      definitions: {
        test: {
          secrets: {
            toJSON: { environment: "PUBLICATION_TOKEN" },
          },
        },
      },
      environment: { PUBLICATION_TOKEN: secretValue },
    }),
    /secret name toJSON is reserved/,
  );
});

test("CLI selection supports an argument, environment setting, and safe local default", () => {
  assert.equal(selectProfileIdentity([], {}), "local");
  assert.equal(selectProfileIdentity([], { ORCHESTRATOR_PROFILE: "test" }), "test");
  assert.equal(selectProfileIdentity(["--profile", "production"], { ORCHESTRATOR_PROFILE: "test" }), "production");
  assert.equal(selectProfileIdentity(["--profile=production"], {}), "production");
});

test("CLI validates the profile before injecting it into graph construction", async () => {
  let receivedProfile;
  let receivedMetadata;
  const summary = { status: JobStatus.SUCCESS };
  const result = await runCli({
    arguments: ["--profile", "test"],
    environment: {},
    createJobs(profile) {
      receivedProfile = profile;
      return [defineJob({
        id: "A",
        execute: async () => ({ status: JobStatus.SUCCESS }),
      })];
    },
    runProcess: async (jobs, options) => {
      assert.equal(jobs.length, 1);
      receivedMetadata = options.runMetadata;
      return summary;
    },
  });

  assert.equal(result, summary);
  assert.equal(receivedProfile.identity, "test");
  assert.equal(receivedProfile.bindings.workspaceRoot, ".work/test");
  assert.deepEqual(receivedMetadata, { profile: "test" });
});

test("invalid CLI configuration never constructs jobs", async () => {
  let constructed = false;
  const errors = [];
  const processLike = {};
  const result = await runCli({
    arguments: ["--profile", "production"],
    environment: {},
    output: { error: (message) => errors.push(message) },
    processLike,
    createJobs() {
      constructed = true;
      return [];
    },
  });

  assert.equal(result, undefined);
  assert.equal(constructed, false);
  assert.equal(processLike.exitCode, 1);
  assert.deepEqual(errors, ["profile production is missing required binding: workspaceRoot"]);
});
