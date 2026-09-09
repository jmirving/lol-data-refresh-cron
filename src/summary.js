import { JobStatus } from "./result.js";

const statusOrder = [
  JobStatus.SUCCESS,
  JobStatus.SKIPPED,
  JobStatus.SKIPPED_DEPENDENCY_FAILED,
  JobStatus.FAILED,
];

export function exitCodeForSummary(summary) {
  return summary.results.some((result) => result.status === JobStatus.FAILED) ? 1 : 0;
}

export function formatRunSummary(summary) {
  const lines = [
    `run ${summary.runId}: ${summary.status}`,
    ...summary.results.map((result) => {
      const detail = result.error ?? result.reason;
      return `${result.jobId}: ${result.status}${detail ? ` (${detail})` : ""}`;
    }),
    `counts: ${statusOrder.map((status) => `${status}=${summary.counts[status]}`).join(" ")}`,
  ];
  return lines.join("\n");
}
