# Execution Plan

This document is the implementation companion to [PLAN.md](PLAN.md).

It converts the architecture into an ordered build sequence for `lol-data-refresh-cron` itself. Worker-specific changes remain in their owning repositories and issues.

Repository: https://github.com/jmirving/lol-data-refresh-cron

---

## Phase 0 — Repository Foundation

Create the minimum repository scaffolding needed before domain worker integration.

### Deliverables

- root `README.md`
- `docs/PLAN.md`
- `docs/EXECUTION_PLAN.md`
- language/runtime choice documented
- package/build files
- test runner
- Dockerfile
- `.gitignore`
- basic CI

### Exit criteria

- repository builds locally
- tests can run with one command
- Docker image builds
- CI runs on pull requests

---

## Phase 1 — Core Job Model

Implement the generic in-process representation of a scheduled job.

### Required concepts

- job ID
- enabled state
- cadence/eligibility policy
- dependency IDs
- timeout
- execution adapter/command
- result status
- result metadata

Minimum statuses:

- `SUCCESS`
- `SKIPPED`
- `FAILED`

Add a dependency-related skipped outcome if useful internally, but keep the public result model simple and explicit.

### Tests

Use synthetic jobs named `A`, `B`, `C`, etc.

Cover:
- success
- skip
- failure
- disabled job
- metadata capture

### Exit criteria

The job model has no references to Oracle, DDragon, Nexus, Clairvoyance, or the current worker set.

---

## Phase 2 — Dependency Graph and Scheduler

Implement arbitrary dependency resolution.

### Requirements

- validate duplicate IDs
- detect unknown dependencies
- detect cycles before execution
- derive legal execution order
- support independent branches
- support fan-out
- support fan-in
- do not rely on declaration order

### Failure behavior

- failed dependency blocks only dependent jobs
- unrelated jobs continue
- skipped dependency does not automatically force dependent skip unless dependency semantics require it

### Tests

Cover:
- linear graph
- independent jobs
- diamond graph
- cycle
- missing dependency
- failure in one branch
- arbitrary insertion/reordering

### Exit criteria

Scheduler behavior remains identical when jobs are reordered in configuration.

---

## Phase 3 — Eligibility/Cadence

Implement schedule eligibility independently of Render's outer cron schedule.

### Requirements

Support at minimum:
- every invocation
- daily eligibility
- selected weekdays
- monthly/date-like policies if simple to support cleanly

Use injected clock/time context in tests.

### Exit criteria

A job can return/not-run because of its own configured cadence without scheduler special cases.

---

## Phase 4 — Execution Engine

Implement actual worker invocation.

### Requirements

- invoke local executable/command adapter
- pass configured environment
- pass orchestrator run ID
- support shared ephemeral workspace paths
- enforce timeout
- capture exit code
- capture structured result metadata where available
- map process outcome to job result

### Design constraint

The execution engine should not parse domain-specific worker output directly. Use a stable result contract or adapter boundary.

### Exit criteria

Synthetic executable workers can be run end-to-end through the scheduler.

---

## Phase 5 — Run Summary and Observability

Implement per-run and per-job observability.

### Requirements

- unique run ID
- start/end timestamp
- duration
- status per job
- concise skip/failure reason
- final summary
- final non-zero process exit when any actual job failed

Logs should be human-readable while preserving enough structured information for future automation.

### Exit criteria

A failed independent branch is obvious in logs while successful unrelated jobs are also shown as completed.

---

## Phase 6 — Durable Publication Framework

Implement the orchestration-level publication abstractions described in `PLAN.md`.

Initial supported publication types should focus on known needs rather than every theoretical backend.

### Initial target

Git publication support:
- checkout/prepare target repo
- write/copy artifact
- detect no-op diff
- optional validation command
- commit only if changed
- push
- return commit SHA/path/checksum metadata

### Later/adapter-ready targets

- database writer integration where a domain owner requires it
- object storage uploader when artifact size warrants it

Do not build DB/object-store infrastructure without a concrete first consumer.

### Exit criteria

A synthetic generated artifact can be published to a Git test target with correct no-change behavior.

---

## Phase 7 — Worker Version Pinning and Packaging

Define how the single Docker image obtains worker repositories.

### Initial recommendation

Pin each worker to an explicit commit SHA or tag in declarative configuration used during image build.

Initial workers:

- https://github.com/jmirving/lol-pro-data-download-cron
- https://github.com/jmirving/lol-pro-data-processor
- https://github.com/jmirving/lol-ddragon-snapshot-cron
- https://github.com/jmirving/lol-ddragon-context-artifact-builder

### Worker integration issues

