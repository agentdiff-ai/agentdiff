import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { buildAgentMap, buildClassificationReport, classifyChangedFile } from "../packages/core/src/index.js";

const files = [
  {
    filePath: "src/supportAgent.js",
    content: `
import React from "react";
import { issueRefund } from "./tools/refund";
import "./side-effect";
export { sendInvoice } from "./tools";
const closeTicket = require("./tools/closeTicket");
export async function runSupportAgent() {
  await issueRefund();
  await closeTicket();
}
`
  },
  {
    filePath: "src/side-effect.ts",
    content: `export const sideEffect = true;`
  },
  {
    filePath: "src/tools/refund.ts",
    content: `
import { auditRefund } from "../audit";
export function issueRefund(customerId, amountUsd) {
  auditRefund(customerId);
  return amountUsd;
}
`
  },
  {
    filePath: "src/audit/index.ts",
    content: `export function auditRefund(customerId) { return customerId; }`
  },
  {
    filePath: "src/tools/index.ts",
    content: `export { sendInvoice } from "./sendInvoice";`
  },
  {
    filePath: "src/tools/sendInvoice.ts",
    content: `export function sendInvoice(recipientEmail, amountUsd, customerId) { return { recipientEmail, amountUsd, customerId }; }`
  },
  {
    filePath: "src/tools/closeTicket.js",
    content: `module.exports = function closeTicket() { return true; };`
  },
  {
    filePath: "docs/agent-refund.md",
    content: `This document mentions refund, close, update, and send behavior.`
  }
];

const map = buildAgentMap({
  repo: "fixture",
  entrypointGlobs: ["src/supportAgent.js"],
  files
});

assert.deepEqual(map.import_graph.entrypoints, ["src/supportAgent.js"]);
assert.equal(map.import_graph.edges.some((edge) => edge.from === "src/supportAgent.js" && edge.to === "src/tools/refund.ts"), true);
assert.equal(map.import_graph.edges.some((edge) => edge.from === "src/tools/refund.ts" && edge.to === "src/audit/index.ts"), true);
assert.equal(map.import_graph.edges.some((edge) => edge.from === "src/supportAgent.js" && edge.to === "src/tools/index.ts"), true);
assert.equal(map.import_graph.edges.some((edge) => edge.from === "src/tools/index.ts" && edge.to === "src/tools/sendInvoice.ts"), true);
assert.equal(map.import_graph.edges.some((edge) => edge.from === "src/supportAgent.js" && edge.to === "src/tools/closeTicket.js"), true);
assert.equal(map.import_graph.edges.some((edge) => edge.import_statement.includes("react")), false);
assert.equal(map.import_graph.unresolved_non_relative_imports, 1);

const sendInvoice = map.surfaces.find((surface) => surface.path === "src/tools/sendInvoice.ts");
assert.ok(sendInvoice);
assert.equal(sendInvoice.reachable_from_entrypoint, true);
assert.deepEqual(sendInvoice.reachable_entrypoints, ["src/supportAgent.js"]);
assert.equal(sendInvoice.imported_by.some((item) => item.path === "src/tools/index.ts"), true);
assert.ok(sendInvoice.confidence >= 0.86);

const docsSurface = map.surfaces.find((surface) => surface.path === "docs/agent-refund.md");
assert.ok(docsSurface);
assert.equal(docsSurface.reachable_from_entrypoint, false);
assert.ok(docsSurface.confidence <= 0.4);
assert.ok(docsSurface.evidence.some((item) => item.includes("not reachable")));

const report = buildClassificationReport({
  repo: "fixture",
  files: [
    {
      filePath: "docs/agent-refund.md",
      content: files.at(-1).content,
      agentMap: {
        surfaces: []
      }
    }
  ]
});

assert.equal(report.map_drift.length, 1);
assert.equal(report.map_drift[0].severity, "low");
assert.notEqual(report.status, "action_required");

