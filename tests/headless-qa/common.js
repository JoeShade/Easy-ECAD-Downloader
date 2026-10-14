/*
 * Evidence persistence and bounded polling for the headless QA harness.
 * Run directories are exclusive: reruns must use a new identifier.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { spawn } from "node:child_process";
export { accountDownloads } from "./download_accounting.js";

export const repoRoot = path.resolve(import.meta.dirname, "../..");
export const stageNames = ["environment", "navigation", "detection", "popup", "previews", "downloads", "rendering"];
export const now = () => new Date().toISOString();

const secretKey = /(?:authorization|password|passwd|user[_-]?name|credential|cookie|phpsessid|sess(?:ion)?[_-]?(?:id|key|secret)$|^session$|^sid$|(?:^|[_-])auth(?:$|[_-])|token|api[_-]?key|signature)/i;
const sessionSecrets = new Set();

export function protectSecrets(values) {
  const secrets = new Set(values.filter(Boolean).flatMap(value => [value, encodeURIComponent(value),
    JSON.stringify(value).slice(1, -1)]));
  sessionSecrets.add(secrets);
  return () => { sessionSecrets.delete(secrets); secrets.clear(); };
}

function maskSessionSecrets(text) {
  const secrets = [...sessionSecrets].flatMap(values => [...values]).sort((a, b) => b.length - a.length);
  for (const secret of secrets) text = text.replaceAll(secret, "[redacted]");
  return text;
}

export function containsProtectedSecret(text) {
  return [...sessionSecrets].some(values => [...values].some(value => text.includes(value)));
}

export function redact(value, seen = new WeakSet()) {
  if (typeof value === "string") {
    return maskSessionSecrets(value.replace(/\bdata:[^,\r\n]*,[^\r\n]+/gi, "[image/blob omitted]")
      .replace(/\bblob:(?:[a-z][a-z0-9+.-]*:|null\/)[^\s"'<>]+/gi, "[image/blob omitted]")
      .replace(/https?:\/\/[^\s"'<>\\]+/gi, match => {
      try {
        const url = new URL(match);
        const hasUserInfo = Boolean(url.username || url.password);
        url.username = ""; url.password = "";
        let changed = hasUserInfo;
        for (const key of url.searchParams.keys()) {
          if (secretKey.test(key) || /^(key|code|auth)$/i.test(key)) {
            url.searchParams.set(key, "[redacted]"); changed = true;
          }
        }
        return changed ? url.href : match;
      } catch { return "[invalid URL omitted]"; }
    }).replace(/\b(?:set-cookie|cookie)["']?\s*:\s*[^\r\n]+/gi, "[cookie omitted]")
      .replace(/\b(?:Basic|Bearer)\s+[A-Za-z0-9+/=._-]+/gi, "[authorization omitted]")
      .replace(/\b(password|token|session|authorization)\s*[:=]\s*[^\s"'<>&,;]+/gi, "$1=[redacted]")
      .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, "[email omitted]"));
  }
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return "[circular value omitted]";
  seen.add(value);
  const output = Array.isArray(value) ? value.map(item => redact(item, seen)) :
    Object.fromEntries(Object.entries(value).map(([key, item]) => [maskSessionSecrets(key), secretKey.test(key) ? "[redacted]" :
      typeof item === "string" && item.length > 4096 && /(?:image(?:data|payload|base64)|blob(?:data|payload)?|base64)$/i.test(key) ?
        "[image/blob omitted]" : redact(item, seen)]));
  seen.delete(value);
  return output;
}

export function options(extra = {}) {
  const { values } = parseArgs({ options: {
    out: { type: "string", default: ".qa-output" },
    id: { type: "string", default: `run-${Date.now()}` },
    timeout: { type: "string", default: "45000" },
    "download-timeout": { type: "string", default: "180000" },
    "render-timeout": { type: "string", default: "180000" },
    retries: { type: "string", default: "1" },
    python: { type: "string", default: process.env.QA_PYTHON || "python" },
    "kicad-cli": { type: "string", default: process.env.KICAD_CLI || "" },
    ...extra
  } });
  for (const key of ["timeout", "download-timeout", "render-timeout", "retries"]) {
    values[key] = Number(values[key]);
    if (!Number.isInteger(values[key]) || values[key] < (key === "retries" ? 0 : 1) ||
        (key === "retries" && values[key] > 3)) throw new Error(`Invalid --${key}`);
  }
  return values;
}

export async function atomicJson(filename, value) {
  const temporary = `${filename}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(redact(value), null, 2)}\n`);
  await fs.rename(temporary, filename);
}

export async function createRun(out, id, kind = "live") {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(id)) throw new Error("Invalid run ID");
  const root = path.resolve(out);
  const relative = path.relative(repoRoot, root);
  if (!relative || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
    const ignored = await command("git", ["check-ignore", "--quiet", `${relative.replaceAll(path.sep, "/")}/`]);
    if (ignored.code !== 0) throw new Error("Output inside repository must be gitignored; use .qa-output");
  }
  const dir = path.join(root, id);
  await fs.mkdir(root, { recursive: true });
  await fs.mkdir(dir); // EEXIST prevents contamination or accidental evidence replacement.
  for (const name of ["browser", "downloads", "renders", "inspection-project"]) {
    await fs.mkdir(path.join(dir, name));
  }
  const result = { schemaVersion: 2, id, kind, startedAt: now(), execution: "RUNNING",
    stages: Object.fromEntries(stageNames.map(name => [name, { execution: "NOT_RUN", checks: [] }])) };
  const save = () => atomicJson(path.join(dir, "result.json"), result);
  const log = async (event, data = {}) => fs.appendFile(path.join(dir, "execution.log"),
    `${JSON.stringify({ timestamp: now(), event, data: redact(data) })}\n`);
  const check = async (stage, outcome, establishes, details = {}) => {
    result.stages[stage].checks.push({ ...details, outcome, establishes, timestamp: now() });
    await save();
  };
  const stage = async (name, action) => {
    const state = result.stages[name];
    Object.assign(state, { execution: "RUNNING", startedAt: now() });
    await save();
    try { await action(); state.execution = "COMPLETED"; }
    catch (error) {
      state.execution = "FAILED";
      await check(name, error.outcome || "FAIL", redact(error.message), { category: error.category || "harness", cause: error.cause || "unknown" });
      await log("stage-error", { stage: name, message: error.message });
      throw error;
    } finally { state.finishedAt = now(); await save(); }
  };
  await save();
  await log("run-created", { id, kind });
  return { dir, result, save, log, check, stage };
}

export function issue(message, category = "harness", outcome = "BLOCKED") {
  return Object.assign(new Error(message), { category, outcome });
}

export async function poll(read, accept, timeout, interval = 200) {
  const deadline = Date.now() + timeout;
  let last;
  do {
    let timer;
    try {
      last = await Promise.race([read(), new Promise((_, reject) => {
        timer = setTimeout(() => reject(issue(`Timed out after ${timeout}ms`)), Math.max(1, deadline - Date.now()));
      })]);
    } finally { clearTimeout(timer); }
    if (accept(last)) return last;
    await new Promise(resolve => setTimeout(resolve, Math.min(interval, Math.max(1, deadline - Date.now()))));
  } while (Date.now() < deadline);
  throw Object.assign(issue(`Timed out after ${timeout}ms`), { last });
}

export async function retryObservation(read, timeout, retries) {
  const attempts = [];
  for (let attempt = 0; attempt <= retries; attempt++) {
    let firstFailure = null;
    try {
      const result = await poll(async () => {
        const value = await read();
        if (value.error && !firstFailure) firstFailure = { message: value.error, timestamp: now() };
        return value;
      }, value => !value.error, Math.max(1, Math.floor(timeout / (retries + 1))));
      attempts.push({ attempt, firstFailure, outcome: "PASS", finishedAt: now() });
      return { ...result, attempts };
    } catch (error) {
      attempts.push({ attempt, firstFailure: firstFailure || { message: error.message, timestamp: now() }, outcome: "FAIL", terminalError: error.message, finishedAt: now() });
      if (attempt === retries) return { ...(error.last || { response: null, error: error.message }), attempts };
    }
  }
}

export async function command(executable, args, { timeout = 180000, cwd = repoRoot, log = async () => {} } = {}) {
  const startedAt = now();
  const output = await new Promise(resolve => {
    const child = spawn(executable, args, { cwd, windowsHide: true, shell: false });
    let stdout = "", stderr = "", timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeout);
    child.stdout.on("data", data => { stdout = (stdout + data).slice(-200000); });
    child.stderr.on("data", data => { stderr = (stderr + data).slice(-200000); });
    child.on("error", error => { stderr += error.message; });
    child.on("close", code => { clearTimeout(timer); resolve({ code, timedOut, stdout: redact(stdout), stderr: redact(stderr) }); });
  });
  const record = { executable, args, startedAt, finishedAt: now(), ...output };
  await log("command", record);
  return record;
}

/*
######################################################################################################################


                                        AAAAAAAA
                                      AAAA    AAAAA              AAAAAAAA
                                    AAA          AAA           AAAA    AAA
                                    AA            AA          AAA       AAA
                                    AA            AAAAAAAAAA  AAA       AAAAAAAAAA
                                    AAA                  AAA  AAA               AA
                                     AAA                AAA    AAAAA            AA
                                      AAAAA            AAA        AAA           AA
                                         AAA          AAA                       AA
                                         AAA         AAA                        AA
                                         AA         AAA                         AA
                                         AA        AAA                          AA
                                        AAA       AAAAAAAAA                     AA
                                        AAA       AAAAAAAAA                     AA
                                        AA                   AAAAAAAAAAAAAA     AA
                                        AA  AAAAAAAAAAAAAAAAAAAAAAAA    AAAAAAA AA
                                       AAAAAAAAAAA                           AA AA
                                                                           AAA  AA
                                                                         AAAA   AA
                                                                      AAAA      AA
                                                                   AAAAA        AA
                                                               AAAAA            AA
                                                            AAAAA               AA
                                                        AAAAAA                  AA
                                                    AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA


######################################################################################################################

                                                Copyright (c) JoeShade
                              Licensed under the GNU Affero General Public License v3.0

######################################################################################################################

                                        +44 (0) 7356 042702 | joe@jshade.co.uk

######################################################################################################################
*/
