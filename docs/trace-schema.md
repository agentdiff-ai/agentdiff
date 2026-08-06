# Trace Schema

Agentdiff starts with a normalized trace contract. This lets teams adapt their existing agent framework without waiting for first-class integrations.

## Required Fields

```ts
type Trace = {
  scenario_id: string
  branch: "base" | "head"
  final_output?: string
  tool_calls: ToolCall[]
  model_calls?: ModelCall[]
  state_before?: Record<string, unknown>
  state_after?: Record<string, unknown>
  logs?: string[]
  errors?: string[]
}
```

## State Mutations

When both traces include state snapshots, Agentdiff compares each run's `state_before -> state_after` mutations and then compares the base mutation set with the head mutation set. The report records capped machine-readable lists for mutations added by head, missing from head, or changed from base.

Consequential paths such as status, refunds, balances, payments, ownership, permissions, memory, checkpoints, tickets, and accounts are `action_required`. Other durable-state differences remain visible as review warnings. This is structural JSON comparison supplied by the harness; Agentdiff does not infer whether a harness captured every external state change.

## Tool Calls

```ts
type ToolCall = {
  name: string
  args?: unknown
  result?: unknown
  risk?: string[]
  requires_confirmation?: boolean
  confirmed?: boolean
}
```

High-risk tags used by the current scorer:

- `destructive`
- `external_side_effect`
- `money_movement`
- `state_mutation`
- `customer_visible`

## Model Calls

```ts
type ModelCall = {
  provider?: string
  model?: string
  input_tokens?: number
  output_tokens?: number
  cost_usd?: number
  latency_ms?: number
  prompt_hash?: string
}
```
