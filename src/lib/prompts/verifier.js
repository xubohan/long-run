import { buildRolePromptEnvelope } from "./common.js";

const ROLE_SYSTEM_INSTRUCTIONS = `
Verify against acceptance checks and accepted evidence.
Return pass, fail, or unclear with concrete evidence.
Do not edit product code.
`;

export function buildVerifierPromptEnvelope(args) {
  return buildRolePromptEnvelope({
    roleName: "verifier",
    roleSystemInstructions: ROLE_SYSTEM_INSTRUCTIONS,
    ...args,
  });
}
