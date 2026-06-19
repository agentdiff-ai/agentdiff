# Suppressions

Agentdiff findings are meant to be reviewable, not noisy forever. If a finding is intentional or not useful for a repo, suppress it in `agentdiff.yml` with a path glob, a reason, and an expiration date.

Suppressed findings do not fail the check, but they still appear in the report under `suppressed findings` for auditability.

## Example

```yaml
ignore:
  - path: "docs/**"
    reason: "documentation examples"
    expires: "2026-07-31"
  - path: "tests/**"
    reason: "test fixtures"
    expires: "2026-07-31"
  - path: "apps/docs/**"
    reason: "docs app metadata"
    expires: "2026-07-31"
```

## Rules

- `path` is a glob matched against repo-relative paths.
- `reason` is required. Rules without a reason do not suppress findings.
- `expires` should be `YYYY-MM-DD`.
- Missing `expires` creates a warning, but still suppresses the finding.
- Expired rules create a warning and do not suppress the finding.
- Suppressions are not deleted from the report; they move findings into `suppressed findings`.

## Suggested Workflow

1. Read the finding explanation: why flagged, reachability chain, imported-by evidence, risk evidence, and confidence reason.
2. If the finding is real and risky, add or update a scenario instead of suppressing it.
3. If it is intentional or not useful, add the narrowest path glob possible.
4. Use a short expiration date so the team revisits the decision.

## Good Suppressions

```yaml
ignore:
  - path: "docs/**"
    reason: "documentation examples are not runtime agent surfaces"
    expires: "2026-07-31"
```

```yaml
ignore:
  - path: "src/tools/sendInvoice.ts"
    reason: "intentional billing tool, covered by manual approval scenario"
    expires: "2026-07-31"
```

## Avoid

```yaml
ignore:
  - path: "**"
    reason: "too noisy"
    expires: "2026-12-31"
```

Broad suppressions make the report quiet by removing the signal. Prefer narrow paths and concrete reasons.
