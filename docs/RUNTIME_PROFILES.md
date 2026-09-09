# Runtime Profiles

Runtime profiles select environment-specific resources at the CLI boundary. The
scheduler, graph, and job model do not select profiles or read profile variables.

Select a profile with `--profile` or `ORCHESTRATOR_PROFILE`:

```sh
npm start -- --profile local
ORCHESTRATOR_PROFILE=test npm start
ORCHESTRATOR_WORKSPACE_ROOT=/var/lib/lol-refresh npm start -- --profile production
```

The safe default is `local`. Supported built-in identities are `local`, `test`,
and `production`. Local and test use `.work/local` and `.work/test` respectively.
Production requires `ORCHESTRATOR_WORKSPACE_ROOT`; `NODE_ENV` is not consulted.

## Definition schema

`loadRuntimeProfile(identity, options)` accepts a profile-definition map for
tests and future deployment configuration. Non-secret bindings are declared
separately from secrets:

```js
const definitions = {
  test: {
    bindings: {
      workspaceRoot: { type: "string", value: ".work/test" },
      publishEnabled: { type: "boolean", environment: "PUBLISH_ENABLED" },
      retries: { type: "integer", value: 2 },
      branches: { type: "string-array", value: ["test-output"] },
    },
    secrets: {
      publicationToken: { environment: "PUBLICATION_TOKEN" },
    },
  },
};
```

Bindings must define exactly one of `value` or `environment` and one supported
`type`: `string`, `boolean`, `integer`, or `string-array`. Values are required by
default; set `required: false` to omit a missing value. Boolean environment
values must be exactly `true` or `false`; string arrays use comma-separated
environment values.

Secret descriptors accept only `environment` and the optional `required` flag;
literal `value` fields and other fields are rejected. The secret name `toJSON`
is reserved for serialization redaction. Resolved secrets are available to the
injected job factory, but serialize as `[REDACTED]`. Only
`{ profile: identity }` is attached to run metadata. Job factories must use the
injected profile argument rather than reading process globals:

```js
export function createJobs(runtimeProfile) {
  return buildJobDefinitions(runtimeProfile.bindings, runtimeProfile.secrets);
}
```
