/*
 * Capture Runtime/Log events before extension installation and page navigation.
 * Records stream to disk with bounded volume; generic failures keep unknown
 * cause rather than being attributed to a provider by message keywords.
 */
import path from "node:path";
import { atomicJson, now, redact } from "./common.js";

export function classifyFailure(message, { category, httpStatus } = {}) {
  const text = String(message || "");
  if (["harness", "environment", "fixture"].includes(category)) {
    return { outcome: "BLOCKED", category, cause: category };
  }
  const restriction = [401, 403, 429].includes(httpStatus) ||
    /access denied|unauthorized|forbidden|(?:authentication|sign.?in|log.?in) (?:is )?required|requires? (?:authentication|sign.?in)|captcha|verify you are human|rate limit|HTTP(?: status| error)?\s*(?:401|403|429)\b/i.test(text);
  return restriction ? { outcome: "BLOCKED", category: "external-access", cause: "explicit access restriction" } :
    { outcome: "FAIL", category: category || "runtime-observation", cause: "unknown" };
}

export function diagnosticRecord(source, method, event) {
  const timestamp = now();
  let message, severity = "error", details;
  if (method === "Runtime.consoleAPICalled") {
    if (!["warning", "error", "assert"].includes(event.type)) return null;
    severity = event.type === "warning" ? "warning" : "error";
    message = (event.args || []).map(arg => arg.value !== undefined ?
      typeof arg.value === "string" ? arg.value : JSON.stringify(redact(arg.value)) : arg.description || `[${arg.type}]`).join(" ");
    details = { stack: event.stackTrace, runtimeTimestamp: event.timestamp };
  } else if (method === "Runtime.exceptionThrown") {
    const exception = event.exceptionDetails || {};
    message = exception.exception?.description || exception.text || "Uncaught runtime exception";
    details = { url: exception.url, lineNumber: exception.lineNumber, columnNumber: exception.columnNumber,
      stack: exception.stackTrace, runtimeTimestamp: event.timestamp };
  } else {
    if (!["warning", "error"].includes(event.entry?.level)) return null;
    message = event.entry.text;
    severity = event.entry.level;
    details = { url: event.entry.url, lineNumber: event.entry.lineNumber, runtimeTimestamp: event.entry.timestamp };
  }
  return redact({ timestamp, source, method, severity, message: redact(message).slice(0, 4000), ...details,
    finding: severity === "warning" ? { outcome: "REVIEW", category: "runtime-observation", cause: "unknown" } : classifyFailure(message) });
}

export function diagnosticCollector(run, limit = 200) {
  const records = [];
  let dropped = 0, pending = Promise.resolve();
  const record = value => {
    if (!value) return;
    if (records.length >= limit) { dropped++; return; }
    records.push(value);
    pending = pending.then(async () => {
      await run.log("runtime-diagnostic", value);
      await atomicJson(path.join(run.dir, "browser/diagnostics.json"), { records, dropped, limit });
    });
  };
  return { records, record, async flush() {
    await pending;
    await atomicJson(path.join(run.dir, "browser/diagnostics.json"), { records, dropped, limit });
  }, summary() { return { evidence: "browser/diagnostics.json", count: records.length, dropped, limit,
    errors: records.filter(record => record.severity === "error").length,
    warnings: records.filter(record => record.severity === "warning").length,
    unknownFailures: records.filter(record => record.finding?.outcome === "FAIL" && record.finding?.cause === "unknown").length,
    contexts: [...new Set(records.map(record => record.source.role || record.source.type))] }; } };
}

export async function attachDiagnostics(browser, run) {
  const collector = diagnosticCollector(run), sessions = [], tasks = new Set();
  const targets = new Map();
  const root = await browser.target().createCDPSession();
  const listen = async (session, info) => {
    targets.set(info.targetId, info);
    const handlers = [];
    const source = () => {
      const url = targets.get(info.targetId)?.url || info.url;
      return { type: info.type, url, targetId: info.targetId,
        role: info.type === "service_worker" ? "extension-worker" : /chrome-extension:\/\/.*\/src\/popup\.html/.test(url) ? "extension-popup" : "page",
        stage: Object.entries(run.result.stages).find(([, state]) => state.execution === "RUNNING")?.[0] || null };
    };
    for (const method of ["Runtime.consoleAPICalled", "Runtime.exceptionThrown", "Log.entryAdded"]) {
      const handler = event => collector.record(diagnosticRecord(source(), method, event));
      session.on(method, handler); handlers.push([method, handler]);
    }
    sessions.push({ session, handlers });
    try {
      await session.send("Runtime.enable");
      await session.send("Log.enable").catch(() => {}); // Not all worker targets expose Log.
    } catch (error) {
      await run.log("diagnostic-attachment-limitation", { source: source(), message: error.message });
    } finally { await session.send("Runtime.runIfWaitingForDebugger").catch(() => {}); }
  };
  const attached = event => {
    const session = root.connection()?.session(event.sessionId);
    if (!session) return;
    const task = listen(session, event.targetInfo).finally(() => tasks.delete(task));
    tasks.add(task);
  };
  root.on("Target.attachedToTarget", attached);
  const changed = event => targets.set(event.targetInfo.targetId, event.targetInfo);
  root.on("Target.targetInfoChanged", changed);
  await root.send("Target.setDiscoverTargets", { discover: true });
  await root.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true,
    filter: [{ type: "page", exclude: false }, { type: "service_worker", exclude: false }, { type: "other", exclude: false }, { exclude: true }] });
  // Explicitly attach existing targets; new targets are observed before resuming.
  for (const target of browser.targets().filter(target => ["page", "service_worker", "other"].includes(target.type()))) {
    const session = await target.createCDPSession();
    await listen(session, { type: target.type(), url: target.url() });
  }
  return { ...collector, async close() {
    root.off("Target.attachedToTarget", attached);
    root.off("Target.targetInfoChanged", changed);
    await root.send("Target.setAutoAttach", { autoAttach: false, waitForDebuggerOnStart: false, flatten: true }).catch(() => {});
    await root.send("Target.setDiscoverTargets", { discover: false }).catch(() => {});
    await Promise.allSettled([...tasks]);
    for (const { session, handlers } of sessions) {
      for (const [event, handler] of handlers) session.off(event, handler);
      await session.detach().catch(() => {});
    }
    await root.detach().catch(() => {});
    await collector.flush();
  } };
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
