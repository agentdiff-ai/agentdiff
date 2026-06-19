# Public Repo Bakeoff

This bakeoff checks whether agentdiff can scan unfamiliar JavaScript and TypeScript agent repos without hidden local state, API keys, or a hosted backend.

It is meant to test scanner survivability and false-positive behavior. It is not a security audit, not a claim that these repos are unsafe, and not a benchmark of model quality.

Run it locally:

```bash
npm run stranger:bakeoff
```

The generated report is written to:

```txt
.agentdiff/stranger-tests/latest/report.md
```

## Latest Results

Latest run: June 19, 2026 on Windows, Node `v22.11.0`.

| repo | scan status | reachable high-risk surfaces | likely false positives | crash? | useful signal? |
| --- | --- | ---: | ---: | --- | --- |
| `langchain-ai/memory-agent-js` | passed | 0 | 1 | no | unclear |
| `langchain-ai/agents-from-scratch-ts` | passed | 3 | 3 | no | yes |
| `mastra-ai/mastra` | passed, partial | 12 | 8 | no | yes |
| `vercel-labs/github-tools` | passed | 3 | 8 | no | yes |
| `langchain-ai/langgraphjs` | passed | 12 | 8 | no | yes |

## What This Proves

- A fresh clone can install and run the core demos.
- Agentdiff can scan five unfamiliar public JS/TS agent repos without crashing.
- Large repos degrade into partial maps with warnings instead of failing.
- The report separates reachable high-risk surfaces from high-risk-looking but unreachable surfaces.

## What This Does Not Prove

- This is not a claim that any scanned project has a vulnerability.
- This is not a full static analysis benchmark.
- This does not evaluate model output quality.
- This does not yet cover package import graphs or `tsconfig` path aliases.

## What Changed Because Of The Bakeoff

The bakeoff found two real launch blockers:

- Large repos could crash scan with `Invalid string length`.
- Broad path/name heuristics were too noisy on docs, skill files, and generated-looking repo areas.

Fixes added:

- Scan limits for file size, file count, total bytes read, and map size.
- Generated/heavy directory skips for folders like `node_modules`, `dist`, `build`, `.next`, `.turbo`, `.cache`, `vendor`, and `generated`.
- Partial maps with scan-limit warnings instead of hard failures.
- JS/TS relative import graph scanning.
- Reachable vs unreachable surface separation in maps and stranger-test reports.

## Current Lessons

- Import graph reachability makes the report more useful than path/name heuristics alone.
- Broad heuristics still produce noise, especially in documentation and skill directories.
- Package imports and `tsconfig` aliases are the next precision gap.
- The current scanner is useful for repo-awareness, not for proving runtime behavior by itself.

## Current Command

```bash
npm run stranger:bakeoff
```

The bakeoff never pushes to external repos, never opens PRs, and never requires API keys.
