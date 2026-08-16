"use strict";

const assert = require("assert");
const {
  isAskUserQuestionName,
  extractAskUserQuestions,
  formatUserAnswersPrompt,
  parseUserAnswersBlock,
  isAnswersOnlyUserText,
  applyAnswersToAsk,
  rememberAskOnRun,
  pendingAsksOf,
} = require("./sessionQuestions");

let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log("ok -", name);
  } catch (err) {
    failed += 1;
    console.error("not ok -", name);
    console.error(err);
  }
}

const CANNED_QUESTIONS = [
  {
    question: "Minimal or bold?",
    options: [
      { label: "Minimal (Recommended)", description: "Clean and quiet" },
      { label: "Bold & expressive", description: "More color and motion" },
    ],
  },
  {
    question: "Framework?",
    options: [
      { label: "React", description: "Familiar SPA" },
      { label: "SvelteKit", description: "Less boilerplate" },
    ],
    multi_select: false,
  },
];

test("isAskUserQuestionName accepts aliases", () => {
  assert.strictEqual(isAskUserQuestionName("ask_user_question"), true);
  assert.strictEqual(isAskUserQuestionName("Ask User Question"), true);
  assert.strictEqual(isAskUserQuestionName("ask-user-question"), true);
  assert.strictEqual(isAskUserQuestionName("grep"), false);
});

test("extractAskUserQuestions from live streaming-json tool_call", () => {
  const evt = {
    type: "tool_call",
    toolCallId: "call-ask-1",
    toolName: "ask_user_question",
    status: "pending",
    rawInput: { questions: CANNED_QUESTIONS },
  };
  const ask = extractAskUserQuestions(evt);
  assert.ok(ask);
  assert.strictEqual(ask.id, "call-ask-1");
  assert.strictEqual(ask.questions.length, 2);
  assert.strictEqual(ask.questions[0].question, "Minimal or bold?");
  assert.strictEqual(ask.questions[0].options[0].label, "Minimal (Recommended)");
  assert.ok(ask.questions[0].options.some((o) => o.isOther));
  assert.strictEqual(ask.questions[1].multiSelect, false);
});

test("extractAskUserQuestions from updates.jsonl session/update", () => {
  const evt = {
    timestamp: 1,
    method: "session/update",
    params: {
      sessionId: "sess-1",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "call-9",
        title: "ask_user_question",
        rawInput: { questions: CANNED_QUESTIONS },
        _meta: { "x.ai/tool": { name: "ask_user_question" } },
      },
    },
  };
  const ask = extractAskUserQuestions(evt);
  assert.ok(ask);
  assert.strictEqual(ask.id, "call-9");
  assert.strictEqual(ask.questions[1].question, "Framework?");
});

test("extractAskUserQuestions from tool_call_update input.questions", () => {
  const evt = {
    type: "tool_call_update",
    toolCallId: "call-later",
    name: "ask_user_question",
    input: { questions: CANNED_QUESTIONS },
  };
  const ask = extractAskUserQuestions(evt);
  assert.strictEqual(ask.id, "call-later");
  assert.strictEqual(ask.questions.length, 2);
});

test("extractAskUserQuestions returns empty questions when only the name is known", () => {
  const ask = extractAskUserQuestions({
    type: "tool_call",
    toolCallId: "call-empty",
    toolName: "ask_user_question",
  });
  assert.ok(ask);
  assert.strictEqual(ask.id, "call-empty");
  assert.deepStrictEqual(ask.questions, []);
});

test("extractAskUserQuestions ignores unrelated tools", () => {
  assert.strictEqual(
    extractAskUserQuestions({
      type: "tool_call",
      toolCallId: "call-grep",
      toolName: "grep",
      rawInput: { pattern: "ask_user_question" },
    }),
    null
  );
});

test("already-normalized questions on a restored tool entry", () => {
  const ask = extractAskUserQuestions({
    id: "call-hist",
    name: "ask_user_question",
    questions: [
      {
        question: "Pick a stack",
        options: [
          { label: "Node", description: "Stay on JS", preview: "", isOther: false },
          { label: "Other…", description: "Type your own answer", preview: "", isOther: true },
        ],
        multiSelect: false,
      },
    ],
  });
  assert.ok(ask);
  assert.strictEqual(ask.questions[0].question, "Pick a stack");
  assert.strictEqual(ask.questions[0].options.filter((o) => o.isOther).length, 1);
});

