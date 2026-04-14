import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";

import {
  answerV2Run,
  resumeV2Run,
  startV2Run,
} from "../src/lib/controller.js";
import { loadV2ControllerState } from "../src/lib/controller-state.js";
import { NativeAgentRuntime } from "../src/lib/native-agent-runtime.js";

class ManagerPlanningRuntimeAdapter {
  constructor() {
    this.calls = [];
  }

  async runTask({ agentSession, taskPacket, envelope, acceptedAnswers = [] }) {
    this.calls.push({
      role: agentSession.role,
      taskId: taskPacket.id,
      envelope,
      acceptedAnswers,
    });

    if (agentSession.role === "manager") {
      return {
        agentId: agentSession.agentId,
        taskId: taskPacket.id,
        role: agentSession.role,
        threadId: `thread-${agentSession.agentId}`,
        status: "completed",
        summary: "Manager identified one key clarification before planning.",
        evidence: ["Need the relay boundary before staffing tasks."],
        filesTouched: [],
        questions: [
          {
            question: "Should all agent coordination be routed only through controller state?",
            priority: "high",
            toRole: "manager",
          },
        ],
        taskProposals: [],
        staffing: [
          { role: "planner", count: 1, rationale: "Need one planning pass after clarification." },
          { role: "observer", count: 2, rationale: "Need two parallel read-only fact gatherers." },
          { role: "executor", count: 1, rationale: "Single-writer rule allows one executor." },
        ],
        verification: null,
        review: null,
      };
    }

    if (agentSession.role === "planner") {
      return {
        agentId: agentSession.agentId,
        taskId: taskPacket.id,
        role: agentSession.role,
        threadId: `thread-${agentSession.agentId}`,
        status: "completed",
        summary: "Planner generated the initial task graph and staffing plan.",
        evidence: ["Clarification answer was incorporated into task boundaries."],
        filesTouched: [],
        questions: [],
        taskProposals: [
          {
            id: "task-observer-1",
            title: "Inspect controller state facts",
            objective: "Read-only gather controller persistence facts.",
            role: "observer",
            dependencies: [],
            acceptanceChecks: ["Return repo fact A."],
            readRoots: ["src/lib"],
            allowedFiles: ["src/lib/controller.js"],
            forbiddenFiles: [],
          },
          {
            id: "task-observer-2",
            title: "Inspect runtime state facts",
            objective: "Read-only gather runtime facts.",
            role: "observer",
            dependencies: [],
            acceptanceChecks: ["Return repo fact B."],
            readRoots: ["src/lib"],
            allowedFiles: ["src/lib/native-agent-runtime.js"],
            forbiddenFiles: [],
          },
          {
            id: "task-executor-1",
            title: "Implement controller relay",
            objective: "Use clarified controller-only coordination boundaries.",
            role: "executor",
            dependencies: ["task-observer-1", "task-observer-2"],
            acceptanceChecks: ["Produce self-test evidence for the relay path."],
            readRoots: ["src/lib", "tests"],
            allowedFiles: ["src/lib/controller.js"],
            forbiddenFiles: [],
          },
        ],
        staffing: [
          { role: "observer", count: 2, rationale: "Two independent read-only investigations." },
          { role: "executor", count: 1, rationale: "Only one write-capable executor is allowed." },
        ],
        verification: null,
        review: null,
      };
    }

    return {
      agentId: agentSession.agentId,
      taskId: taskPacket.id,
      role: agentSession.role,
      threadId: `thread-${agentSession.agentId}`,
      status: "completed",
      summary: `Completed ${taskPacket.title}`,
      evidence: [`fact:${taskPacket.id}`],
      filesTouched: agentSession.role === "executor" ? ["src/lib/controller.js"] : [],
      questions: [],
      taskProposals: [],
      staffing: [],
      verification:
        agentSession.role === "verifier"
          ? {
              status: "pass",
              evidence: `Verifier confirmed ${taskPacket.id}.`,
            }
          : null,
      review:
        agentSession.role === "reviewer"
          ? {
              status: "pass",
              summary: `Reviewer approved ${taskPacket.id}.`,
              findings: [],
            }
          : null,
    };
  }
}

class OverClarifyingManagerRuntimeAdapter extends ManagerPlanningRuntimeAdapter {
  async runTask(args) {
    if (args.agentSession.role !== "manager") {
      return super.runTask(args);
    }

    return {
      agentId: args.agentSession.agentId,
      taskId: args.taskPacket.id,
      role: args.agentSession.role,
      threadId: `thread-${args.agentSession.agentId}`,
      status: "completed",
      summary: "Manager asked too many blocking clarification questions.",
      evidence: ["Need more context."],
      filesTouched: [],
      questions: [
        { question: "Question 1?", priority: "high", toRole: "manager" },
        { question: "Question 2?", priority: "high", toRole: "manager" },
        { question: "Question 3?", priority: "high", toRole: "manager" },
        { question: "Question 4?", priority: "high", toRole: "manager" },
      ],
      taskProposals: [],
      staffing: [
        { role: "planner", count: 1, rationale: "Need one planner." },
      ],
      verification: null,
      review: null,
    };
  }
}

