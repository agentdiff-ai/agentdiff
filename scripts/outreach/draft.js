#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const inputPath = args[0] ?? "docs/outreach-targets.example.json";
  const outPath = readOption(args, "--out") ?? ".agentdiff/outreach/drafts.md";

  const targets = readTargets(inputPath);
  const markdown = renderDraftQueue(targets);

  fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
  fs.writeFileSync(outPath, markdown);
  console.log(`wrote ${targets.length} outreach draft(s): ${outPath}`);
}

export function renderDraftQueue(targets) {
  const now = new Date().toISOString();
  return [
    "# agentdiff outreach drafts",
    "",
    `generated_at: ${now}`,
    "status: draft-first, manual approval required",
    "",
    "These drafts are not sent automatically.",
    "",
    ...targets.flatMap((target, index) => renderTargetDraft(target, index + 1))
  ].join("\n");
}

export function renderTargetDraft(target, index) {
  const name = clean(target.name, "there");
  const company = clean(target.company, "your team");
  const role = clean(target.role, "engineering leader");
  const context = clean(target.repoOrProductContext, "agentic software");
  const why = clean(target.whyTheyMightCare, "agent behavior can change before normal CI catches it");

  return [
    `## ${index}. ${name} / ${company}`,
    "",
    `role: ${role}`,
    `context: ${context}`,
    "",
    "### Email",
    "",
    `Subject: catching risky agent behavior in PRs`,
    "",
    `Hi ${name},`,
    "",
    `I am building agentdiff, open-source CI for AI agent behavior changes. Normal CI says the code runs; agentdiff says whether the agent got riskier.`,
    "",
    `I thought of ${company} because ${why}. The current demo catches PRs that add state-mutating tool calls, map drift, and coding-agent traces where the agent edits tests instead of the implementation.`,
    "",
    `Would it be useful if I sent the 90-second demo and got your reaction?`,
    "",
    "### Twitter / DM",
    "",
    `Building agentdiff: PR-native CI for AI agent behavior changes. Thought of ${company} because ${why}. It flags risky tool-call changes, map drift, and suspicious coding-agent fixes. Worth sending you the 90-sec demo?`,
    "",
    "### GitHub Issue / Comment Draft",
    "",
    `This looks relevant to agentdiff's first design-partner use case: ${context}. The concrete risk is that ${why}. Draft ask: would you review a short demo showing PR comments for risky agent behavior changes?`,
    ""
  ];
}

function readTargets(filePath) {
  const resolved = path.resolve(filePath);
  const parsed = JSON.parse(fs.readFileSync(resolved, "utf8"));
  if (!Array.isArray(parsed)) {
    throw new Error("outreach targets must be a JSON array");
  }
  if (parsed.length === 0) {
    throw new Error("outreach targets must not be empty");
  }
  return parsed.slice(0, 10);
}

function readOption(argv, name) {
  const index = argv.indexOf(name);
  if (index === -1) return undefined;
  return argv[index + 1];
}

function clean(value, fallback) {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  return trimmed || fallback;
}
