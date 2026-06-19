# Bakeoff Finding Quality

This note reviews the latest stranger bakeoff output in `.agentdiff/stranger-tests/latest`.

The goal is qualitative: understand whether reachable high-risk findings are useful, noisy, or unclear. This is not a security audit, not a claim that any project is unsafe, and not a judgment on maintainers. The surfaces below are agent-relevant code areas that agentdiff should explain more clearly over time.

## Summary

| repo | representative signal | quality read | main gap |
| --- | --- | --- | --- |
| `langchain-ai/agents-from-scratch-ts` | email assistant entrypoints with HITL and memory variants | useful | imported tool files were not reachable because this repo mostly uses package imports and entrypoint inference |
| `mastra-ai/mastra` | SDK agent implementations and browser-agent tools | useful but mixed | tests and helper utilities can be promoted too strongly |
| `vercel-labs/github-tools` | chat API routes creating GitHub agents and durable workflows | useful but mixed | docs config and UI metadata can look agent-like from copy and names |
| `langchain-ai/langgraphjs` | runnable examples for SQL agents, HITL agents, streaming APIs, and checkpointing | useful but noisy | examples/docs/tests/framework internals need clearer categories |
| `langchain-ai/memory-agent-js` | memory tool detected, but not reachable | unclear | `.js` import specifiers pointing at `.ts` files and LangGraph config are not resolved yet |

## Representative Findings

### `langchain-ai/agents-from-scratch-ts`

`src/email_assistant.ts`

- Agentdiff flagged this as a reachable `agent_entrypoint` with `state_mutation` and `external_side_effect` risk.
- Evidence included path shape, model-call patterns, and action-oriented content.
- Why it might matter: this is a real email assistant surface, so PR changes here are likely behavior-relevant.
- Quality read: useful.
- Stronger evidence would include imported tool reachability and a scenario link showing which email tools can execute.

`src/email_assistant_hitl.ts`

- Flagged as a reachable agent entrypoint with side-effect risk.
- The file describes human review around agent actions, which is directly relevant to behavior-risk review.
- Quality read: useful.
- Stronger evidence would distinguish safer HITL paths from direct action paths so the report can avoid treating both as equally risky.

`src/email_assistant_hitl_memory.ts`

- Flagged as a reachable entrypoint with memory and side-effect signals.
- Why it might matter: memory updates change future agent behavior, even when they are not external customer actions.
- Quality read: useful.
- Stronger evidence would separate persistent-memory mutation from customer-visible side effects.

`src/tools/default/email-tools.ts`

- Detected as a high-risk tool implementation but marked unreachable.
- Why it might matter: email-writing and email-sending tools are behavior-relevant if imported by an agent.
- Quality read: unclear, not actionable until reachability is proven.
- Stronger evidence would come from package import resolution or configured entrypoints connecting assistants to tool modules.

`tests/README.md`

- Detected as a low-confidence high-risk-looking surface and marked unreachable.
- Quality read: noisy but correctly lowered by reachability.
- Stronger evidence would be a default docs/test suppression or a separate “documentation mentions agent behavior” category.

### `mastra-ai/mastra`

`agent-sdks/acp/src/agent.ts`

- Flagged as a reachable agent entrypoint.
- Evidence included path shape, schema/tool patterns, and imports from `agent-sdks/acp/src/index.ts`.
- Why it might matter: SDK agent implementations are core behavior surfaces.
- Quality read: useful.
- Stronger evidence would show the exported public API path and distinguish type-only imports from runtime imports.

`agent-sdks/claude/src/index.ts`

- Flagged as a reachable agent entrypoint with model-call and tool/schema evidence.
- Why it might matter: this is an agent SDK adapter surface, so behavior changes can affect real runs.
- Quality read: useful.
- Stronger evidence would include runtime call sites and explicit model/provider boundary evidence.

`agent-sdks/claude/src/utils.ts`

- Flagged as a reachable tool-like implementation.
- Why it might matter: helper utilities are imported by the Claude SDK adapter.
- Quality read: mixed. Reachability is useful, but `createNoopModel` is likely not inherently high-risk.
- Stronger evidence would discount test/no-op/mock names and avoid treating every `create*` helper as state mutation.

`browser/agent-browser/src/agent-browser.ts`

- Flagged as a reachable agent entrypoint with state and external-side-effect risk.
- Why it might matter: browser agents can perform user-visible interactions.
- Quality read: useful.
- Stronger evidence would connect the class to specific browser tools such as click, goto, and close.

`browser/agent-browser/src/tools/click.ts`

- Flagged as a reachable tool implementation.
- Why it might matter: click tools mutate browser state and can trigger external effects.
- Quality read: useful.
- Stronger evidence would say this is browser-state mutation rather than generic state mutation.

Unreachable `.claude/skills/**` and `.agents/skills/**` files were also flagged at low confidence.

- Quality read: noisy but useful as a classifier stress test.
- Stronger evidence would come from classifying skills/docs separately from runtime agent code.

### `vercel-labs/github-tools`

`apps/chat/server/api/chats/[id].post.ts`

- Flagged as a reachable agent entrypoint.
- Evidence included AI model-call patterns, tool/schema patterns, and agent creation.
- Why it might matter: a chat API route that creates a GitHub agent is a PR-relevant behavior surface.
- Quality read: useful.
- Stronger evidence would identify the GitHub toolset and whether write tools are enabled.

