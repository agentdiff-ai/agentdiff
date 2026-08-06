# Capability plan

`agentdiff plan` is deterministic change control for agent capabilities.

Normal CI answers whether code still runs. A capability plan answers what consequential actions were added, which guardrails were removed, whether declared policy requirements are present, and whether the pull request should be allowed, reviewed, or blocked.

## Run it

```bash
node packages/cli/bin/agentdiff.js plan \
  --base main \
  --head HEAD \
  --policy agentdiff.policy.json \
  --scenarios .agentdiff/scenarios \
  --run-reports .agentdiff/runs/evidence
```

The command always writes `report.json` and `report.md`. A `block` decision exits nonzero after writing the reports, so the GitHub Action can still update its sticky comment before failing the check.

## Policy

`agentdiff init --github-action` creates `agentdiff.policy.json`, a starter scenario, and a pull request workflow. The v0 policy contract is deliberately small:

```json
{
  "version": "0.1",
  "defaults": {
    "unmatched": "review"
  },
  "rules": [
    {
      "id": "refunds-require-approval",
      "capability": "issue_refund",
      "path": "src/agents/**",
      "reason": "Refund execution requires human approval.",
      "require": {
        "scenarios": ["refund_requires_human_approval"],
        "confirmation": true,
        "execution": true
      },
      "decision": {
        "covered": "review",
        "uncovered": "block"
      }
    }
  ]
}
```

`capability` and optional `path` support `*`, `**`, and `?` globs. Rules are evaluated in file order; the first matching rule wins.

## Decisions

- `allow`: no consequential capability or guardrail change requires review, or an explicit rule allows a covered capability.
- `review`: a capability is policy-covered but still deserves human review, an unmatched capability uses the default review decision, or a guardrail was removed.
- `block`: a matching rule is missing a required scenario or confirmation expectation, or a rule with `execution: true` has no passing scenario result in the supplied run reports.

Overall precedence is `block`, then `review`, then `allow`.

## Scenario coverage

Required scenario IDs are loaded from `.agentdiff/scenarios/**/*.json` and validated against the shared scenario contract. When a rule requires confirmation, at least one required scenario must include:

```json
{
  "type": "requires_confirmation",
  "before_tool": "issue_refund"
}
```

See [scenarios.md](scenarios.md) for all supported expectation types.

Evaluate a normalized head trace against the scenario before planning:

```bash
node packages/cli/bin/agentdiff.js run \
  --base traces/base.json \
  --head traces/head.json \
  --scenario .agentdiff/scenarios/refund.json \
  --out .agentdiff/runs/evidence/refund
```

When scenario expectations fail, `run` writes its report and exits nonzero. CI can use `continue-on-error: true` for that evidence step, then let `plan --run-reports .agentdiff/runs/evidence` produce the final policy decision and sticky comment.

Evidence aggregation is conservative: every supplied result for a required scenario must be structurally valid and pass. Conflicting pass/fail results or malformed result summaries do not satisfy policy coverage.

Run evidence is a deterministic evaluation of the supplied normalized trace. The plan records the report path and result, but v0 does not cryptographically attest how the trace was produced. Recorded and live harness provenance remain the caller's responsibility.

## Current scope

The plan consumes evidence already produced by deterministic JS/TS diff analysis and optional normalized trace reports. It does not itself run agents, call a model, prove runtime safety, or make a vulnerability claim. v0 intentionally starts with added high-risk calls and removed escalation, review, validation, or confirmation calls.
