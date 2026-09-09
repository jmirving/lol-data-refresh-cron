import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { JobStatus, ResultReason } from "../src/index.js";

const java = process.env.CONFORMANCE_JAVA ?? "java";
const gradle = process.env.CONFORMANCE_GRADLE ?? "gradle";
const fixtureVersion = "99.1.0-conformance";
const artifactBuilderExecutable = "lol-ddragon-context-artifact-builder";

function gradleBuild(task) {
  return {
    command: gradle,
    arguments: [task, "--no-daemon"],
    env: {
      GRADLE_USER_HOME: process.env.CONFORMANCE_GRADLE_USER_HOME
        ?? join(tmpdir(), "lol-worker-conformance-gradle"),
    },
  };
}

function javaJar(checkout, jarName, args, options = {}) {
  return {
    command: java,
    arguments: ["-jar", join(checkout, "build/libs", jarName), ...args],
    structuredOutput: options.structured ? "json" : undefined,
    timeoutMs: options.timeoutMs,
    killGraceMs: options.killGraceMs ?? 250,
  };
}

function executable(checkout, name, args, options = {}) {
  return {
    command: join(checkout, "build/install", name, "bin", name),
    arguments: args,
    structuredOutput: options.structured ? "json" : undefined,
    timeoutMs: options.timeoutMs,
    killGraceMs: options.killGraceMs ?? 250,
  };
}

function json(stdout) {
  return JSON.parse(stdout);
}

function assertSuccess(result) {
  assert.equal(result.status, JobStatus.SUCCESS);
  assert.equal(result.metadata.exitCode, 0);
  assert.equal(result.metadata.timedOut, false);
}

function assertNonZeroFailure(result) {
  assert.equal(result.status, JobStatus.FAILED);
  assert.equal(result.reasonCode, ResultReason.COMMAND_EXIT_NON_ZERO);
  assert.notEqual(result.metadata.exitCode, 0);
  assert.equal(result.metadata.timedOut, false);
}

function assertTimeout(result) {
  assert.equal(result.status, JobStatus.FAILED);
  assert.equal(result.reasonCode, ResultReason.TIMEOUT);
  assert.equal(result.metadata.timedOut, true);
  assert.ok(result.metadata.exitCode === null || result.metadata.exitCode !== 0);
  if (result.metadata.signal !== null) assert.match(result.metadata.signal, /^SIG/);
}

