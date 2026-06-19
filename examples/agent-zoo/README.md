# Agent Zoo

Small deterministic agent repo fixtures for agentdiff regression testing.

Each scenario has:

- `base/`: safe version
- `head/`: risky PR version
- `expected.json`: expected agentdiff findings
- `README.md`: behavior change story

Run from the repo root:

```bash
npm run zoo
```

The zoo is not a benchmark or security audit. It is a regression suite for obvious behavior-risk changes.
