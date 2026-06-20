import assert from "node:assert/strict";
import fs from "node:fs";
import { buildAgentMap, classifyChangedFile } from "../packages/core/src/index.js";

const gold = JSON.parse(fs.readFileSync(new URL("./fixtures/action-required-gold.json", import.meta.url), "utf8"));

const expectedActionability = {
  true_positive_action_required: "action_required",
  should_be_review_recommended: "review_recommended",
  should_be_context_only: "context_only",
  should_be_likely_noise: "likely_noise"
};

assert.equal(gold.length, 40, "gold sample should stay small and stable");

for (const item of gold) {
  const file = {
    filePath: item.path,
    content: item.short_content_excerpt ?? ""
  };
  const map = buildAgentMap({
    repo: item.repo,
    files: [file]
  });
  const surface = map.surfaces.find((candidate) => candidate.path === item.path) ?? classifyChangedFile(file);

  assert.equal(
    surface.actionability,
    item.current_actionability,
    `${item.repo} ${item.path} current_actionability fixture is stale`
  );

  if (item.current_actionability_reason) {
    assert.ok(
      surface.actionability_reason?.startsWith(item.current_actionability_reason),
      `${item.repo} ${item.path} expected reason prefix ${item.current_actionability_reason}, got ${surface.actionability_reason}`
    );
  }

  if (item.expected_label === "unclear") {
    assert.notEqual(
      surface.actionability,
      "action_required",
      `${item.repo} ${item.path} unclear gold item should not be urgent without more evidence`
    );
    continue;
  }

  assert.equal(
    surface.actionability,
    expectedActionability[item.expected_label],
    `${item.repo} ${item.path} should match human gold label ${item.expected_label}`
  );
}

console.log("action-required gold tests passed");
