# Agent Repo Lab Results

This page summarizes the latest fixed-seed agent repo lab run. The lab clones public JS/TS agent repos into temporary directories, runs agentdiff without installing dependencies or using API keys, and records useful, noisy, unclear, and missed signals.

This is not a security audit, not a benchmark, and not a claim that external repos are unsafe. It is product evidence for scanner survivability and signal quality on unfamiliar agent repos.

## Latest Run

Source output: `.agentdiff/agent-repo-lab/latest/report.md` and `.agentdiff/agent-repo-lab/latest/results.json`

These raw outputs are ignored by git.

| Metric | Result |
| --- | ---: |
| Public JS/TS agent repos tested | 20 |
| Repos scanned | 20/20 |
| Skipped repos | 0 |
| Crashes | 0 |
| Useful findings | 55 |
| Noisy findings | 2 |
| Unclear findings | 37 |
| Missed signals | 118 |
| Useful synthetic PR tests | 3/3 |

## What The Run Suggests

agentdiff is already finding useful agent-relevant surfaces in several real JS/TS repo shapes: LangGraph examples, GitHub-tool agents, Mastra examples, framework SDKs, and tool-heavy agent examples.

The main remaining blind spot is not broad external package imports such as `zod`, `@langchain/langgraph`, or provider SDKs. The unresolved import report now separates those from imports that look project-local. The strongest unresolved evidence is alias-like imports that appear to connect agent entrypoints to local tools or runtime modules.

## Alias-Like Import Triage

| Repo | Alias-like unresolved imports | Evidence | Triage |
| --- | ---: | --- | --- |
| `vercel/ai` | 147 | `@/tool/weather-tool` from `examples/ai-e2e-next/agent/anthropic/tools-agent.ts`; `@/tool/sandbox-shell-tool` from `examples/ai-e2e-next/agent/openai/sandbox-agent.ts` | Likely blocks useful agent-to-tool reachability. |
| `i-am-bee/beeai-framework` | 117 | `@/agents/base.js`, `@/memory/base.js`, and `@/backend/message.js` from `typescript/src/adapters/a2a/agents/agent.ts` | Likely blocks runtime agent/framework reachability. |
| `VoltAgent/voltagent` | 56 | `@/voltagent` and `@/lib/ai/config` from `examples/next-js-chatbot-starter-template/app/api/chat/route.ts` | Likely blocks example API-route-to-agent reachability. |

Decision: alias-like imports are worth a narrow follow-up issue because the samples include agent files, tool files, and API routes importing local project modules through `@/` aliases. This should not become a universal TypeScript resolver. The useful target is high-confidence project-local alias reachability.

Follow-up: [Improve alias-like import reachability from agent repo lab](https://github.com/agentdiff-ai/agentdiff/issues/8)

## Current Lessons

- Separating unresolved imports into external dependency, workspace-like, alias-like, and unknown buckets makes the blind spot actionable.
- External dependency-like imports should not inflate product urgency by themselves.
- Alias-like imports matter when they connect agent routes or agent files to local tools, memory, runtime, or framework modules.
- Noise is currently low enough that broader false-positive work can wait.

## Reproduce

```bash
AGENTDIFF_LAB_INCLUDE_SECONDARY=1 AGENTDIFF_LAB_MAX_REPOS=20 npm run lab:agent-repos
```

The lab does not install dependencies, run live model calls, modify external repos, push branches, or comment on external repositories.
