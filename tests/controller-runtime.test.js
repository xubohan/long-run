import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";

import { LongRunController } from "../src/lib/controller.js";
import { loadV2ControllerState } from "../src/lib/controller-state.js";
import { NativeAgentRuntime } from "../src/lib/native-agent-runtime.js";

class FakeRuntimeAdapter {
  constructor() {
    this.calls = [];
  }

  async runTask({ agentSession, envelope, taskPacket }) {
    this.calls.push({
      agentId: agentSession.agentId,
      role: agentSession.role,
      taskId: taskPacket.id,
      envelope,
    });

    return {
      agentId: agentSession.agentId,
      taskId: taskPacket.id,
      role: agentSession.role,
      threadId: `thread-${agentSession.agentId}`,
      status: "completed",
      summary: `Completed ${taskPacket.title}`,
      evidence: [`evidence:${taskPacket.id}`],
      filesTouched: [],
      questions: [],
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

  async answerQuestion({ questionRecord, targetSession }) {
    return {
      id: `answer-${questionRecord.id}`,
      questionId: questionRecord.id,
      fromAgentId: targetSession.agentId,
      answer: `answer-from-${targetSession.role}`,
    };
  }
}

test("controller dispatch creates at least two isolated child agent sessions", async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "longrun-controller-"));
  const runtime = new NativeAgentRuntime({
    adapter: new FakeRuntimeAdapter(),
  });
  const controller = new LongRunController({
    workspaceRoot,
    runId: "run-controller-1",
    missionDigest: "digest-1",
    runtime,
  });

  const results = await controller.dispatchAssignments([
    {
      role: "observer",
      taskPacket: {
        id: "task-observer-a",
        title: "Inspect repo A",
        objective: "Find repo fact A",
      },
    },
    {
      role: "observer",
      taskPacket: {
        id: "task-observer-b",
        title: "Inspect repo B",
        objective: "Find repo fact B",
      },
    },
  ]);

  const state = await loadV2ControllerState(workspaceRoot, "run-controller-1");

  assert.equal(results.length, 2);
  assert.equal(state.agents.length, 2);
  assert.notEqual(state.agents[0].historyKey, state.agents[1].historyKey);
  assert.equal(results[0].envelope.systemPrompt, results[1].envelope.systemPrompt);
  assert.notEqual(results[0].envelope.taskPrompt, results[1].envelope.taskPrompt);
});

test("controller advances executor work into reviewing after verifier automation", async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "longrun-controller-"));
  const runtime = new NativeAgentRuntime({
    adapter: new FakeRuntimeAdapter(),
  });
  const controller = new LongRunController({
    workspaceRoot,
    runId: "run-controller-2",
    missionDigest: "digest-2",
    runtime,
  });

  await controller.dispatchAssignments([
    {
      role: "executor",
      taskPacket: {
        id: "task-executor-1",
        title: "Implement feature gate",
        objective: "Add the feature gate safely",
        allowedFiles: ["src/lib/auditor.js"],
        forbiddenFiles: ["README.md"],
      },
    },
  ]);

  await controller.dispatchAssignments([
    {
      role: "verifier",
      taskPacket: {
        id: "task-executor-1",
        title: "Verify feature gate",
        objective: "Validate executor self-test evidence before review.",
      },
    },
  ]);

  const state = await loadV2ControllerState(workspaceRoot, "run-controller-2");
  assert.equal(state.verifications.length, 1);
  assert.equal(state.tasks[0].status, "in_progress");
  assert.equal(state.tasks[0].stage, "reviewing");
});

test("dispatching a verifier task auto-records the verification verdict", async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "longrun-controller-"));
  const runtime = new NativeAgentRuntime({
    adapter: new FakeRuntimeAdapter(),
  });
  const controller = new LongRunController({
    workspaceRoot,
    runId: "run-controller-6",
    missionDigest: "digest-6",
    runtime,
  });

  await controller.dispatchAssignments([
    {
      role: "executor",
      taskPacket: {
        id: "task-executor-6",
        title: "Implement feature gate",
        objective: "Add the feature gate safely",
        allowedFiles: ["src/lib/auditor.js"],
      },
    },
  ]);

  await controller.dispatchAssignments([
    {
      role: "verifier",
      taskPacket: {
        id: "task-executor-6",
        title: "Verify feature gate",
      },
    },
  ]);

  const state = await loadV2ControllerState(workspaceRoot, "run-controller-6");
  assert.equal(state.verifications.length, 1);
  assert.equal(state.verifications[0].status, "pass");
  assert.equal(state.tasks[0].stage, "reviewing");
  assert.equal(state.controller.currentPhase, "reviewing");
});

