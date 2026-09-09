export const JobStatus = Object.freeze({
  SUCCESS: "SUCCESS",
  SKIPPED: "SKIPPED",
  FAILED: "FAILED",
  SKIPPED_DEPENDENCY_FAILED: "SKIPPED_DEPENDENCY_FAILED",
});

export const ResultReason = Object.freeze({
  DISABLED: "DISABLED",
  NOT_ELIGIBLE: "NOT_ELIGIBLE",
  DEPENDENCY_FAILED: "DEPENDENCY_FAILED",
  EXECUTION_ERROR: "EXECUTION_ERROR",
  TIMEOUT: "TIMEOUT",
  INVALID_RESULT: "INVALID_RESULT",
  COMMAND_SPAWN_ERROR: "COMMAND_SPAWN_ERROR",
  COMMAND_EXIT_NON_ZERO: "COMMAND_EXIT_NON_ZERO",
  INVALID_STRUCTURED_OUTPUT: "INVALID_STRUCTURED_OUTPUT",
});

export const workerStatuses = new Set([
  JobStatus.SUCCESS,
  JobStatus.SKIPPED,
  JobStatus.FAILED,
]);

export function errorSummary(error) {
  if (error instanceof Error) {
    return error.message || error.name;
  }
  return String(error);
}
