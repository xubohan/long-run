import path from "node:path";

import {
  getV2StatePaths,
  initializeV2ControllerState,
  loadV2ControllerState,
  saveV2Controller,
  saveV2TaskGraph,
  writeV2Record,
} from "./controller-state.js";
import {
  answerClarification as answerClarificationRecord,
  createClarification,
  hasOpenClarifications,
} from "./clarifications.js";
import { createQuestion, answerQuestion, hasOpenHighPriorityQuestions } from "./questions.js";
import {
  createVerificationRecord,
  getLatestVerificationForTask,
  hasFreshPassingTaskVerification,
  hasPassingTaskVerification,
} from "./verification.js";
import {
  createReviewFinding,
  createReviewPass,
  hasFreshTaskReviewPass,
  hasBlockingReviewFindings,
  hasBlockingTaskReviewFindings,
  resolveReviewFinding,
} from "./reviews.js";
import { createAgentSessionRecord } from "./agent-registry.js";
import { NativeAgentRuntime } from "./native-agent-runtime.js";
import { createV2Task, setTaskStatus } from "./task-graph.js";
import { isoNow, writeJson } from "./io.js";
import { createMissionLock } from "./mission.js";
import { initializeRun, loadRunBundle, saveRun } from "./state.js";
import { evaluateDeliveryGate } from "./delivery-gate.js";

function normalizeList(values) {
  return (values ?? []).map((value) => String(value ?? "").trim()).filter(Boolean);
}

function isWriteCapableRole(role) {
  return role === "executor";
}

function syncCollectionRecord(collection, record) {
  const index = collection.findIndex((entry) => entry.id === record.id);
  if (index >= 0) {
    collection[index] = record;
  } else {
    collection.push(record);
  }

  return collection;
}

function assertSingleWriter(assignments) {
  const writers = assignments.filter((assignment) => isWriteCapableRole(assignment.role));
  if (writers.length > 1) {
    throw new Error("Single-writer rule violation: only one write-capable executor may run at a time.");
  }
}

function assertFilesWithinScope(taskPacket, result) {
  const allowedFiles = normalizeList(taskPacket.allowedFiles);
  const forbiddenFiles = new Set(normalizeList(taskPacket.forbiddenFiles));

  for (const filePath of result.filesTouched ?? []) {
    if (forbiddenFiles.has(filePath)) {
      throw new Error(`Forbidden file touched: ${filePath}`);
    }

    if (allowedFiles.length > 0 && !allowedFiles.includes(filePath)) {
      throw new Error(`Touched file outside allowed scope: ${filePath}`);
    }
  }
}

function buildTaskRecord(taskPacket) {
  return createV2Task({
    id: taskPacket.id,
    title: taskPacket.title,
    objective: taskPacket.objective,
    ownerRole: taskPacket.ownerRole || "executor",
    stage: "implementing",
    status: "dispatched",
    dependencies: taskPacket.dependencies ?? [],
    acceptanceChecks: taskPacket.acceptanceChecks ?? [],
    readRoots: taskPacket.readRoots ?? [],
    allowedFiles: taskPacket.allowedFiles ?? [],
    forbiddenFiles: taskPacket.forbiddenFiles ?? [],
  });
}

function hydrateTaskRecord(existingTask, taskPacket) {
  if (!existingTask) {
    return buildTaskRecord(taskPacket);
  }

  if (taskPacket.title != null) {
    existingTask.title = taskPacket.title;
  }

  if (taskPacket.objective != null) {
    existingTask.objective = taskPacket.objective;
  }

  if (taskPacket.dependencies != null) {
    existingTask.dependencies = [...taskPacket.dependencies];
  }

  if (taskPacket.ownerRole != null) {
    existingTask.ownerRole = String(taskPacket.ownerRole).trim();
  }

  if (taskPacket.acceptanceChecks != null) {
    existingTask.acceptanceChecks = [...taskPacket.acceptanceChecks];
  }

  if (taskPacket.readRoots != null) {
    existingTask.readRoots = [...taskPacket.readRoots];
  }

  if (taskPacket.allowedFiles != null) {
    existingTask.allowedFiles = [...taskPacket.allowedFiles];
  }

  if (taskPacket.forbiddenFiles != null) {
    existingTask.forbiddenFiles = [...taskPacket.forbiddenFiles];
  }

  existingTask.updatedAt = isoNow();
  return existingTask;
}

function findReusableSession(agents, { role, taskId }) {
  return agents.find(
    (agent) => agent.role === role && agent.taskId === taskId,
  ) ?? null;
}

function updateTaskGraphWithTask(taskGraph, taskRecord) {
  const existingIndex = taskGraph.tasks.findIndex((task) => task.id === taskRecord.id);
  if (existingIndex >= 0) {
    taskGraph.tasks[existingIndex] = taskRecord;
  } else {
    taskGraph.tasks.push(taskRecord);
  }
  return taskGraph;
}

function getTaskRecord(state, taskId) {
  const taskRecord = state.tasks.find((task) => task.id === taskId);
  if (!taskRecord) {
    throw new Error(`Unknown task: ${taskId}`);
  }

  return taskRecord;
}

function findActorSession(state, {
  taskId,
  actorRole,
  actorAgentId = "",
}) {
  const normalizedRole = String(actorRole ?? "").trim();
  if (!normalizedRole) {
    throw new Error("Actor role is required.");
  }

  const normalizedAgentId = String(actorAgentId ?? "").trim();
  if (normalizedAgentId) {
    const matchingSession = state.agents.find(
      (agent) =>
        agent.agentId === normalizedAgentId &&
        agent.role === normalizedRole &&
        agent.taskId === taskId,
    );

    if (!matchingSession) {
      throw new Error(
        `No ${normalizedRole} agent session found for task ${taskId} and actor ${normalizedAgentId}.`,
      );
    }

    return matchingSession;
  }

  const candidateSessions = state.agents.filter(
    (agent) => agent.role === normalizedRole && agent.taskId === taskId,
  );

  if (candidateSessions.length !== 1) {
    throw new Error(
      `Exactly one ${normalizedRole} agent session is required for task ${taskId}.`,
    );
  }

  return candidateSessions[0];
}

