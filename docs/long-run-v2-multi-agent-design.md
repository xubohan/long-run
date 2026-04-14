# Long Run v2 Multi-Agent Design

## Goal

Turn `long-run` from a single-worker supervised loop into a controller-governed multi-agent execution system where:

- one **manager/controller** owns mission truth, acceptance, and stop/go decisions;
- multiple role-specific agents work in **isolated contexts**;
- agents do **not** silently redefine the mission or completion criteria;
- agents can ask each other questions through a **controller-routed Q&A bus**;
- project completion is decided by **verification artifacts**, not by executor self-report alone.

This document is the proposed v2 architecture and rollout plan.

---

## Current State vs Target State

### Current v1 (`long-run` today)

Current repository behavior is:

- one `supervisor` loop owns run state;
- one `CodexCliWorker` executes each cycle;
- the same worker thread often acts as planner, executor, and self-reporter;
- `auditor` decides continue/pause/complete from a single structured worker result;
- `resume` works by reusing one worker thread id.

This already gives:

- mission locking;
- file-backed state;
- pause / resume / stop;
- cycle artifacts;
- basic completion gating.

But it does **not** yet provide:

- multiple isolated agents;
- role separation;
- inter-agent questions/answers;
- independent verifier authority;
- manager-only acceptance.

### Target v2

Target behavior is:

- controller owns the mission, plan baseline, DoD, clarifications, risks, and acceptance;
- planner / observer / executor / verifier are separate agents with separate prompts and histories;
- each agent receives only task-scoped context;
- cross-agent communication happens through controller-routed question/answer objects;
- completion requires verifier-backed checks and manager approval.

---

## Codex CLI Reality: What Can Power This

This environment should standardize on one execution surface:

### Codex native child agents

Use this as the only multi-agent runtime for v2.

Good for:

- task-scoped planner / observer / executor / verifier fanout;
- isolated child-agent histories;
- direct leader integration;
- lower implementation complexity;
- keeping the whole system inside native Codex semantics.

Limitations:

- the controller must explicitly manage routing and integration;
- long-running durability must come from `long-run` state itself rather than an external team runtime;
- question routing, retries, and verification all need to be modeled in repository code.

### Recommended rollout

- **MVP and onward**: implement v2 entirely on top of Codex native child agents.
- **No external team runtime**: do not add OMX `team` or tmux worker orchestration to this project.

---

## Core Principles

1. **Manager owns truth**
   - Only the controller may update mission-level truth.
   - Workers may propose, but not mutate, mission / DoD / clarifications.

2. **Isolation by default**
   - Agents receive task-scoped context, not the full project transcript.
   - The system should prefer omission over over-sharing.

3. **Questions are first-class objects**
   - Workers do not free-chat with each other.
   - They submit a question packet to the controller.
   - The controller decides whether to answer directly or route to another agent.

4. **Verification is independent**
   - Executors do work.
   - Verifiers validate work.
   - Managers accept work only from verification evidence.

5. **Artifacts over prose**
   - Progress is measured by files, commands, test results, task state changes, and verifier reports.
   - Natural language summaries are supporting signals, not the primary truth source.

6. **Pause on uncertainty, not after damage**
   - High-risk operations, unresolved contradictions, repeated no-progress loops, or repeated failed verifications should pause the run.

---

## Role Model

### Manager / Controller

Responsibilities:

- lock and persist mission truth;
- maintain task graph / queue;
- dispatch tasks to role-specific agents;
- route questions and answers;
- track blockers, retries, and risk state;
- request verification;
- decide continue / retry / pause / completed.

Non-responsibilities:

- should not be the main code-writing agent;
- should not trust executor self-report as acceptance;
- should not let workers directly edit mission truth.

### Planner

Responsibilities:

- break mission work into task packets;
- identify dependencies;
- define task acceptance checks;
- propose replan changes when evidence demands it.

### Observer

Responsibilities:

- inspect repo state, runtime behavior, logs, and environment;
- answer factual system-state questions;
- gather evidence for planner / executor / verifier.

