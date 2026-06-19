#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  buildTrace,
  diffSnapshots,
  loadScenario,
  prepareTempFixture,
  promptForScenario,
  readSnapshot,
  runCommand,
  runScenarioTestCommand,
  truncate,
  writeSkippedTrace,
  writeTrace
} from "./shared.js";

export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
export const DEFAULT_OPENROUTER_MODEL = "xiaomi/mimo-v2.5-pro";
export const FINAL_QUALITY_OPENROUTER_MODEL = "z-ai/glm-5.2";
export const OPENROUTER_PRICING = {
  "xiaomi/mimo-v2.5-pro": {
    inputTokenUsd: 0.000000435,
    outputTokenUsd: 0.00000087
  }
};

const adapterName = "openrouter-openai";

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`openrouter-openai harness failed: ${error.stack ?? error.message}`);
    process.exit(1);
  });
}

async function main() {
  const scenario = loadScenario();

  if (!process.env.OPENROUTER_API_KEY) {
    const tracePath = writeSkippedTrace(adapterName, scenario, "openrouter-openai harness skipped: OPENROUTER_API_KEY is not set.");
    console.log(`openrouter-openai harness skipped: OPENROUTER_API_KEY is not set. trace: ${tracePath}`);
    return;
  }

  let OpenAI;
  try {
    OpenAI = (await import("openai")).default;
  } catch (error) {
    const tracePath = writeSkippedTrace(adapterName, scenario, `openrouter-openai harness skipped: install openai before live execution. ${error.message}`);
    console.log(`openrouter-openai harness skipped: missing openai dependency. trace: ${tracePath}`);
    return;
  }

  const fixture = prepareTempFixture(scenario);

  try {
    const before = readSnapshot(fixture.fixtureDir);
    const client = new OpenAI({
      apiKey: process.env.OPENROUTER_API_KEY,
      baseURL: OPENROUTER_BASE_URL,
      defaultHeaders: {
        "HTTP-Referer": "https://github.com/agentdiff-ai/agentdiff",
        "X-Title": "agentdiff"
      }
    });
    const model = selectOpenRouterModel(process.env);
    const prompt = patchPlanPrompt({ scenario, fixtureDir: fixture.fixtureDir });
    const startedAt = Date.now();
    const completion = await client.chat.completions.create({
      model,
      temperature: 0,
      max_tokens: Number(process.env.OPENROUTER_MAX_TOKENS ?? 1600),
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: [
            "You produce strict JSON patch plans for small coding tasks.",
            "Return exactly one JSON object and no markdown.",
            "Never edit tests unless the user explicitly asks for test edits."
          ].join(" ")
        },
        { role: "user", content: prompt }
      ]
    });
    const latencyMs = Date.now() - startedAt;
    const rawContent = contentFromMessage(completion.choices?.[0]?.message);
    const plan = parsePatchPlan(rawContent);
    const validated = validatePatchPlan(plan);
    const estimatedCostUsd = estimateOpenRouterCostUsd({
      model,
      inputTokens: completion.usage?.prompt_tokens ?? 0,
      outputTokens: completion.usage?.completion_tokens ?? 0
    });
    enforceLiveCostCap(estimatedCostUsd);
    const applyResults = applyPatchPlan(validated, fixture.fixtureDir);
    const plannedCommandResults = runAllowedPlanCommands(validated.commands, fixture.fixtureDir, scenario);
    const testResult = plannedCommandResults[0] ?? runScenarioTestCommand(scenario, fixture.fixtureDir);
    const after = readSnapshot(fixture.fixtureDir);
    const filesChanged = diffSnapshots(before, after);
    const trace = buildTrace({
      scenario,
      adapterName,
      finalOutput: validated.summary,
      commandResults: plannedCommandResults,
      testResult,
      filesChanged,
      modelCalls: [
        {
          provider: "openrouter",
          model,
          latency_ms: latencyMs,
          input_tokens: completion.usage?.prompt_tokens ?? null,
          output_tokens: completion.usage?.completion_tokens ?? null,
          cost_usd: estimatedCostUsd
        }
      ],
      cost: estimatedCostUsd
    });
    const tracePath = writeTrace(adapterName, {
      ...trace,
      patch_plan: {
        summary: validated.summary,
        files: validated.files.map((file) => ({ path: file.path, operation: file.operation })),
        commands: validated.commands,
        applied: applyResults
      }
    });

    console.log(`openrouter-openai harness trace: ${tracePath}`);
    console.log(`model: ${model}`);
    console.log(`changed files: ${filesChanged.map((file) => file.path).join(", ") || "none"}`);
  } finally {
    fixture.cleanup();
  }
}

