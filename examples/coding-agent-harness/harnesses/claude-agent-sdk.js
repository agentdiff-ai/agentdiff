#!/usr/bin/env node
import {
  buildTrace,
  diffSnapshots,
  loadScenario,
  prepareTempFixture,
  promptForScenario,
  readSnapshot,
  runScenarioTestCommand,
  writeSkippedTrace,
  writeTrace
} from "./shared.js";

const adapterName = "claude-agent-sdk";
const scenario = loadScenario();

if (!process.env.ANTHROPIC_API_KEY) {
  const tracePath = writeSkippedTrace(adapterName, scenario, "claude-agent-sdk harness skipped: ANTHROPIC_API_KEY is not set.");
  console.log(`claude-agent-sdk harness skipped: ANTHROPIC_API_KEY is not set. trace: ${tracePath}`);
  process.exit(0);
}

let sdk;
try {
  sdk = await import("@anthropic-ai/claude-agent-sdk");
} catch (error) {
  const tracePath = writeSkippedTrace(
    adapterName,
    scenario,
    `claude-agent-sdk harness skipped: install @anthropic-ai/claude-agent-sdk before live execution. ${error.message}`
  );
  console.log(`claude-agent-sdk harness skipped: missing dependency. trace: ${tracePath}`);
  process.exit(0);
}

if (typeof sdk.query !== "function") {
  const tracePath = writeSkippedTrace(adapterName, scenario, "claude-agent-sdk harness skipped: SDK did not expose query().");
  console.log(`claude-agent-sdk harness skipped: SDK did not expose query(). trace: ${tracePath}`);
  process.exit(0);
}

const fixture = prepareTempFixture(scenario);

try {
  const before = readSnapshot(fixture.fixtureDir);
  const messages = [];
  const prompt = promptForScenario(scenario);

  for await (const message of sdk.query({
    prompt,
    options: {
      cwd: fixture.fixtureDir,
      maxTurns: Number(process.env.CLAUDE_AGENT_MAX_TURNS ?? 8),
      allowedTools: ["Read", "Write", "Edit", "MultiEdit", "Bash"],
      permissionMode: "acceptEdits"
    }
  })) {
    messages.push(message);
  }

  const testResult = runScenarioTestCommand(scenario, fixture.fixtureDir);
  const after = readSnapshot(fixture.fixtureDir);
  const filesChanged = diffSnapshots(before, after);
  const trace = buildTrace({
    scenario,
    adapterName,
    finalOutput: finalOutputFromMessages(messages),
    commandResults: commandResultsFromMessages(messages),
    testResult,
    filesChanged,
    modelCalls: modelCallsFromMessages(messages)
  });
  const tracePath = writeTrace(adapterName, trace);

  console.log(`claude-agent-sdk harness trace: ${tracePath}`);
  console.log(`changed files: ${filesChanged.map((file) => file.path).join(", ") || "none"}`);
  process.exit(0);
} finally {
  fixture.cleanup();
}

function finalOutputFromMessages(messages) {
  const result = [...messages].reverse().find((message) => message.type === "result" || message.subtype === "success");
  if (result?.result) return String(result.result);

  const assistant = [...messages].reverse().find((message) => message.type === "assistant");
  const textBlocks = assistant?.message?.content?.filter((block) => block.type === "text").map((block) => block.text) ?? [];
  return textBlocks.join("\n") || "claude agent sdk completed without a text result.";
}

function commandResultsFromMessages(messages) {
  const commands = [];
  for (const message of messages) {
    const blocks = message?.message?.content ?? message?.content ?? [];
    for (const block of Array.isArray(blocks) ? blocks : []) {
      if (block.type === "tool_use" && block.name === "Bash") {
        commands.push({
          command: block.input?.command ?? "Bash",
          exit_code: null,
          stdout: "",
          stderr: "",
          duration_ms: null
        });
      }
    }
  }
  return commands;
}

function modelCallsFromMessages(messages) {
  return messages
    .filter((message) => message.type === "assistant")
    .map((message) => ({
      provider: "anthropic",
      model: message.message?.model,
      latency_ms: null,
      cost_usd: null
    }));
}
