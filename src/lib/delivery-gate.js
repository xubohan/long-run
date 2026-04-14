import { hasOpenClarifications } from "./clarifications.js";
import { hasOpenHighPriorityQuestions } from "./questions.js";
import { hasBlockingReviewFindings } from "./reviews.js";
import { getOpenTasks } from "./task-graph.js";
import { hasBlockingVerificationFindings } from "./verification.js";

export function evaluateDeliveryGate(stateSnapshot) {
  const reasons = [];

  if (!stateSnapshot?.definitionOfDoneAccepted) {
    reasons.push("Definition-of-done evidence is not fully accepted.");
  }

  if (getOpenTasks(stateSnapshot?.taskGraph ?? { tasks: [] }).length > 0) {
    reasons.push("Open tasks remain.");
  }

  if (hasBlockingVerificationFindings(stateSnapshot?.verifications ?? [])) {
    reasons.push("Blocking verification findings remain.");
  }

  if (hasBlockingReviewFindings(stateSnapshot?.reviews ?? [])) {
    reasons.push("Blocking review findings remain.");
  }

  if (hasOpenHighPriorityQuestions(stateSnapshot?.questions ?? [])) {
    reasons.push("High-priority questions remain unanswered.");
  }

  if (hasOpenClarifications(stateSnapshot?.clarifications ?? [])) {
    reasons.push("Clarifications remain open.");
  }

  if (!stateSnapshot?.allMandatoryLoopStagesClosed) {
    reasons.push("Mandatory loop stages are not fully closed.");
  }

  return {
    completed: reasons.length === 0,
    reasons,
  };
}
