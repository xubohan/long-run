import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";

import { loadRunBundle, saveRun } from "../src/lib/state.js";
import { resumeRun, startRun } from "../src/lib/supervisor.js";

function makeCycleOutput(overrides = {}) {
  return {
    summary: "Cycle finished.",
    status: "needs_more_work",
    current_task_completed: false,
    made_progress: true,
    stayed_on_mission: true,
    risk_level: "low",
    requires_human: false,
    human_reason: "",
    evidence: [],
    files_touched: [],
    bugs_found: [],
    tasks_completed: [],
    tasks_to_add: [],
    next_focus_task: "",
    verification: {
      status: "not_run",
      evidence: "",
    },
    definition_of_done: [
      {
        criterion: "Create the target file",
        status: "not_met",
        evidence: "",
      },
    ],
    proposed_goal_changes: [],
    blockers: [],
    ...overrides,
  };
}

class FakeWorker {
  constructor(responses) {
    this.responses = [...responses];
    this.calls = [];
  }

  async runCycle({ threadId, onSpawn }) {
    const response = this.responses.shift();
    if (!response) {
      throw new Error("No fake worker response available.");
    }

    if (onSpawn) {
      await onSpawn(process.pid);
    }

    this.calls.push({
      threadId,
    });

    return {
      exitCode: 0,
      threadId: response.threadId ?? threadId ?? "fake-thread",
      structuredOutput: response.output,
      stdout: "",
      stderr: "",
    };
  }
}

test("startRun rejects legacy goal completion claims without verifier pass and persists the mission digest", async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "longrun-"));
  const worker = new FakeWorker([
    {
      threadId: "thread-1",
      output: makeCycleOutput({
        summary: "Inspected workspace and created the implementation task.",
        status: "task_completed",
        current_task_completed: true,
        evidence: ["Reviewed the workspace and established the plan."],
        tasks_to_add: [
          {
            title: "Implement the target file",
            rationale: "Needed to satisfy the mission.",
            priority: "high",
          },
        ],
        next_focus_task: "Implement the target file",
      }),
    },
    {
      threadId: "thread-1",
      output: makeCycleOutput({
        summary: "Implemented the target file and claimed completion.",
        status: "goal_completed",
        current_task_completed: true,
        evidence: ["goal.txt now exists with the expected content."],
        files_touched: ["goal.txt"],
        tasks_completed: ["Implement the target file"],
        definition_of_done: [
          {
            criterion: "Create the target file",
            status: "met",
            evidence: "goal.txt now exists with the expected content.",
          },
        ],
      }),
    },
  ]);

  const result = await startRun({
    workspaceRoot,
    missionInput: {
      goal: "Create the target file",
      definitionOfDone: ["Create the target file"],
      constraints: ["Terminal-first"],
      nonGoals: [],
      guardrails: ["Pause on high risk"],
    },
    worker,
  });

  const persisted = await loadRunBundle(workspaceRoot, result.run.runId);

  assert.equal(result.run.status, "paused");
  assert.equal(result.run.threadId, "thread-1");
  assert.equal(persisted.mission.digest, result.mission.digest);
  assert.equal(result.run.engine, "v1");
  assert.equal(result.run.runtimeVersion, 1);
  assert.match(result.run.pendingApproval.reason, /Verifier pass with evidence is required/);
  assert.equal(result.run.shippingStatus, "not_shippable_yet");
});

test("startRun pauses after three no-progress cycles", async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "longrun-"));
  const worker = new FakeWorker([
    {
      output: makeCycleOutput({
        summary: "No useful progress in cycle 1.",
        made_progress: false,
      }),
    },
    {
      output: makeCycleOutput({
        summary: "No useful progress in cycle 2.",
        made_progress: false,
      }),
    },
    {
      output: makeCycleOutput({
        summary: "No useful progress in cycle 3.",
        made_progress: false,
      }),
    },
  ]);

  const result = await startRun({
    workspaceRoot,
    missionInput: {
      goal: "Create the target file",
      definitionOfDone: ["Create the target file"],
      constraints: [],
      nonGoals: [],
      guardrails: [],
    },
    worker,
  });

  assert.equal(result.run.status, "paused");
  assert.match(
    result.run.pendingApproval.reason,
    /Three consecutive no-progress cycles/,
  );
});

