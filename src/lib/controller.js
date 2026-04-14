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
  hasPassingTaskVerification,
} from "./verification.js";
import {
  createReviewFinding,
  createReviewPass,
  hasBlockingReviewFindings,
  hasBlockingTaskReviewFindings,
  hasTaskReviewPass,
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
    stage: "implementing",
    status: "dispatched",
    dependencies: taskPacket.dependencies ?? [],
    acceptanceChecks: taskPacket.acceptanceChecks ?? [],
    allowedFiles: taskPacket.allowedFiles ?? [],
    forbiddenFiles: taskPacket.forbiddenFiles ?? [],
  });
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

function ensureTaskCanAdvanceToManagerAcceptance(state, taskId) {
  if (!hasPassingTaskVerification(state.verifications, taskId)) {
    throw new Error(`Task ${taskId} cannot be accepted without a passing verifier result.`);
  }

  if (!hasTaskReviewPass(state.reviews, taskId)) {
    throw new Error(`Task ${taskId} cannot be accepted before reviewer coverage exists.`);
  }

  if (hasBlockingTaskReviewFindings(state.reviews, taskId)) {
    throw new Error(`Task ${taskId} has unresolved blocking review findings.`);
  }
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

  async dispatchAssignments(assignments) {
    const state = await this.ensureInitialized();
    if (hasOpenClarifications(state.clarifications)) {
      throw new Error("Cannot dispatch implementation while clarifications remain open.");
    }

    assertSingleWriter(assignments);
    const results = [];

    for (const assignment of assignments) {
      const taskPacket = {
        dependencies: [],
        acceptanceChecks: [],
        allowedFiles: [],
        forbiddenFiles: [],
        ...assignment.taskPacket,
      };

      const reusableSession = findReusableSession(state.agents, {
        role: assignment.role,
        taskId: taskPacket.id,
      });

      const agentSession = reusableSession ?? createAgentSessionRecord({
        role: assignment.role,
        taskId: taskPacket.id,
        threadId: assignment.threadId ?? "",
      });

      const taskRecord = buildTaskRecord(taskPacket);
      updateTaskGraphWithTask(state.taskGraph, taskRecord);
      await writeV2Record(state.paths.tasksDir, taskRecord);

      const runtimeResult = await this.runtime.runTask({
        agentSession,
        missionDigest: this.missionDigest,
        taskPacket,
        acceptedAnswers: assignment.acceptedAnswers ?? [],
      });

      assertFilesWithinScope(taskPacket, runtimeResult.result);

      agentSession.threadId =
        runtimeResult.result.threadId ||
        agentSession.threadId ||
        `thread-${agentSession.agentId}`;
      await writeV2Record(state.paths.agentsDir, agentSession);

      if (isWriteCapableRole(assignment.role)) {
        setTaskStatus(taskRecord, "in_progress");
      } else {
        setTaskStatus(taskRecord, "accepted");
        taskRecord.stage = "delivered";
      }
      await writeV2Record(state.paths.tasksDir, taskRecord);
      updateTaskGraphWithTask(state.taskGraph, taskRecord);

      results.push({
        agentSession,
        envelope: runtimeResult.envelope,
        result: runtimeResult.result,
      });
    }

    await saveV2TaskGraph(state.paths, state.taskGraph);
    state.controller.currentPhase = "implementing";
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

  async recordVerification({ taskId, status, evidence }) {
    const state = await this.ensureInitialized();
    const taskRecord = getTaskRecord(state, taskId);
    const verification = createVerificationRecord({
      taskId,
      status,
      evidence,
    });
    await writeV2Record(state.paths.verificationsDir, verification);

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

  async recordReviewPass({ taskId, summary = "Review passed." }) {
    const state = await this.ensureInitialized();
    const taskRecord = getTaskRecord(state, taskId);
    const reviewPass = createReviewPass({
      taskId,
      summary,
    });
    await writeV2Record(state.paths.reviewsDir, reviewPass);

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

    const taskRecord = state.tasks.find((task) => task.id === finding.taskId);
    if (
      taskRecord &&
      !hasBlockingTaskReviewFindings(
        state.reviews.map((review) => (review.id === finding.id ? finding : review)),
        finding.taskId,
      ) &&
      hasPassingTaskVerification(state.verifications, finding.taskId) &&
      hasTaskReviewPass(
        state.reviews.map((review) => (review.id === finding.id ? finding : review)),
        finding.taskId,
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

  async acceptTaskLevelVerifiedIntegration({ taskId, verificationEvidence }) {
    await this.recordVerification({
      taskId,
      status: "pass",
      evidence: verificationEvidence,
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

    ensureTaskCanAdvanceToManagerAcceptance(state, taskId);

    const latestVerification = getLatestVerificationForTask(state.verifications, taskId);
    if (!latestVerification?.evidence) {
      throw new Error(`Task ${taskId} cannot be accepted without verification evidence.`);
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
  });

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
}) {
  const bundle = await loadRunBundle(workspaceRoot, runId);
  const controller = new LongRunController({
    workspaceRoot,
    runId,
    missionDigest: bundle.mission.digest,
  });
  await controller.ensureInitialized();
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
