# League Data Cron Orchestrator Plan

## Goal

Create a single extensible Render cron service that executes League-related scheduled data jobs while preserving existing repositories as independently testable components.

The primary motivation is cost: Render applies a per-cron-service minimum, so multiple small scheduled services are unnecessarily expensive. One orchestrator should execute the current jobs and accept additional jobs later without redesigning execution flow.

The orchestrator must **not encode assumptions about which job comes next**. Jobs may skip themselves, fail, succeed, produce artifacts, or be added, removed, or reordered over time.

Repository: https://github.com/jmirving/lol-data-refresh-cron

---

## Scope of `lol-data-refresh-cron`

This repository is the generic deployment and orchestration layer for scheduled League data maintenance.

It should contain no League-domain transformation logic that belongs in worker repositories.

Responsibilities:

1. Discover/configure jobs.
2. Determine invocation eligibility.
3. Resolve explicit dependencies.
4. Execute eligible jobs.
5. Capture structured results.
6. Continue unrelated branches after independent failures.
7. Publish durable outputs through configured publication steps.
8. Emit a final run summary.
9. Exit with an appropriate process status.

It becomes the only scheduled Render cron service for this family of maintenance jobs.

---

## Existing Worker Repositories

### Oracle's Elixir Downloader

Repository: https://github.com/jmirving/lol-pro-data-download-cron

Current responsibility:
- download Oracle's Elixir yearly exports,
- validate raw downloads,
- produce source metadata/checksums,
- hand raw data to downstream processors.

Required integration work:
https://github.com/jmirving/lol-pro-data-download-cron/issues/1

### Oracle's Elixir Processor

Repository: https://github.com/jmirving/lol-pro-data-processor

Current responsibility:
- consume Oracle's Elixir exports,
- validate expected schema,
- normalize pro-game data,
- produce compact downstream datasets.

Required integration work, including a canonical one-row-per-game draft artifact:
https://github.com/jmirving/lol-pro-data-processor/issues/1

### Data Dragon Snapshot Worker

Repository: https://github.com/jmirving/lol-ddragon-snapshot-cron

Current responsibility:
- detect the latest Data Dragon version,
- download/extract snapshots,
- record source/version/checksum information.

Required integration work, including ephemeral production snapshots:
https://github.com/jmirving/lol-ddragon-snapshot-cron/issues/3

### Data Dragon Artifact Builder

Repository: https://github.com/jmirving/lol-ddragon-context-artifact-builder

Current responsibility:
- convert Data Dragon snapshots into compact normalized artifacts,
- produce champion mapping/core/spell data for downstream consumers.

Required integration work:
https://github.com/jmirving/lol-ddragon-context-artifact-builder/issues/1

---

## Existing Consumer Pattern

Nexus: https://github.com/jmirving/Nexus

Clairvoyance: https://github.com/jmirving/Clairvoyance

Both currently keep DDragon-derived champion information in their own repositories rather than querying a centralized runtime champion database. The unified pipeline should preserve that general model unless a future runtime requirement justifies otherwise.

---

## Core Design Principle: Arbitrary Job Graph

The orchestrator operates over configured jobs and explicit dependencies, not a hardcoded sequence.

Today's graph may contain:
- DDragon snapshot refresh,
- DDragon artifact generation,
- Oracle's Elixir download,
- Oracle's Elixir processing.

Future jobs may include:
- champion-role refresh,
- pro-meta refresh,
- DraftGraph generation,
- model retraining,
- artifact validation,
- consumer synchronization,
- unrelated League maintenance jobs.

Adding another job must not require restructuring scheduler control flow.

---

## Job Contract

Every job exposes a common orchestration-level result.

Minimum statuses:
- `SUCCESS`
- `SKIPPED`
- `FAILED`

Useful result metadata:
- job ID,
- start/end time,
- duration,
- status,
- skip reason,
- error summary,
- produced artifact identifiers,
- source version/checksum,
- output checksum,
- optional metrics.

