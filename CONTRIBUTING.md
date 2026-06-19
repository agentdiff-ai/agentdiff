# Contributing

Agentdiff is an early prototype. The highest-value contributions right now are install feedback, false-positive reports, small example repos, and focused fixes that improve the PR report.

## Run Tests

```bash
node tests/diff-extraction.test.mjs
node tests/map-drift.test.mjs
node tests/coding-agent-trace.test.mjs
node packages/cli/bin/agentdiff.js demo --out .agentdiff/runs/latest
```

or:

```bash
npm test
```

## Run Demos

Behavior trace demo:

```bash
node packages/cli/bin/agentdiff.js demo
```

Recorded coding-agent harness demo:

```bash
node packages/cli/bin/agentdiff.js run --example coding-agent-harness --recorded
```

Classify a branch against `main`:

```bash
node packages/cli/bin/agentdiff.js classify --base main --head HEAD
```

Generate a starter map:

```bash
node packages/cli/bin/agentdiff.js scan --root examples/demo-support-agent --out .agentdiff/map.json
```

## Add A New Example

Add examples under `examples/<name>/` with:

- `README.md` explaining the agent behavior and failure mode
- scenario or fixture files
- recorded traces if behavior comparison is involved
- the command a user can run without API keys

Examples should prove one clear behavior risk. Avoid large demos that require external services for the default path.

## Report False Positives

Use the false positive issue template. Include:

- the report snippet
- the changed file path
- why the finding is wrong or too noisy
- whether the repo had `.agentdiff/map.json`
- the smallest diff that reproduces the issue

Do not include secrets, private customer data, API keys, or proprietary source code unless you have permission to share it.
