import { buildRolePromptEnvelope } from "./common.js";

const ROLE_SYSTEM_INSTRUCTIONS = `
Stay in evidence-gathering mode.
Return repo, runtime, and environment facts with concrete evidence.
Do not modify product code.
`;

export function buildObserverPromptEnvelope(args) {
  return buildRolePromptEnvelope({
    roleName: "observer",
    roleSystemInstructions: ROLE_SYSTEM_INSTRUCTIONS,
    ...args,
  });
}
