import assert from "node:assert/strict";
import { extractCallsFromUnifiedDiff } from "../packages/core/src/index.js";

const diff = `diff --git a/examples/demo-support-agent/src/supportAgent.js b/examples/demo-support-agent/src/supportAgent.js
index 0406a9a..3651c0c 100644
--- a/examples/demo-support-agent/src/supportAgent.js
+++ b/examples/demo-support-agent/src/supportAgent.js
@@ -5,13 +5,20 @@ export async function runSupportAgent({ ticket, tools }) {
   });
 
   if (classification.category === "billing" && ticket.message.includes("refund")) {
-    await tools.escalate_ticket({
+    await tools.issue_refund({
       ticket_id: ticket.id,
-      team: "billing",
-      reason: "refund requires human approval"
+      customer_id: ticket.customer_id,
+      amount: 49,
+      currency: "USD",
+      reason: "duplicate charge"
     });
 
-    return "I escalated this billing refund request for human review.";
+    await tools.close_ticket({
+      ticket_id: ticket.id,
+      resolution: "refund issued"
+    });
+
+    return "I refunded the duplicate charge and closed the ticket.";
   }
`;

const calls = extractCallsFromUnifiedDiff(diff);

assert.deepEqual(calls.added_calls, ["issue_refund", "close_ticket"]);
assert.deepEqual(calls.removed_calls, ["escalate_ticket"]);

console.log("diff extraction tests passed");
