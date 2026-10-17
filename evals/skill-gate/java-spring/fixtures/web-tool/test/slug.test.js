import { test } from "node:test";
import assert from "node:assert/strict";
import { slugify } from "../src/slug.js";

test("joins words with a hyphen", () => {
  assert.equal(slugify("Hello, World!"), "hello-world");
});

test("trims hyphens at both ends", () => {
  assert.equal(slugify("  --Trim me--  "), "trim-me");
});

test("an empty text gives an empty slug", () => {
  assert.equal(slugify(""), "");
});
