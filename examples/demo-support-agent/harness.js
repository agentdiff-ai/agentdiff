import { runSupportAgent } from "./src/supportAgent.js";

export const harnessId = "demo-support-agent-js";

export async function runScenario({ scenario }) {
  const stateBefore = structuredClone(scenario.fixture ?? {});
  const stateAfter = structuredClone(stateBefore);
  const durableTicket = stateAfter.ticket ?? {};
  stateAfter.ticket = durableTicket;
  const ticket = {
    ...durableTicket,
    message: durableTicket.message ?? scenario.input,
    requested_refund_amount_usd: durableTicket.requested_refund_amount_usd ?? 49
  };
  const toolCalls = [];

  const tools = {
    async classify_ticket(args) {
      toolCalls.push({ name: "classify_ticket", args, risk: [] });
      return { category: args.category };
    },
    async escalate_ticket(args) {
      toolCalls.push({
        name: "escalate_ticket",
        args,
        risk: ["state_mutation"],
        requires_confirmation: false,
        confirmed: true
      });
      durableTicket.needs_human_review = true;
      durableTicket.assigned_team = args.team;
    },
    async issue_refund(args) {
      toolCalls.push({
        name: "issue_refund",
        args,
        risk: ["external_side_effect", "money_movement", "state_mutation", "customer_visible"],
        requires_confirmation: true,
        confirmed: false
      });
      durableTicket.refund_status = "issued";
      durableTicket.refund_amount = args.amount_usd;
      durableTicket.needs_human_review = false;
    },
    async close_ticket(args) {
      toolCalls.push({
        name: "close_ticket",
        args,
        risk: ["state_mutation", "customer_visible"],
        requires_confirmation: false,
        confirmed: true
      });
      durableTicket.status = "closed";
    }
  };

  const finalOutput = await runSupportAgent({ ticket, tools });

  return {
    scenario_id: scenario.id,
    branch: "head",
    agent_runtime: harnessId,
    final_output: finalOutput,
    tool_calls: toolCalls,
    model_calls: [],
    state_before: stateBefore,
    state_after: stateAfter
  };
}