const aliasWorkspaceMap = buildAgentMap({
  repo: "fixture",
  entrypointGlobs: ["apps/web/src/supportAgent.ts"],
  importResolver: {
    tsconfigPaths: [
      { aliasPattern: "@/*", targetPatterns: ["src/*"] },
      { aliasPattern: "~/*", targetPatterns: ["src/*"] },
      { aliasPattern: "@repo/*", targetPatterns: ["packages/*/src"] },
      { aliasPattern: "@outside/*", targetPatterns: ["../outside/*"] }
    ],
    workspacePackages: [
      {
        packageName: "@repo/agent",
        packageRoot: "packages/agent",
        entrypoints: ["src/index"],
        subpathExports: [{ subpathPattern: "./public/*", targetPatterns: ["./source/*.ts"] }]
      }
    ]
  },
  files: [
    {
      filePath: "apps/web/src/supportAgent.ts",
      content: `
import React from "react";
import fs from "node:fs";
import { sendInvoice } from "@/tools/sendInvoice";
import { closeTicket } from "~/tools/closeTicket";
import { logInvoice } from "@repo/internal";
import { runAgent } from "@repo/agent";
import { chargeCard } from "@repo/agent/tools/chargeCard";
import { exportedTool } from "@repo/agent/public/exportedTool";
import { outside } from "@outside/secret";
import { missingAlias } from "@/missing/tool";
import { missingWorkspace } from "@repo/missing/tool";
import virtualThing from "virtual:agent-tool";
export async function runSupportAgent() {
  await sendInvoice();
  await closeTicket();
  await logInvoice();
  await runAgent();
  await chargeCard();
  await exportedTool();
  await missingAlias();
  await missingWorkspace();
  await virtualThing();
  return outside;
}
`
    },
    {
      filePath: "src/tools/sendInvoice.ts",
      content: `export function sendInvoice(recipientEmail, amountUsd, customerId) { return { recipientEmail, amountUsd, customerId }; }`
    },
    {
      filePath: "src/tools/closeTicket.ts",
      content: `export function closeTicket(ticketId) { return ticketId; }`
    },
    {
      filePath: "packages/internal/src/index.ts",
      content: `export function logInvoice(invoiceId) { return invoiceId; }`
    },
    {
      filePath: "packages/agent/src/index.ts",
      content: `import { issueRefund } from "./tools/refund"; export function runAgent() { return issueRefund; }`
    },
    {
      filePath: "packages/agent/src/tools/refund.ts",
      content: `export function issueRefund(customerId, amountUsd) { return { customerId, amountUsd }; }`
    },
    {
      filePath: "packages/agent/src/tools/chargeCard.ts",
      content: `export function chargeCard(customerId, amountUsd) { return { customerId, amountUsd }; }`
    },
    {
      filePath: "packages/agent/source/exportedTool.ts",
      content: `export function exportedTool(customerId) { return customerId; }`
    }
  ]
});

const aliasEdges = aliasWorkspaceMap.import_graph.edges;
assert.equal(
  aliasEdges.some(
    (edge) =>
      edge.to === "src/tools/sendInvoice.ts" &&
      edge.resolved_via === "tsconfig_paths" &&
      edge.alias_pattern === "@/*" &&
      edge.target_pattern === "src/*"
  ),
  true
);
assert.equal(
  aliasEdges.some((edge) => edge.to === "src/tools/closeTicket.ts" && edge.resolved_via === "tsconfig_paths" && edge.alias_pattern === "~/*"),
  true
);
assert.equal(
  aliasEdges.some(
    (edge) => edge.to === "packages/internal/src/index.ts" && edge.resolved_via === "tsconfig_paths" && edge.alias_pattern === "@repo/*"
  ),
  true
);
assert.equal(
  aliasEdges.some(
    (edge) => edge.to === "packages/agent/src/index.ts" && edge.resolved_via === "workspace_package" && edge.package_name === "@repo/agent"
  ),
  true
);
assert.equal(
  aliasEdges.some(
    (edge) => edge.to === "packages/agent/src/tools/chargeCard.ts" && edge.resolved_via === "workspace_package" && edge.package_name === "@repo/agent"
  ),
  true
);
assert.equal(
  aliasEdges.some(
    (edge) => edge.to === "packages/agent/source/exportedTool.ts" && edge.resolved_via === "workspace_package" && edge.package_name === "@repo/agent"
  ),
  true
);
assert.equal(aliasEdges.some((edge) => edge.import_statement.includes("@outside/secret")), false);
assert.equal(aliasWorkspaceMap.import_graph.alias_imports_resolved, 3);
assert.equal(aliasWorkspaceMap.import_graph.workspace_imports_resolved, 3);
assert.deepEqual(aliasWorkspaceMap.import_graph.unresolved_non_relative_import_samples, [
  "@/missing/tool",
  "@outside/secret",
  "@repo/missing/tool",
  "node:fs",
  "react",
  "virtual:agent-tool"
]);
assert.equal(aliasWorkspaceMap.import_graph.unresolved_import_buckets.external_dependency_like.count, 2);
assert.equal(aliasWorkspaceMap.import_graph.unresolved_import_buckets.alias_like.count, 2);
assert.equal(aliasWorkspaceMap.import_graph.unresolved_import_buckets.workspace_package_like.count, 1);
assert.equal(aliasWorkspaceMap.import_graph.unresolved_import_buckets.unknown.count, 1);
assert.equal(aliasWorkspaceMap.import_graph.unresolved_import_buckets.external_dependency_like.samples[0].specifier, "react");
assert.equal(aliasWorkspaceMap.import_graph.unresolved_import_buckets.workspace_package_like.samples[0].specifier, "@repo/missing/tool");

