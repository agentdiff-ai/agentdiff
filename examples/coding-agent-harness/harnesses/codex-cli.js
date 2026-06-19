#!/usr/bin/env node
import { spawnSync } from "node:child_process";

const available = spawnSync("codex", ["--help"], { encoding: "utf8" });

if (available.error || available.status !== 0) {
  console.log("codex-cli harness skipped: codex CLI is not available on PATH.");
  process.exit(0);
}

console.log("codex-cli harness is experimental. Recorded traces are used for the default demo.");
process.exit(0);
