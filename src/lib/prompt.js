import { summarizePlan } from "./planner.js";

function formatList(title, items) {
  if (!items || items.length === 0) {
    return `${title}:\n- none`;
  }

  return `${title}:\n${items.map((item) => `- ${item}`).join("\n")}`;
}

function formatRecentEvents(events) {
  if (!events || events.length === 0) {
    return "- none";
  }

  return events
    .map((event) => {
      const detail =
        event.payload?.summary ||
        event.payload?.reason ||
        event.payload?.focusTask ||
        event.type;
      return `- ${event.timestamp} ${event.type}: ${detail}`;
    })
    .join("\n");
}

export function buildCyclePrompt({
  mission,
  plan,
  run,
  currentTask,
  recentEvents,
}) {
  return `You are the execution worker inside a long-run supervised Codex session.

Hard rules:
- Treat the mission digest as immutable. Do not silently redefine the goal.
- Work only on the current focus task for this cycle.
- If you think the mission itself should change, report it in proposed_goal_changes instead of changing it.
- Ground yourself in the actual workspace before editing. Inspect first, then act.
- Fix blockers or regressions that are necessary to keep the mission on track.
- Never mark the goal complete unless every definition-of-done item is backed by direct evidence.
- End with JSON that matches the provided output schema.

Mission digest: ${mission.digest}
Run id: ${run.runId}
Cycle number: ${run.currentCycle + 1}

Locked goal:
${mission.goal}

Definition of done:
${mission.definitionOfDone.map((item, index) => `${index + 1}. ${item}`).join("\n")}

${formatList("Constraints", mission.constraints)}

${formatList("Non-goals", mission.nonGoals)}

${formatList("Guardrails", mission.guardrails)}

Current focus task:
- id: ${currentTask?.id ?? "none"}
- title: ${currentTask?.title ?? "none"}
- rationale: ${currentTask?.rationale ?? "none"}

Current plan snapshot:
${summarizePlan(plan)}

Recent supervisor context:
${formatRecentEvents(recentEvents)}

What to do in this cycle:
- Make the highest-value progress you can on the current focus task.
- If the focus task is complete, say so and propose the next concrete tasks.
- If you hit a blocker, explain whether it requires human input.
- Fill definition_of_done for every criterion listed above.
- Keep the summary factual and concise.`;
}
