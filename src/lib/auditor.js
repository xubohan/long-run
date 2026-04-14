import {
  addSystemTask,
  chooseFocusTask,
  ensureFocusTask,
  findTaskByHint,
  getFocusTask,
  markTaskCompleted,
  markTasksCompletedByHint,
  mergeSuggestedTasks,
} from "./planner.js";
import { clone, normalizeText } from "./io.js";
import { evaluateLegacyShippingReadiness } from "./verification.js";

function normalizeBugSignature(bug) {
  return normalizeText(bug?.signature || bug?.description || "");
}

function isCriterionMet(outputCriteria, missionCriterion) {
  const match = outputCriteria.find(
    (item) => normalizeText(item.criterion) === normalizeText(missionCriterion),
  );

  return match?.status === "met" && Boolean(String(match?.evidence ?? "").trim());
}

function unmetCriteria(mission, cycleOutput) {
  return mission.definitionOfDone.filter(
    (criterion) => !isCriterionMet(cycleOutput.definition_of_done, criterion),
  );
}

export function buildFallbackCycleOutput({ mission, message }) {
  return {
    summary: message,
    status: "blocked",
    current_task_completed: false,
    made_progress: false,
    stayed_on_mission: true,
    risk_level: "medium",
    requires_human: true,
    human_reason: message,
    evidence: [],
    files_touched: [],
    bugs_found: [
      {
        signature: "codex-cycle-failed",
        description: message,
        severity: "medium",
      },
    ],
    tasks_completed: [],
    tasks_to_add: [],
    next_focus_task: "",
    verification: {
      status: "not_run",
      evidence: "",
    },
    definition_of_done: mission.definitionOfDone.map((criterion) => ({
      criterion,
      status: "unknown",
      evidence: "",
    })),
    proposed_goal_changes: [],
    blockers: [message],
  };
}

export function auditCycle({ mission, run, plan, cycleOutput }) {
  const nextPlan = clone(plan);
  const currentTask = ensureFocusTask(nextPlan);
  const issueCounts = { ...(run.issueCounts ?? {}) };
  const pauseReasons = [];
  const bugSummaries = [];
  const shippingReadiness = evaluateLegacyShippingReadiness(cycleOutput);

  if (currentTask && (cycleOutput.current_task_completed || cycleOutput.status === "task_completed" || cycleOutput.status === "goal_completed")) {
    markTaskCompleted(nextPlan, currentTask.id, cycleOutput.summary);
  }

  markTasksCompletedByHint(nextPlan, cycleOutput.tasks_completed);
  mergeSuggestedTasks(nextPlan, cycleOutput.tasks_to_add, "codex");

  if (
    cycleOutput.next_focus_task &&
    !findTaskByHint(nextPlan, cycleOutput.next_focus_task)
  ) {
    mergeSuggestedTasks(
      nextPlan,
      [
        {
          title: cycleOutput.next_focus_task,
          rationale: "Worker proposed this as the next concrete focus task.",
          priority: "high",
        },
      ],
      "codex",
    );
  }

  for (const bug of cycleOutput.bugs_found) {
    const signature = normalizeBugSignature(bug);
    if (!signature) {
      continue;
    }

    issueCounts[signature] = (issueCounts[signature] ?? 0) + 1;
    bugSummaries.push(signature);

    if (issueCounts[signature] >= 2) {
      pauseReasons.push(`Repeated bug signature detected: ${signature}`);
    }
  }

  const noProgressCount = cycleOutput.made_progress
    ? 0
    : (run.noProgressCount ?? 0) + 1;

  if (noProgressCount >= 3) {
    pauseReasons.push("Three consecutive no-progress cycles detected.");
  }

  if (cycleOutput.proposed_goal_changes.length > 0) {
    pauseReasons.push("Worker requested a mission change.");
  }

  if (!cycleOutput.stayed_on_mission) {
    pauseReasons.push("Worker reported mission drift.");
  }

  if (
    cycleOutput.requires_human ||
    cycleOutput.status === "paused_for_human" ||
    cycleOutput.risk_level === "high"
  ) {
    pauseReasons.push(cycleOutput.human_reason || "High-risk operation requires human confirmation.");
  }

  if (cycleOutput.status === "blocked" && cycleOutput.blockers.length > 0) {
    pauseReasons.push(cycleOutput.blockers.join(" | "));
  }

  const unmet = unmetCriteria(mission, cycleOutput);

  if (cycleOutput.status === "goal_completed") {
    for (const criterion of unmet) {
      addSystemTask(
        nextPlan,
        `Close remaining definition-of-done gap: ${criterion}`,
        "The worker claimed completion without satisfying all success criteria.",
      );
    }

    if (!shippingReadiness.verifierPassed) {
      addSystemTask(
        nextPlan,
        "Obtain verifier-backed completion evidence",
        "Legacy completion claims require a verifier pass with explicit evidence.",
      );
    }

    if (shippingReadiness.reviewStatus === "required") {
      addSystemTask(
        nextPlan,
        "Request independent review before shipping",
        "Legacy completion remains review-required and not shippable yet.",
      );
    }
  }

  for (const reason of shippingReadiness.reasons) {
    if (cycleOutput.status === "goal_completed") {
      pauseReasons.push(reason);
    }
  }

  if (!getFocusTask(nextPlan) && cycleOutput.status !== "goal_completed") {
    addSystemTask(
      nextPlan,
      "Reconcile remaining mission work and set the next focus task",
      "The plan has no open focus task but the mission is not complete.",
    );
  }

  ensureFocusTask(nextPlan);
  chooseFocusTask(nextPlan, cycleOutput.next_focus_task);

  const completed =
    cycleOutput.status === "goal_completed" &&
    unmet.length === 0 &&
    shippingReadiness.verifierPassed &&
    shippingReadiness.reviewStatus !== "required";
  const paused = pauseReasons.length > 0;

  const decision = completed ? "completed" : paused ? "pause" : "continue";
  const reason = completed
    ? "All definition-of-done criteria are satisfied."
    : paused
      ? pauseReasons.join(" ")
      : cycleOutput.summary;

  return {
    decision,
    reason,
    plan: nextPlan,
    runPatch: {
      issueCounts,
      noProgressCount,
      lastSummary: cycleOutput.summary,
      lastAudit: {
        decision,
        reason,
        bugSignatures: bugSummaries,
        shippingStatus: shippingReadiness.shippingStatus,
        reviewStatus: shippingReadiness.reviewStatus,
        verification: shippingReadiness.verification,
        definitionOfDone: cycleOutput.definition_of_done,
      },
      shippingStatus: shippingReadiness.shippingStatus,
      reviewStatus: shippingReadiness.reviewStatus,
    },
  };
}
