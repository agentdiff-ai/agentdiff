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
  state_before?: unknown
  state_after?: unknown
  logs?: string[]
  errors?: string[]
}
```

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
