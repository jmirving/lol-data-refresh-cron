import { runAndReport } from "./orchestrator.js";

export async function runProcess(jobs, options = {}) {
  const processLike = options.processLike ?? process;
  const output = options.output ?? console;

  try {
    const { summary, exitCode } = await runAndReport(jobs, { ...options, output });
    processLike.exitCode = exitCode;
    return summary;
  } catch (error) {
    output.error(error instanceof Error ? error.message : String(error));
    processLike.exitCode = 1;
    return undefined;
  }
}