function getTaskSelfTestEvidence(taskRecord) {
  return normalizeList(taskRecord.selfTestEvidence);
}

function hasPriorTaskVerificationOrReview(state, taskId) {
  return (
    state.verifications.some((verification) => verification.taskId === taskId) ||
    state.reviews.some((review) => review.taskId === taskId)
  );
}

function normalizeAgentRunStatus(status) {
  return String(status ?? "").trim();
}

function getAgentFreshnessTimestamp(agentSession) {
  return String(agentSession.lastCompletedAt || agentSession.lastRunAt || "");
}

function assertCompletedActorSession(state, {
  taskId,
  actorRole,
  actorAgentId = "",
  freshAfter = "",
}) {
  const actorSession = findActorSession(state, {
    taskId,
    actorRole,
    actorAgentId,
  });

  if (normalizeAgentRunStatus(actorSession.lastResultStatus) !== "completed") {
    throw new Error(
      `${actorRole} agent ${actorSession.agentId} has not completed a runtime pass for task ${taskId}.`,
    );
  }

  if (
    String(freshAfter).trim() &&
    getAgentFreshnessTimestamp(actorSession).localeCompare(String(freshAfter).trim()) < 0
  ) {
    throw new Error(
      `${actorRole} agent ${actorSession.agentId} has stale runtime evidence for task ${taskId}.`,
    );
  }

  return actorSession;
}

function assertTaskReadyForVerification(taskRecord) {
  if (!["self_testing", "verifying", "reverifying"].includes(taskRecord.stage)) {
    throw new Error(
      `Task ${taskRecord.id} is not ready for verifier review from stage ${taskRecord.stage}.`,
    );
  }

  if (getTaskSelfTestEvidence(taskRecord).length === 0) {
    throw new Error(`Task ${taskRecord.id} cannot be verified without self-test evidence.`);
  }
}

function getLatestTaskTimestamp(records = [], taskId) {
  return records
    .filter((record) => record.taskId === taskId)
    .map((record) => String(record.updatedAt || record.createdAt || ""))
    .sort()
    .at(-1) ?? "";
}

function buildSupportingRoleStatus(resultStatus) {
  if (resultStatus === "needs_input") {
    return "waiting_for_answer";
  }

  if (resultStatus === "retry_required") {
    return "retry_required";
  }

  if (resultStatus === "blocked") {
    return "blocked";
  }

  return "in_progress";
}

function isActiveDispatchedTask(task) {
  return (
    task.stage !== "delivered" &&
    !["queued", "accepted", "cancelled"].includes(task.status)
  );
}

function getRoleDispatchLimit(staffingPlan = [], role) {
  const staffingEntry = (staffingPlan ?? []).find(
    (entry) => entry.role === role,
  );
  const plannedCount = staffingEntry?.count ?? null;

  if (role === "executor") {
    return plannedCount == null ? 1 : Math.min(plannedCount, 1);
  }

  return plannedCount;
}

function assertManagerClarificationBudget(questions = []) {
  const managerQuestionCount = (questions ?? []).filter(
    (question) => question.toRole === "manager",
  ).length;

  if (managerQuestionCount > 3) {
    throw new Error(
      `Manager clarification pass exceeded the maximum question budget: ${managerQuestionCount} > 3.`,
    );
  }
}

function assertStaffingCoversTaskProposalRoles(taskProposals = [], staffingPlan = []) {
  const staffedRoles = new Set((staffingPlan ?? []).map((entry) => entry.role));
  const proposedRoles = [...new Set((taskProposals ?? []).map((proposal) => proposal.role))];
  const missingRoles = proposedRoles.filter((role) => !staffedRoles.has(role));

  if (missingRoles.length > 0) {
    throw new Error(
      `Planner staffing plan must cover every proposed role. Missing roles: ${missingRoles.join(", ")}`,
    );
  }
}

function hasFreshCompletedRoleRun(state, {
  taskId,
  role,
  freshAfter = "",
}) {
  return state.agents.some(
    (agent) =>
      agent.taskId === taskId &&
      agent.role === role &&
      normalizeAgentRunStatus(agent.lastResultStatus) === "completed" &&
      (
        !String(freshAfter).trim() ||
        getAgentFreshnessTimestamp(agent).localeCompare(String(freshAfter).trim()) >= 0
      ),
  );
}

function ensureTaskCanAdvanceToManagerAcceptance(state, taskRecord) {
  if (taskRecord.stage !== "awaiting_manager_acceptance") {
    throw new Error(
      `Task ${taskRecord.id} cannot be accepted from stage ${taskRecord.stage}; manager acceptance requires awaiting_manager_acceptance.`,
    );
  }

  if (
    !hasFreshPassingTaskVerification(
      state.verifications,
      taskRecord.id,
      taskRecord.lastExecutionCompletedAt,
    )
  ) {
    throw new Error(
      `Task ${taskRecord.id} cannot be accepted without fresh verifier coverage for the latest execution.`,
    );
  }

  const latestVerification = getLatestVerificationForTask(state.verifications, taskRecord.id);
  const reviewFreshAfter =
    latestVerification?.updatedAt || latestVerification?.createdAt || "";

  if (!hasFreshTaskReviewPass(state.reviews, taskRecord.id, reviewFreshAfter)) {
    throw new Error(`Task ${taskRecord.id} cannot be accepted before fresh reviewer coverage exists.`);
  }

  if (hasBlockingTaskReviewFindings(state.reviews, taskRecord.id)) {
    throw new Error(`Task ${taskRecord.id} has unresolved blocking review findings.`);
  }
}

function assertTaskReadyForReview(state, taskRecord) {
  if (!["reviewing", "awaiting_manager_acceptance"].includes(taskRecord.stage)) {
    throw new Error(
      `Task ${taskRecord.id} is not ready for reviewer review from stage ${taskRecord.stage}.`,
    );
  }

  const latestVerification = getLatestVerificationForTask(
    state.verifications,
    taskRecord.id,
  );

  if (
    latestVerification?.status !== "pass" ||
    !String(latestVerification?.evidence || "").trim()
  ) {
    throw new Error(
      `Task ${taskRecord.id} cannot be reviewed without a passing verifier result.`,
    );
  }
}

