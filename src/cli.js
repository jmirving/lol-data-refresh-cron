#!/usr/bin/env node

import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

import { createJobs } from "./jobs.js";
import { runProcess } from "./process.js";
import { loadRuntimeProfile, runtimeProfileDefinitions } from "./runtime-profile.js";

export function selectProfileIdentity(argumentsList, environment = process.env) {
  let selected = environment.ORCHESTRATOR_PROFILE ?? "local";
  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    if (argument === "--profile") {
      if (index + 1 >= argumentsList.length) throw new TypeError("--profile requires a value");
      selected = argumentsList[index + 1];
      index += 1;
    } else if (argument.startsWith("--profile=")) {
      selected = argument.slice("--profile=".length);
    } else {
      throw new TypeError(`unknown argument: ${argument}`);
    }
  }
  return selected;
}

export async function runCli(options = {}) {
  const environment = options.environment ?? process.env;
  const output = options.output ?? console;
  const processLike = options.processLike ?? process;
  try {
    const identity = selectProfileIdentity(options.arguments ?? process.argv.slice(2), environment);
    const runtimeProfile = loadRuntimeProfile(identity, {
      definitions: options.definitions ?? runtimeProfileDefinitions,
      environment,
    });
    const jobs = (options.createJobs ?? createJobs)(runtimeProfile);
    return await (options.runProcess ?? runProcess)(jobs, {
      output,
      processLike,
      runMetadata: { profile: runtimeProfile.identity },
    });
  } catch (error) {
    output.error(error instanceof Error ? error.message : String(error));
    processLike.exitCode = 1;
    return undefined;
  }
}

const isMain = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) await runCli();
