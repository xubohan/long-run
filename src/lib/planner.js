import { randomUUID } from "node:crypto";

import { isoNow, normalizeText } from "./io.js";

const PRIORITY_ORDER = {
  high: 0,
  medium: 1,
  low: 2,
};

function createTask({ title, rationale, source = "system", priority = "medium" }) {
  const now = isoNow();

  return {
    id: randomUUID(),
    title: String(title).trim(),
    rationale: String(rationale ?? "").trim(),
    source,
    priority,
    status: "pending",
    createdAt: now,
    updatedAt: now,
    completedAt: null,
    notes: [],
  };
}

function touchTask(task) {
  task.updatedAt = isoNow();
}

function setTaskStatus(task, status) {
  task.status = status;
  touchTask(task);
}

export function createInitialPlan(mission) {
  const now = isoNow();
  const tasks = [
    createTask({
      title: `Inspect the workspace and produce the first concrete execution plan for: ${mission.goal}`,
      rationale: "Long runs should ground in the real repo before editing anything.",
      source: "system",
      priority: "high",
    }),
    createTask({
      title: `Execute the highest-value mission work for: ${mission.goal}`,
      rationale: "Keep the worker focused on the next meaningful chunk of progress.",
      source: "system",
      priority: "high",
    }),
    createTask({
      title: "Verify every definition-of-done item with direct evidence before closing the mission",
      rationale: "Completion should be evidence-based, not conversational.",
      source: "system",
      priority: "high",
    }),
  ];

  tasks[0].status = "in_progress";

  return {
    version: 1,
    createdAt: now,
    updatedAt: now,
    replanReason: "Initial mission lock created.",
    focusTaskId: tasks[0].id,
    tasks,
  };
}

export function getTaskById(plan, taskId) {
  return plan.tasks.find((task) => task.id === taskId) ?? null;
}

export function getFocusTask(plan) {
  return getTaskById(plan, plan.focusTaskId);
}

function normalizeTaskHint(value) {
  return normalizeText(value);
}

function matchesHint(task, hint) {
  const normalizedHint = normalizeTaskHint(hint);
  const normalizedTitle = normalizeTaskHint(task.title);

  if (!normalizedHint) {
    return false;
  }

  return (
    normalizedTitle === normalizedHint ||
    normalizedTitle.includes(normalizedHint) ||
    normalizedHint.includes(normalizedTitle)
  );
}

export function findTaskByHint(plan, hint) {
  return (
    plan.tasks.find(
      (task) => task.status !== "completed" && matchesHint(task, hint),
    ) ?? null
  );
}

function sortNewTasks(tasks) {
  return [...tasks].sort((left, right) => {
    const leftRank = PRIORITY_ORDER[left.priority] ?? PRIORITY_ORDER.medium;
    const rightRank = PRIORITY_ORDER[right.priority] ?? PRIORITY_ORDER.medium;
    return leftRank - rightRank;
  });
}

export function ensureFocusTask(plan) {
  const currentFocus = getFocusTask(plan);
  if (currentFocus && currentFocus.status !== "completed") {
    if (currentFocus.status === "pending") {
      setTaskStatus(currentFocus, "in_progress");
    }
    return currentFocus;
  }

  const nextTask =
    plan.tasks.find((task) => task.status === "in_progress") ??
    plan.tasks.find((task) => task.status === "pending");

  if (!nextTask) {
    plan.focusTaskId = null;
    plan.updatedAt = isoNow();
    return null;
  }

  for (const task of plan.tasks) {
    if (task.id === nextTask.id) {
      setTaskStatus(task, "in_progress");
    } else if (task.status === "in_progress") {
      setTaskStatus(task, "pending");
    }
  }

  plan.focusTaskId = nextTask.id;
  plan.updatedAt = isoNow();
  return nextTask;
}

export function markTaskCompleted(plan, taskId, note = "") {
  const task = getTaskById(plan, taskId);
  if (!task || task.status === "completed") {
    return null;
  }

  task.status = "completed";
  task.completedAt = isoNow();
  touchTask(task);

  if (note) {
    task.notes.push(String(note).trim());
  }

  plan.updatedAt = isoNow();
  return task;
}

export function markTasksCompletedByHint(plan, hints = []) {
  const completed = [];

  for (const hint of hints) {
    const match = plan.tasks.find((task) => matchesHint(task, hint));
    if (match) {
      markTaskCompleted(plan, match.id, `Marked completed from worker output: ${hint}`);
      completed.push(match);
    }
  }

  return completed;
}

export function mergeSuggestedTasks(plan, suggestions = [], source = "codex") {
  const existingTitles = new Set(plan.tasks.map((task) => normalizeTaskHint(task.title)));
  const newTasks = [];

  for (const suggestion of sortNewTasks(suggestions)) {
    const title = String(suggestion?.title ?? "").trim();
    if (!title) {
      continue;
    }

    const normalizedTitle = normalizeTaskHint(title);
    if (existingTitles.has(normalizedTitle)) {
      continue;
    }

    const task = createTask({
      title,
      rationale: suggestion?.rationale ?? "",
      source,
      priority: suggestion?.priority ?? "medium",
    });

    existingTitles.add(normalizedTitle);
    newTasks.push(task);
  }

  plan.tasks.push(...newTasks);
  if (newTasks.length > 0) {
    plan.updatedAt = isoNow();
  }

  return newTasks;
}

export function addSystemTask(plan, title, rationale, priority = "high") {
  const tasks = mergeSuggestedTasks(
    plan,
    [{ title, rationale, priority }],
    "system",
  );

  return tasks[0] ?? null;
}

export function chooseFocusTask(plan, hint = "") {
  let nextFocus =
    findTaskByHint(plan, hint) ??
    plan.tasks.find((task) => task.status === "in_progress") ??
    plan.tasks.find((task) => task.status === "pending") ??
    null;

  if (!nextFocus) {
    plan.focusTaskId = null;
    plan.updatedAt = isoNow();
    return null;
  }

  for (const task of plan.tasks) {
    if (task.id === nextFocus.id) {
      if (task.status === "pending") {
        setTaskStatus(task, "in_progress");
      }
    } else if (task.status === "in_progress") {
      setTaskStatus(task, "pending");
    }
  }

  plan.focusTaskId = nextFocus.id;
  plan.updatedAt = isoNow();
  return nextFocus;
}

export function summarizePlan(plan, limit = 8) {
  const visibleTasks = plan.tasks.slice(0, limit);

  return visibleTasks
    .map((task, index) => {
      const marker = task.id === plan.focusTaskId ? "*" : "-";
      return `${marker} ${index + 1}. [${task.status}] ${task.title}`;
    })
    .join("\n");
}
