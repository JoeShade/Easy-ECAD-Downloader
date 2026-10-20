/*
 * Exercise CDP attachment ownership and evidence-write failure handling with
 * event emitters. Session stubs keep browser lifecycle checks deterministic.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { attachDiagnostics, diagnosticCollector } from "./diagnostics.js";

const temporary = [];
afterEach(async () => {
  for (const root of temporary.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function runFixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "qa-diagnostics-"));
  temporary.push(dir);
  await fs.mkdir(path.join(dir, "browser"));
  return { dir, log: vi.fn(async () => {}), result: { stages: {} } };
}

// Each session can emit buffered Runtime records as soon as Runtime.enable runs,
// matching CDP's startup-event behavior for an already existing target.
function sessionFixture(info, emitStartup = false) {
  const session = new EventEmitter();
  session.detach = vi.fn(async () => {});
  session.send = vi.fn(async method => {
    if (method === "Target.getTargetInfo") return { targetInfo: info };
    if (method === "Runtime.enable" && emitStartup) session.emit("Runtime.exceptionThrown", {
      exceptionDetails: { text: "Buffered startup error" }
    });
  });
  return session;
}

describe("diagnostic lifecycle", () => {
  it("observes an existing target once when auto-attachment already covered it", async () => {
    const run = await runFixture(), info = { targetId: "existing", type: "page", url: "about:blank" };
    const root = sessionFixture({}), automatic = sessionFixture(info, true), manual = sessionFixture(info, true);
    root.connection = () => ({ session: () => automatic });
    root.send = async (method, params) => {
      if (method === "Target.setAutoAttach" && params.autoAttach) root.emit("Target.attachedToTarget", {
        sessionId: "automatic", targetInfo: info
      });
    };
    const browser = { target: () => ({ createCDPSession: async () => root }), targets: () => [{
      type: () => "page", url: () => "about:blank", createCDPSession: async () => manual
    }] };
    const diagnostics = await attachDiagnostics(browser, run);
    await diagnostics.close();
    expect(diagnostics.records).toHaveLength(1);
    expect(manual.detach).toHaveBeenCalledOnce();
    expect(manual.listenerCount("Runtime.exceptionThrown")).toBe(0);
  });

  it("updates an existing target's source URL after navigation", async () => {
    const run = await runFixture(), info = { targetId: "existing", type: "page", url: "about:blank" };
    const root = sessionFixture({}), manual = sessionFixture(info);
    const browser = { target: () => ({ createCDPSession: async () => root }), targets: () => [{
      type: () => "page", url: () => "about:blank", createCDPSession: async () => manual
    }] };
    const diagnostics = await attachDiagnostics(browser, run);
    root.emit("Target.targetInfoChanged", { targetInfo: { ...info, url: "https://example.test/part" } });
    manual.emit("Runtime.exceptionThrown", { exceptionDetails: { text: "Product runtime error" } });
    await diagnostics.close();
    expect(diagnostics.records[0].source).toMatchObject({ targetId: "existing", url: "https://example.test/part" });
  });

  it("persists later records while surfacing an earlier logging failure at flush", async () => {
    const run = await runFixture(), error = new Error("Log write failed");
    run.log.mockRejectedValueOnce(error);
    const collector = diagnosticCollector(run);
    collector.record({ severity: "error", message: "first", source: { type: "page" } });
    collector.record({ severity: "error", message: "second", source: { type: "page" } });
    await expect(collector.flush()).rejects.toBe(error);
    expect(run.log).toHaveBeenCalledTimes(2);
    const saved = JSON.parse(await fs.readFile(path.join(run.dir, "browser/diagnostics.json"), "utf8"));
    expect(saved.records.map(record => record.message)).toEqual(["first", "second"]);
  });
});

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
