import { dirname, resolve } from "node:path";

import { createCommandAdapter } from "./command-adapter.js";
import { defineJob } from "./job.js";

export const LeagueJobId = Object.freeze({
  DDRAGON_SNAPSHOT: "ddragon-snapshot",
  DDRAGON_ARTIFACT: "ddragon-artifact-builder",
  ORACLE_DOWNLOAD: "oracle-downloader",
  ORACLE_PROCESSOR: "oracle-processor",
});

const DEFAULT_WORKER_ROOT = "/opt/workers";
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

function javaJar(path) {
  return Object.freeze({ command: "java", arguments: Object.freeze(["-jar", path]) });
}

export function defaultWorkerExecutables(workerRoot = DEFAULT_WORKER_ROOT) {
  const root = resolve(workerRoot);
  return Object.freeze({
    [LeagueJobId.DDRAGON_SNAPSHOT]: javaJar(resolve(root, "ddragon-snapshot/worker.jar")),
    [LeagueJobId.DDRAGON_ARTIFACT]: Object.freeze({
      command: resolve(root, "ddragon-artifact-builder/bin/lol-ddragon-context-artifact-builder"),
      arguments: Object.freeze([]),
    }),
    [LeagueJobId.ORACLE_DOWNLOAD]: javaJar(resolve(root, "oracle-downloader/worker.jar")),
    [LeagueJobId.ORACLE_PROCESSOR]: javaJar(resolve(root, "oracle-processor/worker.jar")),
  });
}

function executable(executables, id) {
  const value = executables[id];
  if (!value || typeof value.command !== "string" || !Array.isArray(value.arguments)) {
    throw new TypeError(`missing executable configuration for ${id}`);
  }
  return value;
}

function adapter(executableConfiguration, argumentsList, timeoutMs) {
  return createCommandAdapter({
    command: executableConfiguration.command,
    arguments: [...executableConfiguration.arguments, ...argumentsList],
    env: executableConfiguration.env,
    structuredOutput: "json",
    timeoutMs,
    killGraceMs: 1_000,
  });
}

function safeRunSegment(runId) {
  if (/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(runId) && runId !== "." && runId !== "..") {
    return runId;
  }
  return Buffer.from(runId).toString("hex");
}

function runPaths(workspaceRoot, runId) {
  const root = resolve(workspaceRoot, "runs", safeRunSegment(runId));
  return Object.freeze({
    ddragonSnapshot: resolve(root, "ddragon/snapshot"),
    ddragonArtifacts: resolve(root, "ddragon/artifacts"),
    oracleRaw: resolve(root, "oracle/raw"),
    oracleProcessed: resolve(root, "oracle/processed"),
  });
}

function snapshotHandoff(context) {
  const result = context.dependencies[LeagueJobId.DDRAGON_SNAPSHOT];
  const metadata = result?.metadata?.structured;
  if (typeof metadata?.detectedVersion !== "string" || typeof metadata?.extractedPath !== "string") {
    throw new TypeError("ddragon snapshot did not return detectedVersion and extractedPath metadata");
  }
  return metadata;
}

/**
 * Register the initial League worker graph. Worker-specific commands and handoff
 * paths live here at the configuration boundary; the scheduler stays generic.
 */
export function createJobs(runtimeProfile, options = {}) {
  const workspaceRoot = runtimeProfile?.bindings?.workspaceRoot;
  if (typeof workspaceRoot !== "string" || workspaceRoot.length === 0) {
    throw new TypeError("runtime profile must provide a workspaceRoot binding");
  }

  const executables = options.executables
    ?? defaultWorkerExecutables(runtimeProfile.bindings.workerRoot ?? DEFAULT_WORKER_ROOT);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return [
    defineJob({
      id: LeagueJobId.DDRAGON_SNAPSHOT,
      execute: async (context) => {
        const paths = runPaths(workspaceRoot, context.runId);
        return adapter(executable(executables, LeagueJobId.DDRAGON_SNAPSHOT), [
          `--ddragon.data-dir=${paths.ddragonSnapshot}`,
          "--ddragon.retention-mode=ephemeral",
          "--ddragon.structured-output=true",
        ], timeoutMs)(context);
      },
    }),
    defineJob({
      id: LeagueJobId.DDRAGON_ARTIFACT,
      dependencies: [LeagueJobId.DDRAGON_SNAPSHOT],
      execute: async (context) => {
        const paths = runPaths(workspaceRoot, context.runId);
        const snapshot = snapshotHandoff(context);
        return adapter(executable(executables, LeagueJobId.DDRAGON_ARTIFACT), [
          "--snapshot-base-uri", dirname(snapshot.extractedPath),
          "--snapshot-version", snapshot.detectedVersion,
          "--snapshot-locale", "en_US",
          "--output-directory", paths.ddragonArtifacts,
          "--artifact-version", snapshot.detectedVersion,
          "--structured-output", "json",
        ], timeoutMs)(context);
      },
    }),
    defineJob({
      id: LeagueJobId.ORACLE_DOWNLOAD,
      execute: async (context) => {
        const paths = runPaths(workspaceRoot, context.runId);
        return adapter(executable(executables, LeagueJobId.ORACLE_DOWNLOAD), [
          `--prodata.download.outputDir=${paths.oracleRaw}`,
          "--prodata.download.structuredOutput=json",
        ], timeoutMs)(context);
      },
    }),
    defineJob({
      id: LeagueJobId.ORACLE_PROCESSOR,
      dependencies: [LeagueJobId.ORACLE_DOWNLOAD],
      execute: async (context) => {
        const paths = runPaths(workspaceRoot, context.runId);
        return adapter(executable(executables, LeagueJobId.ORACLE_PROCESSOR), [
          `--input-dir=${paths.oracleRaw}`,
          `--output-dir=${paths.oracleProcessed}`,
          `--artifact-id=${safeRunSegment(context.runId)}`,
          "--structured-output=json",
        ], timeoutMs)(context);
      },
    }),
  ];
}
