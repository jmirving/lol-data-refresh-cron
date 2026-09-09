# External Command Adapter Contract

The command adapter is the domain-neutral boundary between the orchestration DAG and an independently executable worker.

It does not require knowledge of a worker's data source, artifacts, implementation language, or repository.

## Adapter configuration

Create an execution function with `createCommandAdapter`:

```js
const execute = createCommandAdapter({
  command: "/absolute/or/PATH-resolved/program",
  arguments: ["--input", "/work/input"],
  cwd: "/work/worker",
  env: { WORKER_MODE: "refresh" },
  timeoutMs: 300_000,
  killGraceMs: 1_000,
  structuredOutput: "json",
});
```

- `command` is required and is executed directly, without a shell.
- `arguments` defaults to an empty array and must contain strings.
- `cwd` is optional. The child inherits the orchestrator's working directory when omitted.
- `env` is optional. The child inherits the complete parent environment, then configured values override it. A `null` value explicitly removes a variable.
- `timeoutMs` is optional. When present, it must be positive.
- `killGraceMs` controls the delay between graceful and forced timeout termination and defaults to 100 milliseconds.
- `structuredOutput: "json"` opts into the structured stdout contract described below.

The adapter supplies two generic environment variables unless configuration overrides them:

- `ORCHESTRATOR_RUN_ID`
- `ORCHESTRATOR_JOB_ID`

## Plain executable contract

Every external worker can use the plain contract:

1. Be non-interactive and executable as a program plus an argument array.
2. Exit with code zero for successful process completion.
3. Exit non-zero for failure.
4. Use stdout and stderr freely; both are captured as UTF-8 text.
5. Tolerate `SIGTERM` and exit promptly where practical.

No output schema is required in this mode. A zero exit maps to `SUCCESS`. A non-zero exit maps to `FAILED` with reason code `COMMAND_EXIT_NON_ZERO`.

## Optional structured stdout contract

When `structuredOutput: "json"` is configured, the worker's entire stdout must be one JSON object. Surrounding JSON whitespace is allowed. Operational logging should go to stderr in this mode.

The generic envelope is:

```json
{
  "status": "SUCCESS",
  "reasonCode": "OPTIONAL_MACHINE_REASON",
  "reason": "optional human-readable explanation",
  "error": "optional error summary",
  "metadata": {
    "anyDomainNeutralOrWorkerOwnedKey": "any JSON value"
  }
}
```

- `status` is optional and defaults to `SUCCESS`. It may be `SUCCESS`, `SKIPPED`, or `FAILED`.
- `reasonCode`, `reason`, and `error` are optional strings.
- `metadata` is an optional JSON object. Its contents remain worker-owned and are placed under `result.metadata.structured` without domain interpretation.
- A non-zero process exit always remains `FAILED`, regardless of structured content.
- Malformed or contract-invalid JSON after a zero exit maps to `FAILED` with reason code `INVALID_STRUCTURED_OUTPUT`.
- Malformed structured output accompanying a non-zero exit is recorded in metadata, while `COMMAND_EXIT_NON_ZERO` remains the primary failure reason.

## Result metadata

Every completed adapter result includes:

```js
{
  command,
  arguments,
  workingDirectory,
  exitCode,
  signal,
  stdout,
  stderr,
  timedOut,
  durationMs,
  structured,             // only when valid structured metadata was emitted
  structuredOutputError,  // only when configured structured output was invalid
}
```

`exitCode` is `null` when no normal process exit code exists, such as spawn failure or signal termination. `durationMs` is measured with a monotonic clock and is independent of the scheduler's injected wall clock.

## Timeout behavior

On timeout, the adapter:

1. marks the result as `FAILED` with reason code `TIMEOUT`,
2. sends `SIGTERM`,
3. waits for the configured grace period,
4. sends `SIGKILL` if needed,
5. waits for process closure before returning the adapter result.

On POSIX systems, commands run in their own process group and both signals target the group, terminating descendant processes as well as the direct child. On Windows, Node's direct-child termination behavior is used.

Configure subprocess timeouts on `createCommandAdapter` when detailed command timeout metadata is required. The job model's existing `timeoutMs` remains a generic outer safety limit for any execution adapter.

## Expectations for future worker repositories

An external repository does not need an orchestrator-specific library. It needs a stable, independently testable CLI entry point that:

- accepts all required paths and options through documented arguments or environment variables,
- uses meaningful process exit codes,
- does not prompt for input,
- handles termination signals safely,
- writes required outputs before reporting success,
- can optionally emit the generic JSON envelope above,
- keeps worker/domain metadata inside the envelope's `metadata` object,
- remains runnable outside this orchestrator.

Workers may continue using only exit codes and streams until they need explicit `SKIPPED` semantics or structured metadata.