const reachableCharge = aliasWorkspaceMap.surfaces.find((surface) => surface.path === "packages/agent/src/tools/chargeCard.ts");
assert.ok(reachableCharge);
assert.equal(reachableCharge.reachable_from_entrypoint, true);

const projectAliasMap = buildAgentMap({
  repo: "fixture",
  entrypointGlobs: ["app/api/chat/route.ts", "app/agent.ts"],
  files: [
    {
      filePath: "app/agent.ts",
      content: `
import { sendEmail } from "@/tools/sendEmail";
import { missing } from "@/missing/tool";
import { unsafe } from "@/../outside/secret";
export async function agent() {
  await sendEmail();
  return { missing, unsafe };
}
`
    },
    {
      filePath: "app/api/chat/route.ts",
      content: `
import { voltagent } from "@/voltagent";
export async function POST() {
  return voltagent();
}
`
    },
    {
      filePath: "src/tools/sendEmail.ts",
      content: `export function sendEmail(recipientEmail) { return recipientEmail; }`
    },
    {
      filePath: "voltagent.ts",
      content: `export function voltagent() { return true; }`
    },
    {
      filePath: "docs/tools.md",
      content: `# tools\nsend email and refund users`
    }
  ]
});

const projectAliasEdges = projectAliasMap.import_graph.edges;
assert.equal(
  projectAliasEdges.some(
    (edge) =>
      edge.from === "app/agent.ts" &&
      edge.to === "src/tools/sendEmail.ts" &&
      edge.resolved_via === "project_alias" &&
      edge.alias_pattern === "@/*"
  ),
  true
);
assert.equal(
  projectAliasEdges.some(
    (edge) => edge.from === "app/api/chat/route.ts" && edge.to === "voltagent.ts" && edge.resolved_via === "project_alias"
  ),
  true
);
assert.equal(projectAliasEdges.some((edge) => edge.import_statement.includes("@/../outside/secret")), false);
assert.equal(projectAliasMap.import_graph.alias_imports_resolved, 2);
assert.equal(projectAliasMap.import_graph.unresolved_import_buckets.alias_like.count, 2);
assert.ok(projectAliasMap.import_graph.unresolved_import_buckets.alias_like.samples.some((sample) => sample.specifier === "@/missing/tool"));
assert.ok(projectAliasMap.import_graph.unresolved_import_buckets.alias_like.samples.some((sample) => sample.specifier === "@/../outside/secret"));

const reachableSendEmail = projectAliasMap.surfaces.find((surface) => surface.path === "src/tools/sendEmail.ts");
assert.ok(reachableSendEmail);
assert.equal(reachableSendEmail.reachable_from_entrypoint, true);

const docsToolsSurface = projectAliasMap.surfaces.find((surface) => surface.path === "docs/tools.md");
assert.ok(docsToolsSurface);
assert.equal(docsToolsSurface.surface_category, "docs_example");
assert.equal(docsToolsSurface.reachable_from_entrypoint, false);
assert.ok(docsToolsSurface.confidence <= 0.4);

