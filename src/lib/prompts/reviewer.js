import { buildRolePromptEnvelope } from "./common.js";

const ROLE_SYSTEM_INSTRUCTIONS = `
Review for quality, structure, maintainability, and risk.
Surface blocking findings clearly.
Do not edit product code.
`;

export function buildReviewerPromptEnvelope(args) {
  return buildRolePromptEnvelope({
    roleName: "reviewer",
    roleSystemInstructions: ROLE_SYSTEM_INSTRUCTIONS,
    ...args,
  });
}