function deriveControllerPhase(taskRecord, resultStatus) {
  if (resultStatus === "needs_input") {
    return "waiting_for_answer";
  }

  switch (taskRecord.stage) {
    case "self_testing":
      return "self_testing";
    case "verifying":
      return "verifying";
    case "reverifying":
      return "reverifying";
    case "reviewing":
      return "reviewing";
    case "fixing":
      return "fixing";
    case "awaiting_manager_acceptance":
    case "delivered":
      return "awaiting_manager_acceptance";
    default:
      return "implementing";
  }
}

function getAnsweredClarificationSummaries(clarifications = []) {
  return clarifications
    .filter((clarification) => String(clarification.answer ?? "").trim())
    .map(
      (clarification) =>
        `Clarification: ${clarification.prompt}\nAnswer: ${String(clarification.answer).trim()}`,
    );
}

function createBootstrapTaskPacket({
  id,
  title,
  objective,
  role,
  missionGoal,
  definitionOfDone = [],
  readRoots = [],
}) {
  return {
    id,
    title,
    objective: [
      objective,
      `Mission goal: ${missionGoal}`,
      definitionOfDone.length > 0
        ? `Definition of done: ${definitionOfDone.join(" | ")}`
        : "Definition of done: none",
    ].join("\n"),
    ownerRole: role,
    dependencies: [],
    acceptanceChecks: definitionOfDone,
    readRoots,
    allowedFiles: [],
    forbiddenFiles: [],
  };
}

export class LongRunController {
  constructor({
    workspaceRoot,
    runId,
    missionDigest,
    runtime = new NativeAgentRuntime(),
  }) {
    this.workspaceRoot = workspaceRoot;
    this.runId = runId;
    this.missionDigest = missionDigest;
    this.runtime = runtime;
  }

  async ensureInitialized() {
    const paths = getV2StatePaths(this.workspaceRoot, this.runId);
    try {
      const state = await loadV2ControllerState(this.workspaceRoot, this.runId);
      if (state.controller) {
        return state;
      }
    } catch {
      // fall through to initialization
    }

    await initializeV2ControllerState({
      workspaceRoot: this.workspaceRoot,
      runId: this.runId,
      missionDigest: this.missionDigest,
    });

    return loadV2ControllerState(this.workspaceRoot, this.runId);
  }

  async ensureAgentSession({
    role,
    taskId,
    threadId = "",
  }) {
    const state = await this.ensureInitialized();
    const reusableSession = findReusableSession(state.agents, { role, taskId });
    if (reusableSession) {
      return reusableSession;
    }

    const agentSession = createAgentSessionRecord({
      role,
      taskId,
      threadId,
    });
    await writeV2Record(state.paths.agentsDir, agentSession);
    syncCollectionRecord(state.agents, agentSession);
    return agentSession;
  }

  async loadRunBundle() {
    const [runBundle, controllerState] = await Promise.all([
      loadRunBundle(this.workspaceRoot, this.runId),
      this.ensureInitialized(),
    ]);

    return {
      ...runBundle,
      controllerState,
    };
  }

  async runManagerClarificationPass() {
    const state = await this.ensureInitialized();
    if (state.tasks.length > 0 || state.clarifications.length > 0) {
      return [];
    }

    const runBundle = await loadRunBundle(this.workspaceRoot, this.runId);
    const taskPacket = createBootstrapTaskPacket({
      id: "manager-bootstrap",
      title: "Manager clarification bootstrap",
      objective: "Ask only the key clarification questions needed before planning and dispatch.",
      role: "manager",
      missionGoal: runBundle.mission.goal,
      definitionOfDone: runBundle.mission.definitionOfDone,
      readRoots: [".omx/plans", ".omx/specs", "docs", "src", "tests"],
    });
    const agentSession = await this.ensureAgentSession({
      role: "manager",
      taskId: taskPacket.id,
    });

    const runtimeResult = await this.runtime.runTask({
      agentSession,
      missionDigest: this.missionDigest,
      taskPacket,
      acceptedAnswers: getAnsweredClarificationSummaries(state.clarifications),
      workspaceRoot: this.workspaceRoot,
      runId: this.runId,
    });

    agentSession.threadId =
      runtimeResult.result.threadId ||
      agentSession.threadId ||
      `thread-${agentSession.agentId}`;
    agentSession.lastResultStatus = runtimeResult.result.status;
    agentSession.lastResultSummary = runtimeResult.result.summary;
    agentSession.lastEvidence = [...runtimeResult.result.evidence];
    agentSession.lastRunAt = isoNow();
    agentSession.lastCompletedAt =
      runtimeResult.result.status === "completed" ? agentSession.lastRunAt : "";
    await writeV2Record(state.paths.agentsDir, agentSession);
    syncCollectionRecord(state.agents, agentSession);

    state.controller.staffingPlan = runtimeResult.result.staffing ?? [];
    state.controller.managerSummary = runtimeResult.result.summary;
    state.controller.managerClarifiedAt = agentSession.lastRunAt;
    assertManagerClarificationBudget(runtimeResult.result.questions);

    const clarificationRecords = [];
    for (const question of runtimeResult.result.questions ?? []) {
      if (question.toRole !== "manager") {
        continue;
      }
      const clarification = createClarification({ prompt: question.question });
      await writeV2Record(state.paths.clarificationsDir, clarification);
      syncCollectionRecord(state.clarifications, clarification);
      clarificationRecords.push(clarification);
    }

    if (clarificationRecords.length > 0) {
      runBundle.run.status = "paused";
      runBundle.run.pendingApproval = {
        required: true,
        reason: `Clarification required: ${clarificationRecords.map((item) => item.prompt).join(" ")}`,
        requestedAt: isoNow(),
        approvedAt: null,
        note: "",
      };
      state.controller.currentPhase = "understanding";
      await saveRun(runBundle.paths, runBundle.run);
    } else {
      state.controller.currentPhase = "planning";
    }

    await saveV2Controller(state.paths, state.controller);
    return clarificationRecords;
  }