A skipped job is a normal successful orchestration outcome.

Examples:
- `SKIPPED: source version already processed`
- `SKIPPED: not eligible on this schedule`
- `SKIPPED: output checksum unchanged`

The orchestrator should report these reasons without needing to understand their domain meaning.

---

## Job Definitions

Jobs should preferably be declarative.

A job definition may include:
- ID,
- enabled state,
- worker/command/adapter,
- cadence policy,
- dependencies,
- timeout,
- failure policy,
- required environment/secrets,
- expected artifacts.

Configuration can initially live in this repository. A database-backed scheduler is unnecessary.

Changing cadence, disabling a job, or adding an independent job should not require modifying orchestration algorithms.

---

## Scheduling

Render should invoke `lol-data-refresh-cron` on one regular cadence, initially daily.

Individual jobs determine whether they are eligible for the invocation.

Examples:
- a DDragon source check may be eligible daily but commonly return `SKIPPED`,
- an Oracle refresh may be eligible only one configured weekday,
- a validation job may execute every invocation,
- a future monthly job may skip on all but one invocation each month.

The orchestrator must not hardcode facts such as "Oracle is weekly" or "DDragon is daily".

---

## Dependencies and Skip Semantics

Dependencies are explicit metadata and should support arbitrary DAGs such as fan-out and fan-in.

A skipped dependency does not automatically imply that all downstream jobs skip. A downstream job may still determine that its own artifact is stale or missing.

Dependency semantics represent execution prerequisites, not hardcoded business behavior.

If a dependency fails, dependent jobs should not run and should report a dependency-related skipped state.

---

## Failure Policy

Independent job failures should not prevent unrelated jobs from executing.

Dependency failures should prevent only dependent work.

The orchestrator exits non-zero if one or more actual jobs fail, while still allowing unrelated branches to complete.

---

# Durable Data

Render cron filesystem storage is ephemeral. Any file created during an invocation should be assumed to disappear when the process exits.

Local filesystem storage is suitable for:
- downloads,
- extraction,
- intermediate transformations,
- temporary repository checkouts,
- generated artifacts awaiting publication,
- checksums/manifests used during the current run.

It is **not** a durable handoff mechanism.

Any output required after the invocation must be published somewhere durable before the producing job can be considered successfully complete.

## Accepted Durable Storage Targets

### 1. Commit Generated Artifacts to the Worker Repository

Use when the artifact logically belongs to that worker, is small, deterministic, versionable, and useful to inspect historically.

Good examples:
- source/version manifests,
- compact mappings,
- schema fixtures,
- small canonical reference artifacts.

Avoid for:
- raw Oracle yearly exports,
- full Dragontail archives,
- frequently replaced large binaries.

### 2. Commit Generated Artifacts to a Dedicated Artifact Repository

Use when multiple workers or consumers share the same generated dataset and it does not naturally belong to one worker.

A future `lol-data-artifacts` repository is acceptable if a concrete shared-artifact use case justifies it. Do not create it preemptively.

### 3. Vendor Artifacts Directly into Consumer Repositories

Use when the consumer intentionally owns a generated build-time snapshot.

Known examples:
- Nexus: https://github.com/jmirving/Nexus
- Clairvoyance: https://github.com/jmirving/Clairvoyance

Recommended for small, slowly changing DDragon-derived champion metadata.

Publication should:
1. update the generated file,
2. compare the Git diff,
3. skip if unchanged,
4. run consumer-specific validation if changed,
5. commit/push only when changed.

### 4. Database Persistence

Use only when output is inherently runtime/queryable application state, for example data that is:
- frequently filtered/joined,
- incrementally mutable,
- runtime-consumed,
- naturally relational.

Do not use Postgres merely because Render's local filesystem is ephemeral.

### 5. Object/Blob Storage

Use for large durable file-like artifacts where Git becomes inconvenient and database querying is unnecessary.

Potential examples:
- model checkpoints,
- large Parquet datasets,
- intentionally retained raw snapshots,
- archives.

