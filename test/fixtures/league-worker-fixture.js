#!/usr/bin/env node

import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const [mode, ...args] = process.argv.slice(2);

function equalsValue(prefix) {
  return args.find((value) => value.startsWith(`${prefix}=`))?.slice(prefix.length + 1);
}

function followingValue(name) {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
}

function success(metadata) {
  process.stdout.write(`${JSON.stringify({ status: "SUCCESS", metadata })}\n`);
}

if (mode === "ddragon-snapshot") {
  const dataRoot = equalsValue("--ddragon.data-dir");
  const version = "99.1.0-fixture";
  const extractedPath = resolve(dataRoot, "extracted", version);
  const locale = resolve(extractedPath, "data/en_US");
  await mkdir(resolve(locale, "champion"), { recursive: true });
  await writeFile(resolve(locale, "champion.json"), "{}\n");
  await writeFile(resolve(locale, "champion/Ahri.json"), "{}\n");
  success({ detectedVersion: version, extractedPath });
} else if (mode === "ddragon-artifact-builder") {
  const snapshotBase = followingValue("--snapshot-base-uri");
  const version = followingValue("--snapshot-version");
  const input = resolve(snapshotBase, version);
  const output = followingValue("--output-directory");
  await stat(resolve(input, "data/en_US/champion.json"));
  await mkdir(output, { recursive: true });
  const artifact = resolve(output, "champion-mapping.json");
  await writeFile(artifact, `${version}\n`);
  success({ snapshotVersion: version, artifacts: [{ path: artifact }] });
} else if (mode === "oracle-downloader") {
  const output = equalsValue("--prodata.download.outputDir");
  await mkdir(output, { recursive: true });
  const artifact = resolve(output, "2026_LoL_esports_match_data_from_OraclesElixir.csv");
  await writeFile(artifact, "gameid,year\n1,2026\n");
  success({ outputDirectory: output, artifacts: [{ path: artifact }] });
} else if (mode === "oracle-processor") {
  const input = equalsValue("--input-dir");
  const output = equalsValue("--output-dir");
  const artifactId = equalsValue("--artifact-id");
  await readFile(resolve(input, "2026_LoL_esports_match_data_from_OraclesElixir.csv"));
  await mkdir(resolve(output, "all"), { recursive: true });
  const artifact = resolve(output, "all", `all_${artifactId}.csv`);
  await writeFile(artifact, "gameid,year\n1,2026\n");
  success({ artifactId, outputs: { all: artifact } });
} else if (mode !== undefined) {
  throw new Error(`unknown fixture mode: ${mode}`);
}
