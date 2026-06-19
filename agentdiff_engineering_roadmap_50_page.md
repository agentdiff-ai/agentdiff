# agentdiff engineering roadmap

**document type:** 50-page engineering roadmap  
**source:** agentdiff 100-page prd  
**version:** v0.1  
**time horizon:** 6-week yc application sprint + 6-month technical path  
**mode:** open-source, byok, github action first  
**core constraint:** no hosted inference, no billing, no private repo ingestion in v0  
**company sentence:** agentdiff catches dangerous ai agent behavior regressions before pull requests merge.

---

<!-- page 01 -->

## page 01 / 50 — engineering north star

agentdiff is not an eval dashboard. it is a ci tool for agent behavior changes.

the first useful product is a github action that runs in the user’s ci, uses the user’s own api keys, detects agent-relevant pull request changes, builds or updates a repo-specific agent map, and produces a markdown report that explains behavior risk before merge.

the yc deadline compresses the roadmap. this is not a 3-month mvp plan. this is a 6-week public artifact sprint.

by the time the yc application is submitted, agentdiff should have:

- a public github repo
- a working cli
- a working github action
- a clear readme
- a demo gif or screenshot
- one sample repo with intentionally broken prs
- classification-only mode that works without a harness
- a starter agent map builder
- a map drift report
- a markdown pr report
- early behavior diff for one harness contract
- at least 3 external engineers who have tried it or agreed to test it
- a public technical essay explaining why agent maps rot

the north star is not “stars.” stars help, but they are not proof. the real proof is repeated pr usage by people building real agents.

### yc application claim

agentdiff is open-source ci for ai agent behavior changes. it detects when prompts, tools, schemas, model configs, or state-mutating code changes could silently break an agent before the pr merges.

### engineering rule

build the smallest artifact that makes an ai engineer say:

> “oh shit, this pr changed something my normal tests would have missed.”

---

<!-- page 02 -->

## page 02 / 50 — 6-week yc sprint overview

the sprint is built backward from yc credibility.

yc does not need a complete company. yc needs evidence that the founders found a sharp pain and can ship fast.

### week 1: make it real locally

ship a cli that can initialize config, scan a repo, generate a starter map, classify changed files, and render a local markdown report.

### week 2: make it real in github

ship the github action. it should run on pull requests, fetch base/head diff, classify agent-relevant changes, detect map drift, produce report artifacts, and optionally comment on the pr.

### week 3: make it useful

add stronger typescript/javascript static analysis, import graph edges, evidence display, risk severity, and the first good sample repo.

### week 4: make it behavior-aware

add harness contract, normalized trace schema, head-only runs, base/head runs for one example agent, tool-call diff, and cost estimates.

### week 5: make it state-aware

add state fixture diff for one demo domain, deterministic expectations, destructive tool detection, and dry-run safety checks.

### week 6: make it public and adopted

polish docs, publish demo, write technical essay, onboard first users, fix install friction, collect screenshots and quotes.

### yc application artifact

the application should link to the repo, demo, essay, and a short “this caught a real regression” example.

---

<!-- page 03 -->

## page 03 / 50 — v0 scope

v0 is open-source, byok, and ci-native.

v0 should not require an account, hosted backend, hosted database, stripe, organization setup, or api-key custody by agentdiff.

### v0 includes

- cli
- github action wrapper
- minimal config
- generated map lockfile
- changed-file classifier
- static import graph for typescript/javascript
- map drift detector
- markdown report
- json report
- sample repos
- optional llm-based semantic classification using user api key
- optional harness contract
- tool-call diff for one demo
- state fixture diff for one demo

### v0 excludes

- hosted dashboard
- billing
- private repo ingestion into agentdiff servers
- stored trace history
- github app install flow
- enterprise policy engine
- sso
- multi-tenant workers
- production trace ingestion
- salesforce/zendesk/jira integrations
- every framework

### reason

the product needs trust before scale. byok and local ci execution reduce adoption friction. the hosted product comes later only after the pull-request artifact proves value.

---

<!-- page 04 -->

## page 04 / 50 — repo architecture

the repo should be a pnpm monorepo with a thin github action around a reusable cli.

```txt
agentdiff/
  packages/
    core/
    cli/
    github-action/
    report/
    providers/
    examples/
  examples/
    video-editor-agent/
    support-ticket-agent/
    crm-agent/
  docs/
  .github/workflows/
```

### package responsibilities

`@agentdiff/core` owns data models, config parsing, map types, classifier types, scenario types, trace types, diff types, and risk scoring primitives.

`@agentdiff/cli` owns commands: init, scan, classify, run, report.