  async runPlannerTaskGraphPass() {
    const state = await this.ensureInitialized();
    if (state.tasks.length > 0 || hasOpenClarifications(state.clarifications)) {
      return [];
    }

    const runBundle = await loadRunBundle(this.workspaceRoot, this.runId);
    const taskPacket = createBootstrapTaskPacket({
      id: "planner-bootstrap",
      title: "Planner task graph bootstrap",
      objective: "Generate the initial task graph and role mix after clarifications are answered.",
      role: "planner",
      missionGoal: runBundle.mission.goal,
      definitionOfDone: runBundle.mission.definitionOfDone,
      readRoots: [".omx/plans", ".omx/specs", "docs", "src", "tests"],
    });
    const agentSession = await this.ensureAgentSession({
      role: "planner",
      taskId: taskPacket.id,
    });

    const runtimeResult = await this.runtime.runTask({
      agentSession,
      missionDigest: this.missionDigest,
      taskPacket,
      acceptedAnswers: getAnsweredClarificationSummaries(state.clarifications),
      workspaceRoot: this.workspaceRoot,
      runId: this.runId,
    });

    agentSession.threadId =
      runtimeResult.result.threadId ||
      agentSession.threadId ||
      `thread-${agentSession.agentId}`;
    agentSession.lastResultStatus = runtimeResult.result.status;
    agentSession.lastResultSummary = runtimeResult.result.summary;
    agentSession.lastEvidence = [...runtimeResult.result.evidence];
    agentSession.lastRunAt = isoNow();
    agentSession.lastCompletedAt =
      runtimeResult.result.status === "completed" ? agentSession.lastRunAt : "";
    await writeV2Record(state.paths.agentsDir, agentSession);
    syncCollectionRecord(state.agents, agentSession);

    if (runtimeResult.result.status !== "completed") {
      state.controller.currentPhase = "planning";
      await saveV2Controller(state.paths, state.controller);
      return [];
    }

    state.controller.staffingPlan = runtimeResult.result.staffing ?? state.controller.staffingPlan ?? [];
    assertStaffingCoversTaskProposalRoles(
      runtimeResult.result.taskProposals,
      state.controller.staffingPlan,
    );
    state.controller.planningSummary = runtimeResult.result.summary;
    state.controller.plannedTaskIds = [];

    for (const proposal of runtimeResult.result.taskProposals ?? []) {
      const taskRecord = createV2Task({
        id: proposal.id,
        title: proposal.title,
        objective: proposal.objective,
        ownerRole: proposal.role,
        stage: proposal.role === "executor" ? "implementing" : "understanding",
        status: "queued",
        dependencies: proposal.dependencies ?? [],
        acceptanceChecks: proposal.acceptanceChecks ?? [],
        readRoots: proposal.readRoots ?? [],
        allowedFiles: proposal.allowedFiles ?? [],
        forbiddenFiles: proposal.forbiddenFiles ?? [],
      });
      await writeV2Record(state.paths.tasksDir, taskRecord);
      syncCollectionRecord(state.tasks, taskRecord);
      updateTaskGraphWithTask(state.taskGraph, taskRecord);
      state.controller.plannedTaskIds.push(taskRecord.id);
    }

    await saveV2TaskGraph(state.paths, state.taskGraph);
    state.controller.currentPhase = "planning";
    await saveV2Controller(state.paths, state.controller);
    return state.controller.plannedTaskIds;
  }

  async dispatchQueuedTasks() {
    const state = await this.ensureInitialized();
    if (hasOpenClarifications(state.clarifications) || hasOpenHighPriorityQuestions(state.questions)) {
      return [];
    }

    const activeRoleCounts = new Map();
    for (const task of state.tasks) {
      if (!isActiveDispatchedTask(task)) {
        continue;
      }

      const role = task.ownerRole || "executor";
      activeRoleCounts.set(role, (activeRoleCounts.get(role) ?? 0) + 1);
    }

    const assignments = [];
    const queuedRoleCounts = new Map();

    for (const task of state.tasks) {
      if (task.status !== "queued") {
        continue;
      }

      const role = task.ownerRole || "executor";
      const roleLimit = getRoleDispatchLimit(state.controller.staffingPlan, role);
      const activeCount = activeRoleCounts.get(role) ?? 0;
      const queuedCount = queuedRoleCounts.get(role) ?? 0;

      if (roleLimit != null && activeCount + queuedCount >= roleLimit) {
        continue;
      }

      assignments.push({
        role,
        taskPacket: {
          id: task.id,
          title: task.title,
          objective: task.objective,
          ownerRole: role,
          dependencies: task.dependencies ?? [],
          acceptanceChecks: task.acceptanceChecks ?? [],
          readRoots: task.readRoots ?? [],
          allowedFiles: task.allowedFiles ?? [],
          forbiddenFiles: task.forbiddenFiles ?? [],
        },
        acceptedAnswers: getAnsweredClarificationSummaries(state.clarifications),
      });
      queuedRoleCounts.set(role, queuedCount + 1);
    }

    if (assignments.length === 0) {
      return [];
    }

    return this.dispatchAssignments(assignments);
  }

  async autoAcceptReadyTasks() {
    const state = await this.ensureInitialized();
    if (hasOpenClarifications(state.clarifications) || hasOpenHighPriorityQuestions(state.questions)) {
      return [];
    }

    const readyTaskIds = state.tasks
      .filter((task) => task.stage === "awaiting_manager_acceptance" && task.status !== "accepted")
      .map((task) => task.id);

    const acceptedTasks = [];
    for (const taskId of readyTaskIds) {
      acceptedTasks.push(await this.managerAcceptTask({ taskId }));
    }

    return acceptedTasks;
  }

  async advanceManagerLoop() {
    const maxPasses = 12;
    for (let pass = 0; pass < maxPasses; pass += 1) {
      let progressed = false;
      const state = await this.ensureInitialized();

      if (state.tasks.length === 0 && state.clarifications.length === 0) {
        const clarifications = await this.runManagerClarificationPass();
        progressed = progressed || clarifications.length > 0;
      }

      const refreshed = await this.ensureInitialized();
      if (refreshed.tasks.length === 0 && !hasOpenClarifications(refreshed.clarifications)) {
        const plannedTaskIds = await this.runPlannerTaskGraphPass();
        progressed = progressed || plannedTaskIds.length > 0;
      }

      const queuedResults = await this.dispatchQueuedTasks();
      progressed = progressed || queuedResults.length > 0;

      const readyResults = await this.continueReadyTasks();
      progressed = progressed || readyResults.length > 0;

      const acceptedTasks = await this.autoAcceptReadyTasks();
      progressed = progressed || acceptedTasks.length > 0;

      const latest = await this.ensureInitialized();
      if (
        hasOpenClarifications(latest.clarifications) ||
        hasOpenHighPriorityQuestions(latest.questions)
      ) {
        return [];
      }

      if (!progressed) {
        return [];
      }
    }

    throw new Error("Manager loop exceeded the maximum stabilization passes.");
  }