const runtimeSpecifierMap = buildAgentMap({
  repo: "fixture",
  entrypointGlobs: [
    "app/graph.ts",
    "app/index-user.ts",
    "app/mjs-user.ts",
    "app/cjs-user.ts",
    "app/exact-user.ts"
  ],
  files: [
    {
      filePath: "app/graph.ts",
      content: `import { initializeTools } from "./tools.js"; export const graph = initializeTools();`
    },
    {
      filePath: "app/tools.ts",
      content: `export function initializeTools() { return []; }`
    },
    {
      filePath: "app/index-user.ts",
      content: `import { value } from "./index.js"; export const output = value;`
    },
    {
      filePath: "app/index.ts",
      content: `export const value = true;`
    },
    {
      filePath: "app/mjs-user.ts",
      content: `import { runner } from "./runner.mjs"; export const output = runner;`
    },
    {
      filePath: "app/runner.mts",
      content: `export const runner = true;`
    },
    {
      filePath: "app/cjs-user.ts",
      content: `const legacy = require("./legacy.cjs"); export const output = legacy;`
    },
    {
      filePath: "app/legacy.cts",
      content: `export const legacy = true;`
    },
    {
      filePath: "app/exact-user.ts",
      content: `import { exact } from "./exact.js"; export const output = exact;`
    },
    {
      filePath: "app/exact.js",
      content: `export const exact = "js";`
    },
    {
      filePath: "app/exact.ts",
      content: `export const exact = "ts";`
    }
  ]
});

const runtimeEdges = runtimeSpecifierMap.import_graph.edges;
const toolsFallbackEdge = runtimeEdges.find((edge) => edge.from === "app/graph.ts" && edge.to === "app/tools.ts");
assert.ok(toolsFallbackEdge);
assert.equal(toolsFallbackEdge.resolved_via, "relative");
assert.equal(toolsFallbackEdge.specifier_ext, ".js");
assert.equal(toolsFallbackEdge.resolved_source_ext, ".ts");
assert.equal(toolsFallbackEdge.note, "resolved JS runtime specifier to TS source");
assert.ok(runtimeEdges.some((edge) => edge.from === "app/index-user.ts" && edge.to === "app/index.ts" && edge.resolved_source_ext === ".ts"));
assert.ok(runtimeEdges.some((edge) => edge.from === "app/mjs-user.ts" && edge.to === "app/runner.mts" && edge.resolved_source_ext === ".mts"));
assert.ok(runtimeEdges.some((edge) => edge.from === "app/cjs-user.ts" && edge.to === "app/legacy.cts" && edge.resolved_source_ext === ".cts"));
const exactEdge = runtimeEdges.find((edge) => edge.from === "app/exact-user.ts");
assert.equal(exactEdge.to, "app/exact.js");
assert.equal(exactEdge.resolved_source_ext, undefined);

const repoRoot = process.cwd();
const cli = path.join(repoRoot, "packages", "cli", "bin", "agentdiff.js");
const scanFixtureRoot = path.join(repoRoot, "tmp-import-graph-fixture");