class UnderstaffedPlannerRuntimeAdapter extends ManagerPlanningRuntimeAdapter {
  async runTask(args) {
    if (args.agentSession.role === "manager") {
      return {
        agentId: args.agentSession.agentId,
        taskId: args.taskPacket.id,
        role: args.agentSession.role,
        threadId: `thread-${args.agentSession.agentId}`,
        status: "completed",
        summary: "Manager has enough clarified context to start planning immediately.",
        evidence: ["Repo task, target scope, and acceptance criteria are already known."],
        filesTouched: [],
        questions: [],
        taskProposals: [],
        staffing: [
          { role: "planner", count: 1, rationale: "Need one planner to produce the first wave." },
        ],
        verification: null,
        review: null,
      };
    }

    if (args.agentSession.role !== "planner") {
      return super.runTask(args);
    }

    return {
      agentId: args.agentSession.agentId,
      taskId: args.taskPacket.id,
      role: args.agentSession.role,
      threadId: `thread-${args.agentSession.agentId}`,
      status: "completed",
      summary: "Planner proposed work without fully covering role staffing.",
      evidence: ["Missing observer staffing coverage."],
      filesTouched: [],
      questions: [],
      taskProposals: [
        {
          id: "task-observer-missing-staffing",
          title: "Inspect controller facts",
          objective: "Read-only gather controller facts.",
          role: "observer",
          dependencies: [],
          acceptanceChecks: ["Return one repo fact."],
          readRoots: ["src/lib"],
          allowedFiles: ["src/lib/controller.js"],
          forbiddenFiles: [],
        },
      ],
      staffing: [
        { role: "executor", count: 1, rationale: "Single writer only." },
      ],
      verification: null,
      review: null,
    };
  }
}

test("startV2Run triggers a manager clarification pass before implementation dispatch", async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "longrun-manager-loop-"));
  const adapter = new ManagerPlanningRuntimeAdapter();
  const runtime = new NativeAgentRuntime({ adapter });

  const started = await startV2Run({
    workspaceRoot,
    missionInput: {
      goal: "Deliver a manager-driven native-agent loop",
      definitionOfDone: ["Manager must clarify before planning and dispatch."],
    },
    workerConfig: {
      sandbox: "workspace-write",
      config: [],
    },
    runtime,
    autoBootstrap: true,
  });

  const state = await loadV2ControllerState(workspaceRoot, started.run.runId);
  assert.equal(started.run.status, "paused");
  assert.equal(state.clarifications.length, 1);
  assert.equal(state.tasks.length, 0);
  assert.equal(adapter.calls[0].role, "manager");
  assert.equal(state.controller.currentPhase, "understanding");
  assert.equal(state.controller.staffingPlan.length, 3);
});

test("resume after clarification answer runs planner, persists task graph, and dispatches same-role observer tasks", async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "longrun-manager-loop-"));
  const adapter = new ManagerPlanningRuntimeAdapter();
  const runtime = new NativeAgentRuntime({ adapter });

  const started = await startV2Run({
    workspaceRoot,
    missionInput: {
      goal: "Deliver a manager-driven native-agent loop",
      definitionOfDone: ["Manager must clarify before planning and dispatch."],
    },
    workerConfig: {
      sandbox: "workspace-write",
      config: [],
    },
    runtime,
    autoBootstrap: true,
  });

  const preAnswerState = await loadV2ControllerState(workspaceRoot, started.run.runId);
  await answerV2Run({
    workspaceRoot,
    runId: started.run.runId,
    clarificationId: preAnswerState.clarifications[0].id,
    answer: "Yes, all coordination must flow through controller state only.",
  });

  const resumed = await resumeV2Run({
    workspaceRoot,
    runId: started.run.runId,
    runtime,
    autoBootstrap: true,
  });

  const state = await loadV2ControllerState(workspaceRoot, started.run.runId);
  const observerCalls = adapter.calls.filter((call) => call.role === "observer");
  const executorCalls = adapter.calls.filter((call) => call.role === "executor");
  const plannerCalls = adapter.calls.filter((call) => call.role === "planner");

  assert.equal(plannerCalls.length, 1);
  assert.equal(state.tasks.length, 3);
  assert.deepEqual(
    state.controller.plannedTaskIds,
    ["task-observer-1", "task-observer-2", "task-executor-1"],
  );
  assert.equal(observerCalls.length, 2);
  assert.equal(observerCalls[0].envelope.systemPrompt, observerCalls[1].envelope.systemPrompt);
  assert.notEqual(observerCalls[0].envelope.taskPrompt, observerCalls[1].envelope.taskPrompt);
  assert.equal(executorCalls.length, 1);
  assert.equal(state.tasks.find((task) => task.id === "task-executor-1").ownerRole, "executor");
  assert.equal(resumed.controllerState.controller.currentPhase, "complete");
  assert.equal(resumed.run.status, "completed");
});

test("manager clarification bootstrap rejects more than three blocking questions", async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "longrun-manager-loop-"));
  const runtime = new NativeAgentRuntime({
    adapter: new OverClarifyingManagerRuntimeAdapter(),
  });

  await assert.rejects(
    () =>
      startV2Run({
        workspaceRoot,
        missionInput: {
          goal: "Reject oversized clarification batches",
          definitionOfDone: ["Manager clarification budget stays bounded."],
        },
        workerConfig: {
          sandbox: "workspace-write",
          config: [],
        },
        runtime,
        autoBootstrap: true,
      }),
    /maximum question budget/i,
  );
});

test("planner bootstrap rejects task proposals whose roles are missing from staffing", async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "longrun-manager-loop-"));
  const runtime = new NativeAgentRuntime({
    adapter: new UnderstaffedPlannerRuntimeAdapter(),
  });

  await assert.rejects(
    () =>
      startV2Run({
        workspaceRoot,
        missionInput: {
          goal: "Reject planner outputs without staffing coverage",
          definitionOfDone: ["Planner staffing must cover every proposed role."],
        },
        workerConfig: {
          sandbox: "workspace-write",
          config: [],
        },
        runtime,
        autoBootstrap: true,
      }),
    /must cover every proposed role/i,
  );
});
