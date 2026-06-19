import { spawnSync } from "node:child_process";
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

process.exit(result.status ?? 1);

function buildArgs(commandName, outDir) {
  if (commandName === "demo") {
    return ["demo", "--out", outDir];
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
