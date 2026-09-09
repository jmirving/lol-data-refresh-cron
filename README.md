# lol-data-refresh-cron

Generic orchestration and deployment layer for scheduled League of Legends data-maintenance jobs.

Repository: https://github.com/jmirving/lol-data-refresh-cron

## Purpose

Render charges a minimum per cron service. This project consolidates multiple independently owned League data workers behind one extensible scheduled deployment while keeping each worker independently runnable and testable.

The orchestrator is intentionally domain-light. It should configure jobs, resolve dependencies, decide schedule eligibility, execute workers, publish durable outputs, summarize results, and return an appropriate process status. Oracle's Elixir parsing, Data Dragon normalization, model training, and similar domain logic remain in their owning repositories.

## Start Here

- [Architecture and Planning](docs/PLAN.md) — source-of-truth design, worker boundaries, durable-data policy, Render deployment, and definition of done.
- [Execution Plan](docs/EXECUTION_PLAN.md) — implementation order and concrete completion gates for building the repository.

## Initial Worker Repositories

- Oracle's Elixir downloader: https://github.com/jmirving/lol-pro-data-download-cron
- Oracle's Elixir processor: https://github.com/jmirving/lol-pro-data-processor
- Data Dragon snapshot worker: https://github.com/jmirving/lol-ddragon-snapshot-cron
- Data Dragon artifact builder: https://github.com/jmirving/lol-ddragon-context-artifact-builder

Worker-specific integration changes are tracked in those repositories rather than duplicated here.

## Core Rule

The current workers are only the first jobs. The scheduler must support an arbitrary future job graph without hardcoded assumptions about which job comes next.

## Runtime and Development

The orchestration core uses Node.js 20 or newer and has no runtime dependencies. Tests use Node's built-in test runner.

```sh
npm test
npm start
```

`npm start` currently runs an empty graph intentionally. Real worker registration belongs to later integration phases.

Runtime resources are selected and validated before that graph is constructed.
The CLI defaults to the safe `local` profile and accepts an explicit profile via
`npm start -- --profile test` or `ORCHESTRATOR_PROFILE`. See
[Runtime Profiles](docs/RUNTIME_PROFILES.md) for the binding schema, supported
profiles, production requirements, and secret-handling contract.

## Generic Core API

Jobs are declared with `defineJob` and provide:

- a unique `id`,
- optional `enabled`, `dependencies`, `eligibility`, and `timeoutMs` values,
- an async `execute(context)` adapter returning `SUCCESS`, `SKIPPED`, or `FAILED` plus optional reason/error/metadata fields.

The scheduler owns the `SKIPPED_DEPENDENCY_FAILED` status. A normal `SKIPPED` dependency does not block downstream work; `FAILED` and transitively dependency-blocked prerequisites do. Execution order is a deterministic topological order with job ID as the tie-breaker, so declaration order has no effect.

Eligibility is a generic policy boundary. Built-in policies cover every invocation, daily invocation, selected UTC weekdays, and selected UTC month days; custom policies can implement the same `evaluate(context)` contract.

`runJobs` returns a structured deterministic-order summary. `runAndReport` also emits the human-readable summary and returns the intended process exit code. `runProcess` applies that code at the process boundary and maps graph/configuration errors to a non-zero exit. Only an actual job `FAILED` result makes a completed run non-zero.

## External Commands

`createCommandAdapter` executes an external program as a job without a shell. It supports arguments, working directory, inherited environment with explicit overrides, stdout/stderr capture, exit-code mapping, timeouts with termination escalation, and optional generic JSON results.

The complete adapter and future-worker contract is documented in [External Command Adapter Contract](docs/COMMAND_ADAPTER.md).