### Executor

Responsibilities:

- modify allowed files only;
- implement one task packet at a time;
- return result packets with touched files, evidence, and blockers.

### Verifier

Responsibilities:

- independently run task acceptance checks;
- assess whether the task result satisfies objective and DoD fragments;
- issue pass / fail / unclear verdicts with evidence.

---

## Isolation Model

Each agent gets a dedicated execution envelope:

- `agent_id`
- `role`
- `thread_id` or pane identity
- `task_id`
- task-scoped prompt
- task-local artifact directory
- optional file write boundary
- optional worktree or patch sandbox

### Context policy

Each agent prompt should include only:

- mission summary digest;
- current task packet;
- directly relevant repo facts;
- previously answered questions relevant to that task;
- explicit acceptance checks;
- allowed and forbidden write scope.

It should exclude:

- unrelated prior conversations;
- other tasks' full transcripts;
- raw manager deliberation;
- speculative roadmap not needed for the task.

---

## Canonical Data Objects

The system should move from “one cycle JSON” to several object types.

### Mission lock

```json
{
  "mission_id": "mission-001",
  "goal": "...",
  "definition_of_done": ["..."],
  "constraints": ["..."],
  "non_goals": ["..."],
  "guardrails": ["..."],
  "clarifications": ["..."],
  "digest": "sha256..."
}
```

### Task packet

```json
{
  "task_id": "task-008",
  "title": "Implement verifier-backed DoD checks",
  "role": "executor",
  "objective": "Add the verification execution path for task-scoped checks.",
  "why_now": "Manager cannot independently validate executor claims yet.",
  "inputs": [
    "docs/long-run-v2-multi-agent-design.md",
    "src/lib/auditor.js",
    "src/lib/supervisor.js"
  ],
  "allowed_files": [
    "src/lib/supervisor.js",
    "src/lib/worker.js",
    "src/lib/verifier.js",
    "tests/"
  ],
  "forbidden_files": [
    "README.md"
  ],
  "dependencies": ["task-004"],
  "acceptance_checks": [
    "npm test",
    "new verifier tests pass",
    "controller rejects executor completion without verifier pass"
  ],
  "priority": "high",
  "retry_budget": 2,
  "status": "queued"
}
```

### Question packet

```json
{
  "question_id": "q-017",
  "task_id": "task-008",
  "from_agent": "executor-2",
  "to_role": "observer",
  "priority": "high",
  "question": "What is the current completion decision path in supervisor and auditor?",
  "status": "open"
}
```

### Answer packet

```json
{
  "question_id": "q-017",
  "from_agent": "observer-1",
  "to_agent": "executor-2",
  "answer": "Supervisor writes cycle output, then auditor decides continue/pause/completed.",
  "evidence": [
    "src/lib/supervisor.js",
    "src/lib/auditor.js"
  ],
  "status": "answered"
}
```

### Result packet

```json
{
  "task_id": "task-008",
  "agent_id": "executor-2",
  "summary": "Added verifier execution path and tests.",
  "files_touched": [
    "src/lib/supervisor.js",
    "src/lib/verifier.js",
    "tests/verifier.test.js"
  ],
  "artifacts": [
    ".longrun/runs/<run_id>/artifacts/task-008/executor/result.json"
  ],
  "made_progress": true,
  "blockers": [],
  "requires_human": false,
  "status": "ready_for_verification"
}
```

### Verification report

```json
{
  "task_id": "task-008",
  "agent_id": "verifier-1",
  "verdict": "pass",
  "checks_run": [
    {
      "command": "npm test",
      "exit_code": 0,
      "evidence": "5 passing + verifier tests"
    }
  ],
  "remaining_gaps": [],
  "status": "accepted"
}
```

---

## State Layout Proposal

Under `.longrun/runs/<run_id>/` add new v2 state folders:

