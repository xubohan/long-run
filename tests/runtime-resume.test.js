import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";

import { LongRunController } from "../src/lib/controller.js";
import { NativeAgentRuntime } from "../src/lib/native-agent-runtime.js";

class ResumeRuntimeAdapter {
  async runTask({ agentSession, taskPacket }) {
    return {
      agentId: agentSession.agentId,
      taskId: taskPacket.id,
      role: agentSession.role,
      threadId: agentSession.threadId || `thread-${agentSession.agentId}`,
      status: "completed",
      summary: `Completed ${taskPacket.title}`,
      evidence: [],
      filesTouched: [],
      questions: [],
    };
  }
}

test("controller reuses persisted agent identity and thread mapping across resume", async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "longrun-resume-"));
  const runtime = new NativeAgentRuntime({
    adapter: new ResumeRuntimeAdapter(),
  });

  const firstController = new LongRunController({
    workspaceRoot,
    runId: "run-resume-1",
    missionDigest: "digest-resume",
    runtime,
  });

  const firstDispatch = await firstController.dispatchAssignments([
    {
      role: "observer",
      taskPacket: {
        id: "task-resume-1",
        title: "Observe on first run",
        objective: "Collect first observation",
      },
    },
  ]);

  const secondController = new LongRunController({
    workspaceRoot,
    runId: "run-resume-1",
    missionDigest: "digest-resume",
    runtime,
  });

  const resumedDispatch = await secondController.dispatchAssignments([
    {
      role: "observer",
      taskPacket: {
        id: "task-resume-1",
        title: "Observe on first run",
        objective: "Collect first observation",
      },
    },
  ]);

  assert.equal(
    firstDispatch[0].agentSession.agentId,
    resumedDispatch[0].agentSession.agentId,
  );
  assert.equal(
    firstDispatch[0].agentSession.threadId,
    resumedDispatch[0].agentSession.threadId,
  );
});