This can be added when artifact size actually warrants it.

### 6. No Durable Storage

This is valid and preferred for intermediate data that can be regenerated or consumed within the same invocation.

Examples:
- Oracle's Elixir raw yearly CSV,
- downloaded Dragontail archive,
- extracted DDragon working directory,
- temporary normalized CSVs,
- temporary Git checkouts.

## Recommended Storage Decision Order

For each output:

1. Does anything need it after this invocation?
   - No: ephemeral only.
2. Is it small, deterministic, and naturally version-controlled?
   - Yes: prefer Git.
3. Does one consumer own it?
   - Yes: vendor into that consumer repository.
4. Is it a shared artifact with multiple consumers?
   - Yes: worker repo or dedicated artifact repo.
5. Is it mutable/queryable relational runtime data?
   - Yes: database.
6. Is it large and file-like?
   - Yes: object storage.

The orchestrator must not enforce one global storage strategy.

## Initial Durable-Data Map

### DDragon raw archive/extraction
- Storage: ephemeral only.
- Worker: https://github.com/jmirving/lol-ddragon-snapshot-cron
- Issue: https://github.com/jmirving/lol-ddragon-snapshot-cron/issues/3

### DDragon canonical artifacts
- Producer: https://github.com/jmirving/lol-ddragon-context-artifact-builder
- Issue: https://github.com/jmirving/lol-ddragon-context-artifact-builder/issues/1
- Storage: compact generated files; exact publication target may vary by artifact.

### Nexus DDragon data
- Storage: commit into Nexus.
- Repository: https://github.com/jmirving/Nexus

### Clairvoyance DDragon data
- Storage: commit into Clairvoyance.
- Repository: https://github.com/jmirving/Clairvoyance

### Oracle's Elixir raw yearly file
- Storage: ephemeral only.
- Worker: https://github.com/jmirving/lol-pro-data-download-cron
- Issue: https://github.com/jmirving/lol-pro-data-download-cron/issues/1

### Canonical pro draft dataset
- Producer: https://github.com/jmirving/lol-pro-data-processor
- Issue: https://github.com/jmirving/lol-pro-data-processor/issues/1
- Initial recommendation: Git artifact if practical by size.
- Preferred targets in order:
  1. `lol-pro-data-processor` if the artifact remains reasonably sized and naturally belongs there,
  2. a dedicated artifact repo if multiple consumers make that cleaner,
  3. object storage if Git becomes inconvenient,
  4. database only if a runtime consumer actually requires database querying.

## Durable Publication Contract

Jobs that publish durable output should report:
- target type,
- target repository/database/bucket identifier,
- artifact path/key,
- source checksum/version,
- output checksum,
- artifact schema version,
- resulting Git commit SHA where applicable,
- row/object count where useful.

A generated file that was not successfully pushed/uploaded/written to its durable target is not a successfully persisted output.

## Git Publication Rules

When Git is the durable target:
- use stable artifact paths unless historical copies are explicitly required,
- compare before committing,
- do not create commits for unchanged content,
- include source/version information in commit messages where practical,
- consider generated-file markers/documentation,
- treat publication as complete only after push succeeds.

## Database Publication Rules

When a database is the durable target:
- writes must be idempotent,
- stable canonical keys should be used where possible,
- source provenance/version should be recorded,
- duplicated raw source representations should be avoided without a clear need,
- schema ownership remains with the domain/application repository, not this orchestrator.

## Object Storage Publication Rules

When object storage is used:
- object keys should be deterministic/versioned,
- checksums should be recorded,
- identical large artifacts should not be re-uploaded unnecessarily,
- downstream consumers must be able to locate the intended version,
- retention policy should be explicit.

## Durable-Data Principle

Optimize for **rebuildability rather than accumulation**.

Raw public inputs that can be downloaded again are usually disposable. Compact derived artifacts that are meaningful or expensive to reproduce should be persisted. Runtime application state belongs in the owning application's durable store.

`lol-data-refresh-cron` coordinates these decisions but does not become a data warehouse.

