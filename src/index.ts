export interface CheckResult {
  pass: boolean;
  reason?: string;
}
/** A check receives the model output and returns a boolean or a result with a reason. */
export type Check = (output: string) => boolean | CheckResult;
export interface EvalCase {
  name: string;
  prompt: string;
  check: Check;
  tags?: string[];
}
export interface CaseResult {
  name: string;
  pass: boolean;
  reason: string;
  ms: number;
  output: string;
  tags: string[];
}
export interface Report {
  total: number;
  passed: number;
  failed: number;
  passRate: number;
  results: CaseResult[];
}
/** Your model call. Anything that turns a prompt into text: an SDK, a fetch to your endpoint, a stub. */
export type Ask = (prompt: string) => Promise<string>;

const norm = (r: boolean | CheckResult): CheckResult => (typeof r === "boolean" ? { pass: r } : r);

// ---------- checks ----------
/** Passes when the output contains at least one of the terms (case-insensitive). */
export const includesAny = (...terms: string[]): Check => (out) => ({
  pass: terms.some((t) => out.toLowerCase().includes(t.toLowerCase())),
  reason: `expected one of: ${terms.join(", ")}`,
});
/** Passes when the output contains every term (case-insensitive). */
export const includesAll = (...terms: string[]): Check => (out) => {
  const missing = terms.filter((t) => !out.toLowerCase().includes(t.toLowerCase()));
  return { pass: missing.length === 0, reason: `missing: ${missing.join(", ")}` };
};
export const matches = (re: RegExp): Check => (out) => ({ pass: re.test(out), reason: `expected to match ${re}` });
export const notMatches = (re: RegExp): Check => (out) => ({ pass: !re.test(out), reason: `must not match ${re}` });
export const maxWords = (n: number): Check => (out) => {
  const words = out.trim().split(/\s+/).filter(Boolean).length;
  return { pass: words <= n, reason: `${words} words, limit ${n}` };
};
/** Every check must pass. The first failure's reason is reported. */
export const all = (...checks: Check[]): Check => (out) => {
  for (const c of checks) {
    const r = norm(c(out));
    if (!r.pass) return r;
  }
  return { pass: true };
};
/** At least one check must pass. */
export const any = (...checks: Check[]): Check => (out) => {
  const reasons: string[] = [];
  for (const c of checks) {
    const r = norm(c(out));
    if (r.pass) return { pass: true };
    reasons.push(r.reason ?? "failed");
  }
  return { pass: false, reason: `none passed (${reasons.join("; ")})` };
};

// ---------- runner ----------
export interface RunOptions {
  /** How many prompts to run at once. Default 1. Results keep the input order. */
  concurrency?: number;
  /** Per-case timeout in milliseconds. Default 30000. */
  timeoutMs?: number;
}

async function runOne(c: EvalCase, ask: Ask, timeoutMs: number): Promise<CaseResult> {
  const t0 = performance.now();
  let output = "";
  let r: CheckResult;
  try {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, rej) => {
      timer = setTimeout(() => rej(new Error(`timeout after ${timeoutMs} ms`)), timeoutMs);
    });
    try {
      output = await Promise.race([ask(c.prompt), timeout]);
    } finally {
      clearTimeout(timer);
    }
    r = norm(c.check(output));
  } catch (e) {
    r = { pass: false, reason: e instanceof Error ? e.message : String(e) };
  }
  return { name: c.name, pass: r.pass, reason: r.pass ? "" : (r.reason ?? "check failed"), ms: Math.round(performance.now() - t0), output, tags: c.tags ?? [] };
}

export async function runEvals(cases: EvalCase[], ask: Ask, opts: RunOptions = {}): Promise<Report> {
  const concurrency = Math.max(1, opts.concurrency ?? 1);
  const timeoutMs = opts.timeoutMs ?? 30000;
  const results: CaseResult[] = new Array(cases.length);
  let next = 0;
  const worker = async () => {
    while (next < cases.length) {
      const i = next++;
      results[i] = await runOne(cases[i], ask, timeoutMs);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, cases.length) }, worker));
  const passed = results.filter((r) => r.pass).length;
  return { total: cases.length, passed, failed: cases.length - passed, passRate: cases.length ? passed / cases.length : 1, results };
}

export function formatReport(report: Report): string {
  const lines = report.results.map((r) => `${r.pass ? "PASS" : "FAIL"}  ${r.name} (${r.ms} ms)${r.pass ? "" : `\n      ${r.reason}`}`);
  lines.push("", `${report.passed}/${report.total} passed`);
  return lines.join("\n");
}

/** 0 when the pass rate meets the threshold (default 1, meaning every case), otherwise 1. Use as process.exitCode in CI. */
export const exitCode = (report: Report, threshold = 1): number => (report.passRate >= threshold ? 0 : 1);

/** Build an Ask that POSTs JSON to an endpoint. `body` shapes the request, `pick` extracts the text from the response. */
export function httpAsk(url: string, opts: { body: (prompt: string) => unknown; pick: (json: any) => string; headers?: Record<string, string> }): Ask {
  return async (prompt) => {
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...opts.headers }, body: JSON.stringify(opts.body(prompt)) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return opts.pick(await res.json());
  };
}