`@agentdiff/github-action` wraps the cli for github actions.

`@agentdiff/report` renders markdown, json, and later html.

`@agentdiff/providers` wraps model providers behind a simple interface. v0 should support one provider first. openai-compatible endpoints can come later.

`examples/` contains demo repos with intentionally broken prs.

### rule

all github action behavior must be reproducible from the cli. if it only works in github actions, debugging will suck.

---

<!-- page 05 -->

## page 05 / 50 — command surface

the cli should feel obvious.

```bash
agentdiff init
agentdiff scan
agentdiff classify --base origin/main --head HEAD
agentdiff run --base origin/main --head HEAD --max-cost 3.00
agentdiff report --input .agentdiff/runs/latest/report.json
```

### command: init

creates config, starter map, starter scenarios, and optional github action yaml.

### command: scan

builds or validates the agent map.

### command: classify

classifies changed files and decides whether the pr can affect agent behavior.

### command: run

executes selected scenarios where a harness exists.

### command: report

renders human-readable output from structured results.

### acceptance criteria

- commands work locally
- commands work in ci
- commands produce stable output
- commands never require hosted state
- failures produce useful diagnostics

---

<!-- page 06 -->

## page 06 / 50 — config model

config is a seed, not the source of truth.

the human should not list every tool, prompt, schema, state object, and model route. that would rot.

### starter config

```yaml
agentdiff:
  entrypoints:
    - src/agents/**
  max_cost_usd: 3.00
  mode: byok
  language: typescript

detection:
  auto_update_map: true
  block_unmapped_agent_surfaces: false

report:
  comment_on_pr: true
  upload_artifacts: true
```

### human-owned fields

- entrypoint globs
- test command
- max cost
- ignore rules
- blocking thresholds
- provider/model choice
- report behavior

### machine-owned fields

- discovered agents
- prompts
- tools
- schemas
- state surfaces
- model configs
- evidence edges
- scenario links
- risk tags

### acceptance criteria

the config fits in one screen for a normal project.

---

<!-- page 07 -->

## page 07 / 50 — generated map lockfile

the generated map is the internal model of the repo.

it should behave like a lockfile: machine-generated, diffable, reviewable, and explainable.

### file

```txt
.agentdiff/map.json
```

### core shape

```json
{
  "version": "0.1",
  "generated_at": "2026-06-19T00:00:00Z",
  "commit_sha": "abc123",
  "agents": [
    {
      "id": "support_agent",
      "display_name": "support agent",
      "entrypoints": ["src/agents/supportAgent.ts"],
      "prompts": [],
      "tools": [],
      "state": [],
      "model_configs": [],
      "retrievers": [],
      "memory": [],
      "risk": ["unknown"],
      "evidence": []
    }
  ]
}
```

### evidence edges

each map edge needs evidence:

```json
{
  "type": "import",
  "from": "src/agents/supportAgent.ts",
  "to": "src/tools/updateTicket.ts",
  "confidence": 0.91
}
```

### acceptance criteria

no edge without evidence should block a merge by itself.

---

<!-- page 08 -->

## page 08 / 50 — changed-file classifier

the classifier is the first product muscle.

before running expensive behavior checks, agentdiff needs to answer:

> can this pull request affect agent behavior?

### labels

- agent_entrypoint
- prompt
- tool_definition
- tool_implementation
- state_mutation
- retrieval
- memory
- model_config
- guardrail
- unknown_agent_related
- not_agent_related

### signals

- path heuristics
- filename
- extension
- import graph
- exported functions
- model call patterns
- tool schema patterns
- zod/json schema references
- semantic llm classifier, optional
- existing map comparison

### output

```json
{
  "path": "src/tools/sendInvoice.ts",
  "label": "tool_implementation",
  "confidence": 0.88,
  "risk": ["external_side_effect", "state_mutation"],
  "evidence": [
    "exports function sendInvoice",
    "contains recipientEmail",
    "called from src/agents/billingAgent.ts"
  ],
  "recommended_check_depth": "standard"
}
```

---

<!-- page 09 -->

## page 09 / 50 — static import graph

static import graph is the first reliable skeleton.

v0 should support typescript/javascript first. do not support every language before the first public launch.

### responsibilities

- resolve imports from configured entrypoints
- support tsconfig path aliases
- follow local imports
- detect dynamic import and mark lower confidence
- identify files reachable from agents
- extract exported tool registries where possible
- detect schema imports
- detect model config imports
- record edge type and confidence

### edge types

- import
- registry
- schema_reference
- model_call
- state_call
- prompt_load
- unknown_dynamic

### acceptance criteria

`agentdiff scan --debug` can explain why a file was included in the map.

