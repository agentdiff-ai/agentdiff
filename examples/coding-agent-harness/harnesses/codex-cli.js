#!/usr/bin/env node
import {
  buildTrace,
  diffSnapshots,
  isCommandAvailable,
  loadScenario,
  prepareTempFixture,
  promptForScenario,
  readSnapshot,
  runCommand,
  runScenarioTestCommand,
  writeSkippedTrace,
  writeTrace
} from "./shared.js";

const adapterName = "codex-cli";
const scenario = loadScenario();

if (!isCommandAvailable("codex")) {
  const tracePath = writeSkippedTrace(adapterName, scenario, "codex-cli harness skipped: codex CLI is not available on PATH.");
  console.log(`codex-cli harness skipped: codex CLI is not available on PATH. trace: ${tracePath}`);
  process.exit(0);
}

if (!isCommandAvailable("codex", ["exec", "--help"])) {
  const tracePath = writeSkippedTrace(adapterName, scenario, "codex-cli harness skipped: codex exec is not available.");
  console.log(`codex-cli harness skipped: codex exec is not available. trace: ${tracePath}`);
  process.exit(0);
}

const fixture = prepareTempFixture(scenario);

try {
  const before = readSnapshot(fixture.fixtureDir);
  const prompt = promptForScenario(scenario);
  const codexResult = runCommand("codex", ["exec", prompt], {
    cwd: fixture.fixtureDir,
    timeoutMs: 180_000
  });
  const testResult = runScenarioTestCommand(scenario, fixture.fixtureDir);
  const after = readSnapshot(fixture.fixtureDir);
  const filesChanged = diffSnapshots(before, after);
  const trace = buildTrace({
    scenario,
    adapterName,
    finalOutput: codexResult.stdout || codexResult.stderr || "codex exec completed without output.",
    commandResults: [codexResult],
    testResult,
    filesChanged
  });
  const tracePath = writeTrace(adapterName, trace);

  console.log(`codex-cli harness trace: ${tracePath}`);
  console.log(`changed files: ${filesChanged.map((file) => file.path).join(", ") || "none"}`);
  process.exit(0);
} finally {
  fixture.cleanup();
}
