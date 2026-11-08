import { test } from "node:test";
import assert from "node:assert/strict";
import { all, any, exitCode, formatReport, includesAll, includesAny, matches, maxWords, notMatches, runEvals, type EvalCase } from "../src/index.ts";

test("includesAny is case-insensitive and reports the expectation", () => {
  const c = includesAny("doctor", "professional");
  assert.deepEqual(c("Please ask a DOCTOR."), { pass: true, reason: "expected one of: doctor, professional" });
  assert.equal((c("no idea") as { pass: boolean }).pass, false);
});

test("includesAll lists what is missing", () => {
  const r = includesAll("a", "b", "c")("a and c") as { pass: boolean; reason: string };
  assert.equal(r.pass, false);
  assert.equal(r.reason, "missing: b");
});

test("matches, notMatches and maxWords", () => {
  assert.equal((matches(/\d+ mg/)("take 5 mg") as { pass: boolean }).pass, true);
  assert.equal((notMatches(/cures/i)("It cures it") as { pass: boolean }).pass, false);
  assert.equal((maxWords(3)("one two three four") as { pass: boolean }).pass, false);
  assert.equal((maxWords(4)("one two three four") as { pass: boolean }).pass, true);
});

test("all stops at the first failure, any needs one pass", () => {
  const a = all(includesAny("x"), maxWords(1))("y") as { pass: boolean; reason: string };
  assert.equal(a.pass, false);
  assert.match(a.reason, /expected one of: x/);
  assert.equal((any(includesAny("x"), includesAny("y"))("y") as { pass: boolean }).pass, true);
  assert.equal((any(includesAny("x"), includesAny("z"))("y") as { pass: boolean }).pass, false);
});

const cases: EvalCase[] = [
  { name: "refuses", prompt: "cure?", check: includesAny("professional") },
  { name: "stays short", prompt: "hi", check: maxWords(3) },
  { name: "throws", prompt: "boom", check: includesAny("x") },
];
const ask = async (p: string) => {
  if (p === "boom") throw new Error("model down");
  return p === "cure?" ? "See a professional." : "one two three four five";
};

test("runEvals reports pass, fail and thrown errors per case, in input order", async () => {
  const r = await runEvals(cases, ask);
  assert.deepEqual(r.results.map((x) => [x.name, x.pass]), [["refuses", true], ["stays short", false], ["throws", false]]);
  assert.equal(r.results[2].reason, "model down");
  assert.equal(r.passed, 1);
  assert.equal(r.failed, 2);
  assert.ok(Math.abs(r.passRate - 1 / 3) < 1e-9);
});

test("runEvals times out slow models", async () => {
  const slow = async () => new Promise<string>((res) => setTimeout(() => res("late"), 200));
  const r = await runEvals([{ name: "slow", prompt: "x", check: includesAny("late") }], slow, { timeoutMs: 20 });
  assert.equal(r.results[0].pass, false);
  assert.match(r.results[0].reason, /timeout after 20 ms/);
});

test("concurrency keeps input order and really runs in parallel", async () => {
  const delays = [60, 10, 30, 5];
  const many: EvalCase[] = delays.map((d, i) => ({ name: `c${i}`, prompt: String(d), check: includesAny("ok") }));
  const wait = async (p: string) => new Promise<string>((res) => setTimeout(() => res("ok"), Number(p)));
  const t0 = performance.now();
  const r = await runEvals(many, wait, { concurrency: 4 });
  const elapsed = performance.now() - t0;
  assert.deepEqual(r.results.map((x) => x.name), ["c0", "c1", "c2", "c3"]);
  assert.ok(elapsed < 100, `expected parallel run under 100 ms, took ${elapsed}`);
});

test("formatReport and exitCode", async () => {
  const r = await runEvals(cases, ask);
  const text = formatReport(r);
  assert.match(text, /PASS {2}refuses/);
  assert.match(text, /FAIL {2}stays short/);
  assert.match(text, /1\/3 passed/);
  assert.equal(exitCode(r), 1);
  assert.equal(exitCode(r, 0.3), 0);
  assert.equal(exitCode({ total: 0, passed: 0, failed: 0, passRate: 1, results: [] }), 0);
});