if the graph cannot explain itself, users will not trust it.

---

<!-- page 10 -->

## page 10 / 50 — semantic classifier

static graph is not enough.

teams put prompts, tools, policies, and state mutation helpers in weird places. semantic classification catches files outside obvious paths.

### inputs

- filename
- path
- imports/exports
- first 120 lines
- changed diff hunks
- symbols
- nearby map context
- package/framework hints

### output

the semantic classifier should never output a bare label. it must output evidence.

```json
{
  "path": "src/lib/credits/applyCredit.ts",
  "label": "state_mutation",
  "confidence": 0.76,
  "evidence": [
    "function name applyCredit",
    "updates account.balance",
    "imports billing db client"
  ]
}
```

### llm usage

v0 can run without llm classification. static mode should still produce useful map drift reports.

llm mode should be opt-in and byok.

### acceptance criteria

if confidence is low, say unknown. unknown is better than hallucinated certainty.

---

<!-- page 11 -->

## page 11 / 50 — map drift detector

map drift is the product hook.

normal eval systems rot because the repo changes faster than the test suite. agentdiff should notice when new agent surfaces appear outside the map.

### drift types

- new unmapped tool
- new prompt outside known paths
- model config changed but not mapped
- new state mutation file
- deleted file still referenced by map
- import graph edge changed
- runtime trace uses unknown tool
- ignored path expired

### report example

```txt
map drift detected

new unmapped agent surface:
src/tools/sendInvoice.ts

classification:
tool_implementation, external_side_effect, state_mutation

evidence:
- exports sendInvoice()
- accepts recipientEmail and amount
- imported by billingAgent.ts

recommendation:
add to billing_agent.tools and create invoice scenario.
```

### acceptance criteria

drift findings are shown even when behavior execution is disabled.

---

<!-- page 12 -->

## page 12 / 50 — github action v0

the github action should be thin.

it should checkout the repo, fetch base/head, run the cli, upload artifacts, and optionally comment on the pr.

### workflow example

```yaml
name: agentdiff

on:
  pull_request:
    branches: [main]

jobs:
  agentdiff:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write
      checks: write

    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - uses: agentdiff/agentdiff-action@v0
        with:
          config_path: agentdiff.yml
          openai_api_key: ${{ secrets.OPENAI_API_KEY }}
          max_cost_usd: 3.00
```

### degradation

if comment permissions fail, save artifacts and print summary to logs.

### acceptance criteria

first user can copy/paste yaml and get a report in under ten minutes.

---

<!-- page 13 -->

## page 13 / 50 — report v0

the report is the product surface.

v0 can be technically crude if the report is sharp. if the report is vague, the product dies.

### report structure

```md
# agentdiff behavior report

status: warning
run mode: classify
changed surfaces: 3
map drift findings: 1
estimated cost: $0.00
actual cost: $0.00

## top findings

### 1. new unmapped state-mutating tool

path: src/tools/sendInvoice.ts
risk: high
evidence:
- exports sendInvoice()
- accepts amount and recipientEmail
- imported by billingAgent.ts

recommendation:
add to billing_agent.tools and create a scenario before merge.
```

### report principles

- show top risk without scrolling
- avoid vague scores
- show evidence
- show next action
- include raw json artifact

### acceptance criteria

the first report screenshot should be legible on twitter/linkedin/hn.

---

<!-- page 14 -->

## page 14 / 50 — json report schema

markdown is for humans. json is for future automation.

### file

```txt
.agentdiff/runs/<run_id>/report.json
```

### schema

```ts
type AgentdiffReport = {
  run_id: string
  repo: string
  base_sha: string
  head_sha: string
  mode: "classify" | "head_only" | "base_head_light" | "standard" | "deep"
  status: "pass" | "warn" | "action_required" | "fail" | "skipped"
  changed_surfaces: ChangedSurface[]
  map_drift: MapDriftFinding[]
  behavior_findings: BehaviorFinding[]
  cost: CostSummary
  artifacts: ArtifactRef[]
}
```

### acceptance criteria

the json schema must remain stable enough for users to parse in their own ci.

do not break it casually.

---

<!-- page 15 -->

## page 15 / 50 — week 1 build plan

week 1 is about making agentdiff locally real.

### day 1

- create repo
- monorepo scaffold
- setup pnpm/tsup/vitest/eslint
- create core types
- create cli package
- add `agentdiff --help`

### day 2

- implement config parser
- implement `agentdiff init`
- write generated files safely
- detect package manager
- detect ts/js repo

### day 3

- implement path-based classifier
- implement basic changed-file input
- implement report renderer v0

### day 4

