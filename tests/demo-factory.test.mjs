import assert from "node:assert/strict";
import { buildSrt, formatSrtTimestamp, loadDemoSpec } from "../scripts/demo-factory.js";

const { spec } = loadDemoSpec("refund-support-boundary");

assert.equal(spec.id, "refund-support-boundary");
assert.equal(spec.shots.length, 4);
assert.equal(spec.outputFile, "agentdiff-refund-support-demo.mp4");

const totalDuration = spec.shots.reduce((sum, shot) => sum + shot.durationSeconds, 0);
assert.equal(totalDuration, 75);
assert.ok(totalDuration >= spec.video.minDurationSeconds);
assert.ok(totalDuration <= spec.video.maxDurationSeconds);

assert.equal(formatSrtTimestamp(0), "00:00:00,000");
assert.equal(formatSrtTimestamp(10), "00:00:10,000");
assert.equal(formatSrtTimestamp(75.25), "00:01:15,250");

const srt = buildSrt(spec.shots);

assert.match(srt, /1\n00:00:00,000 --> 00:00:10,000\nNormal CI tells you whether code still runs\./);
assert.match(srt, /2\n00:00:10,000 --> 00:00:30,000\nHere, a tiny support-agent PR changes refund handling/);
assert.match(srt, /3\n00:00:30,000 --> 00:00:55,000\nAgentdiff does not claim this is a bug/);
assert.match(srt, /4\n00:00:55,000 --> 00:01:15,000\nThis came from a repeatable evidence loop/);

for (const shot of spec.shots) {
  assert.ok(shot.expectedText.length > 0, `${shot.id} should define expected visible text`);
  assert.ok(shot.caption.length < 90, `${shot.id} caption should be short enough to burn in`);
}

console.log("demo factory tests passed");
