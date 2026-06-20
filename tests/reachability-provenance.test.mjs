import assert from "node:assert/strict";
import { buildAgentMap, buildClassificationReport, classifyChangedFile } from "../packages/core/src/index.js";

function surfaceFor(map, path) {
  const surface = map.surfaces.find((item) => item.path === path);
  assert.ok(surface, `expected surface ${path}`);
  return surface;
}

function mapFor(files, entrypointGlobs = []) {
  return buildAgentMap({
    repo: "fixture",
    entrypointGlobs,
    files
  });
}

const toolContent = `
export async function sendEmail({ recipientEmail }) {
  return fetch("https://mail.example/send", { method: "POST", body: recipientEmail });
}
`;

{
  const map = mapFor(
    [
      { filePath: "tests/agent.test.ts", content: `import { sendEmail } from "../src/tools/sendEmail"; export async function testAgent() { return sendEmail({ recipientEmail: "a@example.com" }); }` },
      { filePath: "src/tools/sendEmail.ts", content: toolContent }
    ],
    ["tests/agent.test.ts"]
  );
  const surface = surfaceFor(map, "src/tools/sendEmail.ts");
  assert.equal(surface.reachability_provenance, "test");
  assert.equal(surface.actionability, "context_only");
}

{
  const map = mapFor(
    [
      { filePath: "examples/demo/agent.ts", content: `import { sendEmail } from "../../src/tools/sendEmail"; export async function demoAgent() { return sendEmail({ recipientEmail: "a@example.com" }); }` },
      { filePath: "src/tools/sendEmail.ts", content: toolContent }
    ],
    ["examples/demo/agent.ts"]
  );
  const surface = surfaceFor(map, "src/tools/sendEmail.ts");
  assert.equal(surface.reachability_provenance, "example");
  assert.equal(surface.actionability, "review_recommended");
}

{
  const map = mapFor(
    [
      { filePath: "archive/deprecated/agent.ts", content: `import { sendEmail } from "./sendEmail"; export async function oldAgent() { return sendEmail({ recipientEmail: "a@example.com" }); }` },
      { filePath: "archive/deprecated/sendEmail.ts", content: toolContent }
    ],
    ["archive/deprecated/agent.ts"]
  );
  const surface = surfaceFor(map, "archive/deprecated/sendEmail.ts");
  assert.equal(surface.reachability_provenance, "archive");
  assert.equal(surface.actionability, "likely_noise");
}

{
  const docsSurface = classifyChangedFile({
    filePath: "docs/tools.md",
    content: "This document explains a sendEmail tool that can send mail."
  });
  assert.equal(docsSurface.reachability_provenance, "docs");
  assert.equal(docsSurface.actionability, "likely_noise");

  const configSurface = classifyChangedFile({
    filePath: "package.json",
    content: JSON.stringify({ scripts: { sendEmail: "node send.js" } })
  });
  assert.equal(configSurface.reachability_provenance, "config");
  assert.equal(configSurface.actionability, "likely_noise");
}

{
  const map = mapFor(
    [
      { filePath: "app/api/chat/route.ts", content: `import { sendEmail } from "../../../src/tools/sendEmail"; export async function POST() { return sendEmail({ recipientEmail: "a@example.com" }); }` },
      { filePath: "src/tools/sendEmail.ts", content: toolContent }
    ],
    ["app/api/chat/route.ts"]
  );
  const surface = surfaceFor(map, "src/tools/sendEmail.ts");
  assert.equal(surface.reachability_provenance, "runtime");
  assert.equal(surface.actionability, "action_required");

  const report = buildClassificationReport({
    files: [
      {
        filePath: "src/tools/sendEmail.ts",
        content: toolContent,
        agentMap: map
      }
    ]
  });
  assert.equal(report.map_drift[0].actionability, "action_required");
  assert.equal(report.map_drift[0].severity, "high");
}

{
  const map = mapFor(
    [
      { filePath: "src/routeTree.gen.ts", content: `import { sendEmail } from "./tools/sendEmail"; export const routeTree = sendEmail;` },
      { filePath: "src/tools/sendEmail.ts", content: toolContent }
    ],
    ["src/routeTree.gen.ts"]
  );
  const surface = surfaceFor(map, "src/tools/sendEmail.ts");
  assert.equal(surface.reachability_provenance, "generated");
  assert.equal(surface.actionability, "likely_noise");

  const report = buildClassificationReport({
    files: [
      {
        filePath: "src/tools/sendEmail.ts",
        content: toolContent,
        agentMap: map
      }
    ]
  });
  assert.equal(report.map_drift[0].actionability, "likely_noise");
  assert.equal(report.map_drift[0].severity, "low");
  assert.notEqual(report.status, "action_required");
}

console.log("reachability provenance tests passed");
