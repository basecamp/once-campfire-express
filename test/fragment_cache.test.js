import { test } from "node:test";
import assert from "node:assert/strict";
import { FragmentCache } from "../src/fragment_cache.js";

test("f: fetch builds once per key and evicts least recently used within the byte budget", () => {
  const cache = new FragmentCache(100);
  let builds = 0;
  const build = (s) => () => (builds++, s);
  assert.equal(cache.fetch("a", build("x".repeat(20))), "x".repeat(20));
  cache.fetch("a", build("never"));
  assert.equal(builds, 1);
  cache.fetch("b", build("y".repeat(20)));
  cache.fetch("a", build("never"));
  cache.fetch("c", build("z".repeat(20)));
  assert.ok(cache.size <= 100);
  cache.fetch("a", build("again"));
  assert.equal(builds, 3, "a was recently used and must survive");
});

test("entries larger than half of the budget are returned but not stored", () => {
  const cache = new FragmentCache(100);
  assert.equal(
    cache.fetch("big", () => "q".repeat(40)),
    "q".repeat(40),
  );
  assert.equal(cache.size, 0);
});