---

## Artifact Publication

Publication is distinct from artifact generation.

Support two broad patterns:
- shared artifact publication,
- consumer-specific vendoring.

Generating workers should not need knowledge of every consumer repository. Publication should be represented as separate jobs/adapters when appropriate.

---

## State and Idempotency

The orchestrator should retain as little private durable state as possible. Prefer deriving freshness from durable manifests/artifacts.

Useful state may include:
- source version,
- source checksum,
- output checksum,
- last successfully processed version,
- artifact schema version.

Deleting/redeploying the cron container must not destroy meaningful state.

Every job must be safe to execute repeatedly. No-change outcomes should normally return `SKIPPED`.

---

## Observability

Every invocation should have a unique run ID.

Each job should log its result independently and the orchestrator should emit a final concise summary.

Render should receive:
- exit `0` when every job succeeds or skips,
- non-zero when one or more actual jobs fail.

---

## Security and Credentials

The unified cron may require credentials for:
- GitHub reads,
- GitHub writes to selected consumer/artifact repositories,
- future authenticated data sources.

Secrets belong in Render environment configuration. No deployment credentials should be committed to this or worker repositories.

GitHub access should be scoped as narrowly as practical.

---

## Packaging Strategy

Target: one Render cron service.

Preferred initial approach: one Docker image built from this repository, containing or obtaining pinned revisions of required worker repositories.

Every deployment must be reproducible. Worker revisions should be explicit through commit SHA, tag, release, or equivalent version pinning.

Do not create a large internal packaging ecosystem until it provides concrete value.

---

## Render Deployment

This repository should contain `render.yaml` defining one cron service named `lol-data-refresh-cron`.

It should specify:
- cron service type,
- Docker/runtime configuration,
- daily schedule,
- environment variables/secrets,
- compute tier,
- start command if needed.

Existing individual cron services remain during migration and are disabled only after unified execution is verified.

---

## Testing Strategy

Scheduler tests should use synthetic jobs rather than current worker names.

Cover:
- arbitrary job lists/IDs,
- dependency ordering,
- independent branches,
- all-skipped runs,
- independent failure,
- dependency failure,
- disabled jobs,
- mixed schedules,
- jobs inserted before/after existing jobs,
- fan-out/fan-in,
- deterministic summaries,
- final exit status.

No core scheduler test should imply that the current workers are the complete universe of jobs.

---

## Rollout

1. Build the orchestration core with synthetic jobs.
2. Establish the worker execution/version-pinning mechanism.
3. Complete worker-specific integration issues in their owning repositories.
4. Register initial worker jobs.
5. Implement durable publication support.
6. Add `render.yaml` and deploy one Render cron service.
7. Shadow-run alongside existing services and compare outputs/checksums/logs.
8. Disable superseded individual Render cron services only after validation.
9. Keep worker repos independently runnable/testable.
10. Add future jobs through configuration/adapters rather than scheduler rewrites.

---

## Definition of Done

The project is complete when:
- one Render cron service executes all current scheduled League data maintenance,
- arbitrary future jobs are supported,
- ordering comes from dependencies rather than hardcoded sequencing,
- jobs can skip independently,
- unrelated branches continue after independent failures,
- raw source downloads can remain ephemeral,
- useful outputs persist through an explicit durable-publication target,
- consumer repos update only when generated content changes,
- worker repos remain independently runnable/testable,
- worker revisions are reproducible,
- Render deployment is represented in `render.yaml`,
- old Render cron services are no longer required.

---

## Explicit Non-Goals

For this repository:
- no Oracle's Elixir parsing logic,
- no Data Dragon normalization logic,
- no DraftGraph modeling,
- no DraftSage model redesign,
- no centralized runtime League-data database,
- no generalized distributed workflow engine,
- no requirement to retain historical raw source downloads,
- no assumption that today's job list is permanent.

`lol-data-refresh-cron` should stay boring: **configure, schedule, execute, observe, publish, report.**