`apps/chat/server/api/workflow/chats/[id].post.ts`

- Flagged as a reachable agent entrypoint.
- Why it might matter: workflow-backed chat routes are agent execution boundaries.
- Quality read: useful.
- Stronger evidence would include the relative import to the durable workflow and any downstream tools.

`apps/docs/nuxt.config.ts`

- Flagged as reachable and high-risk-looking because docs metadata contains AI/tool/product language.
- Quality read: noisy.
- Stronger evidence would downrank config files unless they import or instantiate agent runtime code.

`apps/chat/shared/utils/tools/github.ts`

- Detected as an unreachable high-risk tool implementation.
- Why it might matter: GitHub actions such as creating branches or issues are state-mutating if wired into an agent.
- Quality read: unclear until reachable.
- Stronger evidence would connect UI metadata to the runtime GitHub tool invocation path.

`apps/chat/README.md`

- Flagged as low-confidence and unreachable.
- Quality read: noisy but appropriately downranked.
- Stronger evidence would move docs matches into a non-actionable documentation bucket by default.

### `langchain-ai/langgraphjs`

`examples/sql-agent/sql_agent.ts`

- Flagged as a reachable agent entrypoint.
- Why it might matter: SQL agents can execute database-facing tools, so changes here are behavior-relevant.
- Quality read: useful.
- Stronger evidence would identify query execution tools separately from read-only schema/list tools.

`examples/streaming/src/agents/hitl-agent.ts`

- Flagged as a reachable agent entrypoint with external-side-effect risk.
- Why it might matter: the example includes human-in-the-loop behavior around an email-sending action.
- Quality read: useful.
- Stronger evidence would explicitly call out the interrupt-before-execution pattern as a mitigating control.

`examples/streaming/src/api/messages.ts`

- Flagged as a reachable agent entrypoint based on model/message streaming patterns.
- Quality read: mixed. It is agent-adjacent runtime code, but not necessarily a state-mutating agent surface.
- Stronger evidence would distinguish API stream plumbing from direct agent decision logic.

`examples/ui-multimodal/src/agent.ts`

- Flagged as a reachable agent entrypoint.
- Why it might matter: multimodal agent nodes can affect user-visible behavior.
- Quality read: useful.
- Stronger evidence would connect the nodes to concrete tools or state writes.

`libs/checkpoint-postgres/src/index.ts`

- Flagged as a reachable high-risk surface.
- Why it might matter: checkpoint persistence is stateful and can affect agent execution continuity.
- Quality read: useful but should be labeled as persistence infrastructure, not agent behavior itself.
- Stronger evidence would introduce a separate persistence/checkpoint surface type.

`docs/docs/agents/tools.md`

- Flagged as high-risk-looking but unreachable.
- Quality read: noisy and correctly separated from reachable runtime code.
- Stronger evidence would suppress or demote docs examples unless the file is explicitly configured as a prompt/instruction source.

### `langchain-ai/memory-agent-js`

`src/memory_agent/tools.ts`

- Detected as a high-risk tool implementation, but not reachable.
- Why it might matter: the tool writes memories via a store and can update existing memories.
- Quality read: likely useful, but agentdiff currently lacks enough reachability evidence.
- Stronger evidence would resolve TypeScript source files imported with `.js` specifiers.

`src/memory_agent/graph.ts`

- This file is referenced by `langgraph.json`, imports `./tools.js`, and initializes/binds tools.
- Quality read: missed as a reachable high-risk path in the current bakeoff.
- Stronger evidence would parse LangGraph config entrypoints and resolve `.js` specifiers to `.ts` files.

`README.md` and `package.json`

- Both were high-risk-looking but unreachable.
- Quality read: noisy.
- Stronger evidence would avoid promoting metadata/docs files to agent entrypoints without configured runtime evidence.

## True Positive Patterns

- Runtime files that create or configure agents.
- Agent SDK adapters that call model providers or bind tools.
- Browser automation tools such as click/goto/close.
- Email, GitHub, SQL, memory, and checkpoint surfaces where state can change.
- Reachable tool modules imported by agent entrypoints.

## False Positive Patterns

- README and docs pages containing example agent vocabulary.
- Test files that import agent code for validation.
- Config files containing product copy about AI or tools.
- Helper names like `createNoopModel`, where `create` does not imply state mutation.
- Type-only imports increasing apparent reachability.

## Next Precision Improvements

1. Explain findings better: show path, reachability chain, risk words, imported-by evidence, and why the surface is actionable or informational.
2. Add suppressions in `agentdiff.yml` for docs, tests, generated areas, and intentional surfaces.
3. Resolve TypeScript source files imported with `.js` specifiers.
4. Parse framework config entrypoints such as `langgraph.json`.
5. Mark or ignore type-only imports when computing behavior reachability.
6. Split surface types for docs, tests, config, persistence, browser tools, and runtime agent entrypoints.
7. Reduce broad high-risk verbs such as `create` unless supported by stronger context.

## Product Read

The bakeoff supports the current direction: import graph reachability makes the scanner more useful than path/name heuristics alone. The next useful product work is not another broad detector; it is better explanations and suppressions so users can understand, accept, or silence findings without losing trust.
