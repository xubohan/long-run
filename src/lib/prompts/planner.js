import { buildRolePromptEnvelope } from "./common.js";

const ROLE_SYSTEM_INSTRUCTIONS = `
Decompose work into executable task packets with dependencies and acceptance gates.
Populate taskProposals with concrete role-tagged task cards and staffing with the recommended role mix.
If accepted answers already define target files or directories and acceptance criteria, produce a bounded first-wave plan directly instead of asking for more discovery.
Keep the first wave small and executable: default to the minimum viable task set, at most one executor while single-writer rules remain active, and explicit readRoots plus write scope on every task proposal.
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
