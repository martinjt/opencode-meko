import { test } from "node:test";
import assert from "node:assert/strict";

import { __TEST__ } from "../assets/opencode-plugin/meko-memory.mjs";

const { deriveAgentId, extractExchanges, textOf, reasoningOf } = __TEST__;

test("deriveAgentId: repo-scoped bucket from directory basename", () => {
  assert.equal(deriveAgentId("/home/martin/repos/martinjt/opencode-meko"), "opencode:opencode-meko");
});

test("deriveAgentId: sanitizes non [a-z0-9-] characters", () => {
  assert.equal(deriveAgentId("/home/martin/repos/My Cool Project!"), "opencode:my-cool-project");
});

test("deriveAgentId: falls back to bare 'opencode' with no directory", () => {
  assert.equal(deriveAgentId(""), "opencode");
  assert.equal(deriveAgentId("/"), "opencode");
});

test("textOf: joins text parts, ignores non-text parts", () => {
  const parts = [
    { type: "text", text: "hello" },
    { type: "tool", text: "ignored" },
    { type: "text", text: "world" },
  ];
  assert.equal(textOf(parts), "hello\nworld");
});

test("reasoningOf: joins reasoning parts only", () => {
  const parts = [
    { type: "reasoning", text: "thinking..." },
    { type: "text", text: "answer" },
  ];
  assert.equal(reasoningOf(parts), "thinking...");
});

test("extractExchanges: pairs assistant replies with their parent user message", () => {
  const messages = [
    {
      info: { id: "u1", role: "user", parentID: undefined },
      parts: [{ type: "text", text: "What is 2+2?" }],
    },
    {
      info: { id: "a1", role: "assistant", parentID: "u1", finish: "stop" },
      parts: [{ type: "text", text: "4" }],
    },
    {
      info: { id: "u2", role: "user", parentID: undefined },
      parts: [{ type: "text", text: "And 3+3?" }],
    },
    {
      info: { id: "a2", role: "assistant", parentID: "u2", finish: "stop" },
      parts: [{ type: "text", text: "6" }],
    },
  ];

  const all = extractExchanges(messages, null);
  assert.equal(all.length, 2);
  assert.deepEqual(
    all.map((e) => [e.input, e.output]),
    [["What is 2+2?", "4"], ["And 3+3?", "6"]],
  );

  const afterFirst = extractExchanges(messages, "a1");
  assert.equal(afterFirst.length, 1);
  assert.equal(afterFirst[0].input, "And 3+3?");
});

test("extractExchanges: skips an assistant message with no finish (still in progress)", () => {
  const messages = [
    { info: { id: "u1", role: "user" }, parts: [{ type: "text", text: "hi" }] },
    { info: { id: "a1", role: "assistant", parentID: "u1" }, parts: [{ type: "text", text: "" }] },
  ];
  assert.equal(extractExchanges(messages, null).length, 0);
});
