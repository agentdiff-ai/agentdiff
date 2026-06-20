# Why agent behavior diffs matter

Normal CI tells you whether code still runs.

Agent review also needs to show what the agent can now do: which tools it can call, which external systems it can affect, and which automation boundaries changed.

The recurring pattern is not vulnerabilities. The pattern is that agent capability changes can hide inside ordinary code diffs.

This page describes product patterns that agentdiff should make visible in review. It does not name external repos, link external PRs, or judge maintainers.

## Useful categories

Agent capability changes often show up as ordinary implementation changes:

- write-capable tool catalog expansion
- agent automation boundary changes
- agent-facing API or graph surfaces
- memory or state behavior changes

These changes can be correct and intentional. The point is that reviewers should be able to see them clearly.

## Case 1: Write-capable tool catalog expansion

A merged PR adds new tools to an agent/tool package.

The added tools can create, update, delete, trigger, cancel, or rerun external resources. The PR also expands presets so agents can expose those tools through normal configuration.

What agentdiff should surface:

- new write-capable tool names
- changed tool catalog/index files
- changed runtime tool implementation files
- an action-required behavior delta around external side effects

Why normal CI might not make this visible:

Type checks and tests can pass while the agent-visible tool catalog gains new external actions. A reviewer still has to notice that the agent can now do more than it could before.

Product lesson:

Tool catalog expansion is one of the clearest agentdiff categories. The PR comment should plainly say that the agent gained new write-capable tools.

## Case 2: Agent automation boundary change

A merged PR adds automation that reacts to CI or review events on agent-authored PRs and dispatches follow-up agent runs.

The change includes gating, skip rules, deduping, loop caps, repository opt-in, and per-PR controls. The important point is not that the automation is wrong. The important point is that the automation boundary changed.

What agentdiff should surface:

- runtime automation files
- state-update behavior in the auto-fix path
- related monitoring and external API integration paths
- a behavior delta around when an agent can react to external PR events

Why normal CI might not make this visible:

CI can validate the implementation while the product behavior changes from "an agent opens PRs" to "an agent can react to external events and attempt follow-up fixes." That boundary should be obvious in review.

Product lesson:

Agent lifecycle automation is a strong review category. The report should emphasize the automation boundary and the guardrails, not use alarmist language.

## Case 3: Agent-facing API or graph surface

A merged PR adds an agent-facing chat/API graph surface around review data.

The change adds a new graph, new API routes, state and stream proxying, and thread management behavior. The PR describes intended constraints such as read-only scope and no execution capability.

What agentdiff should surface:

- new agent-facing API route behavior
- new state/thread operations
- changed graph/tool files around the new surface
- an action-required behavior delta around the new API surface

Why normal CI might not make this visible:

CI can validate routes and tests without summarizing that the product gained a new agent-facing graph/API surface. Reviewers should see that surface and its boundaries in one place.

Product lesson:

Agent-facing API surfaces are good case studies when the wording stays neutral. "New graph/routes/state behavior appeared" is more useful than broad risk language.

## What this proves

Real PRs can contain agent capability changes.

Those changes are hard to summarize from normal CI alone.

Agentdiff can make some of them visible during review.

The strongest patterns are:

- new write-capable tools
- new automation boundaries
- new agent-facing API surfaces
- changed memory or state behavior

## What this does not prove

This is not a security audit.

This is not a vulnerability report.

This is not a claim that any project made an incorrect change.

This is not proof of perfect scanner precision.

This is evidence for a product need: agent PRs need review output that explains behavior and capability changes, not only whether tests pass.

## Product claim

agentdiff is open-source CI for AI agent behavior changes.

