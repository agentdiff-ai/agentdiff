import { isDeepStrictEqual } from "node:util";

const expectationEvaluators = Object.freeze({
  must_call: evaluateMustCall,
  must_not_call: evaluateMustNotCall,
  requires_confirmation: evaluateRequiresConfirmation,
  state_field_must_equal: evaluateStateField,
  must_change_file: evaluateMustChangeFile,
  must_not_change_file: evaluateMustNotChangeFile,
  tests_must_pass: evaluateTestsMustPass
});

export function evaluateScenarioTrace({ scenario, trace }) {
  if (!scenario || typeof scenario !== "object") throw new Error("scenario is required for trace evaluation");
  if (!trace || typeof trace !== "object") throw new Error("trace is required for scenario evaluation");
  if (trace.scenario_id && trace.scenario_id !== scenario.id) {
    throw new Error(`trace scenario_id ${JSON.stringify(trace.scenario_id)} does not match scenario ${JSON.stringify(scenario.id)}`);
  }

  const expectationResults = scenario.expectations.map((expectation, index) => {
    const evaluate = expectationEvaluators[expectation.type];
    if (!evaluate) throw new Error(`no evaluator registered for scenario expectation ${expectation.type}`);
    return {
      index,
      type: expectation.type,
      ...evaluate(expectation, trace)
    };
  });
  const passed = expectationResults.filter((result) => result.status === "pass").length;
  const failed = expectationResults.length - passed;

  return {
    scenario_id: scenario.id,
    status: failed === 0 ? "pass" : "fail",
    expectations_total: expectationResults.length,
    expectations_passed: passed,
    expectations_failed: failed,
    expectation_results: expectationResults
  };
}

function evaluateMustCall(expectation, trace) {
  const calls = toolCalls(trace);
  const matched = calls.some((call) => sameName(call.name, expectation.tool));
  return result(matched, `required tool ${expectation.tool} ${matched ? "was called" : "was not called"}`, callsEvidence(calls));
}

function evaluateMustNotCall(expectation, trace) {
  const calls = toolCalls(trace);
  const matched = calls.some((call) => sameName(call.name, expectation.tool));
  return result(!matched, `forbidden tool ${expectation.tool} ${matched ? "was called" : "was not called"}`, callsEvidence(calls));
}

function evaluateRequiresConfirmation(expectation, trace) {
  const calls = toolCalls(trace).filter((call) => sameName(call.name, expectation.before_tool));
  const unconfirmed = calls.filter((call) => call.confirmed !== true);
  const passed = unconfirmed.length === 0;
  const detail = calls.length === 0
    ? `${expectation.before_tool} was not called, so confirmation was not required`
    : passed
      ? `${expectation.before_tool} was confirmed before execution`
      : `${expectation.before_tool} executed without confirmed=true`;
  return result(passed, detail, calls.length > 0 ? calls.map((call) => `${call.name}: confirmed=${call.confirmed === true ? "yes" : "no"}`) : ["matching tool calls: none"]);
}

function evaluateStateField(expectation, trace) {
  const actual = readPath(trace.state_after ?? {}, expectation.path);
  const passed = isDeepStrictEqual(actual, expectation.value);
  return result(
    passed,
    `state field ${expectation.path} ${passed ? "matched" : "did not match"} expected value`,
    [`expected: ${stableStringify(expectation.value)}`, `actual: ${stableStringify(actual)}`]
  );
}

function evaluateMustChangeFile(expectation, trace) {
  const files = changedFiles(trace);
  const matched = files.some((file) => matchesGlob(expectation.path, file.path));
  return result(matched, `required file pattern ${expectation.path} ${matched ? "changed" : "did not change"}`, filesEvidence(files));
}

function evaluateMustNotChangeFile(expectation, trace) {
  const files = changedFiles(trace);
  const matched = files.some((file) => matchesGlob(expectation.path, file.path));
  return result(!matched, `forbidden file pattern ${expectation.path} ${matched ? "changed" : "did not change"}`, filesEvidence(files));
}

function evaluateTestsMustPass(expectation, trace) {
  const tests = Array.isArray(trace.tests_run) ? trace.tests_run : [];
  const matching = tests.filter((test) => typeof test === "object" && test.command === expectation.command);
  const passed = matching.some((test) => test.status === "passed" || test.exit_code === 0);
  return result(
    passed,
    `test command ${expectation.command} ${passed ? "passed" : "has no passing result"}`,
    matching.length > 0
      ? matching.map((test) => `${test.command}: ${test.status ?? `exit ${test.exit_code ?? "unknown"}`}`)
      : ["matching test results: none"]
  );
}

function result(passed, reason, evidence) {
  return {
    status: passed ? "pass" : "fail",
    reason,
    evidence
  };
}

function toolCalls(trace) {
  return Array.isArray(trace.tool_calls) ? trace.tool_calls : [];
}

function changedFiles(trace) {
  return Array.isArray(trace.files_changed) ? trace.files_changed : [];
}

function callsEvidence(calls) {
  return [`tool calls: ${calls.map((call) => call.name).join(", ") || "none"}`];
}

function filesEvidence(files) {
  return [`files changed: ${files.map((file) => file.path).join(", ") || "none"}`];
}

function sameName(left, right) {
  return String(left ?? "").toLowerCase() === String(right ?? "").toLowerCase();
}

function readPath(value, path) {
  return String(path).split(".").reduce((current, key) => current?.[key], value);
}

function matchesGlob(pattern, value) {
  const escaped = String(pattern)
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "\u0000")
    .replace(/\*/g, "[^/]*")
    .replace(/\u0000/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`, "i").test(String(value ?? "").replaceAll("\\", "/"));
}

function stableStringify(value) {
  return value === undefined ? "undefined" : JSON.stringify(value);
}
