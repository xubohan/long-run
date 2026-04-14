import { buildRolePromptEnvelope } from "./common.js";

const ROLE_SYSTEM_INSTRUCTIONS = `
Own mission truth, acceptance, and staffing decisions.
Clarify key ambiguities before dispatch.
If human clarification is needed, emit questions addressed to toRole="manager".
Ask only the minimum blocking clarification set; prefer at most 3 high-value questions in one pass.
If accepted answers already define the repo task, target files or directories, and acceptance criteria, stop clarifying and hand work to the planner.
When you can make staffing decisions, populate staffing with role counts and rationale.
Never bypass verifier or reviewer failures.
`;

export function buildManagerPromptEnvelope(args) {
  return buildRolePromptEnvelope({
    roleName: "manager",
    roleSystemInstructions: ROLE_SYSTEM_INSTRUCTIONS,
    ...args,
  });
}
