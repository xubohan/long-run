import test from "node:test";
import assert from "node:assert/strict";

import { createAgentSessionRecord } from "../src/lib/agent-registry.js";

test("agent session records keep same-role histories isolated by agent identity", () => {
  const first = createAgentSessionRecord({
    agentId: "observer-1",
    role: "observer",
    taskId: "task-a",
    threadId: "thread-a",
  });
  const second = createAgentSessionRecord({
    agentId: "observer-2",
    role: "observer",
    taskId: "task-b",
    threadId: "thread-b",
  });

  assert.notEqual(first.historyKey, second.historyKey);
  assert.equal(first.role, second.role);
  assert.notEqual(first.threadId, second.threadId);
});