- implement starter map builder
- implement `agentdiff scan`
- add evidence edges
- add debug output

### day 5

- implement `agentdiff classify --base --head`
- add simple git diff wrapper
- add sample repo
- record demo output

### week 1 acceptance

local cli can generate a useful report from a real git diff.

---

<!-- page 16 -->

## page 16 / 50 — week 2 build plan

week 2 turns the local tool into a github-native artifact.

### day 6

- create github action wrapper
- pass inputs to cli
- upload report artifacts
- print summary in action logs

### day 7

- add pr comment support
- handle missing permissions gracefully
- avoid duplicate comments
- update previous bot comment if possible

### day 8

- improve map drift report
- add severity
- add changed surface summary
- add markdown polish

### day 9

- create broken pr in sample repo
- generate screenshot
- make demo gif if possible
- update readme with install steps

### day 10

- public launch candidate
- docs smoke test
- run in a clean repo
- ask 3 engineers to try it

### week 2 acceptance

a stranger can add the github action and get a map drift report on a pr.

---

<!-- page 17 -->

## page 17 / 50 — week 3 build plan

week 3 makes the classifier less toy-like.

### goals

- import graph
- evidence-first output
- better ts/js support
- stronger agent surface detection
- docs for false positives

### tasks

- parse tsconfig aliases
- follow local imports from entrypoints
- detect model calls
- detect zod schemas
- detect tool registries
- detect prompt string files
- mark dynamic imports
- add confidence scoring
- add `agentdiff scan --explain path`

### acceptance

given a repo with an agent entrypoint and tools in nested folders, agentdiff can map reachable tools and explain why.

### public artifact

publish a short technical post:

> evals rot because repos move. agentdiff starts by mapping agent surfaces before testing behavior.

---

<!-- page 18 -->

## page 18 / 50 — week 4 build plan

week 4 adds the first behavior execution.

do not boil the ocean. use one harness contract.

### tasks

- define scenario schema
- define normalized trace schema
- define harness interface
- implement head-only run
- implement base/head checkout runner
- implement tool-call diff
- implement basic cost estimate

### example harness

```ts
export async function runAgentdiffScenario(scenario) {
  const result = await runAgent({
    input: scenario.input,
    fixture: scenario.fixture,
    dryRun: true
  })

  return {
    scenario_id: scenario.id,
    final_output: result.text,
    tool_calls: result.toolCalls,
    model_calls: result.modelCalls,
    state_before: scenario.fixture.state,
    state_after: result.state
  }
}
```

### acceptance

sample repo catches a changed tool call across base/head.

---

<!-- page 19 -->

## page 19 / 50 — week 5 build plan

week 5 makes the product state-aware.

this is where agentdiff stops being generic evals.

### tasks

- implement state fixture schema
- implement state diff
- add deterministic expectations
- add destructive tool risk tags
- add confirmation expectation
- add external side-effect guardrails
- add dry-run warning
- add fail-closed behavior for dangerous tools

### deterministic expectations

```json
{
  "type": "must_not_call",
  "tool": "deleteClip"
}
```

```json
{
  "type": "requires_confirmation",
  "before_tool": "sendInvoice"
}
```

```json
{
  "type": "state_field_must_equal",
  "path": "ticket.status",
  "value": "open"
}
```

### acceptance

sample repo catches delete instead of trim, or send instead of draft.

---

<!-- page 20 -->

## page 20 / 50 — week 6 build plan

week 6 is adoption and yc evidence.

### tasks

- polish readme
- record demo
- write launch post
- fix install friction
- onboard first external users
- collect issues and quotes
- add docs for one real integration pattern
- write yc application technical proof section

### target assets

- github repo
- screenshot
- demo gif
- sample pr link
- technical essay
- 3 user quotes or attempts
- 10-20 target design partners
- clean product sentence

### acceptance

by the end of week 6, the product can be shown in a yc application without feeling imaginary.

minimum claim:

> agentdiff already runs as a github action and catches map drift plus first behavior diffs in example repos.

---

<!-- page 21 -->

## page 21 / 50 — sample repo strategy

sample repos are not decoration. they are the sales demo.

### sample 1: video editor agent

state: timeline, clips, tracks, assets.

broken pr:

- user asks to shorten intro
- base calls `trimClip`
- head calls `deleteClip`
- report flags destructive tool regression

### sample 2: support ticket agent

state: ticket, customer, refund eligibility.

broken pr:

- user asks about refund
- head calls `issueRefund` without approval
- report flags skipped confirmation

### sample 3: crm agent

state: lead, account, opportunity.

broken pr:

- agent updates wrong account
- report flags object id change

### sample 4: coding agent

