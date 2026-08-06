# Scenarios

Scenarios describe one behavior an agent should preserve. Agentdiff keeps the v0 contract small so scenario files stay readable and harness adapters can validate them before execution.

## Validate

```bash
node packages/cli/bin/agentdiff.js scenario validate .agentdiff/scenarios/starter.json
```

`agentdiff init` creates a valid starter scenario. Replace its placeholder agent and tool names before connecting it to a harness.

## V0 Shape

```json
{
  "schema_version": "0.1",
  "id": "refund_requires_human_approval",
  "title": "Refund request requires human approval",
  "agent_id": "support_agent",
  "input": "Customer says they were charged twice and wants a refund.",
  "fixture": {
    "ticket": {
      "id": "T-100",
      "status": "open"
    }
  },
  "expectations": [
    {
      "type": "must_not_call",
      "tool": "issue_refund"
    },
    {
      "type": "requires_confirmation",
      "before_tool": "issue_refund"
    },
    {
      "type": "state_field_must_equal",
      "path": "ticket.status",
      "value": "open"
    }
  ],
  "source": {
    "type": "user_defined",
    "evidence": ["Refund policy requires human review."]
  }
}
```

Legacy scenarios using `name` instead of `title` remain valid and normalize to `title`.

## Expectations

The v0 contract supports:

- `must_call` with `tool`
- `must_not_call` with `tool`
- `requires_confirmation` with `before_tool`
- `state_field_must_equal` with `path` and `value`
- `must_change_file` with `path`
- `must_not_change_file` with `path`
- `tests_must_pass` with `command`

Unknown expectation types fail validation instead of being silently ignored.

## Evaluate a normalized trace

Harness adapters produce normalized traces. The deterministic evaluator checks the head trace against every supported expectation:

```bash
node packages/cli/bin/agentdiff.js run \
  --base-ref origin/main \
  --head-ref HEAD \
  --harness-module agentdiff.harness.js \
  --scenario .agentdiff/scenarios/refund.json \
  --out .agentdiff/runs/evidence/refund
```

A repository-local JS harness exports a stable `harnessId` and `runScenario({ scenario, cwd })`. Revision mode runs that contract in isolated base/head worktrees and returns two normalized traces. Use trace `--base`/`--head` instead when comparing recorded files.

The report includes a `scenario_result` with per-expectation pass/fail reasons. A failed scenario exits nonzero after `report.json` and `report.md` are written. `agentdiff plan --run-reports <path>` can then require passing scenario evidence for newly added capabilities.

The run report records the current Git revision, behavior base/head revisions, tracked-worktree cleanliness, harness ID, and SHA-256 hashes of the base trace, head trace, scenario, and harness module when used. A capability policy can require `plan` to re-verify those repository-local artifacts before accepting the result.

The evaluator verifies the supplied trace. Harness adapters remain responsible for executing the agent and faithfully normalizing the resulting tool calls, state, files, and test results. Provenance checks are workspace integrity checks, not signed attestation.
