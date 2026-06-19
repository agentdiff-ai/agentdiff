import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const actionDir = path.dirname(fileURLToPath(import.meta.url));
const cliPath = path.resolve(actionDir, "../cli/bin/agentdiff.js");

const command = input("command") || "classify";
const out = input("out") || ".agentdiff/runs/latest";
const args = buildArgs(command, out);

console.log(`agentdiff action: node ${cliPath} ${args.join(" ")}`);

const result = spawnSync(process.execPath, [cliPath, ...args], {
  cwd: process.env.GITHUB_WORKSPACE || process.cwd(),
  stdio: "inherit",
  env: process.env
});

if (result.error) {
  console.error(`agentdiff action failed: ${result.error.message}`);
  process.exit(1);
}

appendStepSummary(out);
await upsertPullRequestComment(out);

process.exit(result.status ?? 1);

function buildArgs(commandName, outDir) {
  if (commandName === "demo") {
    return ["demo", "--out", outDir];
  }

  if (commandName === "run") {
    const example = input("example");
    const args = ["run"];
    if (example) args.push("--example", example);
    if (truthyInput("recorded")) args.push("--recorded");
    if (truthyInput("live")) args.push("--live");
    args.push("--out", outDir);

    if (!example && !truthyInput("live")) {
      throw new Error("run mode needs example for action usage, e.g. example=coding-agent-harness.");
    }

    return args;
  }

  if (commandName !== "classify") {
    throw new Error(`unsupported action command: ${commandName}`);
  }

  const files = input("files");
  if (files) {
    return ["classify", "--files", files, "--out", outDir];
  }

  const base = input("base") || defaultBaseRef();
  const head = input("head") || "HEAD";
  if (!base) {
    throw new Error("classify mode needs either files or base. Set files, or run on pull_request with a base ref.");
  }

  return ["classify", "--base", base, "--head", head, "--out", outDir];
}

function defaultBaseRef() {
  if (process.env.GITHUB_BASE_REF) {
    return `origin/${process.env.GITHUB_BASE_REF}`;
  }

  return "";
}

function input(name) {
  return process.env[`INPUT_${name.toUpperCase()}`]?.trim() || "";
}

function truthyInput(name) {
  const value = input(name).toLowerCase();
  return value === "true" || value === "1" || value === "yes";
}

function appendStepSummary(outDir) {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryPath) return;

  const workspace = process.env.GITHUB_WORKSPACE || process.cwd();
  const reportPath = path.resolve(workspace, outDir, "report.md");
  if (!fs.existsSync(reportPath)) return;

  const report = fs.readFileSync(reportPath, "utf8");
  fs.appendFileSync(summaryPath, `\n${report}\n`);
  console.log(`wrote GitHub step summary from ${reportPath}`);
}

async function upsertPullRequestComment(outDir) {
  try {
    const context = readPullRequestContext();
    if (!context) {
      console.log("skipping PR comment: not running on a pull_request event");
      return;
    }

    const token = input("github-token") || process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
    if (!token) {
      console.log("skipping PR comment: GitHub token is unavailable");
      return;
    }

    const workspace = process.env.GITHUB_WORKSPACE || process.cwd();
    const reportPath = path.resolve(workspace, outDir, "report.md");
    if (!fs.existsSync(reportPath)) {
      console.log(`skipping PR comment: report not found at ${reportPath}`);
      return;
    }

    const report = fs.readFileSync(reportPath, "utf8");
    const body = buildCommentBody({ report, runUrl: actionRunUrl() });
    const existing = await findExistingComment({ token, context });

    if (existing) {
      await githubRequest({
        token,
        method: "PATCH",
        path: `/repos/${context.repo}/issues/comments/${existing.id}`,
        body: { body }
      });
      console.log(`updated agentdiff PR comment ${existing.id}`);
      return;
    }

    const created = await githubRequest({
      token,
      method: "POST",
      path: `/repos/${context.repo}/issues/${context.pullNumber}/comments`,
      body: { body }
    });
    console.log(`created agentdiff PR comment ${created.id}`);
  } catch (error) {
    console.log(`skipping PR comment: ${error.message}`);
  }
}

function readPullRequestContext() {
  if (process.env.GITHUB_EVENT_NAME !== "pull_request") return null;
  if (!process.env.GITHUB_EVENT_PATH || !fs.existsSync(process.env.GITHUB_EVENT_PATH)) return null;
  if (!process.env.GITHUB_REPOSITORY) return null;

  const event = JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
  const pullNumber = event.pull_request?.number ?? event.number;
  if (!pullNumber) return null;

  return {
    repo: process.env.GITHUB_REPOSITORY,
    pullNumber
  };
}

async function findExistingComment({ token, context }) {
  const comments = await githubRequest({
    token,
    method: "GET",
    path: `/repos/${context.repo}/issues/${context.pullNumber}/comments?per_page=100`
  });

  return comments.find((comment) => typeof comment.body === "string" && comment.body.includes("<!-- agentdiff-report -->"));
}

function buildCommentBody({ report, runUrl }) {
  const footer = runUrl ? `\n\n[View action run](${runUrl})` : "";
  return `<!-- agentdiff-report -->\n${report.trim()}${footer}\n`;
}

function actionRunUrl() {
  const repo = process.env.GITHUB_REPOSITORY;
  const runId = process.env.GITHUB_RUN_ID;
  if (!repo || !runId) return "";
  return `https://github.com/${repo}/actions/runs/${runId}`;
}

async function githubRequest({ token, method, path: requestPath, body }) {
  const response = await fetch(`https://api.github.com${requestPath}`, {
    method,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": "agentdiff-action",
      "X-GitHub-Api-Version": "2022-11-28"
    },
    body: body ? JSON.stringify(body) : undefined
  });

  const text = await response.text();
  const data = text ? JSON.parse(text) : null;

  if (!response.ok) {
    const message = data?.message ?? response.statusText;
    throw new Error(`GitHub API ${method} ${requestPath} failed: ${response.status} ${message}`);
  }

  return data;
}
