import assert from "node:assert/strict";
import { buildSrt, formatSrtTimestamp, getRenderUnits, loadDemoSpec } from "../scripts/demo-factory.js";

const { spec } = loadDemoSpec("refund-support-boundary");

assert.equal(spec.id, "refund-support-boundary");
assert.equal(spec.shots.length, 4);
assert.equal(spec.outputFile, "agentdiff-refund-support-demo.mp4");
assert.equal(spec.voice.requireHumanForFinal, true);

const renderUnits = getRenderUnits(spec);
assert.equal(renderUnits.length, 6);
const totalDuration = renderUnits.reduce((sum, scene) => sum + scene.durationSeconds, 0);
assert.equal(totalDuration, 41);
assert.ok(totalDuration >= spec.video.minDurationSeconds);
assert.ok(totalDuration <= spec.video.maxDurationSeconds);
assert.equal(spec.render.transitions.length, renderUnits.length - 1);

assert.equal(formatSrtTimestamp(0), "00:00:00,000");
assert.equal(formatSrtTimestamp(10), "00:00:10,000");
assert.equal(formatSrtTimestamp(75.25), "00:01:15,250");

const srt = buildSrt(renderUnits);

assert.match(srt, /1\n00:00:00,000 --> 00:00:04,000\nNormal CI tells you if your code still runs\./);
assert.match(srt, /2\n00:00:04,000 --> 00:00:13,000\nBut it does not tell you if your agent's behavior changed/);
assert.match(srt, /3\n00:00:13,000 --> 00:00:21,000\nAgentdiff catches that behavior boundary change/);
assert.match(srt, /6\n00:00:36,000 --> 00:00:41,000\nAgentdiff: CI for agent behavior changes\./);

for (const shot of spec.shots) {
  assert.ok(shot.expectedText.length > 0, `${shot.id} should define expected visible text`);
  assert.ok(shot.caption.length < 90, `${shot.id} caption should be short enough to burn in`);
}

for (const scene of renderUnits) {
  assert.ok(scene.voiceover.length > 0, `${scene.id} should define voiceover`);
  assert.ok(scene.durationSeconds > 0, `${scene.id} should have a positive duration`);
}

console.log("demo factory tests passed");
