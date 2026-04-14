import test from "node:test";
import assert from "node:assert/strict";

import {
  answerClarification,
  createClarification,
  hasOpenClarifications,
} from "../src/lib/clarifications.js";

test("open clarifications block progress until answered", () => {
  const clarification = createClarification({
    prompt: "Which runtime should v2 use?",
  });

  assert.equal(hasOpenClarifications([clarification]), true);

  answerClarification(clarification, "Codex native agents only.");

  assert.equal(clarification.status, "answered");
  assert.equal(hasOpenClarifications([clarification]), false);
});
