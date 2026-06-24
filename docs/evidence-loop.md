# Evidence loop

This page documents the internal evidence loop behind agentdiff. It is not a benchmark, security audit, vulnerability report, or claim that any external project made a bad change.

The product premise is simple: normal CI can show that code still runs, but it does not summarize how an agent's tool or action surface changed. Agent review needs to make those behavior deltas visible.

## Summary

Agentdiff became more useful through a closed loop:

1. Mine public agent PRs read-only.
2. Verify which candidates are real behavior deltas.
3. Notice detector blind spots.
4. Fix the detector.
5. Rerun the miner.
6. Compare the verified evidence bank before and after.

The most important result from this loop was that verified regression-style cases increased from 10 to 22 after context-aware create/write/schedule/persist detection was added.

## What we tested

The local evidence-bank workflow has two layers.

First, a deterministic scanner/prospector runs for recall. It inspects public PR metadata and diffs, runs agentdiff's local classification logic, and writes compact verifier packets under `.agentdiff/open-pr-prospect/`.

Second, Codex/manual semantic verification runs for precision. The verifier labels candidates as:

- `verified_regression_candidate`
- `verified_behavior_delta`
- `comment_candidate`
- `watch`
- `reject`

The workflow is read-only:

- no external repos are modified
- no external PRs, issues, or comments are created
- no external agent code is run
- no dependencies are installed in external repos
- no live model API judge is used
- generated outputs stay local under `.agentdiff/`

## V1 evidence bank

The first verified bank was intentionally small and manual-heavy:

- raw candidates inspected: 50
- verified regression-style candidates: 10
- verified behavior deltas: 20
- comment candidates: 1
- watch: 12
- rejected: 7

This was enough to show that real PRs contain agent behavior changes that normal CI does not summarize.

## Detector blind spot found

V1 exposed a clear detector gap.

Many strong behavior deltas were not just obvious `send`, `delete`, or `refund` calls. They were capability expansions such as:

- create a new resource
- add a tab or item
- append rows
- write or save output
- schedule a workflow
- persist agent state
- execute a broader runner path

The existing diff-aware high-risk detection was better at obvious destructive or external calls than at context-dependent create/write capability changes.

## Detector improvement

Commit `9163e38` (`Detect context-aware create/write tool changes`) added context-aware create/write detection for agent/tool/MCP/workflow/API surfaces.

The detector now treats calls such as `create*`, `add*`, `append*`, `insert*`, `write*`, `save*`, `schedule*`, and `persist*` as meaningful only when the file or nearby diff context suggests an agent/tool/runtime surface.

The same pass added allowlists so benign constructor, client, DOM, and test utility patterns do not get promoted as urgent findings.

Before release, the audit caught and tightened false-positive patterns including:

- `createOctokit`
- `createGeminiClient`
- `createElevenLabsClient`
- `envWithoutDeploymentName`
- test utility factories

The final released `v0` included the tightened detector.

## V2 evidence bank

After the detector fix, the evidence miner was rerun against the same style of public PR corpus.

Raw deterministic pass:

- repos scanned: 50
- open PRs inspected: 560
- candidates found: 414
- deep-analyzed candidates: 100
- A/B/C/D: 50 / 12 / 29 / 9
- review_now/watch/skip: 4 / 58 / 38

Codex/manual verified bank:

- `verified_regression_candidate`: 22
- `verified_behavior_delta`: 20
- `comment_candidate`: 0
- `watch`: 20
- `reject`: 38

The v2 bank found 19 create/write/schedule-style regression candidates.

## What improved

The evidence bank improved in the exact category that V1 exposed:

- verified regression-style cases went from 10 to 22
- create/write/schedule/persist capability changes became visible
- the miner produced better verifier packets for future Codex/manual judgment
- no better public comment candidate emerged

That last point is useful. It means the scanner can find behavior deltas without turning every delta into a public comment. Public comments should remain rare and manually approved.

## What this does not prove

This evidence loop does not prove:

- that any external project is unsafe
- that agentdiff found vulnerabilities
- that this is a benchmark over all agent repos
- that scanner precision is perfect
- that semantic judgment is fully automated

Gold labels still used Codex/manual verification. The deterministic miner improves recall and packaging; it does not replace human judgment.

## Why this matters for users

The product wedge is concrete:

```txt
normal CI: code still passes
agentdiff: the agent can now do more
```

Examples of changes agentdiff should make visible:

- read/list spreadsheet tools become create/add/append/write spreadsheet tools
- read-only channel tools become message/image/reaction sending tools
- draft/log notification paths become external email sending paths
- get/list agent-management tools become create/delete agent tools
- list workflow behavior becomes create/update/delete/schedule workflow behavior
- transient browser output becomes persistent file storage
- constrained tool surfaces become delegated runner paths with broader file or execution access

These changes can be correct and intentional. The point is that the reviewer should see the changed capability boundary in one place.

## Next steps

The evidence loop should remain the product steering wheel:

- keep expanding the local evidence bank
- turn the strongest verified regressions into synthetic deterministic fixtures
- improve detectors only when evidence shows a real miss or noisy pattern
- keep the GitHub Action deterministic
- consider a BYOK LLM reviewer later, but do not put a generic LLM judge in core CI

The useful loop is:

```txt
detector improves -> evidence miner runs -> Codex/manual labels -> gold bank updates -> fixtures/docs/product improve
```

