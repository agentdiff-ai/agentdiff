# Agent Zoo

The agent zoo is a deterministic regression suite for agentdiff's core product claim.

Public repo labs answer:

```txt
does agentdiff survive real messy repos?
```

The agent zoo answers:

```txt
does agentdiff catch the behavior-risk changes we say it catches?
```

It is not a benchmark, not a security audit, and not a claim about external repositories.

## Run

```bash
npm run zoo
```

The runner writes:

```txt
.agentdiff/agent-zoo/latest/report.md
.agentdiff/agent-zoo/latest/results.json
```

The output directory is ignored by git.

## Fixture Shape

Each scenario under `examples/agent-zoo/` has:

```txt
base/          safe version
head/          risky PR version
expected.json  expected diff-aware findings
README.md      scenario explanation
```

The runner creates a temporary git repo, commits `base/`, overlays and commits `head/`, runs:

```bash
node packages/cli/bin/agentdiff.js classify --base <base-sha> --head <head-sha>
```

Then it compares the report to `expected.json`.

## Safety

The zoo:

- does not use live model calls
- does not require API keys
- does not install dependencies
- does not touch external repos
- does not execute fixture application code

## Update Mode

```bash
npm run zoo:update
```

Update mode runs the same checks and records a `last_actual` snapshot in each `expected.json`. Use it only when intentionally refreshing fixtures after reviewing the output.