- https://github.com/jmirving/lol-pro-data-download-cron/issues/1
- https://github.com/jmirving/lol-pro-data-processor/issues/1
- https://github.com/jmirving/lol-ddragon-snapshot-cron/issues/3
- https://github.com/jmirving/lol-ddragon-context-artifact-builder/issues/1

### Exit criteria

The built image can report exactly which revision of every included worker it contains.

---

## Phase 8 — Initial League Job Graph

After worker issues are complete, register the first real jobs.

Initial logical graph:

- DDragon snapshot/source job
- DDragon artifact job depending on the snapshot/source job
- Oracle download job
- Oracle processor job depending on Oracle download

These names and relationships are configuration, not scheduler logic.

### Exit criteria

All four workers can run in one local container invocation using ephemeral intermediate storage.

---

## Phase 9 — Initial Durable Outputs

Configure the first real publication targets.

### DDragon

- raw archive/extraction: ephemeral
- canonical generated artifacts: durable only where needed
- Nexus consumer update: Git commit to https://github.com/jmirving/Nexus when changed
- Clairvoyance consumer update: Git commit to https://github.com/jmirving/Clairvoyance when changed

### Oracle's Elixir

- raw yearly CSV: ephemeral
- normalized/canonical pro draft artifact: initially Git if practical by size
- do not introduce database persistence until a runtime-query use case requires it

### Exit criteria

A no-change invocation creates no generated-data commit.

---

## Phase 10 — Render Deployment

Add `render.yaml` for one Render cron service.

### Requirements

- service name: `lol-data-refresh-cron`
- one scheduled cron service
- Docker deployment
- daily outer schedule
- required environment/secrets
- smallest practical compute tier

### Exit criteria

Manual Render invocation executes the same container command used locally.

---

## Phase 11 — Shadow Run

Run the unified service without immediately removing existing scheduled services.

### Verify

- source versions
- checksums
- generated artifacts
- Nexus/CV changes
- skip behavior
- failure behavior
- repeated-run idempotency

### Exit criteria

Unified jobs are demonstrably equivalent to or better than existing service behavior.

---

## Phase 12 — Consolidation

Disable superseded individual Render cron services.

Do not merge/archive worker repositories solely because scheduling has been consolidated.

Target operational model:

> many independently owned workers, one scheduled deployment

### Exit criteria

Only `lol-data-refresh-cron` incurs the Render cron-service minimum for this workload family.

---

## Phase 13 — Future Job Onboarding Contract

Adding another scheduled worker should normally require only:

1. a stable independently executable worker,
2. a job definition,
3. dependency declarations,
4. cadence configuration,
5. required secrets,
6. durable-output configuration where needed,
7. worker revision pinning.

It should not require changes to scheduler control flow.

---

# First Implementation Slice

The first coding slice should stop before integrating any real League worker.

Build only:

1. project/runtime scaffold,
2. job/result model,
3. dependency graph validation/order,
4. cadence eligibility,
5. synthetic execution adapter,
6. summary/exit behavior,
7. tests.

This proves the generic orchestrator before worker-specific constraints can distort its design.

## First-slice acceptance tests

- `A -> B` executes in dependency order.
- `A` skipped does not inherently prevent `B` from evaluating its own eligibility/work policy.
- `A` failed prevents dependent `B` but independent `C` still runs.
- `A -> {B,C} -> D` works.
- a cycle fails validation before any job executes.
- declaration order has no effect on valid execution order.
- disabled/ineligible jobs produce explicit skipped results.
- final process exits non-zero if an actual job fails.
- no test contains knowledge of the four current League workers.

## Core implementation note

The generic core is implemented with Node.js 20+ and no runtime dependencies. The in-process `execute(context)` function remains the adapter boundary. A domain-neutral subprocess adapter now implements Phase 4 command invocation, environment/run-context passing, stream and exit capture, timeout termination, and optional structured JSON results. No worker repository is registered yet.

Execution is currently sequential in deterministic topological order. Independent branches are isolated for failure propagation but are not run concurrently. Concurrency is not required by the architecture and can be added later without changing dependency semantics.

The subprocess adapter adds only generic failure reason codes (`COMMAND_SPAWN_ERROR`, `COMMAND_EXIT_NON_ZERO`, and `INVALID_STRUCTURED_OUTPUT`) to the existing result contract. Status and dependency semantics are unchanged. See [COMMAND_ADAPTER.md](COMMAND_ADAPTER.md) for the external worker contract.

Runtime profile selection is implemented at the CLI boundary with validated
`local`, `test`, and `production` definitions. Job construction receives the
resolved profile by injection, while the generic orchestrator only carries safe
run metadata. Secrets are environment-only and excluded from serialization. See
[RUNTIME_PROFILES.md](RUNTIME_PROFILES.md) for the schema and CLI contract.