```text
.longrun/runs/<run_id>/
  mission.lock.json
  controller.json
  plan.json
  task-graph.json
  tasks/
    task-001.json
    task-002.json
  agents/
    manager.json
    planner-1.json
    observer-1.json
    executor-1.json
    verifier-1.json
  questions/
    q-001.json
    q-002.json
  answers/
    q-001.answer.json
  verifications/
    task-001.verify.json
  events.jsonl
  artifacts/
    task-001/
      planner/
      executor/
      verifier/
```

### Why this split matters

This allows:

- replaying exactly why a task was dispatched;
- seeing who asked what;
- determining whether a verifier passed or failed;
- resuming after interruption without reconstructing intent from chat history.

---

## Controller State Machine

Recommended top-level states:

1. `ready`
2. `planning`
3. `dispatching`
4. `executing`
5. `awaiting_answers`
6. `verifying`
7. `integrating`
8. `paused`
9. `completed`
10. `stopped`

### Normal loop

1. Load mission and controller state.
2. Determine runnable tasks whose dependencies are satisfied.
3. Dispatch tasks to role-specific agents.
4. Collect result packets and question packets.
5. Route questions.
6. When executor work is ready, dispatch verification.
7. Integrate verified results into plan / task graph.
8. Recompute DoD gap.
9. Decide continue / retry / pause / completed.

### Pause conditions

Pause when any of the following occurs:

- mission change requested;
- unresolved contradiction between planner and verifier;
- repeated failed verification of the same task beyond retry budget;
- repeated no-progress loops across the run;
- high-risk action requires approval;
- task graph has no runnable tasks but DoD remains open.

---

## Q&A Relay Model

### Rule

Workers never rely on unrestricted direct chat.

### Flow

1. Worker emits a question packet.
2. Controller inspects it.
3. Controller either:
   - answers directly from known state;
   - routes it to another role;
   - pauses for human clarification;
   - marks the task blocked.
4. Answer packet is injected into the requester's next prompt.

### Why this is better than free-form worker chat

- preserves isolation;
- keeps auditability;
- avoids accidental context sprawl;
- makes unresolved questions visible to the manager;
- prevents hidden side conversations from driving project direction.

---

## Acceptance Model

The manager should not accept work from executor output alone.

### Required pipeline

1. **Executor** produces code and result packet.
2. **Verifier** independently runs task acceptance checks.
3. **Manager** updates task state only if verifier passes.

### Task lifecycle

Recommended task statuses:

- `queued`
- `dispatched`
- `in_progress`
- `waiting_for_answer`
- `ready_for_verification`
- `verifying`
- `accepted`
- `retry_required`
- `blocked`
- `cancelled`

### Mission completion rule

Mission can become `completed` only if:

- every DoD item is mapped to accepted evidence;
- no required task is still open;
- no verification report remains failed or pending;
- no open high-priority question remains unresolved.

---

## Native Runtime Abstraction

Keep the controller hard-wired to Codex native child agents for v2. A light adapter is still useful so launch, polling, cancellation, and result normalization live behind one interface.

### Suggested interface

```ts
interface NativeAgentRuntime {
  launchTask(input: AgentTaskLaunch): Promise<AgentLaunchResult>
  pollTask(agentRunId: string): Promise<AgentPollResult>
  cancelTask(agentRunId: string): Promise<void>
}
```

### Scope

- one native runtime adapter built on Codex child agents;
- optional local helper lanes for shell-based verification under controller ownership;
- no tmux team backend, no external orchestration dependency.

---

## Codebase Refactor Mapping

### Current files and v2 direction

- `src/lib/supervisor.js`
  - evolve into `controller.js` and keep high-level orchestration only.

- `src/lib/worker.js`
  - split into a native child-agent runtime adapter and task/result normalization helpers.

- `src/lib/planner.js`
  - evolve from linear task list into task graph / queue management.

- `src/lib/auditor.js`
  - split responsibilities:
    - manager decision logic;
    - verifier result integration;
    - pause heuristics.

- `src/lib/prompt.js`
  - replace single worker prompt builder with role-specific prompt builders:
    - manager prompt envelope;
    - planner prompt;
    - observer prompt;
    - executor prompt;
    - verifier prompt.

