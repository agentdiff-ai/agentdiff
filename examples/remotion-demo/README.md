# agentdiff Remotion Demo

This package renders the short launch demo video from structured data in `src/demoData.json`.

Install dependencies:

```bash
npm --prefix examples/remotion-demo install
```

Validate the scene data:

```bash
npm --prefix examples/remotion-demo run validate-data
```

Render the MP4:

```bash
npm --prefix examples/remotion-demo run video
```

Output:

```txt
examples/remotion-demo/dist/agentdiff-demo.mp4
```

The `dist/` output is generated and ignored by git. Commit source data, scripts, and package lock changes, not rendered videos by default.
