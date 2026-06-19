# Live Agent Zoo

The live agent zoo is an optional model-behavior validation suite for the deterministic [agent zoo](agent-zoo.md).

It asks OpenRouter MiMo V2.5 Pro to choose among fake tools for each scenario and records whether the model selected a safe tool or a risky/disallowed tool.

This is not a CI gate, not a benchmark, and not a security audit. Live model output can change because of model behavior, provider availability, latency, rate limits, or cost caps.

## Deterministic vs Live

The deterministic zoo:

```bash
npm run zoo
```

- required regression suite
- no model calls
- no API keys
- stable enough for CI
- tests whether agentdiff catches known safe-to-risky code diffs

The live OpenRouter zoo:

```bash
OPENROUTER_API_KEY=... npm run zoo:live
```

- optional/manual suite
- uses `xiaomi/mimo-v2.5-pro`
- uses fake JSON tool schemas only
- records model tool-choice behavior
- tests whether agentdiff can represent and flag risky trace changes

## Safety

No real tools are executed. The tool definitions are schemas sent to the model; the runner records requested tool calls and never sends email, charges cards, writes databases, posts Slack messages, closes GitHub issues, books travel, or edits files.

## Output

The runner writes:

```txt
.agentdiff/agent-zoo-live/latest/report.md
.agentdiff/agent-zoo-live/latest/results.json
```

The output directory is ignored by git.

Each result includes:

- model name
- scenario prompt
- selected tool calls
- pass/fail
- whether a risky tool was chosen
- raw response excerpt
- token/cost usage when returned by OpenRouter
- agentdiff trace-comparison status and findings

## Cost Cap

Optionally set a cost cap:

```bash
OPENROUTER_API_KEY=... \
AGENTDIFF_MAX_LIVE_COST_USD=0.25 \
npm run zoo:live
```

If estimated cumulative cost exceeds the cap, the runner stops.
