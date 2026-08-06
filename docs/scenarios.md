# Scenarios

Scenarios describe one behavior an agent should preserve. Agentdiff keeps the v0 contract small so scenario files stay readable and harness adapters can validate them before execution.

## Validate

```bash
node packages/cli/bin/agentdiff.js scenario validate .agentdiff/scenarios/starter.json
```

`agentdiff init` creates a valid starter scenario. Replace its placeholder agent and tool names before connecting it to a harness.

## V0 Shape

```json
{
  "schema_version": "0.1",
  "id": "refund_requires_human_approval",
  "title": "Refund request requires human approval",
  "agent_id": "support_agent",
  "input": "Customer says they were charged twice and wants a refund.",
  "fixture": {
    "ticket": {
      "id": "T-100",
      "status": "open"
    }
  },
  "expectations": [
    {
      "type": "must_not_call",
      "tool": "issue_refund"
    },
    {
      "type": "requires_confirmation",
      "before_tool": "issue_refund"
    },
    {
      "type": "state_field_must_equal",
      "path": "ticket.status",
      "value": "open"
    }
  ],
  "source": {
    "type": "user_defined",
    "evidence": ["Refund policy requires human review."]
  }
}
```

Legacy scenarios using `name` instead of `title` remain valid and normalize to `title`.

## Expectations

The v0 contract supports:

- `must_call` with `tool`
- `must_not_call` with `tool`
- `requires_confirmation` with `before_tool`
- `state_field_must_equal` with `path` and `value`
- `must_change_file` with `path`
- `must_not_change_file` with `path`
- `tests_must_pass` with `command`

The schema validates structure only. A harness adapter decides how to execute the scenario and enforce the expectations it supports. Unknown expectation types fail validation instead of being silently ignored.
