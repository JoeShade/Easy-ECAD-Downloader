/*
 * Runner regressions cover final exit status and durable download evidence when
 * the action popup closes. Browser observations are stubbed; files are real.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRun } from "./common.js";
import { collectDownloads, finish } from "./run.js";
import { downloadItems, popupState, safeScreenshot } from "./browser.js";

vi.mock("./browser.js", async importOriginal => ({
  ...await importOriginal(), downloadItems: vi.fn(), popupState: vi.fn(), safeScreenshot: vi.fn()
}));

const directories = [];
const originalExitCode = process.exitCode;
afterEach(async () => {
  process.exitCode = originalExitCode;
  vi.restoreAllMocks();
  vi.clearAllMocks();
  for (const directory of directories.splice(0)) await fs.rm(directory, { recursive: true, force: true });
});

async function temporaryRun() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "qa-run-test-"));
  directories.push(root);
  return createRun(root, "runner");
}

describe("QA runner failures", () => {
  it("returns a failure exit and records an unclassified execution failure", async () => {
    const run = await temporaryRun();
    run.result.execution = "FAILED";
    vi.spyOn(console, "log").mockImplementation(() => {});
    await finish(run);
    expect(process.exitCode).toBe(1);
    expect(run.result.outcomes).toContain("FAIL");
    const saved = JSON.parse(await fs.readFile(path.join(run.dir, "result.json"), "utf8"));
    expect(saved.failure).toMatchObject({ outcome: "FAIL", category: "harness" });
  });

  it("retains the blocked exit for a failed stage with an explicit blocker", async () => {
    const run = await temporaryRun();
    run.result.execution = "FAILED";
    run.result.stages.environment.execution = "FAILED";
    await run.check("environment", "BLOCKED", "Chrome unavailable");
    vi.spyOn(console, "log").mockImplementation(() => {});
    await finish(run);
    expect(process.exitCode).toBe(2);
    expect(run.result.outcomes).toEqual(["BLOCKED"]);
  });

  it("retains an unclassified failure alongside an unrelated rendering blocker", async () => {
    const run = await temporaryRun();
    run.result.execution = "FAILED";
    run.result.stages.environment.execution = "COMPLETED";
    await run.check("environment", "BLOCKED", "KiCad unavailable; browser checks can proceed");
    run.result.error = "Browser page creation failed between stages";
    vi.spyOn(console, "log").mockImplementation(() => {});
    await finish(run);
    expect(process.exitCode).toBe(1);
    expect(run.result.failure).toMatchObject({ outcome: "FAIL", message: run.result.error });
    expect(run.result.outcomes).toEqual(["BLOCKED", "FAIL"]);
  });

  it("preserves completed assets and accounting after the popup closes", async () => {
    const run = await temporaryRun();
    const downloadRoot = path.join(path.dirname(run.dir), "acquisition");
    await fs.mkdir(downloadRoot);
    const filename = path.join(downloadRoot, "part.step");
    await fs.writeFile(filename, "model bytes");
    const context = { downloadRoot, settings: { downloadIndividually: false, libraryDownloadRoot: "ecad" } };
    const popup = { evaluate: vi.fn().mockResolvedValueOnce([]).mockResolvedValue({ ok: true, downloadCount: 1 }), click: vi.fn() };
    popupState.mockResolvedValueOnce({ downloadDisabled: false }).mockRejectedValue(new Error("Target closed"));
    downloadItems.mockResolvedValue([{ id: 1, filename, state: "complete", bytesReceived: 11 }]);
    safeScreenshot.mockRejectedValue(new Error("Target closed"));
    await collectDownloads(context, popup, run, { "download-timeout": 1000 });
    const saved = JSON.parse(await fs.readFile(path.join(run.dir, "result.json"), "utf8"));
    expect(saved.stages.downloads.assets[0]).toMatchObject({ verified: true, preserved: true });
    expect(saved.stages.downloads.checks).toContainEqual(expect.objectContaining({ name: "download.popupEvidence", outcome: "BLOCKED" }));
    expect(await fs.readFile(path.join(run.dir, "downloads", "part.step"), "utf8")).toBe("model bytes");
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
