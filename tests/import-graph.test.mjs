import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { buildAgentMap, buildClassificationReport } from "../packages/core/src/index.js";

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
        entrypoints: ["src/index"]
      }
    ]
  },
  files: [
    {
      filePath: "apps/web/src/supportAgent.ts",
      content: `
import React from "react";
import { sendInvoice } from "@/tools/sendInvoice";
import { closeTicket } from "~/tools/closeTicket";
import { logInvoice } from "@repo/internal";
import { runAgent } from "@repo/agent";
import { chargeCard } from "@repo/agent/tools/chargeCard";
import { outside } from "@outside/secret";
export async function runSupportAgent() {
  await sendInvoice();
  await closeTicket();
  await logInvoice();
  await runAgent();
  await chargeCard();
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
assert.equal(aliasEdges.some((edge) => edge.import_statement.includes("@outside/secret")), false);
assert.equal(aliasWorkspaceMap.import_graph.alias_imports_resolved, 3);
assert.equal(aliasWorkspaceMap.import_graph.workspace_imports_resolved, 2);
assert.deepEqual(aliasWorkspaceMap.import_graph.unresolved_non_relative_import_samples, ["@outside/secret", "react"]);

const reachableCharge = aliasWorkspaceMap.surfaces.find((surface) => surface.path === "packages/agent/src/tools/chargeCard.ts");
assert.ok(reachableCharge);
assert.equal(reachableCharge.reachable_from_entrypoint, true);

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
  fs.writeFileSync(path.join(scanFixtureRoot, "package.json"), JSON.stringify({ workspaces: ["packages/agent"] }, null, 2));
  fs.writeFileSync(
    path.join(scanFixtureRoot, "app", "supportAgent.ts"),
    `
import React from "react";
import { sendInvoice } from "@/tools/sendInvoice";
import { closeTicket } from "~/tools/closeTicket";
import { aliasTool } from "@repo/aliasOnly";
import { runAgent } from "@repo/agent";
import { chargeCard } from "@repo/agent/tools/chargeCard";
import { outside } from "@outside/secret";
export async function supportAgent() {
  await sendInvoice();
  await closeTicket();
  await aliasTool();
  await runAgent();
  await chargeCard();
  return outside;
}
`
  );
  fs.writeFileSync(path.join(scanFixtureRoot, "src", "tools", "sendInvoice.ts"), "export function sendInvoice(recipientEmail, amountUsd) { return amountUsd; }\n");
  fs.writeFileSync(path.join(scanFixtureRoot, "src", "tools", "closeTicket.ts"), "export function closeTicket(ticketId) { return ticketId; }\n");
  fs.writeFileSync(path.join(scanFixtureRoot, "packages", "aliasOnly", "src", "index.ts"), "export function aliasTool() { return true; }\n");
  fs.writeFileSync(path.join(scanFixtureRoot, "packages", "agent", "package.json"), JSON.stringify({ name: "@repo/agent", exports: "./src/index.ts" }, null, 2));
  fs.writeFileSync(path.join(scanFixtureRoot, "packages", "agent", "src", "index.ts"), "export function runAgent() { return true; }\n");
  fs.writeFileSync(path.join(scanFixtureRoot, "packages", "agent", "src", "tools", "chargeCard.ts"), "export function chargeCard(amountUsd) { return amountUsd; }\n");

  const outPath = path.join(scanFixtureRoot, ".agentdiff", "map.json");
  const result = spawnSync(process.execPath, [cli, "scan", "--root", scanFixtureRoot, "--out", outPath], {
    cwd: repoRoot,
    encoding: "utf8"
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /alias imports resolved: 3/);
  assert.match(result.stdout, /workspace imports resolved: 2/);
  assert.match(result.stdout, /unresolved non-relative imports: 2/);

  const scanMap = JSON.parse(fs.readFileSync(outPath, "utf8"));
  assert.equal(scanMap.scan.alias_imports_resolved, 3);
  assert.equal(scanMap.scan.workspace_imports_resolved, 2);
  assert.equal(scanMap.scan.unresolved_non_relative_imports, 2);
  assert.ok(scanMap.import_graph.edges.some((edge) => edge.resolved_via === "tsconfig_paths" && edge.alias_pattern === "@/*"));
  assert.ok(scanMap.import_graph.edges.some((edge) => edge.resolved_via === "tsconfig_paths" && edge.alias_pattern === "~/*"));
  assert.ok(scanMap.import_graph.edges.some((edge) => edge.resolved_via === "tsconfig_paths" && edge.alias_pattern === "@repo/*"));
  assert.ok(scanMap.import_graph.edges.some((edge) => edge.resolved_via === "workspace_package" && edge.package_name === "@repo/agent"));
} finally {
  fs.rmSync(scanFixtureRoot, { recursive: true, force: true });
}

console.log("import graph tests passed");
