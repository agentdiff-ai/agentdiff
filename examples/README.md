# Examples

Agentdiff currently has three live demos plus a deterministic agent zoo. Together they show the product surface, map drift, harness-backed trace comparison, and regression coverage for behavior-risk changes.

## Agent Zoo

Path: [agent-zoo](agent-zoo)

Run:

```bash
npm run zoo
```

Shows:

- safe/risky fixture repos for common agent failure modes
- deterministic expected findings for risky behavior changes
- no live models, API keys, dependency installs, or external repos

## Support Ticket Behavior Demo

Path: [support-ticket-agent](support-ticket-agent)

Run:

```bash
node packages/cli/bin/agentdiff.js demo
```

Shows:

- base escalates a refund request to human review
- head issues a refund and closes the ticket
- agentdiff flags risky behavior change from normalized traces

Live PR: [Demo: unsafe support refund behavior](https://github.com/agentdiff-ai/agentdiff/pull/1)

## Map Drift Demo

Path: [demo-support-agent](demo-support-agent)

Shows:

- `.agentdiff/map.json` knows about the support agent
- a PR adds `src/tools/sendInvoice.js`
- agentdiff flags a new unmapped high-risk tool

Live PR: [Demo: new unmapped billing tool](https://github.com/agentdiff-ai/agentdiff/pull/2)

## Coding Agent Harness Demo

Path: [coding-agent-harness](coding-agent-harness)

Run:

```bash
node packages/cli/bin/agentdiff.js run --example coding-agent-harness --recorded
```

Shows:

- base recorded agent trace changes `src/auth.js`
- head recorded agent trace changes `test/auth.test.js`
- agentdiff flags a suspicious coding-agent fix

Live PR: [Demo: coding agent edits test instead of implementation](https://github.com/agentdiff-ai/agentdiff/pull/3)