test("does not duplicate an existing Other option", () => {
  const ask = extractAskUserQuestions({
    toolName: "ask_user_question",
    rawInput: {
      questions: [
        {
          question: "Color?",
          options: [
            { label: "Blue" },
            { label: "Other", description: "Something else" },
          ],
        },
      ],
    },
  });
  assert.strictEqual(ask.questions[0].options.filter((o) => o.isOther).length, 1);
});

test("multi_select is preserved", () => {
  const ask = extractAskUserQuestions({
    toolName: "ask_user_question",
    input: {
      questions: [
        {
          question: "Which extras?",
          options: [{ label: "Tests" }, { label: "Docs" }],
          multi_select: true,
        },
      ],
    },
  });
  assert.strictEqual(ask.questions[0].multiSelect, true);
});

test("preview stays text, not an embed", () => {
  const ask = extractAskUserQuestions({
    toolName: "ask_user_question",
    rawInput: {
      questions: [
        {
          question: "Layout?",
          options: [
            {
              label: "Wide",
              preview: "https://example.com/mockup.png",
            },
          ],
        },
      ],
    },
  });
  assert.strictEqual(ask.questions[0].options[0].preview, "https://example.com/mockup.png");
});

test("format + parse user_answers round-trip", () => {
  const prompt = formatUserAnswersPrompt([
    { question: "Minimal or bold?", answer: "Bold & expressive" },
    { question: "Framework?", answer: "Other: SvelteKit" },
  ]);
  assert.ok(prompt.includes("<user_answers>"));
  assert.ok(!prompt.includes("Use this choice instead"));
  const pairs = parseUserAnswersBlock(prompt);
  assert.strictEqual(pairs.length, 2);
  assert.strictEqual(pairs[0].answer, "Bold & expressive");
  assert.strictEqual(pairs[1].answer, "Other: SvelteKit");
});

test("override prefix is parseable and answers-only", () => {
  const prompt = formatUserAnswersPrompt(
    [{ question: "Tone?", answer: "Minimal" }],
    { override: true }
  );
  assert.ok(prompt.startsWith("Use this choice instead"));
  assert.ok(isAnswersOnlyUserText(prompt));
  assert.strictEqual(parseUserAnswersBlock(prompt)[0].answer, "Minimal");
});

test("isAnswersOnlyUserText handles user_query wrapping", () => {
  const wrapped =
    "<user_query>\n<user_answers>\nQuestion: A?\nAnswer: Yes\n</user_answers>\n</user_query>";
  assert.strictEqual(isAnswersOnlyUserText(wrapped), true);
  assert.strictEqual(isAnswersOnlyUserText("also please use dark mode\n" + wrapped), false);
});

test("applyAnswersToAsk stores labels only", () => {
  const entry = { id: "call-1", questions: [] };
  applyAnswersToAsk(entry, [{ question: "Q", answer: "A" }]);
  assert.deepStrictEqual(entry.answers, [{ question: "Q", answer: "A" }]);
});

test("rememberAskOnRun upserts by id and pendingAsksOf hides answered", () => {
  const record = { runId: "r1" };
  rememberAskOnRun(record, {
    type: "tool_call",
    toolCallId: "call-a",
    toolName: "ask_user_question",
  });
  rememberAskOnRun(record, {
    type: "tool_call_update",
    toolCallId: "call-a",
    toolName: "ask_user_question",
    rawInput: { questions: CANNED_QUESTIONS },
  });
  assert.strictEqual(record.asks.length, 1);
  assert.strictEqual(pendingAsksOf(record).length, 1);
  record.asks[0].answers = [{ question: "Minimal or bold?", answer: "Bold" }];
  assert.strictEqual(pendingAsksOf(record).length, 0);
});

test("hostile HTML in labels is kept as plain text", () => {
  const ask = extractAskUserQuestions({
    toolName: "ask_user_question",
    rawInput: {
      questions: [
        {
          question: "<img src=x onerror=alert(1)>",
          options: [{ label: "<script>alert(1)</script>", description: "<b>nope</b>" }],
        },
      ],
    },
  });
  assert.strictEqual(ask.questions[0].question, "<img src=x onerror=alert(1)>");
  assert.strictEqual(ask.questions[0].options[0].label, "<script>alert(1)</script>");
});

if (failed) {
  process.exitCode = 1;
  throw new Error(`${failed} test(s) failed`);
}

console.log("all tests passed");