test("resumeRun reuses the previous thread id after a persisted pause", async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "longrun-"));
  const firstWorker = new FakeWorker([
    {
      threadId: "thread-resume",
      output: makeCycleOutput({
        summary: "Finished the planning cycle.",
        status: "task_completed",
        current_task_completed: true,
        evidence: ["A concrete implementation task is now queued."],
        tasks_to_add: [
          {
            title: "Implement the target file",
            rationale: "Needed to finish the mission.",
            priority: "high",
          },
        ],
        next_focus_task: "Implement the target file",
      }),
    },
  ]);

  const firstResult = await startRun({
    workspaceRoot,
    missionInput: {
      goal: "Create the target file",
      definitionOfDone: ["Create the target file"],
      constraints: [],
      nonGoals: [],
      guardrails: [],
    },
    worker: firstWorker,
    maxCycles: 1,
  });

  assert.equal(firstResult.run.status, "paused");
  assert.equal(firstResult.run.threadId, "thread-resume");

  const bundle = await loadRunBundle(workspaceRoot, firstResult.run.runId);
  bundle.run.maxCycles = 0;
  bundle.run.status = "ready";
  bundle.run.pendingApproval = null;
  await saveRun(bundle.paths, bundle.run);

  const secondWorker = new FakeWorker([
    {
      output: makeCycleOutput({
        summary: "Implemented the file and closed the mission.",
        status: "goal_completed",
        current_task_completed: true,
        made_progress: true,
        evidence: ["goal.txt now exists."],
        files_touched: ["goal.txt"],
        tasks_completed: ["Implement the target file"],
        definition_of_done: [
          {
            criterion: "Create the target file",
            status: "met",
            evidence: "goal.txt now exists.",
          },
        ],
      }),
    },
  ]);

  const resumed = await resumeRun({
    workspaceRoot,
    runId: firstResult.run.runId,
    worker: secondWorker,
  });

  assert.equal(secondWorker.calls[0].threadId, "thread-resume");
  assert.equal(resumed.run.status, "paused");
  assert.equal(resumed.run.reviewStatus, "required");
});

test("next_focus_task without tasks_to_add still becomes the next focus", async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "longrun-"));
  const worker = new FakeWorker([
    {
      output: makeCycleOutput({
        summary: "Planned the next concrete implementation step.",
        status: "task_completed",
        current_task_completed: true,
        next_focus_task: "Implement the target file now",
      }),
    },
  ]);

  const result = await startRun({
    workspaceRoot,
    missionInput: {
      goal: "Create the target file",
      definitionOfDone: ["Create the target file"],
      constraints: [],
      nonGoals: [],
      guardrails: [],
    },
    worker,
    maxCycles: 1,
  });

  const focusTask = result.plan.tasks.find(
    (task) => task.id === result.plan.focusTaskId,
  );

  assert.equal(result.run.status, "paused");
  assert.equal(focusTask.title, "Implement the target file now");
});

test("legacy goal completion with verifier evidence still pauses for review_required semantics", async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "longrun-"));
  const worker = new FakeWorker([
    {
      output: makeCycleOutput({
        summary: "Verifier-backed completion evidence is available.",
        status: "goal_completed",
        current_task_completed: true,
        evidence: ["goal.txt now exists with the expected content."],
        files_touched: ["goal.txt"],
        verification: {
          status: "pass",
          evidence: "Verifier reran the required checks successfully.",
        },
        definition_of_done: [
          {
            criterion: "Create the target file",
            status: "met",
            evidence: "goal.txt now exists with the expected content.",
          },
        ],
      }),
    },
  ]);

  const result = await startRun({
    workspaceRoot,
    missionInput: {
      goal: "Create the target file",
      definitionOfDone: ["Create the target file"],
      constraints: [],
      nonGoals: [],
      guardrails: [],
    },
    worker,
  });

  assert.equal(result.run.status, "paused");
  assert.equal(result.run.reviewStatus, "required");
  assert.equal(result.run.shippingStatus, "not_shippable_yet");
  assert.match(result.run.pendingApproval.reason, /review is still required/i);
});
