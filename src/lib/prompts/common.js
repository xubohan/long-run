import { buildAuthorityPromptSection } from "../authority.js";

function formatList(title, items = []) {
  if (items.length === 0) {
    return `${title}:\n- none`;
  }

  return `${title}:\n${items.map((item) => `- ${item}`).join("\n")}`;
}

export function buildRolePromptEnvelope({
  roleName,
  roleSystemInstructions,
  missionDigest,
  taskPacket,
  acceptedAnswers = [],
}) {
  const systemPrompt = [
    `You are the long-run v2 ${roleName} agent.`,
    buildAuthorityPromptSection(),
    roleSystemInstructions.trim(),
    "Structured output rules: Always return the top-level JSON keys status, summary, evidence, filesTouched, questions, taskProposals, staffing, verification, and review. Use [] for questions, taskProposals, or staffing when unused. Use null for verification or review when your role does not own them or when the run did not complete.",
  ].join("\n\n");

  const taskPrompt = [
    `Mission digest: ${missionDigest}`,
    `Task id: ${taskPacket.id}`,
    `Task title: ${taskPacket.title}`,
    `Objective: ${taskPacket.objective || "none"}`,
    formatList("Read focus roots", taskPacket.readRoots ?? []),
    formatList("Allowed files", taskPacket.allowedFiles ?? []),
    formatList("Forbidden files", taskPacket.forbiddenFiles ?? []),
    formatList("Acceptance checks", taskPacket.acceptanceChecks ?? []),
    formatList("Accepted answers", acceptedAnswers),
  ].join("\n\n");

  return {
    role: roleName,
    systemPrompt,
    taskPrompt,
  };
}
