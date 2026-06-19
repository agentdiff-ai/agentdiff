import assert from "node:assert/strict";
import { renderDraftQueue } from "../scripts/outreach/draft.js";

const markdown = renderDraftQueue([
  {
    name: "Avery",
    company: "ExampleCo",
    role: "AI Engineering Lead",
    repoOrProductContext: "support agent with refund tools",
    whyTheyMightCare: "their agent can mutate customer-visible state"
  }
]);

assert.match(markdown, /status: draft-first, manual approval required/);
assert.match(markdown, /These drafts are not sent automatically/);
assert.match(markdown, /### Email/);
assert.match(markdown, /### Twitter \/ DM/);
assert.match(markdown, /### GitHub Issue \/ Comment Draft/);
assert.match(markdown, /ExampleCo/);

console.log("outreach draft tests passed");
