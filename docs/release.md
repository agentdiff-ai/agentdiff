# Release Checklist

Agentdiff is currently an early prototype. Public prototype installs should pin to the first tag:

```yaml
uses: agentdiff-ai/agentdiff@v0.1.0
```

`@main` follows the latest repository state and should only be used to test unreleased changes.

A future moving major tag may be introduced later:

```yaml
uses: agentdiff-ai/agentdiff@v0
```

Do not publish to npm or create additional git tags until the release owner explicitly decides to cut the next release.

## Release Checklist

Before tagging a new release:

1. Run `npm test`.
2. Run `npm run stranger`.
3. Verify the three live demo PRs:
   - unsafe behavior got riskier
   - new unmapped high-risk tool
   - coding-agent harness comparison
4. Verify `node packages/cli/bin/agentdiff.js init --github-action` creates:
   - `agentdiff.yml`
   - `.agentdiff/map.json`
   - `.agentdiff/scenarios/starter.json`
   - `.github/workflows/agentdiff.yml`
5. Open a test PR and confirm the sticky PR comment updates without duplicates.
6. Confirm `README.md`, `docs/bakeoff.md`, and `docs/suppressions.md` match current behavior.
7. Confirm no secrets or local generated artifacts are tracked.
8. Create and push the tag only after the checks above pass:

```bash
git tag v0.1.0
git push origin v0.1.0
```

## Npm

Do not publish to npm yet. The root package now has CLI metadata so a future package can expose:

```bash
agentdiff init --github-action
agentdiff scan
agentdiff classify --base main --head HEAD
```

Before npm publishing, decide whether the public package should be the root `agentdiff` package or scoped workspace packages such as `@agentdiff/cli`.
