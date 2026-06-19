# Release Checklist

Agentdiff is currently an early prototype. Public prototype installs should use the v0 channel:

```yaml
uses: agentdiff-ai/agentdiff@v0
```

`@v0` is a moving tag. GitHub Actions updates it to the latest green `main` commit after `npm test` and `npm run stranger` pass.

Use immutable tags when exact reproducibility matters:

```yaml
uses: agentdiff-ai/agentdiff@v0.1.0
```

`@main` follows the latest repository state and should only be used to test unreleased changes.

Do not publish to npm from release workflows.

## Continuous Delivery

`.github/workflows/release-v0.yml` runs on pushes to `main`.

It:

1. checks out full history and tags
2. installs dependencies
3. runs `npm test`
4. runs `npm run stranger`
5. force-updates the moving `v0` tag to the green commit

It does not publish to npm, create immutable patch tags, or create GitHub releases.

If the workflow cannot push the tag, enable:

```txt
Repo Settings -> Actions -> General -> Workflow permissions -> Read and write permissions
```

## Immutable Tags

`.github/workflows/release-immutable.yml` is manual only.

It accepts a version such as `v0.1.1`, validates `vMAJOR.MINOR.PATCH`, runs the same checks, creates the immutable tag only if it does not already exist, and updates `v0` to the same commit.

## Release Checklist

Before running the immutable release workflow:

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
8. Run the manual immutable release workflow with the chosen version.

Manual fallback only:

```bash
git tag v0.1.1
git push origin v0.1.1
git tag -f v0
git push origin refs/tags/v0 --force
```

## Npm

Do not publish to npm yet. The root package now has CLI metadata so a future package can expose:

```bash
agentdiff init --github-action
agentdiff scan
agentdiff classify --base main --head HEAD
```

Before npm publishing, decide whether the public package should be the root `agentdiff` package or scoped workspace packages such as `@agentdiff/cli`.
