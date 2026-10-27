/**
 * LOCAL ONLY. Shared infrastructure for the permanent integration suites:
 * bounded D1 commands, real Worker startup + readiness, bounded fetch, a hard
 * suite timeout and guaranteed process-group teardown. No business assertions
 * live here.
 *
 * Cleanup order used by every suite (see `installSuiteGuard`):
 *   1. Chromium closes (UI suite only),
 *   2. the Worker process group is killed,
 *   3. owned fixtures are restored by direct, bounded D1 commands (needs no HTTP,
 *      so it works even when the Worker is unhealthy),
 *   4. the final baseline is asserted.
 * The emergency path (timeout, SIGINT/SIGTERM, uncaught exception) performs 1-3
 * and exits non-zero. Cleanup only runs after the suite's own baseline guard
 * has succeeded, so unknown developer data is never touched.
 */
import { execFileSync, spawn } from "node:child_process";
import http from "node:http";
import { closeSync, existsSync, openSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const WRANGLER = ["--import", "./scripts/sites-env.mjs", "./node_modules/wrangler/bin/wrangler.js"];
const D1_ARGS = ["d1", "execute", "DB", "--local", "--config", "dist/server/wrangler.json", "--persist-to", ".wrangler/state", "--json", "--command"];
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const D1_TIMEOUT_MS = 30_000; // a healthy CLI call takes ~0.7s (max seen 1.3s)
let d1Retries = 0;
process.on("exit", () => {
  if (d1Retries > 0) console.log(`[test-helpers] ${d1Retries} stalled D1 CLI call(s) were killed and re-run.`);
});

/** Kills workerd processes whose wrangler parent is gone (a killed CLI can leave one behind holding D1 files). */
function reapOrphanedWorkerd() {
  try {
    const out = execFileSync("ps", ["-axo", "pid=,ppid=,command="], { encoding: "utf8", timeout: 10_000 });
    for (const line of out.split("\n")) {
      const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
      if (m && m[2] === "1" && /workerd/.test(m[3])) { try { process.kill(Number(m[1]), "SIGKILL"); } catch { /* gone */ } }
    }
  } catch { /* best effort */ }
}

/**
 * Bounded local D1 command: a stalled wrangler CLI is killed (and any orphaned
 * workerd reaped) instead of waited on. Read-only SELECTs are re-run up to twice
 * after a stall; writes are never re-run (the suite fails loudly instead, and
 * the guard restores owned fixtures).
 */
export function sql(command, timeoutMs = D1_TIMEOUT_MS) {
  const readOnly = /^\s*SELECT\b/i.test(command);
  for (let attempt = 0; ; attempt++) {
    try {
      const out = execFileSync(process.execPath, [...WRANGLER, ...D1_ARGS, command], {
        encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: timeoutMs, killSignal: "SIGKILL",
      });
      return JSON.parse(out)[0].results;
    } catch (error) {
      if (error?.code !== "ETIMEDOUT") throw error;
      reapOrphanedWorkerd();
      if (!readOnly || attempt >= 2) throw new Error(`D1 command timed out after ${timeoutMs}ms: ${command.slice(0, 80)}`);
      d1Retries++;
    }
  }
}
export const count = (table, where = "1=1") => sql(`SELECT count(*) AS n FROM ${table} WHERE ${where}`)[0].n;
export const one = (query) => sql(query)[0];

/**
 * fetch-compatible request over a fresh, non-keep-alive connection with a hard
 * total timeout. Pooled keep-alive connections are what wedge when wrangler dev's
 * proxy answers a body-carrying request early (see fetchBounded), so every test
 * request gets its own connection.
 */
function requestOnce(url, init, timeoutMs) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const headers = { ...(init.headers ?? {}) };
    const body = init.body === undefined || init.body === null ? null : Buffer.from(init.body);
    if (body) headers["content-length"] = String(body.length);
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: init.method ?? "GET", headers, agent: false }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("error", reject);
      res.on("end", () => {
        clearTimeout(timer);
        const out = new Headers();
        for (let i = 0; i < res.rawHeaders.length; i += 2) out.append(res.rawHeaders[i], res.rawHeaders[i + 1]);
        const empty = [101, 204, 205, 304].includes(res.statusCode);
        resolve(new Response(empty ? null : Buffer.concat(chunks), { status: res.statusCode, headers: out }));
      });
    });
    const timer = setTimeout(() => {
      const error = new Error(`Request timed out after ${timeoutMs}ms: ${init.method ?? "GET"} ${u.pathname}`);
      error.name = "TimeoutError";
      req.destroy(error);
    }, timeoutMs);
    req.on("error", (error) => { clearTimeout(timer); reject(error); });
    req.end(body);
  });
}

