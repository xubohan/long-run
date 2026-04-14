import test from "node:test";
import assert from "node:assert/strict";

import {
  answerQuestion,
  createQuestion,
  hasOpenHighPriorityQuestions,
} from "../src/lib/questions.js";

test("high-priority unanswered questions remain blocking", () => {
  const question = createQuestion({
    taskId: "task-1",
    question: "Can the manager change authority order?",
    priority: "high",
  });

  assert.equal(hasOpenHighPriorityQuestions([question]), true);

  answerQuestion(question, "answer-1");

  assert.equal(hasOpenHighPriorityQuestions([question]), false);
});
