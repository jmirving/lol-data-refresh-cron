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