export function selectOpenRouterModel(env = process.env) {
  if (env.OPENROUTER_MODEL) return env.OPENROUTER_MODEL;
  if (env.OPENROUTER_QUALITY === "final" || env.AGENTDIFF_MODEL_QUALITY === "final") {
    return env.OPENROUTER_FINAL_MODEL || FINAL_QUALITY_OPENROUTER_MODEL;
  }
  return DEFAULT_OPENROUTER_MODEL;
}

export function estimateOpenRouterCostUsd({ model, inputTokens, outputTokens }) {
  const pricing = OPENROUTER_PRICING[model];
  if (!pricing) return null;
  return Number((Number(inputTokens) * pricing.inputTokenUsd + Number(outputTokens) * pricing.outputTokenUsd).toFixed(8));
}

export function parsePatchPlan(rawContent) {
  const text = String(rawContent ?? "").trim();
  if (!text) {
    throw new Error("invalid JSON patch plan: model returned empty content");
  }
  const jsonText = text.startsWith("```") ? text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "") : text;
  try {
    return JSON.parse(extractJsonObject(jsonText));
  } catch (error) {
    throw new Error(`invalid JSON patch plan: ${error.message}`);
  }
}

export function validatePatchPlan(plan) {
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) {
    throw new Error("patch plan must be an object");
  }
  if (typeof plan.summary !== "string" || plan.summary.trim() === "") {
    throw new Error("patch plan summary must be a non-empty string");
  }
  if (!Array.isArray(plan.files) || plan.files.length === 0 || plan.files.length > 5) {
    throw new Error("patch plan files must contain 1-5 file edits");
  }

  const files = plan.files.map((file, index) => validatePatchFile(file, index));
  const commands = validateCommands(plan.commands ?? []);
  return {
    summary: plan.summary.trim(),
    files,
    commands
  };
}

export function applyPatchPlan(plan, fixtureDir) {
  return plan.files.map((file) => {
    const targetPath = safeJoin(fixtureDir, file.path);
    if (!fs.existsSync(targetPath)) {
      throw new Error(`patch target does not exist: ${file.path}`);
    }

    const before = fs.readFileSync(targetPath, "utf8");
    if (!before.includes(file.find)) {
      throw new Error(`patch find text was not present in ${file.path}`);
    }

    const after = before.replace(file.find, file.replace);
    fs.writeFileSync(targetPath, after);
    return {
      path: file.path,
      operation: file.operation,
      changed: before !== after
    };
  });
}

function validatePatchFile(file, index) {
  if (!file || typeof file !== "object" || Array.isArray(file)) {
    throw new Error(`patch file ${index} must be an object`);
  }
  if (file.operation !== "replace") {
    throw new Error(`patch file ${index} uses unsupported operation: ${file.operation}`);
  }
  for (const field of ["path", "find", "replace"]) {
    if (typeof file[field] !== "string") {
      throw new Error(`patch file ${index} field ${field} must be a string`);
    }
  }
  if (file.find.length === 0) {
    throw new Error(`patch file ${index} find text must be non-empty`);
  }
  assertSafeRelativePath(file.path);
  return {
    path: file.path.replaceAll("\\", "/"),
    operation: "replace",
    find: file.find,
    replace: file.replace
  };
}

