#!/usr/bin/env node
import { resolve } from "node:path";

import { formatConformanceReport, runConformance } from "./harness.js";
import { workerDefinitions } from "./workers.js";

function parseArguments(args) {
  const options = { workers: [] };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--checkout-root" || argument === "--workspace-root") {
      const value = args[index + 1];
      if (!value) throw new Error(`${argument} requires a path`);
      options[argument === "--checkout-root" ? "checkoutRoot" : "workspaceRoot"] = resolve(value);
      index += 1;
    } else if (argument === "--keep-workspaces") options.keepWorkspaces = true;
    else if (argument === "--json") options.json = true;
    else if (argument.startsWith("--")) throw new Error(`unknown option: ${argument}`);
    else options.workers.push(argument);
  }
  return options;
}

try {
  const options = parseArguments(process.argv.slice(2));
  const selected = options.workers.length === 0
    ? workerDefinitions
    : options.workers.map((id) => {
      const worker = workerDefinitions.find((candidate) => candidate.id === id);
      if (!worker) throw new Error(`unknown worker: ${id}`);
      return worker;
    });
  const reports = await runConformance(selected, options);
  console.log(options.json ? JSON.stringify(reports, null, 2) : formatConformanceReport(reports));
  process.exitCode = reports.every((report) => report.overall === "PASS") ? 0 : 1;
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 2;
}