test("dispatching a reviewer task auto-records review approval", async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "longrun-controller-"));
  const runtime = new NativeAgentRuntime({
    adapter: new FakeRuntimeAdapter(),
  });
  const controller = new LongRunController({
    workspaceRoot,
    runId: "run-controller-7",
    missionDigest: "digest-7",
    runtime,
  });

  await controller.dispatchAssignments([
    {
      role: "executor",
      taskPacket: {
        id: "task-executor-7",
        title: "Implement feature gate",
        objective: "Add the feature gate safely",
        allowedFiles: ["src/lib/auditor.js"],
      },
    },
  ]);
  await controller.dispatchAssignments([
    {
      role: "verifier",
      taskPacket: {
        id: "task-executor-7",
        title: "Verify feature gate",
      },
    },
  ]);
  await controller.dispatchAssignments([
    {
      role: "reviewer",
      taskPacket: {
        id: "task-executor-7",
        title: "Review feature gate",
      },
    },
  ]);

  const state = await loadV2ControllerState(workspaceRoot, "run-controller-7");
  assert.equal(state.reviews.length, 1);
  assert.equal(state.reviews[0].kind, "pass");
  assert.equal(state.tasks[0].stage, "awaiting_manager_acceptance");
  assert.equal(state.controller.currentPhase, "awaiting_manager_acceptance");
});

test("controller rejects verifier pass when executor self-test evidence is missing", async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "longrun-controller-"));
  const runtime = new NativeAgentRuntime({
    adapter: {
      async runTask({ agentSession, taskPacket }) {
        return {
          agentId: agentSession.agentId,
          taskId: taskPacket.id,
          role: agentSession.role,
          threadId: `thread-${agentSession.agentId}`,
          status: "completed",
          summary: `Completed ${taskPacket.title}`,
          evidence: [],
          filesTouched: [],
          questions: [],
        };
      },
    },
  });
  const controller = new LongRunController({
    workspaceRoot,
    runId: "run-controller-4",
    missionDigest: "digest-4",
    runtime,
  });

  await assert.rejects(
    () =>
      controller.dispatchAssignments([
        {
          role: "executor",
          taskPacket: {
            id: "task-executor-4",
            title: "Implement without self-test proof",
            allowedFiles: ["src/lib/controller.js"],
          },
        },
      ]),
    /self-test evidence/i,
  );
});

test("controller rejects verifier dispatch before executor self-test evidence exists", async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "longrun-controller-"));
  const runtime = new NativeAgentRuntime({
    adapter: new FakeRuntimeAdapter(),
  });
  const controller = new LongRunController({
    workspaceRoot,
    runId: "run-controller-verifier-direct",
    missionDigest: "digest-direct-verifier",
    runtime,
  });

  await assert.rejects(
    () =>
      controller.dispatchAssignments([
        {
          role: "verifier",
          taskPacket: {
            id: "task-verifier-direct",
            title: "Verify without executor evidence",
          },
        },
      ]),
    /not ready for verifier review|cannot be verified without self-test evidence/i,
  );
});

test("controller rejects malformed child results instead of silently normalizing mismatches", async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "longrun-controller-"));
  const runtime = new NativeAgentRuntime({
    adapter: {
      async runTask({ agentSession }) {
        return {
          agentId: agentSession.agentId,
          taskId: "wrong-task-id",
          role: agentSession.role,
          threadId: `thread-${agentSession.agentId}`,
          status: "completed",
          summary: "Returned the wrong task id.",
          evidence: [],
          filesTouched: [],
          questions: [],
        };
      },
    },
  });
  const controller = new LongRunController({
    workspaceRoot,
    runId: "run-controller-3",
    missionDigest: "digest-3",
    runtime,
  });

  await assert.rejects(
    () =>
      controller.dispatchAssignments([
        {
          role: "observer",
          taskPacket: {
            id: "task-observer-3",
            title: "Inspect repo mismatch",
            objective: "Return a mismatched task id",
          },
        },
      ]),
    /taskId mismatch/i,
  );
});

test("controller keeps verifier tasks open when runtime reports a non-completed status", async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "longrun-controller-"));
  const runtime = new NativeAgentRuntime({
    adapter: {
      async runTask({ agentSession, taskPacket }) {
        return {
          agentId: agentSession.agentId,
          taskId: taskPacket.id,
          role: agentSession.role,
          threadId: `thread-${agentSession.agentId}`,
          status: agentSession.role === "verifier" ? "blocked" : "completed",
          summary: `Completed ${taskPacket.title}`,
          evidence: agentSession.role === "executor" ? [`self-test:${taskPacket.id}`] : [],
          filesTouched: [],
          questions: [],
        };
      },
    },
  });
  const controller = new LongRunController({
    workspaceRoot,
    runId: "run-controller-5",
    missionDigest: "digest-5",
    runtime,
  });

  await controller.dispatchAssignments([
    {
      role: "executor",
      taskPacket: {
        id: "task-verifier-blocked",
        title: "Implement something reviewable",
        allowedFiles: ["src/lib/controller.js"],
      },
    },
  ]);

  await controller.dispatchAssignments([
    {
      role: "verifier",
      taskPacket: {
        id: "task-verifier-blocked",
        title: "Verify something reviewable",
      },
    },
  ]);

  const state = await loadV2ControllerState(workspaceRoot, "run-controller-5");
  assert.equal(state.tasks[0].stage, "verifying");
  assert.equal(state.tasks[0].status, "blocked");
});