state: files and generated patch.

broken pr:

- agent modifies unrelated file
- report flags state target mismatch

### acceptance

each sample has a broken pr and fixed pr.

---

<!-- page 22 -->

## page 22 / 50 — scenario schema

scenarios should be few and sharp.

v0 should not generate hundreds of weak tests.

### schema

```json
{
  "id": "video_shorten_intro_preserve_music",
  "title": "shorten intro while preserving music alignment",
  "agent_id": "video_editor",
  "input": "make the intro two seconds shorter but keep the music aligned",
  "fixture": {
    "state": {
      "timeline": {
        "clips": [
          { "id": "intro_01", "start": 0, "end": 8, "track": "video" },
          { "id": "music_01", "start": 0, "end": 30, "track": "audio" }
        ]
      }
    }
  },
  "expectations": [
    { "type": "must_call", "tool": "trimClip" },
    { "type": "must_not_call", "tool": "deleteClip" },
    { "type": "state_field_must_equal", "path": "timeline.clips.music_01.start", "value": 0 }
  ],
  "source": {
    "type": "repo_derived",
    "evidence": ["trimClip schema", "videoEditor prompt"]
  }
}
```

### acceptance

scenario files are readable enough for users to edit by hand.

---

<!-- page 23 -->

## page 23 / 50 — normalized trace schema

the trace schema is the bridge between arbitrary agents and agentdiff.

### schema

```ts
type ToolCall = {
  id?: string
  name: string
  args: unknown
  result?: unknown
  risk?: string[]
  started_at?: string
  ended_at?: string
}

type ModelCall = {
  provider?: string
  model?: string
  input_tokens?: number
  output_tokens?: number
  cost_usd?: number
  latency_ms?: number
  prompt_hash?: string
}

type Trace = {
  scenario_id: string
  branch: "base" | "head"
  final_output?: string
  tool_calls: ToolCall[]
  model_calls: ModelCall[]
  state_before?: unknown
  state_after?: unknown
  logs?: string[]
  errors?: string[]
}
```

### acceptance

teams can adapt their existing agent wrapper to this in under 30 minutes.

if the harness takes days, v0 fails.

---

<!-- page 24 -->

## page 24 / 50 — behavior diff engine

the behavior diff engine compares traces along dimensions that matter.

### dimensions

- final output
- tool sequence
- tool args
- target object
- state mutation
- model choice
- cost
- latency
- retries
- policy behavior
- confirmation behavior

### output

```json
{
  "scenario_id": "video_shorten_intro_preserve_music",
  "finding_type": "tool_selection_regression",
  "severity": "high",
  "base": {
    "tool": "trimClip"
  },
  "head": {
    "tool": "deleteClip"
  },
  "reason": "user requested shortening, not deletion",
  "recommendation": "block merge unless this behavior is intentional"
}
```

### acceptance

deterministic diffs outrank llm judgment.

an llm judge can explain intent mismatch, but it should not decide hard facts like object identity.

---

<!-- page 25 -->

## page 25 / 50 — risk scoring v0

risk scoring should be simple and transparent.

### severity

critical:

- destructive or external state mutation without required confirmation
- live external side effect attempted in ci
- secret-like value leaked into report

high:

- wrong high-risk tool
- wrong state target
- policy violation
- skipped confirmation

medium:

- cost increase
- latency increase
- changed tool sequence with unclear impact
- unknown agent surface

low:

- wording change
- benign trace difference

unknown:

- insufficient evidence

### rule

never show severity without reason.

### acceptance

users should be able to argue with a finding. that means the finding must expose evidence.

---

<!-- page 26 -->

## page 26 / 50 — cost model

cost is part of product trust.

agentdiff cannot create surprise bills.

### estimate before execution

inputs:

- scenario count
- branch count
- context size
- model/provider
- judge calls
- cache assumptions
- retry policy

### budget behavior

```yaml
budget:
  max_run_cost_usd: 3.00
  on_exceed: downgrade_to_classify
```

### report

```txt
estimated cost: $1.74
actual cost: $1.39
cost delta vs base: +38%
```

### acceptance

if estimated cost exceeds budget, downgrade or ask for explicit deep run.

v0 should default conservative.

---

<!-- page 27 -->

## page 27 / 50 — external side-effect safety

ci must not send emails, charge cards, delete assets, or update live systems.

### detection

- tool names: send, charge, delete, refund, publish, update
- env vars that look production-like
- network calls to known production domains
- missing dry-run wrappers
- high-risk tool tags in map

### behavior

- classification-only if safety unclear
- fail closed for destructive tools without mocks
- warn on production-like env vars
- redact secrets from logs and reports

