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
  "controls": {
    "decision": "block",
    "paths": [
      ".github/workflows/agentdiff.yml",
      ".agentdiff/scenarios/**",
      "agentdiff.harness.*"
    ]
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
        "execution": {
          "required": true,
          "current_revision": true,
          "artifacts": true,
          "harnesses": ["support-ticket-recorded"]
        }
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

## Review control integrity

The policy file, every loaded scenario, and repository-local scenario and harness artifacts used by run evidence are protected automatically. `controls.paths` adds repository-specific controls such as the Agentdiff workflow. If the planned diff changes one of these files, the report includes a `changed_review_control` entry and blocks. `controls.decision` must be `block`; a head policy cannot relax the rule that protects its own changes.

This prevents a pull request from satisfying its own policy by weakening the policy, scenario, harness, or configured workflow used to judge that same pull request. Renames are evaluated as a deletion plus an addition so moving a protected control does not hide its original path. Review and merge control changes separately. Branch protection must still require the Agentdiff check; a workflow cannot defend itself after it has been disabled outside the check.

## Decisions

- `allow`: no consequential capability or guardrail change requires review, or an explicit rule allows a covered capability.
- `review`: a capability is policy-covered but still deserves human review, an unmatched capability uses the default review decision, or a guardrail was removed.
- `block`: a matching rule is missing a required scenario or confirmation expectation, required run evidence is missing, failing, stale, produced by an unapproved harness, or backed by altered artifacts, or the pull request changes a protected review control.

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

Execute the same deterministic harness against both Git revisions before planning:

```bash
node packages/cli/bin/agentdiff.js run \
  --base-ref origin/main \
  --head-ref HEAD \
  --harness-module agentdiff.harness.js \
  --scenario .agentdiff/scenarios/refund.json \
  --out .agentdiff/runs/evidence/refund
```

The repository-local harness module executes the checked-out agent and returns the head trace. It must export a stable `harnessId` and `runScenario`:

```js
export const harnessId = "support-agent-js";

export async function runScenario({ scenario, cwd }) {
  return {
    scenario_id: scenario.id,
    tool_calls: [],
    state_after: scenario.fixture
  };
}
```

`runScenario` may execute repository code, so only use harness modules reviewed as part of the repository. Revision mode creates isolated detached worktrees under `.agentdiff/worktrees`, applies the head harness contract to both revisions, and writes generated base/head traces. This keeps the test contract constant while the agent implementation changes. Worktrees remain beneath the current checkout so Node can resolve installed root dependencies without copying or linking them.

In v0, keep the harness module self-contained apart from imports into repository code. Helper modules added only on head will not be copied into the base worktree, and workspace-package symlinks may still resolve to the current checkout rather than the isolated revision.

Agentdiff validates the basic normalized trace shape and records both generated traces plus the harness source as hashed evidence. Supplying `--base traces/base.json --head traces/head.json` remains supported for recorded traces, and `--base traces/base.json --harness-module ...` remains available for head-only execution.

When scenario expectations fail, `run` writes its report and exits nonzero. CI can use `continue-on-error: true` for that evidence step, then let `plan --run-reports .agentdiff/runs/evidence` produce the final policy decision and sticky comment.

Upload `.agentdiff/runs` as a CI artifact when reviewers need the generated trace and evidence report behind the plan. Uploading only `.agentdiff/runs/latest` omits the underlying scenario evidence.

Evidence aggregation is conservative: every eligible supplied result for a required scenario must be structurally valid and pass. Conflicting pass/fail results or malformed result summaries do not satisfy policy coverage.

`run` records the current Git revision, behavior base/head revisions, tracked-worktree cleanliness, a stable harness ID, and SHA-256 hashes for the base trace, head trace, scenario, and harness module when used. When policy enables `current_revision`, `artifacts`, or `harnesses`, `plan` only accepts evidence from a clean tracked worktree for the planned head revision, from an approved harness, whose repository-local artifacts still match the recorded hashes.

This is an integrity check inside the same trusted CI workspace. It prevents stale or accidentally copied evidence from satisfying policy, but it is not a signature, remote attestation, or proof that a harness faithfully represented model execution. Keep trace and scenario artifacts inside the repository workspace so `plan` can re-read and verify them.

## Current scope

The plan consumes evidence already produced by deterministic JS/TS diff analysis and optional normalized trace reports. It does not itself run agents, call a model, prove runtime safety, or make a vulnerability claim. v0 intentionally starts with added high-risk calls and removed escalation, review, validation, or confirmation calls.