const TRANSIENT = /ECONNRESET|ECONNREFUSED|UND_ERR|fetch failed|socket|terminated/i;
const PROXY_RACE = /worker restarted mid-request/i;
const READ_ATTEMPT_MS = 6_000;
let proxyRaceRetries = 0;
let stalledReads = 0;
process.on("exit", () => {
  if (proxyRaceRetries > 0) console.log(`[test-helpers] ${proxyRaceRetries} request(s) re-sent after the wrangler dev proxy's early-response 503 (see fetchBounded).`);
  if (stalledReads > 0) console.log(`[test-helpers] ${stalledReads} stalled read probe(s) aborted and re-asked (wrangler dev proxy wedge, see workerBarrier).`);
});

/**
 * fetch with a hard per-request timeout.
 *
 * Retry policy (evidence-based, see the probes recorded in the SEC0H4.1 report):
 *  - GET/HEAD: retried twice on connection-level errors or 503.
 *  - Mutations are NEVER retried on errors or timeouts. The single exception is
 *    the dev proxy's own signature `503 "Your worker restarted mid-request"` for
 *    a request that carries a body. wrangler dev's proxy emits it when a handler
 *    answers (typically an early 401/403/404 reject) before the request body was
 *    consumed: ~15% of such requests, 0/150 for body-less ones, and never for a
 *    handler that read its body. A handler that reads the body before acting
 *    cannot lose this race, so the request was rejected before any work and is
 *    safe to re-send. Every re-send is counted and reported at exit.
 */
export async function fetchBounded(url, init = {}, timeoutMs = 15_000) {
  const method = (init.method ?? "GET").toUpperCase();
  const idempotent = method === "GET" || method === "HEAD";
  const hasBody = init.body !== undefined && init.body !== null;
  if (!idempotent) await workerBarrier(url);
  // A stalled read is aborted quickly and re-asked: aborting is what un-wedges the proxy.
  const attemptTimeout = idempotent ? Math.min(timeoutMs, READ_ATTEMPT_MS) : timeoutMs;
  for (let attempt = 0; ; attempt++) {
    try {
      const response = await requestOnce(url, init, attemptTimeout);
      if (response.status === 503 && attempt < 3) {
        if (idempotent && attempt < 2) { await sleep(500); continue; }
        if (!idempotent && hasBody && PROXY_RACE.test(await response.clone().text())) { proxyRaceRetries++; await workerBarrier(url); continue; }
      }
      return response;
    } catch (error) {
      const retryable = TRANSIENT.test(`${error?.message} ${error?.cause?.code ?? ""} ${error?.cause?.message ?? ""}`) || error?.name === "TimeoutError";
      if (!idempotent || attempt >= 2 || !retryable) throw error;
      if (error?.name === "TimeoutError") stalledReads++;
      await sleep(300);
    }
  }
}

/**
 * Before any mutation, prove the Worker channel is answering: a cheap read-only
 * request (an unknown session token, D1 lookup, 401) that is aborted and re-asked
 * if it stalls. Mutations are therefore never the request that discovers a wedged
 * proxy, so no mutation ever needs to be retried because of one.
 */
async function workerBarrier(url) {
  const origin = new URL(url).origin;
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      await requestOnce(`${origin}/api/auth/me`, { headers: { cookie: "session=barrier" } }, 3_000).then((r) => r.text());
      return;
    } catch (error) {
      if (error?.name === "TimeoutError") stalledReads++;
      await sleep(200);
    }
  }
  throw new Error(`Worker stopped answering requests (barrier probe failed 6 times) before ${url}`);
}

function groupAlive(pid) {
  try { process.kill(-pid, 0); return true; } catch { return false; }
}

/**
 * Starts `wrangler dev` in its own process group (so workerd dies with it), logs
 * its output to a file, and returns only once the Worker really answers. The
 * readiness probe is read-only: an unauthenticated-token lookup through
 * `/api/auth/me`, which exercises routing and D1 and answers 401.
 */
