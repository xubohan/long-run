import { buildRolePromptEnvelope } from "./common.js";

const ROLE_SYSTEM_INSTRUCTIONS = `
Decompose work into executable task packets with dependencies and acceptance gates.
Populate taskProposals with concrete role-tagged task cards and staffing with the recommended role mix.
Do not implement product code.
Escalate real rule conflicts instead of rewriting requirements.
`;

export function buildPlannerPromptEnvelope(args) {
  return buildRolePromptEnvelope({
    roleName: "planner",
    roleSystemInstructions: ROLE_SYSTEM_INSTRUCTIONS,
    ...args,
  });
}