try {
  fs.rmSync(scanFixtureRoot, { recursive: true, force: true });
  fs.mkdirSync(path.join(scanFixtureRoot, "app"), { recursive: true });
  fs.mkdirSync(path.join(scanFixtureRoot, "src", "tools"), { recursive: true });
  fs.mkdirSync(path.join(scanFixtureRoot, "packages", "agent", "src", "tools"), { recursive: true });
  fs.mkdirSync(path.join(scanFixtureRoot, "packages", "aliasOnly", "src"), { recursive: true });

  fs.writeFileSync(path.join(scanFixtureRoot, "agentdiff.yml"), "entrypoints:\n  - app/supportAgent.ts\n");
  fs.writeFileSync(
    path.join(scanFixtureRoot, "tsconfig.json"),
    JSON.stringify(
      {
        compilerOptions: {
          baseUrl: ".",
          paths: {
            "@/*": ["src/*"],
            "~/*": ["src/*"],
            "@repo/*": ["packages/*/src"],
            "@outside/*": ["../outside/*"]
          }
        }
      },
      null,
      2
    )
  );
  fs.writeFileSync(
    path.join(scanFixtureRoot, "package.json"),
    JSON.stringify({ name: "@fixture/root", exports: { "./self": "./src/self.ts" }, workspaces: ["packages/agent"] }, null, 2)
  );
  fs.writeFileSync(
    path.join(scanFixtureRoot, "app", "supportAgent.ts"),
    `
import React from "react";
import { sendInvoice } from "@/tools/sendInvoice";
import { closeTicket } from "~/tools/closeTicket";
import { aliasTool } from "@repo/aliasOnly";
import { runAgent } from "@repo/agent";
import { chargeCard } from "@repo/agent/public/chargeCard";
import { rootSelf } from "@fixture/root/self";
import { outside } from "@outside/secret";
import { missingAlias } from "@/missing/tool";
import { missingWorkspace } from "@repo/missing/tool";
import virtualThing from "virtual:agent-tool";
export async function supportAgent() {
  await sendInvoice();
  await closeTicket();
  await aliasTool();
  await runAgent();
  await chargeCard();
  await rootSelf();
  await missingAlias();
  await missingWorkspace();
  await virtualThing();
  return outside;
}
`
  );
  fs.writeFileSync(path.join(scanFixtureRoot, "src", "tools", "sendInvoice.ts"), "export function sendInvoice(recipientEmail, amountUsd) { return amountUsd; }\n");
  fs.writeFileSync(path.join(scanFixtureRoot, "src", "tools", "closeTicket.ts"), "export function closeTicket(ticketId) { return ticketId; }\n");
  fs.writeFileSync(path.join(scanFixtureRoot, "src", "self.ts"), "export function rootSelf(customerId) { return customerId; }\n");
  fs.writeFileSync(path.join(scanFixtureRoot, "packages", "aliasOnly", "src", "index.ts"), "export function aliasTool() { return true; }\n");
  fs.writeFileSync(
    path.join(scanFixtureRoot, "packages", "agent", "package.json"),
    JSON.stringify({ name: "@repo/agent", exports: { ".": "./src/index.ts", "./public/*": "./src/tools/*.ts" } }, null, 2)
  );
  fs.writeFileSync(path.join(scanFixtureRoot, "packages", "agent", "src", "index.ts"), "export function runAgent() { return true; }\n");
  fs.writeFileSync(path.join(scanFixtureRoot, "packages", "agent", "src", "tools", "chargeCard.ts"), "export function chargeCard(amountUsd) { return amountUsd; }\n");

  const outPath = path.join(scanFixtureRoot, ".agentdiff", "map.json");
  const result = spawnSync(process.execPath, [cli, "scan", "--root", scanFixtureRoot, "--out", outPath], {
    cwd: repoRoot,
    encoding: "utf8"
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /alias imports resolved: 3/);
  assert.match(result.stdout, /workspace imports resolved: 3/);
  assert.match(result.stdout, /unresolved non-relative imports: 5/);
  assert.match(result.stdout, /unresolved external_dependency_like: 2/);
  assert.match(result.stdout, /unresolved workspace_package_like: 1/);
  assert.match(result.stdout, /unresolved alias_like: 1/);
  assert.match(result.stdout, /unresolved unknown: 1/);

  const scanMap = JSON.parse(fs.readFileSync(outPath, "utf8"));
  assert.equal(scanMap.scan.alias_imports_resolved, 3);
  assert.equal(scanMap.scan.workspace_imports_resolved, 3);
  assert.equal(scanMap.scan.unresolved_non_relative_imports, 5);
  assert.equal(scanMap.scan.unresolved_import_buckets.external_dependency_like.count, 2);
  assert.equal(scanMap.scan.unresolved_import_buckets.workspace_package_like.count, 1);
  assert.equal(scanMap.scan.unresolved_import_buckets.alias_like.count, 1);
  assert.equal(scanMap.scan.unresolved_import_buckets.unknown.count, 1);
  assert.ok(scanMap.import_graph.edges.some((edge) => edge.resolved_via === "tsconfig_paths" && edge.alias_pattern === "@/*"));
  assert.ok(scanMap.import_graph.edges.some((edge) => edge.resolved_via === "tsconfig_paths" && edge.alias_pattern === "~/*"));
  assert.ok(scanMap.import_graph.edges.some((edge) => edge.resolved_via === "tsconfig_paths" && edge.alias_pattern === "@repo/*"));
  assert.ok(scanMap.import_graph.edges.some((edge) => edge.resolved_via === "workspace_package" && edge.package_name === "@repo/agent"));
  assert.ok(scanMap.import_graph.edges.some((edge) => edge.to.endsWith("packages/agent/src/tools/chargeCard.ts") && edge.resolved_via === "workspace_package"));
  assert.ok(scanMap.import_graph.edges.some((edge) => edge.to.endsWith("src/self.ts") && edge.resolved_via === "workspace_package" && edge.package_name === "@fixture/root"));
} finally {
  fs.rmSync(scanFixtureRoot, { recursive: true, force: true });
}

const langGraphFixtureRoot = path.join(repoRoot, "tmp-langgraph-fixture");

try {
  fs.rmSync(langGraphFixtureRoot, { recursive: true, force: true });
  fs.mkdirSync(path.join(langGraphFixtureRoot, "src", "memory_agent"), { recursive: true });
  fs.writeFileSync(
    path.join(langGraphFixtureRoot, "langgraph.json"),
    JSON.stringify({ graphs: { agent: "./src/memory_agent/graph.ts:graph" } }, null, 2)
  );
  fs.writeFileSync(
    path.join(langGraphFixtureRoot, "src", "memory_agent", "graph.ts"),
    `
import { initializeTools } from "./tools.js";
export const graph = initializeTools();
`
  );
  fs.writeFileSync(
    path.join(langGraphFixtureRoot, "src", "memory_agent", "tools.ts"),
    `
export function initializeTools() {
  return [async function upsertMemory(content, memoryId) {
    return { content, memoryId };
  }];
}
`
  );

  const outPath = path.join(langGraphFixtureRoot, ".agentdiff", "map.json");
  const result = spawnSync(process.execPath, [cli, "scan", "--root", langGraphFixtureRoot, "--out", outPath], {
    cwd: repoRoot,
    encoding: "utf8"
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /LangGraph entrypoints found: 1/);

  const langGraphMap = JSON.parse(fs.readFileSync(outPath, "utf8"));
  assert.equal(langGraphMap.scan.langgraph_entrypoints, 1);
  assert.equal(langGraphMap.import_graph.entrypoints.includes("tmp-langgraph-fixture/src/memory_agent/graph.ts"), true);
  assert.deepEqual(langGraphMap.import_graph.entrypoint_sources["tmp-langgraph-fixture/src/memory_agent/graph.ts"], {
    entrypoint_source: "langgraph.json",
    graph_name: "agent"
  });
  const langGraphEdge = langGraphMap.import_graph.edges.find((edge) => edge.to === "tmp-langgraph-fixture/src/memory_agent/tools.ts");
  assert.ok(langGraphEdge);
  assert.equal(langGraphEdge.specifier_ext, ".js");
  assert.equal(langGraphEdge.resolved_source_ext, ".ts");
  const memoryTool = langGraphMap.surfaces.find((surface) => surface.path === "tmp-langgraph-fixture/src/memory_agent/tools.ts");
  assert.ok(memoryTool);
  assert.equal(memoryTool.reachable_from_entrypoint, true);
  assert.ok(memoryTool.evidence.some((item) => item.includes("reachable from entrypoint")));
} finally {
  fs.rmSync(langGraphFixtureRoot, { recursive: true, force: true });
}

const malformedLangGraphRoot = path.join(repoRoot, "tmp-langgraph-malformed");

try {
  fs.rmSync(malformedLangGraphRoot, { recursive: true, force: true });
  fs.mkdirSync(malformedLangGraphRoot, { recursive: true });
  fs.writeFileSync(path.join(malformedLangGraphRoot, "langgraph.json"), "{ invalid json");

  const outPath = path.join(malformedLangGraphRoot, ".agentdiff", "map.json");
  const result = spawnSync(process.execPath, [cli, "scan", "--root", malformedLangGraphRoot, "--out", outPath], {
    cwd: repoRoot,
    encoding: "utf8"
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /LangGraph config warning: could not parse langgraph\.json/);
  assert.ok(fs.existsSync(outPath));
} finally {
  fs.rmSync(malformedLangGraphRoot, { recursive: true, force: true });
}

const frameworkSurfaceMap = buildAgentMap({
  repo: "framework-surfaces",
  files: [
    {
      filePath: "langgraph.json",
      content: JSON.stringify({ graphs: { agent: "./src/agent.ts:graph" } })
    },
    {
      filePath: "product-hunt-agent/src/mastra/index.ts",
      content: `
import { Mastra } from "@mastra/core/mastra";
export const mastra = new Mastra({ agents: {}, workflows: {} });
`
    },
    {
      filePath: "apps/chat/server/workflows/chat.ts",
      content: `
import type { Tool } from "ai";
import type { ModelMessage, UIMessageChunk } from "ai";
export function startWorkflow() {
  return createDurableGithubAgent({ messages: [] as ModelMessage[], onChunk: (_chunk: UIMessageChunk) => {} });
}
export const workflowTools = {
  sendMessage: tool({
    parameters: z.object({ recipientEmail: z.string() }),
    execute: async ({ recipientEmail }) => ({ recipientEmail })
  })
};
`
    },
    {
      filePath: "packages/github-tools/src/types.ts",
      content: `
import type { Tool } from "ai";
export const githubTool = {
  type: "function",
  function: {
    name: "createIssue",
    parameters: { type: "object", properties: { title: { type: "string" } } }
  }
};
`
    },
    {
      filePath: "src/anthropicTool.ts",
      content: `
export const tool = {
  name: "sendEmail",
  input_schema: { type: "object", properties: { recipientEmail: { type: "string" } } }
};
`
    }
  ]
});

const langGraphConfigSurface = frameworkSurfaceMap.surfaces.find((surface) => surface.path === "langgraph.json");
assert.ok(langGraphConfigSurface);
assert.equal(langGraphConfigSurface.surface_category, "framework_config");
assert.ok(langGraphConfigSurface.evidence.some((item) => item.includes("langgraph.json")));

const mastraSurface = frameworkSurfaceMap.surfaces.find((surface) => surface.path === "product-hunt-agent/src/mastra/index.ts");
assert.ok(mastraSurface);
assert.equal(mastraSurface.surface_category, "framework_config");
assert.ok(mastraSurface.evidence.some((item) => item.includes("Mastra runtime path")));

const aiSdkSurface = frameworkSurfaceMap.surfaces.find((surface) => surface.path === "apps/chat/server/workflows/chat.ts");
assert.ok(aiSdkSurface);
assert.equal(aiSdkSurface.surface_category, "ai_sdk_tool");
assert.ok(aiSdkSurface.evidence.some((item) => item.includes("tool(...)")));
assert.ok(aiSdkSurface.evidence.some((item) => item.includes("parameters:")));
assert.ok(aiSdkSurface.evidence.some((item) => item.includes("execute:")));
assert.ok(aiSdkSurface.evidence.some((item) => item.includes("agent factory")));

const openAiSchemaSurface = frameworkSurfaceMap.surfaces.find((surface) => surface.path === "packages/github-tools/src/types.ts");
assert.ok(openAiSchemaSurface);
assert.equal(openAiSchemaSurface.surface_category, "tool_schema");
assert.ok(openAiSchemaSurface.evidence.some((item) => item.includes("Tool from ai")));
assert.ok(openAiSchemaSurface.evidence.some((item) => item.includes('type: "function"')));
assert.ok(openAiSchemaSurface.evidence.some((item) => item.includes("function { name, parameters }")));

const anthropicSchemaSurface = frameworkSurfaceMap.surfaces.find((surface) => surface.path === "src/anthropicTool.ts");
assert.ok(anthropicSchemaSurface);
assert.equal(anthropicSchemaSurface.surface_category, "tool_schema");
assert.ok(anthropicSchemaSurface.evidence.some((item) => item.includes("input_schema")));

const docsAiSdkSurface = classifyChangedFile({
  filePath: "docs/tools.md",
  content: `
Example only:
tool({
  parameters: {},
  execute: async () => {}
});
`
});
assert.equal(docsAiSdkSurface.surface_category, "docs_example");
assert.ok(docsAiSdkSurface.confidence <= 0.8);

console.log("import graph tests passed");