async function sha256(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function startStubServer(routes) {
  const sockets = new Set();
  const server = http.createServer((request, response) => {
    const route = routes[request.url];
    if (route === "hang") return;
    const status = route?.status ?? 404;
    const body = route?.body ?? "not found";
    response.writeHead(status, { "content-type": route?.contentType ?? "text/plain" });
    response.end(body);
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    cleanup: () => new Promise((resolve) => {
      for (const socket of sockets) socket.destroy();
      server.close(resolve);
    }),
  };
}

async function prepareProcessor({ checkout, workspace }) {
  const input = join(workspace, "raw");
  await mkdir(input, { recursive: true });
  await copyFile(
    join(checkout, "src/test/resources/oracle-elixir/2025_LoL_esports_match_data_from_OraclesElixir.csv"),
    join(input, "2025_LoL_esports_match_data_from_OraclesElixir.csv"),
  );
  return { input, firstHashes: undefined };
}

async function prepareSnapshot({ workspace }) {
  const server = await startStubServer({
    "/versions": { status: 200, body: `["${fixtureVersion}"]`, contentType: "application/json" },
    "/failure": { status: 500, body: "synthetic failure" },
    "/hang": "hang",
    "/dragontail-source": { status: 200, body: "synthetic archive" },
  });
  const makeData = async (name) => {
    const root = join(workspace, name);
    const raw = join(root, "raw", fixtureVersion);
    await mkdir(raw, { recursive: true });
    await writeFile(join(raw, `dragontail-${fixtureVersion}.tgz`), "synthetic archive");
    await mkdir(join(root, "extracted", fixtureVersion), { recursive: true });
    return root;
  };
  return {
    ...server,
    plainData: await makeData("plain-data"),
    structuredData: await makeData("structured-data"),
  };
}

async function prepareBuilder({ workspace }) {
  const locale = join(workspace, "snapshot/data/en_US");
  await mkdir(join(locale, "champion"), { recursive: true });
  await writeFile(join(locale, "champion.json"),
    '{"data":{"Ahri":{"name":"Ahri","id":"Ahri","key":"103"}}}\n');
  await writeFile(join(locale, "champion/Ahri.json"), `${JSON.stringify({
    data: {
      Ahri: {
        id: "Ahri", key: "103", name: "Ahri", tags: ["Mage"], partype: "Mana",
        info: { attack: 3 }, stats: { hp: 590 },
        spells: [{ id: "AhriQ", name: "Orb", maxrank: 5, cooldown: [7], cost: [55], range: [970] }],
      },
    },
  })}\n`);
  return { snapshot: join(workspace, "snapshot"), firstHashes: undefined };
}

const downloader = {
  id: "oracle-downloader",
  name: "Oracle downloader",
  repository: "https://github.com/jmirving/lol-pro-data-download-cron.git",
  revision: "9b3a6727a9437af63ae381106f61a69c89d3792b",
  build: () => gradleBuild("bootJar"),
  prepare: async ({ workspace }) => ({
    ...await startStubServer({
      "/empty": { status: 200, body: "<html>synthetic empty listing</html>", contentType: "text/html" },
      "/hang": "hang",
    }),
    output: join(workspace, "raw"),
  }),
  cases: ({ checkout, fixture }) => {
    const common = [
      `--prodata.download.outputDir=${fixture.output}`,
      "--prodata.download.years=2026",
      "--prodata.download.structuredOutput=json",
    ];
    return [
      {
        id: "local-success-path-unavailable",
        groups: ["plainCli", "structuredOutput", "idempotencyPathHandling"],
        violation: "reviewed worker hardcodes https://drive.google.com/uc for file downloads; a successful pinned CLI cannot use a local stub source endpoint",
      },
      {
        id: "structured-failure",
        groups: ["failureMapping", "streams"],
        adapter: javaJar(checkout, "lol-pro-data-download-cron-1.0-SNAPSHOT.jar", [
          ...common,
          `--prodata.download.googleDriveFolderUrl=${fixture.baseUrl}/empty`,
        ], { structured: true }),
        assert(result) {
          assertNonZeroFailure(result);
          const envelope = json(result.metadata.stdout);
          assert.equal(envelope.status, "FAILED");
          assert.equal(envelope.reasonCode, "DOWNLOAD_FAILED");
          assert.match(envelope.error, /Missing CSVs for years/);
        },
      },
      {
        id: "invalid-invocation",
        groups: ["failureMapping"],
        adapter: javaJar(checkout, "lol-pro-data-download-cron-1.0-SNAPSHOT.jar", [
          ...common,
          "--prodata.download.years=not-a-year",
        ], { structured: true }),
        assert: assertNonZeroFailure,
      },
      {
        id: "timeout",
        groups: ["timeoutTermination"],
        adapter: javaJar(checkout, "lol-pro-data-download-cron-1.0-SNAPSHOT.jar", [
          ...common,
          `--prodata.download.googleDriveFolderUrl=${fixture.baseUrl}/hang`,
        ], { structured: true, timeoutMs: 1500 }),
        assert: assertTimeout,
      },
    ];
  },
};

const processor = {
  id: "oracle-processor",
  name: "Oracle processor",
  repository: "https://github.com/jmirving/lol-pro-data-processor.git",
  revision: "9456f3486246e97d95680a20de469e0dde6eb917",
  build: () => gradleBuild("bootJar"),
  prepare: prepareProcessor,
  cases: ({ checkout, workspace, fixture }) => {
    const jar = "lol-pro-data-processor-1.0-SNAPSHOT.jar";
    const output = join(workspace, "processed");
    const args = [
      `--input-dir=${fixture.input}`, `--output-dir=${output}`, "--years=2025",
      "--artifact-id=conformance-2026-09-09",
    ];
    const artifactPaths = ["all", "players", "teams"].map((kind) =>
      join(output, kind, `${kind}_conformance-2026-09-09.csv`));
    return [
      {
        id: "plain-success",
        groups: ["plainCli", "streams"],
        adapter: javaJar(checkout, jar, [
          `--input-dir=${fixture.input}`, `--output-dir=${join(workspace, "plain-output")}`,
          "--years=2025", "--artifact-id=plain-conformance",
        ]),
        assert(result) {
          assertSuccess(result);
          assert.equal(result.metadata.stdout, "");
          assert.match(result.metadata.stderr, /Processing/);
        },
      },
      {
        id: "structured-success",
        groups: ["structuredOutput", "idempotencyPathHandling"],
        adapter: javaJar(checkout, jar, [...args, "--structured-output=json"], { structured: true }),
        async assert(result) {
          assertSuccess(result);
          assert.equal(result.metadata.structured.artifactId, "conformance-2026-09-09");
          assert.deepEqual(Object.values(result.metadata.structured.outputs), artifactPaths);
          fixture.firstHashes = await Promise.all(artifactPaths.map(sha256));
        },
      },
      {
        id: "repeat-success",
        groups: ["idempotencyPathHandling"],
        adapter: javaJar(checkout, jar, [...args, "--structured-output=json"], { structured: true }),
        async assert(result) {
          assertSuccess(result);
          assert.deepEqual(await Promise.all(artifactPaths.map(sha256)), fixture.firstHashes);
        },
      },
      {
        id: "structured-failure",
        groups: ["failureMapping", "streams"],
        adapter: javaJar(checkout, jar, [
          `--input-dir=${join(workspace, "missing")}`, `--output-dir=${join(workspace, "failed")}`,
          "--years=2025", "--artifact-id=failure", "--structured-output=json",
        ], { structured: true }),
        assert(result) {
          assertNonZeroFailure(result);
          assert.equal(json(result.metadata.stdout).reasonCode, "PROCESSING_FAILED");
          assert.match(result.metadata.stderr, /processing failed/i);
        },
      },
      {
        id: "invalid-invocation",
        groups: ["failureMapping"],
        adapter: javaJar(checkout, jar, [...args, "--years=invalid", "--structured-output=json"], { structured: true }),
        assert: assertNonZeroFailure,
      },
      {
        id: "timeout",
        groups: ["timeoutTermination"],
        adapter: javaJar(checkout, jar, args, { timeoutMs: 25 }),
        assert: assertTimeout,
      },
    ];
  },
};

const snapshot = {
  id: "ddragon-snapshot",
  name: "Data Dragon snapshot",
  repository: "https://github.com/jmirving/lol-ddragon-snapshot-cron.git",
  revision: "aa276377b8b10c4caf77499eb9b9d19b52e3dd67",
  build: () => gradleBuild("bootJar"),
  prepare: prepareSnapshot,
  cases: ({ checkout, workspace, fixture }) => {
    const jar = "ai-pb-data-download-cron-1.0-SNAPSHOT.jar";
    const args = (data, endpoint = "versions") => [
      `--ddragon.versions-url=${fixture.baseUrl}/${endpoint}`,
      `--ddragon.data-dir=${data}`,
      "--ddragon.retention-mode=ephemeral",
    ];
    return [
      {
        id: "plain-success",
        groups: ["plainCli", "streams"],
        adapter: javaJar(checkout, jar, args(fixture.plainData)),
        assert(result) {
          assertSuccess(result);
          assert.equal(result.metadata.stdout, "");
          assert.match(result.metadata.stderr, /Snapshot processed/);
        },
      },
      {
        id: "structured-success",
        groups: ["structuredOutput", "idempotencyPathHandling"],
        adapter: javaJar(checkout, jar, [...args(fixture.structuredData), "--ddragon.structured-output=true"], { structured: true }),
        assert(result) {
          assertSuccess(result);
          assert.equal(result.metadata.structured.detectedVersion, fixtureVersion);
          assert.equal(result.metadata.structured.currentVersion, fixtureVersion);
          assert.equal(result.metadata.structured.retentionMode, "ephemeral");
          assert.equal(result.metadata.structured.extractedPath,
            join(fixture.structuredData, "extracted", fixtureVersion));
          fixture.firstSha = result.metadata.structured.sha256;
        },
      },
      {
        id: "repeat-success",
        groups: ["idempotencyPathHandling"],
        adapter: javaJar(checkout, jar, [...args(fixture.structuredData), "--ddragon.structured-output=true"], { structured: true }),
        assert(result) {
          assertSuccess(result);
          assert.equal(result.metadata.structured.sha256, fixture.firstSha);
        },
      },
      {
        id: "local-source-endpoint",
        groups: ["idempotencyPathHandling"],
        violation: "reviewed worker exposes a local versions URL but hardcodes the dragontail source URL; the successful fixture must preseed the archive instead of exercising a local source endpoint",
      },
      {
        id: "structured-failure",
        groups: ["failureMapping", "streams"],
        adapter: javaJar(checkout, jar, [
          ...args(join(workspace, "failure-data"), "failure"), "--ddragon.structured-output=true",
        ], { structured: true }),
        assert(result) {
          assertNonZeroFailure(result);
          assert.equal(json(result.metadata.stdout).reasonCode, "DDRAGON_WORKER_FAILED");
          assert.notEqual(result.metadata.stderr, "");
        },
      },
      {
        id: "invalid-invocation",
        groups: ["failureMapping"],
        adapter: javaJar(checkout, jar, [
          ...args(join(workspace, "invalid-data")),
          "--ddragon.retention-mode=invalid", "--ddragon.structured-output=true",
        ], { structured: true }),
        assert: assertNonZeroFailure,
      },
      {
        id: "timeout",
        groups: ["timeoutTermination"],
        adapter: javaJar(checkout, jar, [
          ...args(join(workspace, "timeout-data"), "hang"), "--ddragon.structured-output=true",
        ], { structured: true, timeoutMs: 1500 }),
        assert: assertTimeout,
      },
    ];
  },
};

const artifactBuilder = {
  id: "ddragon-artifact-builder",
  name: "Data Dragon artifact builder",
  repository: "https://github.com/jmirving/lol-ddragon-context-artifact-builder.git",
  revision: "04e64e94ae35a09a975de0914f69c6a8748f6b2e",
  build: () => gradleBuild("installDist"),
  prepare: prepareBuilder,
  cases: ({ checkout, workspace, fixture }) => {
    const output = join(workspace, "artifacts");
    const args = [
      "--snapshot-input", fixture.snapshot, "--snapshot-version", "14.1.1",
      "--snapshot-locale", "en_US", "--output-directory", output,
      "--artifact-version", "14.1.1",
    ];
    const paths = ["champion-mapping.json", "champion-core.csv", "champion-spells.csv"]
      .map((name) => join(output, name));
    return [
      {
        id: "plain-success",
        groups: ["plainCli", "streams"],
        adapter: executable(checkout, artifactBuilderExecutable, [
          "--snapshot-input", fixture.snapshot, "--snapshot-version", "14.1.1",
          "--output-directory", join(workspace, "plain-artifacts"),
        ]),
        assert(result) {
          assertSuccess(result);
          assert.match(result.metadata.stdout, /Wrote champion mapping/);
          assert.equal(result.metadata.stderr, "");
        },
      },
      {
        id: "structured-success",
        groups: ["structuredOutput", "idempotencyPathHandling"],
        adapter: executable(checkout, artifactBuilderExecutable, [...args, "--structured-output", "json"], { structured: true }),
        async assert(result) {
          assertSuccess(result);
          assert.equal(result.metadata.structured.snapshotVersion, "14.1.1");
          assert.equal(result.metadata.structured.artifactVersion, "14.1.1");
          assert.deepEqual(result.metadata.structured.artifacts.map((item) => item.path), paths);
          for (const item of result.metadata.structured.artifacts) assert.equal(item.sha256, await sha256(item.path));
          fixture.firstHashes = await Promise.all(paths.map(sha256));
        },
      },
      {
        id: "repeat-success",
        groups: ["idempotencyPathHandling"],
        adapter: executable(checkout, artifactBuilderExecutable, [...args, "--structured-output", "json"], { structured: true }),
        async assert(result) {
          assertSuccess(result);
          assert.deepEqual(await Promise.all(paths.map(sha256)), fixture.firstHashes);
        },
      },
      {
        id: "structured-failure",
        groups: ["failureMapping", "streams"],
        adapter: executable(checkout, artifactBuilderExecutable, [
          "--snapshot-input", join(workspace, "missing"), "--snapshot-version", "14.1.1",
          "--output-directory", join(workspace, "failure"), "--structured-output", "json",
        ], { structured: true }),
        assert(result) {
          assertNonZeroFailure(result);
          assert.equal(result.metadata.stdout, "");
          assert.match(result.metadata.stderr, /Artifact build failed/);
        },
      },
      {
        id: "invalid-invocation",
        groups: ["failureMapping"],
        adapter: executable(checkout, artifactBuilderExecutable, ["--unsupported", "value"]),
        assert: assertNonZeroFailure,
      },
      {
        id: "timeout",
        groups: ["timeoutTermination"],
        adapter: executable(checkout, artifactBuilderExecutable, args, { timeoutMs: 10 }),
        assert: assertTimeout,
      },
    ];
  },
};

export const workerDefinitions = Object.freeze([
  downloader,
  processor,
  snapshot,
  artifactBuilder,
]);
