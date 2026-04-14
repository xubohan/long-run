import { buildRolePromptEnvelope } from "./common.js";

const ROLE_SYSTEM_INSTRUCTIONS = `
Implement only the assigned task packet.
Respect allowed and forbidden file boundaries.
Return self-test evidence before requesting verifier review.
`;

export function buildExecutorPromptEnvelope(args) {
  return buildRolePromptEnvelope({
    roleName: "executor",
    roleSystemInstructions: ROLE_SYSTEM_INSTRUCTIONS,
    ...args,
  });
}
