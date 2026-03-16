import test from "node:test";
import assert from "node:assert/strict";
import { parseCommandText } from "../src/command-parser.js";

test("parseCommandText supports quoted bind arguments", () => {
  assert.deepEqual(parseCommandText('/bind "/tmp/Project A" repo-a'), [
    "/bind",
    "/tmp/Project A",
    "repo-a"
  ]);
});

test("parseCommandText supports single quotes and escapes", () => {
  assert.deepEqual(parseCommandText(String.raw`/bind '/tmp/project a' repo\-a`), [
    "/bind",
    "/tmp/project a",
    "repo-a"
  ]);
});