export async function startWorker(port, { readyTimeoutMs = 20_000 } = {}) {
  const base = `http://127.0.0.1:${port}`;
  const logPath = join(tmpdir(), `gym-test-worker-${port}-${process.pid}.log`);
  const fd = openSync(logPath, "w");
  const child = spawn(process.execPath, [...WRANGLER, "dev", "--config", "dist/server/wrangler.json", "--local",
    "--persist-to", ".wrangler/state", "--ip", "127.0.0.1", "--port", String(port), "--inspector-port", "0"],
    { stdio: ["ignore", fd, fd], detached: true });
  closeSync(fd);
  let exited = false;
  child.on("exit", () => { exited = true; });

  const worker = {
    base, pid: child.pid, logPath,
    logTail: (n = 40) => { try { return readFileSync(logPath, "utf8").split("\n").slice(-n).join("\n"); } catch { return "(no log)"; } },
    /** SIGTERM the group, wait briefly, then SIGKILL; resolves once nothing is left. */
    async stop() {
      if (!child.pid) return;
      try { process.kill(-child.pid, "SIGTERM"); } catch { /* already gone */ }
      for (let i = 0; i < 40 && groupAlive(child.pid); i++) await sleep(100);
      if (groupAlive(child.pid)) { try { process.kill(-child.pid, "SIGKILL"); } catch { /* gone */ } }
    },
    killNow() { try { process.kill(-child.pid, "SIGKILL"); } catch { /* gone */ } },
    discardLog() { try { rmSync(logPath, { force: true }); } catch { /* ignore */ } },
  };
  // Last line of defence: never leave a Worker group behind, however node exits.
  process.on("exit", (code) => {
    worker.killNow();
    if (code === 0) worker.discardLog();
    else console.error(`Worker log kept for diagnosis: ${logPath}`);
  });

  const started = Date.now();
  let streak = 0;
  let last = "no response";
  while (Date.now() - started < readyTimeoutMs) {
    if (exited) break;
    try {
      const response = await fetch(`${base}/api/auth/me`, { headers: { cookie: "session=readiness-probe" }, signal: AbortSignal.timeout(3_000) });
      last = `HTTP ${response.status}`;
      streak = response.status === 401 ? streak + 1 : 0;
      if (streak >= 3) break;
    } catch (error) {
      last = error?.cause?.code ?? error?.name ?? "error";
      streak = 0;
    }
    await sleep(200);
  }
  if (streak >= 3) return worker;
  worker.killNow();
  throw new Error(`Worker failed readiness check after ${Math.round((Date.now() - started) / 1000)}s (${exited ? "wrangler exited" : last}).\n${worker.logTail()}`);
}

/**
 * Hard total-runtime limit plus signal/exception handling. `emergency` must be
 * synchronous and bounded (kill processes, restore owned fixtures by direct D1);
 * after it runs the process exits non-zero.
 */
export function installSuiteGuard(name, timeoutMs, emergency) {
  let fired = false;
  const fire = (reason, code = 1) => {
    if (fired) return;
    fired = true;
    console.error(`\n[${name}] ${reason}; running emergency cleanup.`);
    try { emergency(); } catch (error) { console.error(`[${name}] emergency cleanup failed:`, error?.message ?? error); }
    process.exit(code);
  };
  const timer = setTimeout(() => fire(`suite exceeded its ${Math.round(timeoutMs / 1000)}s limit`), timeoutMs);
  timer.unref(); // never keeps a finished run alive; still fires while a hung run holds the loop open
  process.on("SIGINT", () => fire("received SIGINT", 130));
  process.on("SIGTERM", () => fire("received SIGTERM", 143));
  process.on("uncaughtException", (error) => fire(`uncaught exception: ${error?.message ?? error}`));
  process.on("unhandledRejection", (error) => fire(`unhandled rejection: ${error?.message ?? error}`));
}

const CHROMIUM_CANDIDATES = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser",
];

/** Chromium/Chrome executable for the browser suites: CHROMIUM_PATH, a standard install, or Playwright's own. */
export function resolveChromium(chromium) {
  if (process.env.CHROMIUM_PATH) {
    if (!existsSync(process.env.CHROMIUM_PATH)) throw new Error(`CHROMIUM_PATH does not exist: ${process.env.CHROMIUM_PATH}`);
    return process.env.CHROMIUM_PATH;
  }
  const found = [...CHROMIUM_CANDIDATES, chromium.executablePath()].find((path) => path && existsSync(path));
  if (!found) throw new Error("No Chromium/Chrome found. Set CHROMIUM_PATH to a Chromium/Chrome executable.");
  return found;
}