  async dispatchAssignments(assignments) {
    const state = await this.ensureInitialized();
    if (
      hasOpenClarifications(state.clarifications) &&
      assignments.some((assignment) => isWriteCapableRole(assignment.role))
    ) {
      throw new Error("Cannot dispatch implementation while clarifications remain open.");
    }

    assertSingleWriter(assignments);
    const results = [];
    let nextControllerPhase = state.controller.currentPhase || "planning";

    for (const assignment of assignments) {
      const taskPacket = { ...assignment.taskPacket };

      const agentSession = await this.ensureAgentSession({
        role: assignment.role,
        taskId: taskPacket.id,
        threadId: assignment.threadId ?? "",
      });
      const existingTaskRecord = state.tasks.find((task) => task.id === taskPacket.id);
      const taskRecord = hydrateTaskRecord(existingTaskRecord, taskPacket);

      if (assignment.role === "verifier") {
        assertTaskReadyForVerification(taskRecord);
      }

      if (assignment.role === "reviewer") {
        assertTaskReadyForReview(state, taskRecord);
      }

      updateTaskGraphWithTask(state.taskGraph, taskRecord);
      await writeV2Record(state.paths.tasksDir, taskRecord);
      syncCollectionRecord(state.tasks, taskRecord);

      const runtimeResult = await this.runtime.runTask({
        agentSession,
        missionDigest: this.missionDigest,
        taskPacket,
        acceptedAnswers: assignment.acceptedAnswers ?? [],
        workspaceRoot: this.workspaceRoot,
        runId: this.runId,
      });

      assertFilesWithinScope(taskPacket, runtimeResult.result);

      agentSession.threadId =
        runtimeResult.result.threadId ||
        agentSession.threadId ||
        `thread-${agentSession.agentId}`;
      agentSession.lastResultStatus = runtimeResult.result.status;
      agentSession.lastResultSummary = runtimeResult.result.summary;
      agentSession.lastEvidence = [...runtimeResult.result.evidence];
      agentSession.lastRunAt = isoNow();
      agentSession.lastCompletedAt =
        runtimeResult.result.status === "completed" ? agentSession.lastRunAt : "";
      await writeV2Record(state.paths.agentsDir, agentSession);
      syncCollectionRecord(state.agents, agentSession);

      if (isWriteCapableRole(assignment.role)) {
        if (
          runtimeResult.result.status === "completed" &&
          runtimeResult.result.evidence.length === 0
        ) {
          throw new Error(
            `Executor task ${taskPacket.id} must provide self-test evidence before verifier review.`,
          );
        }

        taskRecord.selfTestEvidence =
          runtimeResult.result.status === "completed"
            ? [...runtimeResult.result.evidence]
            : [];
        taskRecord.selfTestActorAgentId =
          runtimeResult.result.status === "completed" ? agentSession.agentId : "";
        taskRecord.lastExecutionStatus = runtimeResult.result.status;
        taskRecord.lastExecutionSummary = runtimeResult.result.summary;
        taskRecord.lastExecutionCompletedAt =
          runtimeResult.result.status === "completed" ? agentSession.lastCompletedAt : "";

        if (runtimeResult.result.status === "completed") {
          taskRecord.stage = hasPriorTaskVerificationOrReview(state, taskPacket.id)
            ? "reverifying"
            : "self_testing";
          setTaskStatus(taskRecord, "in_progress");
        } else if (runtimeResult.result.status === "needs_input") {
          taskRecord.stage = taskRecord.stage === "fixing" ? "fixing" : "implementing";
          setTaskStatus(taskRecord, "waiting_for_answer");
        } else if (runtimeResult.result.status === "retry_required") {
          taskRecord.stage = "fixing";
          setTaskStatus(taskRecord, "retry_required");
        } else {
          taskRecord.stage = taskRecord.stage === "fixing" ? "fixing" : "implementing";
          setTaskStatus(taskRecord, "blocked");
        }
      } else {
        const supportingRole = assignment.role;
        if (supportingRole === "verifier") {
          taskRecord.stage = "verifying";
          setTaskStatus(taskRecord, buildSupportingRoleStatus(runtimeResult.result.status));

          if (runtimeResult.result.status === "completed") {
            if (!runtimeResult.result.verification) {
              throw new Error(
                `Verifier task ${taskPacket.id} must return verification.status and verification.evidence.`,
              );
            }

            const verification = createVerificationRecord({
              taskId: taskPacket.id,
              status: runtimeResult.result.verification.status,
              evidence: runtimeResult.result.verification.evidence,
              actorRole: "verifier",
              actorAgentId: agentSession.agentId,
            });
            await writeV2Record(state.paths.verificationsDir, verification);
            syncCollectionRecord(state.verifications, verification);

            if (runtimeResult.result.verification.status === "pass") {
              taskRecord.stage = "reviewing";
              setTaskStatus(taskRecord, "in_progress");
            } else {
              taskRecord.stage = "fixing";
              setTaskStatus(taskRecord, "retry_required");
            }
          }
        } else if (supportingRole === "reviewer") {
          taskRecord.stage = "reviewing";
          setTaskStatus(taskRecord, buildSupportingRoleStatus(runtimeResult.result.status));

          if (runtimeResult.result.status === "completed") {
            if (!runtimeResult.result.review) {
              throw new Error(
                `Reviewer task ${taskPacket.id} must return review.status, review.summary, and review.findings.`,
              );
            }

            if (runtimeResult.result.review.status === "pass") {
              const reviewPass = createReviewPass({
                taskId: taskPacket.id,
                summary: runtimeResult.result.review.summary,
                actorRole: "reviewer",
                actorAgentId: agentSession.agentId,
              });
              await writeV2Record(state.paths.reviewsDir, reviewPass);
              syncCollectionRecord(state.reviews, reviewPass);

              if (hasPassingTaskVerification(state.verifications, taskPacket.id)) {
                taskRecord.stage = "awaiting_manager_acceptance";
                setTaskStatus(taskRecord, "in_progress");
              }
            } else {
              const findings = runtimeResult.result.review.findings?.length
                ? runtimeResult.result.review.findings
                : [
                    {
                      summary: runtimeResult.result.review.summary,
                      severity: "medium",
                    },
                  ];

              for (const findingInput of findings) {
                const finding = createReviewFinding({
                  taskId: taskPacket.id,
                  summary: findingInput.summary,
                  severity: findingInput.severity,
                  actorRole: "reviewer",
                  actorAgentId: agentSession.agentId,
                });
                await writeV2Record(state.paths.reviewsDir, finding);
                syncCollectionRecord(state.reviews, finding);
              }

              taskRecord.stage = "fixing";
              setTaskStatus(taskRecord, "retry_required");
            }
          }
        } else if (runtimeResult.result.status === "completed") {
          setTaskStatus(taskRecord, "accepted");
          taskRecord.stage = "delivered";
        } else if (runtimeResult.result.status === "needs_input") {
          setTaskStatus(taskRecord, "waiting_for_answer");
        } else if (runtimeResult.result.status === "retry_required") {
          setTaskStatus(taskRecord, "retry_required");
        } else {
          setTaskStatus(taskRecord, "blocked");
        }
      }
      await writeV2Record(state.paths.tasksDir, taskRecord);
      updateTaskGraphWithTask(state.taskGraph, taskRecord);
      syncCollectionRecord(state.tasks, taskRecord);
      nextControllerPhase = deriveControllerPhase(
        taskRecord,
        runtimeResult.result.status,
      );

      results.push({
        agentSession,
        envelope: runtimeResult.envelope,
        result: runtimeResult.result,
      });
    }

    await saveV2TaskGraph(state.paths, state.taskGraph);
    state.controller.currentPhase = nextControllerPhase;
    await saveV2Controller(state.paths, state.controller);

    return results;
  }

