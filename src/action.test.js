import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";

/**
 * The Marketplace listing rejects a description of 125 characters or more, and it
 * rejects it at publish time — long after the text was written. Both YAML forms
 * are read so reflowing the block cannot slip past this.
 */
function description(text) {
  const folded = /^description: >-?\n((?:[ \t]+\S.*\n)+)/m.exec(text);
  if (folded) {
    return folded[1]
      .trim()
      .split("\n")
      .map((line) => line.trim())
      .join(" ");
  }
  const inline = /^description:[ \t]+["']?(.*?)["']?[ \t]*$/m.exec(text);
  assert.ok(inline, "action.yml declares no description");
  return inline[1];
}

const ACTION = fs.readFileSync("action.yml", "utf8");

test("the description fits what the Marketplace accepts", () => {
  const text = description(ACTION);
  assert.ok(text.length > 0);
  assert.ok(
    text.length < 125,
    `description is ${text.length} characters; the Marketplace limit is 124: ${text}`,
  );
});

test("the description says both halves of what the action does", () => {
  // Shortening it must not cost the save; the restore is the half people expect.
  const text = description(ACTION).toLowerCase();
  assert.match(text, /resume|restore/);
  assert.match(text, /save/);
});
