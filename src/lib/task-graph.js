import { randomUUID } from "node:crypto";

import { isoNow } from "./io.js";

export const TASK_STAGES = Object.freeze([
  "understanding",
  "planning",
  "implementing",
  "self_testing",
  "verifying",
  "reviewing",
  "fixing",
  "reverifying",
  "awaiting_manager_acceptance",
  "delivered",
]);

export const TASK_STATUSES = Object.freeze([
  "queued",
  "dispatched",
  "in_progress",
  "waiting_for_answer",
  "blocked",
  "retry_required",
  "accepted",
  "cancelled",
]);

function assertEnum(value, validValues, label) {
  if (!validValues.includes(value)) {
    throw new Error(`Invalid ${label}: ${value}`);
  }
}

export function createV2Task({
  id = randomUUID(),
  title,
  objective = "",
  ownerRole = "executor",
  stage = "understanding",
  status = "queued",
  dependencies = [],
  acceptanceChecks = [],
  allowedFiles = [],
  forbiddenFiles = [],
}) {
  if (!String(title ?? "").trim()) {
    throw new Error("Task title is required.");
  }

  assertEnum(stage, TASK_STAGES, "task stage");
  assertEnum(status, TASK_STATUSES, "task status");

  const now = isoNow();

  return {
    id,
    title: String(title).trim(),
    objective: String(objective ?? "").trim(),
    ownerRole: String(ownerRole ?? "executor").trim(),
    stage,
    status,
    dependencies: [...dependencies],
    acceptanceChecks: [...acceptanceChecks],
    allowedFiles: [...allowedFiles],
    forbiddenFiles: [...forbiddenFiles],
    createdAt: now,
    updatedAt: now,
  };
}

export function createTaskGraph(tasks = []) {
  return {
    version: 2,
    tasks,
    updatedAt: isoNow(),
  };
}

export function setTaskStage(task, stage) {
  assertEnum(stage, TASK_STAGES, "task stage");
  task.stage = stage;
  task.updatedAt = isoNow();
  return task;
}

export function setTaskStatus(task, status) {
  assertEnum(status, TASK_STATUSES, "task status");
  task.status = status;
  task.updatedAt = isoNow();
  return task;
}

export function getOpenTasks(taskGraph) {
  return taskGraph.tasks.filter(
    (task) => !["accepted", "cancelled"].includes(task.status),
  );
}