  async requestClarification(prompt) {
    const state = await this.ensureInitialized();
    const clarification = createClarification({ prompt });
    await writeV2Record(state.paths.clarificationsDir, clarification);

    const runBundle = await loadRunBundle(this.workspaceRoot, this.runId);
    runBundle.run.status = "paused";
    runBundle.run.pendingApproval = {
      required: true,
      reason: `Clarification required: ${clarification.prompt}`,
      requestedAt: isoNow(),
      approvedAt: null,
      note: "",
    };
    await saveRun(runBundle.paths, runBundle.run);

    state.controller.currentPhase = "understanding";
    await saveV2Controller(state.paths, state.controller);

    return clarification;
  }

  async answerClarification({ clarificationId, answer }) {
    const state = await this.ensureInitialized();
    const clarification = state.clarifications.find(
      (item) => item.id === clarificationId,
    );
    if (!clarification) {
      throw new Error(`Unknown clarification: ${clarificationId}`);
    }

    answerClarificationRecord(clarification, answer);
    await writeV2Record(state.paths.clarificationsDir, clarification);

    const runBundle = await loadRunBundle(this.workspaceRoot, this.runId);
    if (!hasOpenClarifications(state.clarifications)) {
      runBundle.run.status = "ready";
      runBundle.run.pendingApproval = null;
      state.controller.currentPhase = "planning";
      await saveV2Controller(state.paths, state.controller);
    }

    await saveRun(runBundle.paths, runBundle.run);
    return clarification;
  }

  async relayQuestion({
    fromAgentId,
    toRole,
    taskId,
    question,
    priority = "medium",
    acceptedAnswers = [],
  }) {
    const state = await this.ensureInitialized();
    const questionRecord = createQuestion({
      taskId,
      question,
      priority,
    });
    await writeV2Record(state.paths.questionsDir, questionRecord);

    const targetSession = state.agents.find((agent) => agent.role === toRole);
    if (!targetSession) {
      throw new Error(`No target agent available for role: ${toRole}`);
    }

    const taskRecord = state.tasks.find((task) => task.id === taskId) ?? {
      id: taskId,
      title: taskId,
      objective: "",
      readRoots: [],
      allowedFiles: [],
      forbiddenFiles: [],
      acceptanceChecks: [],
    };

    const answerRecord = await this.runtime.answerQuestion({
      questionRecord,
      targetSession,
      missionDigest: this.missionDigest,
      taskPacket: taskRecord,
      acceptedAnswers,
      workspaceRoot: this.workspaceRoot,
      runId: this.runId,
    });

    await writeJson(path.join(state.paths.answersDir, `${answerRecord.id}.json`), answerRecord);
    answerQuestion(questionRecord, answerRecord.id);
    await writeV2Record(state.paths.questionsDir, questionRecord);

    state.controller.currentPhase = "waiting_for_answer";
    await saveV2Controller(state.paths, state.controller);

    return {
      questionRecord,
      answerRecord,
      fromAgentId,
      targetSession,
    };
  }

  async recordVerification({ taskId, status, evidence, actorAgentId = "" }) {
    const state = await this.ensureInitialized();
    const taskRecord = getTaskRecord(state, taskId);
    assertTaskReadyForVerification(taskRecord);
    const verifierSession = assertCompletedActorSession(state, {
      taskId,
      actorRole: "verifier",
      actorAgentId,
      freshAfter: taskRecord.lastExecutionCompletedAt,
    });
    const verification = createVerificationRecord({
      taskId,
      status,
      evidence,
      actorRole: "verifier",
      actorAgentId: verifierSession.agentId,
    });
    await writeV2Record(state.paths.verificationsDir, verification);
    syncCollectionRecord(state.verifications, verification);

    if (status === "pass") {
      taskRecord.stage = "reviewing";
      setTaskStatus(taskRecord, "in_progress");
      state.controller.currentPhase = "reviewing";
    } else {
      taskRecord.stage = "fixing";
      setTaskStatus(taskRecord, "retry_required");
      state.controller.currentPhase = "fixing";
    }

    await writeV2Record(state.paths.tasksDir, taskRecord);
    updateTaskGraphWithTask(state.taskGraph, taskRecord);
    await saveV2TaskGraph(state.paths, state.taskGraph);
    await saveV2Controller(state.paths, state.controller);
    return verification;
  }