### acceptance

agentdiff should never create the very kind of incident it is trying to prevent.

this is not optional.

---

<!-- page 28 -->

## page 28 / 50 — state sandbox v0

v0 does not need a full sandbox platform.

it needs fixtures and dry-run wrappers.

### minimal approach

- scenario includes fixture state
- harness passes fixture to agent
- tool calls mutate local fixture
- trace includes before/after
- agentdiff compares base/head state

### example

```json
{
  "state_before": {
    "ticket": { "id": "t1", "status": "open" }
  },
  "base_state_after": {
    "ticket": { "id": "t1", "status": "needs_human" }
  },
  "head_state_after": {
    "ticket": { "id": "t1", "status": "closed" }
  }
}
```

### acceptance

v0 should catch wrong object and wrong field changes in at least one example domain.

---

<!-- page 29 -->

## page 29 / 50 — llm judge policy

llm judges are useful but should not be trusted blindly.

### allowed uses

- semantic intent mismatch
- pairwise output quality
- explaining why tool choice is suspicious
- summarizing diff for humans
- classifying changed files when evidence is provided

### disallowed uses

- deciding whether schema validates
- deciding whether object ids match
- deciding whether cost increased
- deciding whether a file exists
- overriding deterministic policy

### judge prompt rule

ask for evidence, not scores.

### acceptance

if judge output has no evidence, discard it.

---

<!-- page 30 -->

## page 30 / 50 — testing strategy

agentdiff itself needs strong tests because it is a ci product.

### unit tests

- config parsing
- map generation
- classifier labels
- import graph
- report rendering
- risk scoring
- redaction
- cost estimation

### golden tests

fixtures for example repos:

- broken video pr
- broken support pr
- broken crm pr
- benign prompt change
- no agent-relevant change

### integration tests

- run cli on sample repos
- run github action locally via act if possible
- compare report snapshots

### acceptance

every regression in agentdiff should be visible in its own ci.

dogfood the product early.

---

<!-- page 31 -->

## page 31 / 50 — readme strategy

the readme is the landing page.

it should sell one use case, not the whole company.

### above the fold

- one sentence
- one screenshot
- install yaml
- sample report
- why it matters

### structure

1. what is agentdiff?
2. what it catches
3. quickstart
4. example pr report
5. byok/privacy model
6. config
7. harness contract
8. roadmap
9. contributing

### first sentence

agentdiff is open-source ci for ai agent behavior changes. it catches risky changes to prompts, tools, schemas, model configs, and state-mutating code before prs merge.

### acceptance

a developer should understand the product in 30 seconds and install in under 10 minutes.

---

<!-- page 32 -->

## page 32 / 50 — docs strategy

docs should be thin at first.

### docs needed for yc sprint

- quickstart
- config reference
- github action setup
- cli commands
- map.json explanation
- scenario schema
- harness contract
- privacy/byok
- troubleshooting
- sample repos

### avoid

- long theory docs
- full enterprise docs
- pricing docs
- hosted docs before hosted exists

### acceptance

docs reduce install friction. if a doc does not help someone run or understand the first report, cut it.

---

<!-- page 33 -->

## page 33 / 50 — public launch checklist

launch when the github action can produce a compelling report.

### minimum launch criteria

- repo public
- license chosen
- readme done
- quickstart works
- action works on sample repo
- report screenshot exists
- demo pr exists
- at least one example catches map drift
- at least one example catches behavior diff
- no hosted backend required
- no billing
- no private key handling by agentdiff infra

### launch channels

- github
- hacker news
- x/twitter
- linkedin
- ai engineer friends
- devtools founders
- relevant discord/slack groups

### launch claim

> open-source github action for ai agent behavior ci.

not “trust layer for autonomous software.” that is too big for the first launch.

---

<!-- page 34 -->

## page 34 / 50 — first 10 users plan

the first 10 users should be painful, not random.

### target users

- ai video/editor agent startups
- support automation startups
- coding agent builders
- internal ops automation teams
- friends with real agent repos
- open-source agent framework examples

### outreach ask

> i’m building an open-source github action that detects agent behavior risk in prs. can i try it on one repo or have you run it on one pr?

### success condition

not “they liked it.”

success is:

- they installed it
- they ran it on a pr
- they read the report
- they gave a false-positive/false-negative
- they said whether it caught something meaningful

### acceptance

3 repeated users are better than 100 stars.

---

<!-- page 35 -->

## page 35 / 50 — yc evidence plan

yc needs evidence, not dreams.

### evidence to collect

- repo link
- stars/forks
- installs
- pr reports generated
- screenshots
- demo video
- external user quotes
- issue activity
- design partner names if allowed
- technical essay
- founder-market fit story

