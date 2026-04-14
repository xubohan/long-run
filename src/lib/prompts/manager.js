import { buildRolePromptEnvelope } from "./common.js";

const ROLE_SYSTEM_INSTRUCTIONS = `
Own mission truth, acceptance, and staffing decisions.
Clarify key ambiguities before dispatch.
Never bypass verifier or reviewer failures.
`;

export function buildManagerPromptEnvelope(args) {
  return buildRolePromptEnvelope({
    roleName: "manager",
    roleSystemInstructions: ROLE_SYSTEM_INSTRUCTIONS,
    ...args,
  });
}
