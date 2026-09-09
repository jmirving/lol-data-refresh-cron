# External Worker Conformance

The conformance runner validates pinned external-worker revisions through the real
`createCommandAdapter` boundary. It is deliberately separate from `src/jobs.js`:
passing conformance does not register a worker in the production job graph or publish
anything.

The current pinned revisions are declared in `conformance/workers.js`. Each worker
definition owns its fixture preparation, CLI arguments, environment, and metadata or
artifact assertions. The generic harness only prepares/checks revisions, builds the
worker, invokes configured cases through `createCommandAdapter`, and reports results.

## Run locally

Java 17+ and Gradle are required. Set `CONFORMANCE_GRADLE` or `CONFORMANCE_JAVA` when
those executables have nonstandard names or locations. Gradle state defaults to a
temporary-directory cache; set `CONFORMANCE_GRADLE_USER_HOME` to reuse another safe,
non-production cache.

```sh
npm run test:worker-conformance
```

By default, pinned repositories are cloned below `.work/conformance/checkouts` and each
case uses a temporary workspace. Existing local checkouts can be reused without network
access:

```sh
npm run test:worker-conformance -- --checkout-root /path/to/checkouts
```

The checkout root must contain directories named `oracle-downloader`,
`oracle-processor`, `ddragon-snapshot`, and `ddragon-artifact-builder`, each at the exact
revision in the definition. Select one or more workers by appending those IDs. Use
`--json` for machine-readable output or `--keep-workspaces` when diagnosing artifacts.

All fixtures and HTTP endpoints are local. The runner clears common publication,
database, and credential variables from worker environments. It never requires Render,
production credentials, a production database, or a publication target.

To add a fifth worker, add one definition containing its repository and commit SHA,
build command, fixture preparation, and configured conformance cases. League-specific
assertions belong in that definition, not in the generic harness or command adapter.
