import test from "node:test";
import assert from "node:assert/strict";

import {
  createTaskGraph,
  createV2Task,
  getOpenTasks,
  setTaskStage,
  setTaskStatus,
} from "../src/lib/task-graph.js";

test("createV2Task enforces valid stage and status", () => {
  const task = createV2Task({
    title: "Implement controller state",
    stage: "planning",
    status: "queued",
  });

  assert.equal(task.stage, "planning");
  assert.equal(task.status, "queued");
});

test("getOpenTasks excludes accepted and cancelled tasks", () => {
  const openTask = createV2Task({ title: "Open task" });
  const acceptedTask = createV2Task({ title: "Accepted task" });
  const cancelledTask = createV2Task({ title: "Cancelled task" });

  setTaskStatus(acceptedTask, "accepted");
  setTaskStatus(cancelledTask, "cancelled");
  setTaskStage(openTask, "implementing");

  const openTasks = getOpenTasks(
    createTaskGraph([openTask, acceptedTask, cancelledTask]),
  );

  assert.deepEqual(openTasks.map((task) => task.title), ["Open task"]);
});