  async recordReviewFinding({ taskId, summary, severity = "medium" }) {
    const state = await this.ensureInitialized();
    const taskRecord = getTaskRecord(state, taskId);
    const finding = createReviewFinding({
      taskId,
      summary,
      severity,
    });
    await writeV2Record(state.paths.reviewsDir, finding);
    syncCollectionRecord(state.reviews, finding);

    if (severity !== "low") {
      taskRecord.stage = "fixing";
      setTaskStatus(taskRecord, "retry_required");
      state.controller.currentPhase = "fixing";
      await writeV2Record(state.paths.tasksDir, taskRecord);
      updateTaskGraphWithTask(state.taskGraph, taskRecord);
      await saveV2TaskGraph(state.paths, state.taskGraph);
      await saveV2Controller(state.paths, state.controller);
    }

    return finding;
  }

  async recordReviewPass({ taskId, summary = "Review passed.", actorAgentId = "" }) {
    const state = await this.ensureInitialized();
    const taskRecord = getTaskRecord(state, taskId);
    assertTaskReadyForReview(state, taskRecord);
    const latestVerification = getLatestVerificationForTask(state.verifications, taskId);
    const reviewerSession = assertCompletedActorSession(state, {
      taskId,
      actorRole: "reviewer",
      actorAgentId,
      freshAfter: latestVerification?.updatedAt || latestVerification?.createdAt || "",
    });
    const reviewPass = createReviewPass({
      taskId,
      summary,
      actorRole: "reviewer",
      actorAgentId: reviewerSession.agentId,
    });
    await writeV2Record(state.paths.reviewsDir, reviewPass);
    syncCollectionRecord(state.reviews, reviewPass);

    if (hasPassingTaskVerification(state.verifications, taskId)) {
      taskRecord.stage = "awaiting_manager_acceptance";
      setTaskStatus(taskRecord, "in_progress");
      await writeV2Record(state.paths.tasksDir, taskRecord);
      updateTaskGraphWithTask(state.taskGraph, taskRecord);
      await saveV2TaskGraph(state.paths, state.taskGraph);
    }

    state.controller.currentPhase = "awaiting_manager_acceptance";
    await saveV2Controller(state.paths, state.controller);
    return reviewPass;
  }

  async resolveReviewFinding({ findingId }) {
    const state = await this.ensureInitialized();
    const finding = state.reviews.find((item) => item.id === findingId);
    if (!finding) {
      throw new Error(`Unknown review finding: ${findingId}`);
    }

    resolveReviewFinding(finding);
    await writeV2Record(state.paths.reviewsDir, finding);
    syncCollectionRecord(state.reviews, finding);

    const taskRecord = state.tasks.find((task) => task.id === finding.taskId);
    if (
      taskRecord &&
      !hasBlockingTaskReviewFindings(
        state.reviews.map((review) => (review.id === finding.id ? finding : review)),
        finding.taskId,
      ) &&
      hasPassingTaskVerification(state.verifications, finding.taskId) &&
      hasFreshTaskReviewPass(
        state.reviews.map((review) => (review.id === finding.id ? finding : review)),
        finding.taskId,
        getLatestTaskTimestamp(state.verifications, finding.taskId),
      )
    ) {
      taskRecord.stage = "awaiting_manager_acceptance";
      setTaskStatus(taskRecord, "in_progress");
      await writeV2Record(state.paths.tasksDir, taskRecord);
      updateTaskGraphWithTask(state.taskGraph, taskRecord);
      await saveV2TaskGraph(state.paths, state.taskGraph);
    }

    return finding;
  }

  async acceptTaskLevelVerifiedIntegration({
    taskId,
    verificationEvidence,
    actorAgentId = "",
  }) {
    await this.recordVerification({
      taskId,
      status: "pass",
      evidence: verificationEvidence,
      actorAgentId,
    });

    const state = await this.ensureInitialized();
    if (!state.controller.acceptedEvidence.includes(verificationEvidence)) {
      state.controller.acceptedEvidence.push(verificationEvidence);
    }
    state.controller.currentPhase = "task_level_verified_integration";
    await saveV2Controller(state.paths, state.controller);

    return getTaskRecord(state, taskId);
  }

  async managerAcceptTask({ taskId }) {
    const state = await this.ensureInitialized();
    const taskRecord = getTaskRecord(state, taskId);

    if (hasOpenClarifications(state.clarifications)) {
      throw new Error("Manager cannot accept while clarifications remain open.");
    }

    if (hasOpenHighPriorityQuestions(state.questions)) {
      throw new Error("Manager cannot accept while high-priority questions remain open.");
    }

    ensureTaskCanAdvanceToManagerAcceptance(state, taskRecord);

    const latestVerification = getLatestVerificationForTask(state.verifications, taskId);
    if (!latestVerification?.evidence) {
      throw new Error(`Task ${taskId} cannot be accepted without verification evidence.`);
    }

    if (!state.controller.acceptedEvidence.includes(latestVerification.evidence)) {
      state.controller.acceptedEvidence.push(latestVerification.evidence);
    }

    setTaskStatus(taskRecord, "accepted");
    taskRecord.stage = "delivered";
    await writeV2Record(state.paths.tasksDir, taskRecord);
    updateTaskGraphWithTask(state.taskGraph, taskRecord);
    await saveV2TaskGraph(state.paths, state.taskGraph);

    state.controller.currentPhase = "awaiting_manager_acceptance";
    await saveV2Controller(state.paths, state.controller);

    return taskRecord;
  }