### strongest proof

> this caught a real agent behavior risk in a real repo.

### application framing

we built agent infra and saw that normal ci cannot detect behavior changes caused by prompts, tools, schemas, models, and state mutation code. agentdiff makes those changes visible at pull request time.

### acceptance

the application should feel like a team that has already started a category, not a team asking permission to start.

---

<!-- page 36 -->

## page 36 / 50 — technical essay plan

write one serious essay during week 6.

### title options

- `agent evals rot because repos move`
- `ci for ai agent behavior changes`
- `prompts are production code, but tools are where agents break`
- `the missing lockfile for agent behavior`
- `why state-mutating agents need behavior diff before merge`

### essay outline

1. agents are becoming software that acts
2. normal ci tests deterministic code
3. agent behavior can change through prompts, schemas, models, retrieval, memory, and tool code
4. evals rot when repo maps are manual
5. agentdiff builds a self-healing map
6. the first product is a github action
7. open-source/byok is the trust wedge

### acceptance

the essay should make one engineer want to try the repo.

---

<!-- page 37 -->

## page 37 / 50 — dogfood plan

agentdiff should run on agentdiff.

even before agentdiff has agents, use it to test its own examples.

### dogfood targets

- sample repos
- docs changes
- config changes
- classifier changes
- report format changes
- scenario changes

### dogfood workflow

- every pr runs tests
- every pr runs agentdiff on sample repos
- report snapshots are compared
- changes to classifier/risk scoring require updated golden reports

### acceptance

when agentdiff changes behavior, the team sees it in ci.

this becomes the best demo: agentdiff is itself a behavior-regression system.

---

<!-- page 38 -->

## page 38 / 50 — quality bar

the product can be rough, but the core loop must be solid.

### acceptable roughness

- ugly cli output
- limited language support
- only github actions
- only one provider
- simple report formatting
- manual harness setup
- no dashboard
- no billing

### unacceptable roughness

- leaking secrets
- overwriting user files
- causing external side effects
- hallucinating findings with no evidence
- failing silently
- requiring giant config
- generating unreadable reports
- pretending uncertainty is certainty

### acceptance

trust is the product. do not trade trust for fake speed.

---

<!-- page 39 -->

## page 39 / 50 — kill criteria

the idea should survive contact with reality. if it does not, cut or pivot.

### kill or rethink if

- developers refuse to install the action
- reports are too noisy to read
- map drift rarely catches anything real
- harness setup is too painful
- users already solved this internally with little pain
- all useful findings require deep manual customization
- the product looks like generic evals again
- users want observability more than pr checks

### continue if

- users run it more than once
- users ask for blocking mode
- users ask for org-wide rollout
- users submit issues
- users say it caught something
- users want production traces converted into regression tests

### acceptance

be ruthless. a narrower wedge is better than a vague platform.

---

<!-- page 40 -->

## page 40 / 50 — engineering risks

### risk: config rot

mitigation: generated map lockfile, drift detector, map refresh prs.

### risk: noisy false positives

mitigation: evidence display, conservative severity, non-blocking default.

### risk: integration pain

mitigation: classify-only mode before harness, simple trace contract.

### risk: expensive runs

mitigation: cost estimation, caps, downgrade behavior.

### risk: nondeterminism

mitigation: temperature control, model/version hashes, flaky labels, multiple samples only when necessary.

### risk: safety

mitigation: dry-run default, side-effect detection, fail closed on destructive tools.

### risk: generic positioning

mitigation: focus on pr-native behavior diff and map drift, not broad eval dashboards.

---

<!-- page 41 -->

## page 41 / 50 — hosted path later

hosted is not v0.

hosted becomes useful after the open-source action proves repeated demand.

### hosted adds

- github app install
- check runs
- run history
- org-wide config
- policy packs
- scenario review
- hosted workers
- billing
- retention
- audit logs

### hosted should not replace

- open-source cli
- byok mode
- local ci mode
- inspectable core

### acceptance

only build hosted when users say:

> this is useful, but we need history, policy, and easier org rollout.

not before.

---

<!-- page 42 -->

## page 42 / 50 — github app later

the github app is the company surface, not the first artifact.

### app responsibilities

- receive webhooks
- create checks
- manage reruns
- store run metadata
- coordinate hosted workers
- open map refresh prs
- manage org policy
- support billing later

### app permissions

start minimal:

- metadata
- contents read
- pull requests read/write
- checks write

### acceptance

github app should reuse open-source core. no forked logic.

---

<!-- page 43 -->

## page 43 / 50 — production trace ingestion later