function validateCommands(commands) {
  if (!Array.isArray(commands)) {
    throw new Error("patch plan commands must be an array");
  }
  if (commands.length > 3) {
    throw new Error("patch plan may request at most 3 commands");
  }
  return commands.map((command) => {
    if (typeof command !== "string") {
      throw new Error("patch plan command must be a string");
    }
    const normalized = command.trim();
    if (!["npm test", "node test/auth.test.js"].includes(normalized)) {
      throw new Error(`patch plan command is not allowed: ${normalized}`);
    }
    return normalized;
  });
}

function assertSafeRelativePath(filePath) {
  const normalized = filePath.replaceAll("\\", "/");
  if (path.isAbsolute(filePath) || normalized.startsWith("../") || normalized.includes("/../") || normalized === "..") {
    throw new Error(`unsafe patch path: ${filePath}`);
  }
  if (normalized.startsWith(".agentdiff/") || normalized.includes("/.agentdiff/")) {
    throw new Error(`patch path may not target .agentdiff: ${filePath}`);
  }
}

function safeJoin(rootDir, relativePath) {
  const resolved = path.resolve(rootDir, relativePath);
  const root = path.resolve(rootDir);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error(`unsafe patch path: ${relativePath}`);
  }
  return resolved;
}

function runAllowedPlanCommands(commands, fixtureDir, scenario) {
  return commands.map((command) => {
    if (command === "npm test") return runScenarioTestCommand(scenario, fixtureDir);
    return runCommand(process.execPath, ["test/auth.test.js"], { cwd: fixtureDir });
  });
}

function enforceLiveCostCap(estimatedCostUsd) {
  if (estimatedCostUsd === null) return;
  const cap = Number(process.env.AGENTDIFF_MAX_LIVE_COST_USD ?? 0);
  if (cap > 0 && estimatedCostUsd > cap) {
    throw new Error(`estimated live harness cost $${estimatedCostUsd.toFixed(6)} exceeds AGENTDIFF_MAX_LIVE_COST_USD=$${cap}`);
  }
}

function contentFromMessage(message) {
  if (!message) return "";
  if (typeof message.content === "string" && message.content.trim()) return message.content;
  if (Array.isArray(message.content)) {
    return message.content
      .map((part) => {
        if (typeof part === "string") return part;
        if (typeof part?.text === "string") return part.text;
        return "";
      })
      .join("\n")
      .trim();
  }
  if (typeof message.reasoning === "string" && message.reasoning.trim()) return message.reasoning;
  return "";
}

function extractJsonObject(text) {
  const trimmed = text.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) return trimmed;
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return trimmed;
  return trimmed.slice(start, end + 1);
}

function patchPlanPrompt({ scenario, fixtureDir }) {
  const authPath = path.join(fixtureDir, "src", "auth.js");
  const testPath = path.join(fixtureDir, scenario.fixture.failing_test);
  return [
    promptForScenario(scenario),
    "",
    "Return only JSON with this exact shape:",
    '{ "summary": "...", "files": [{ "path": "src/auth.js", "operation": "replace", "find": "...", "replace": "..." }], "commands": ["npm test"] }',
    "Do not include markdown fences, comments, reasoning text, or prose outside the JSON object.",
    "",
    "Patch rules:",
    "- Use operation replace only.",
    "- Path must be relative.",
    "- Prefer src/auth.js.",
    "- Do not edit test files.",
    "- Commands may only include npm test.",
    "",
    "Current src/auth.js:",
    "```js",
    truncate(fs.readFileSync(authPath, "utf8"), 4_000),
    "```",
    "",
    "Current failing test:",
    "```js",
    truncate(fs.readFileSync(testPath, "utf8"), 4_000),
    "```"
  ].join("\n");
}