### New files likely needed

- `src/lib/controller.js`
- `src/lib/task-graph.js`
- `src/lib/questions.js`
- `src/lib/verification.js`
- `src/lib/agent-registry.js`
- `src/lib/native-agent-runtime.js`
- `src/lib/prompts/{planner,observer,executor,verifier}.js`

---

## MVP Rollout Plan

### M0 - Documented design and state contracts

Deliverables:

- this design doc;
- task / question / answer / verification schemas;
- directory layout decision.

Success gate:

- repository contains a stable v2 design artifact and agreed contracts.

### M1 - Manager + verifier separation without multi-agent runtime

Deliverables:

- manager refuses to complete mission from executor self-report alone;
- verifier check path exists even if still local / sequential;
- DoD gaps become explicit verification requirements.

Success gate:

- controller can reject false completion claims.

### M2 - Native subagent multi-role MVP

Deliverables:

- planner / observer / executor / verifier launched as separate role-specific child agents;
- controller creates task packets and result packets;
- controller routes questions and answers.

Success gate:

- one run can dispatch at least two isolated agents and integrate one verified task.

### M3 - Durable task graph and question bus

Deliverables:

- persistent task graph;
- question / answer persistence;
- retry budgets;
- blocker visibility.

Success gate:

- interrupted run can resume with open tasks and unanswered questions intact.

### M4 - Native durability hardening

Deliverables:

- stable child-agent identity and retry handling;
- better persistence for open tasks, open questions, and verifier backlog;
- recovery logic that can rebuild controller state after interruption using only repository state.

Success gate:

- manager can resume a partially completed native-agent run without losing task ownership, unanswered questions, or verification backlog.

---

## Key Risks and Mitigations

### Risk: agents step on the same files

Mitigation:

- task packets include allowed write scope;
- keep tasks file-disjoint where possible;
- prefer worktree or patch isolation later;
- verifier runs after integration, not just per-worker local success.

### Risk: manager becomes another overpowered worker

Mitigation:

- explicitly ban manager from being default code writer;
- manager mostly schedules, routes, accepts, and pauses.

### Risk: verifier is weak and only repeats executor claims

Mitigation:

- verifier must run independent checks;
- store check commands and outputs;
- do not accept prose-only verification.

### Risk: too much context gets copied to all agents

Mitigation:

- build strict prompt envelopes by role;
- include answered questions selectively;
- treat context minimization as a correctness feature, not only a cost optimization.

### Risk: uncontrolled worker chat loops

Mitigation:

- questions are controller-routed;
- open question counts affect task state;
- unresolved critical questions can pause the run.

---

## Recommended First Implementation Path

If starting implementation now, the most leverage-first order is:

1. add **verification independence** to v1;
2. add **clarifications into every role prompt**;
3. split state into **task packets + verification packets**;
4. add **native child-agent runtime**;
5. add **question/answer relay**;
6. harden resume/retry behavior for native-agent runs.

This order is intentional:

- independent verification removes the biggest correctness weakness first;
- clarification propagation removes a current mission-anchor gap;
- task packets make role separation possible;
- native subagents provide the practical multi-agent runtime without overbuilding;
- resume and retry durability should be implemented in repository state instead of an external runtime.

---

## Non-Goals for v2 MVP

- unrestricted agent-to-agent free chat;
- fully autonomous project-wide replanning without controller approval;
- direct mission mutation by worker agents;
- “completed” status without verifier-backed evidence;
- external team runtimes or tmux-based worker orchestration.

---

## Final Recommendation

The correct v2 shape is **not** “let more agents talk more.”

The correct v2 shape is:

- controller owns global truth;
- workers are role-specific and isolated;
- questions are routed through controller;
- verification is independent;
- completion is evidence-backed;
- native child agents are the sole execution runtime for v2.

That is the shortest path from the current single-worker `long-run` to the team-like multi-agent system this project is actually aiming for, without introducing an external team runtime.