  async continueReadyTasks() {
    const state = await this.ensureInitialized();

    if (
      hasOpenClarifications(state.clarifications) ||
      hasOpenHighPriorityQuestions(state.questions)
    ) {
      return [];
    }

    const assignments = [];

    for (const task of state.tasks) {
      if (task.status === "cancelled" || task.stage === "delivered") {
        continue;
      }

      if (
        ["self_testing", "reverifying"].includes(task.stage) &&
        !hasFreshCompletedRoleRun(state, {
          taskId: task.id,
          role: "verifier",
          freshAfter: task.lastExecutionCompletedAt,
        })
      ) {
        assignments.push({
          role: "verifier",
          taskPacket: {
            id: task.id,
            title: `Verify ${task.title}`,
            objective: `Validate the latest self-test evidence for task ${task.id}.`,
            acceptanceChecks: task.acceptanceChecks ?? [],
          },
        });
        continue;
      }

      if (
        task.stage === "reviewing" &&
        hasPassingTaskVerification(state.verifications, task.id) &&
        !hasBlockingTaskReviewFindings(state.reviews, task.id) &&
        !hasFreshTaskReviewPass(
          state.reviews,
          task.id,
          getLatestTaskTimestamp(state.verifications, task.id),
        ) &&
        !hasFreshCompletedRoleRun(state, {
          taskId: task.id,
          role: "reviewer",
          freshAfter: getLatestTaskTimestamp(state.verifications, task.id),
        })
      ) {
        assignments.push({
          role: "reviewer",
          taskPacket: {
            id: task.id,
            title: `Review ${task.title}`,
            objective: `Review the latest verified state for task ${task.id}.`,
            acceptanceChecks: task.acceptanceChecks ?? [],
          },
        });
      }
    }

    if (assignments.length === 0) {
      return [];
    }

    return this.dispatchAssignments(assignments);
  }

  async finalizeRunIfDeliverable() {
    const state = await this.ensureInitialized();
    const runBundle = await loadRunBundle(this.workspaceRoot, this.runId);

    const gate = evaluateDeliveryGate({
      definitionOfDoneAccepted:
        state.controller.acceptedEvidence.length >=
        runBundle.mission.definitionOfDone.length,
      taskGraph: state.taskGraph,
      clarifications: state.clarifications,
      questions: state.questions,
      verifications: state.verifications,
      reviews: state.reviews,
      allMandatoryLoopStagesClosed: state.tasks.every(
        (task) => task.stage === "delivered" || task.status === "cancelled",
      ),
    });

    if (gate.completed) {
      runBundle.run.status = "completed";
      runBundle.run.completedAt = isoNow();
      runBundle.run.pendingApproval = null;
      state.controller.currentPhase = "complete";
    } else {
      runBundle.run.status =
        hasOpenClarifications(state.clarifications) ||
        hasOpenHighPriorityQuestions(state.questions) ||
        hasBlockingReviewFindings(state.reviews)
          ? "paused"
          : "ready";
      runBundle.run.pendingApproval = gate.reasons.length > 0
        ? {
            required: true,
            reason: gate.reasons.join(" "),
            requestedAt: isoNow(),
            approvedAt: null,
            note: "",
          }
        : null;
    }

    await saveRun(runBundle.paths, runBundle.run);
    await saveV2Controller(state.paths, state.controller);

    return {
      gate,
      ...(await this.loadRunBundle()),
      run: runBundle.run,
    };
  }
}

function createV2ShellPlan() {
  const now = isoNow();
  return {
    version: 2,
    createdAt: now,
    updatedAt: now,
    replanReason: "V2 controller run initialized.",
    focusTaskId: null,
    tasks: [],
  };
}

export async function startV2Run({
  workspaceRoot,
  missionInput,
  workerConfig,
  runtime,
  autoBootstrap = false,
}) {
  const mission = createMissionLock({
    workspaceRoot,
    ...missionInput,
  });
  const state = await initializeRun({
    workspaceRoot,
    mission,
    plan: createV2ShellPlan(),
    workerConfig,
    engine: "v2",
    runtimeVersion: 2,
  });

  await initializeV2ControllerState({
    workspaceRoot,
    runId: state.runId,
    missionDigest: mission.digest,
  });

  const controller = new LongRunController({
    workspaceRoot,
    runId: state.runId,
    missionDigest: mission.digest,
    runtime,
  });

  if (autoBootstrap) {
    await controller.advanceManagerLoop();
  }
  return controller.loadRunBundle();
}

export async function loadV2Status(workspaceRoot, runId) {
  const controller = new LongRunController({
    workspaceRoot,
    runId,
    missionDigest: "",
  });
  return controller.loadRunBundle();
}

export async function resumeV2Run({
  workspaceRoot,
  runId,
  runtime,
  autoBootstrap = false,
}) {
  const bundle = await loadRunBundle(workspaceRoot, runId);
  const controller = new LongRunController({
    workspaceRoot,
    runId,
    missionDigest: bundle.mission.digest,
    runtime,
  });
  await controller.ensureInitialized();
  if (autoBootstrap) {
    await controller.advanceManagerLoop();
  } else {
    await controller.continueReadyTasks();
  }
  return controller.finalizeRunIfDeliverable();
}

export async function approveV2Run({
  workspaceRoot,
  runId,
  note = "",
}) {
  const bundle = await loadRunBundle(workspaceRoot, runId);
  const controller = new LongRunController({
    workspaceRoot,
    runId,
    missionDigest: bundle.mission.digest,
  });
  const state = await controller.ensureInitialized();

  if (hasOpenClarifications(state.clarifications)) {
    throw new Error("Open clarifications must be answered before approving a v2 run.");
  }

  if (hasOpenHighPriorityQuestions(state.questions)) {
    throw new Error("Open high-priority questions must be answered before approving a v2 run.");
  }

  if (hasBlockingReviewFindings(state.reviews)) {
    throw new Error("Blocking review findings must be resolved before approving a v2 run.");
  }

  bundle.run.pendingApproval = {
    ...(bundle.run.pendingApproval ?? {}),
    required: false,
    approvedAt: isoNow(),
    note,
  };
  bundle.run.status = "ready";
  await saveRun(bundle.paths, bundle.run);

  return controller.loadRunBundle();
}

export async function answerV2Run({
  workspaceRoot,
  runId,
  clarificationId,
  answer,
}) {
  const bundle = await loadRunBundle(workspaceRoot, runId);
  const controller = new LongRunController({
    workspaceRoot,
    runId,
    missionDigest: bundle.mission.digest,
  });

  await controller.answerClarification({
    clarificationId,
    answer,
  });

  return controller.loadRunBundle();
}