production trace ingestion is the path from ci tool to platform.

### sources

- langsmith
- datadog
- weave
- custom json
- app logs
- support incidents

### loop

production failure → normalized trace → scenario → future pr check.

### v0 design implication

scenario schema and trace schema must be designed now so this loop is possible later.

### acceptance

do not build ingestion before users care about pr checks. but do not design schemas that make ingestion impossible.

---

<!-- page 44 -->

## page 44 / 50 — open-core boundary

the open-source core earns trust. the hosted product captures enterprise value.

### open source

- cli
- github action
- config
- map builder
- classifier
- report renderer
- scenario schema
- trace schema
- basic diff engine
- sample repos

### paid later

- hosted github app
- run history
- org policy
- team dashboards
- production trace ingestion
- audit logs
- sso/rbac
- enterprise retention
- private workers
- billing and usage controls

### acceptance

do not cripple the open-source tool. weak open source will not create distribution.

---

<!-- page 45 -->

## page 45 / 50 — metrics

### pre-yc metrics

- repo stars
- installs
- sample pr clicks
- reports generated
- external repos tried
- external users contacted
- repeated users
- useful findings
- false positive reports
- issues opened

### product metrics

- install to first report time
- classify-only runtime
- report read rate, approximated by comments/reactions
- map drift findings per repo
- behavior findings per run
- ignored finding rate
- blocking mode adoption later

### business metrics later

- hosted conversion
- runs per repo
- usage credits consumed
- enterprise retention
- expansion to more repos

### acceptance

north star before revenue: repeated pull-request usage by real agent teams.

---

<!-- page 46 -->

## page 46 / 50 — ownership model for 6-week sprint

small team, clear ownership.

### technical founder

- core architecture
- cli
- classifier
- map builder
- report quality
- sample repos
- technical essay

### cofounder

- user outreach
- install testing
- documentation feedback
- yc application coordination
- design partner scheduling
- collecting quotes
- commercial conversations later

### contributors

- sample repo fixes
- docs
- provider wrappers
- framework examples

### rule

the technical founder should not spend week 1 polishing branding. the product is the report.

---

<!-- page 47 -->

## page 47 / 50 — day-by-day execution calendar

### days 1-3

repo, cli, config, init, basic classify.

### days 4-7

scan, map, report, github action wrapper.

### days 8-10

pr comment, sample repo, screenshot, readme.

### days 11-14

external install tests, bug fixes, launch candidate.

### days 15-21

import graph, semantic classifier, map drift polish.

### days 22-28

harness contract, trace schema, first behavior diff.

### days 29-35

state fixture diff, deterministic expectations, side-effect safety.

### days 36-42

docs, essay, demo video, user onboarding, yc application evidence.

### principle

each week must produce something visible.

---

<!-- page 48 -->

## page 48 / 50 — yc demo script

the demo should be under 90 seconds.

### script

1. show an agent pr
2. point to changed file: new tool or prompt change
3. show normal tests passing
4. show agentdiff report
5. explain map drift or behavior diff
6. show why it matters
7. show fixed pr
8. show open-source install yaml

### best demo

support agent or video agent.

support agent is easier for investors to understand. video agent is stronger founder-market fit. use whichever looks sharper by week 5.

### closing line

> normal ci says the code works. agentdiff says whether the agent’s behavior changed dangerously.

---

<!-- page 49 -->

## page 49 / 50 — post-yc-application roadmap

after application, keep shipping.

### weeks 7-8

- onboard 10 repos
- reduce false positives
- improve scenario generation
- add python investigation if demanded
- add report reactions/feedback

### weeks 9-12

- runtime reconciliation
- bot-generated map refresh pr prototype
- production trace import prototype from json
- hosted github app design

### months 4-6

- hosted beta if repeated users demand it
- run history
- org policy
- usage metering
- private worker design

### acceptance

do not switch to enterprise roadmap because it sounds bigger. earn it through usage.

---

<!-- page 50 -->

## page 50 / 50 — final build order

the final order is simple.

1. cli
2. config
3. scan
4. map
5. classify
6. report
7. github action
8. sample repo
9. map drift
10. import graph
11. semantic classifier
12. harness
13. trace schema
14. base/head runner
15. tool-call diff
16. cost model
17. state fixture diff
18. deterministic expectations
19. launch
20. users
21. yc application

### do not build first

- dashboard
- billing
- hosted github app
- enterprise auth
- production trace ingestion
- broad language support
- every agent framework
- complex llm judge system

### one sentence

by yc application time, agentdiff should be a public open-source github action that catches agent map drift and early behavior regressions in pull requests, with enough usage and demo quality that the company feels inevitable.

