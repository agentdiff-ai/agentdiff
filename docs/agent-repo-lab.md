# Agent Repo Lab

The agent repo lab is a fixed-seed test loop for trying agentdiff against real public JavaScript and TypeScript agent repositories.

It is meant to answer product questions:

- where does agentdiff produce useful agent-relevant findings?
- where is it noisy?
- what obvious agent surfaces does it miss?
- what repo structures break or weaken the scanner?
- what should we build next?

It is not a security audit, not a claim that external repos are unsafe, and not a model-quality benchmark.

## Run

```bash
npm run lab:agent-repos
```

This writes:

```txt
.agentdiff/agent-repo-lab/latest/report.md
.agentdiff/agent-repo-lab/latest/results.json
```

The output directory is ignored by git.

## Safety

The lab:

- clones public repos into a temp directory
- uses shallow clones
- does not install dependencies
- does not require API keys
- does not run live model harnesses
- does not push branches
- does not open external pull requests
- does not comment on external repositories

Synthetic PR tests are local only. For selected temp clones, the lab creates a local branch, adds a small high-risk tool fixture, modifies a likely agent file, modifies docs, runs `agentdiff classify`, and records whether the report would be useful.

## Seed Repos

The default run uses the first 10 primary seeds:

- `langchain-ai/agents-from-scratch-ts`
- `langchain-ai/memory-agent-js`
- `mastra-ai/mastra`
- `vercel-labs/github-tools`
- `langchain-ai/langgraphjs`
- `langchain-ai/langgraph-101-ts`
- `langchain-ai/langgraphjs-gen-ui-examples`
- `langchain-ai/agent-inbox-langgraphjs-example`
- `vercel-labs/lead-agent`
- `cometchat/ai-agent-mastra-examples`

Archived repos are skipped by default. Use the report to see skipped repos and reasons.

## Configuration

```bash
AGENTDIFF_LAB_MAX_REPOS=10 npm run lab:agent-repos
AGENTDIFF_LAB_MAX_REPO_KB=300000 npm run lab:agent-repos
AGENTDIFF_LAB_SYNTHETIC_REPOS=3 npm run lab:agent-repos
AGENTDIFF_LAB_INCLUDE_SECONDARY=1 npm run lab:agent-repos
```

Equivalent flags:

```bash
node scripts/agent-repo-lab.js --max-repos 10 --max-repo-kb 300000 --synthetic-limit 3
node scripts/agent-repo-lab.js --include-secondary
```

## Scores

Scores are 0-5 and are intentionally lightweight.

- `install friction`: whether the public repo could be cloned and inspected without installs.
- `scan survivability`: whether `agentdiff scan` completed without crashing.
- `useful signal`: count-capped useful agent-relevant findings.
- `false-positive pressure`: lower when docs/tests/config or unclear findings dominate.
- `product fit`: whether the repo exercises agentdiff's current wedge: JS/TS agents, tools, imports, and missed surface evidence.

## Labels

The lab labels representative findings as:

- `useful`: reachable from an agent entrypoint and has state-changing or external side-effect evidence.
- `noisy`: likely docs/tests/config/example signal that should stay low pressure.
- `unclear`: agent-looking or risk-looking code without enough reachability or tool evidence.
- `missed`: obvious agent/tool/config signals found by the lab that were not present in the map.

These are product feedback labels, not vulnerability labels.

## After A Run

Read:

```bash
.agentdiff/agent-repo-lab/latest/report.md
```

The latest committed summary is in [lab-results.md](lab-results.md).

Use the `candidate GitHub issues` section only for concrete product fixes with evidence from tested repos. Do not create vague issues or issues that accuse external maintainers of unsafe code.
