/*
 * Deterministic harness checks for evidence durability, download accounting,
 * exclusive run isolation and bounded polling. No live services are contacted.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { accountDownloads, atomicJson, createRun, issue, poll, redact } from "./common.js";

const temporary = [];
async function tempDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "headless-qa-"));
  temporary.push(dir);
  return dir;
}
afterEach(async () => {
  for (const dir of temporary.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

describe("headless QA evidence", () => {
  it("writes atomic JSON without leftover temporary files", async () => {
    const dir = await tempDir();
    const filename = path.join(dir, "result.json");
    await atomicJson(filename, { value: 1 });
    await atomicJson(filename, { value: 2 });
    expect(JSON.parse(await fs.readFile(filename, "utf8"))).toEqual({ value: 2 });
    expect(await fs.readdir(dir)).toEqual(["result.json"]);
  });
  it("rejects reused IDs and path traversal while isolating downloads", async () => {
    const root = await tempDir();
    const first = await createRun(root, "first");
    const second = await createRun(root, "second");
    await fs.writeFile(path.join(first.dir, "downloads", "one.step"), "first");
    expect(await fs.readdir(path.join(second.dir, "downloads"))).toEqual([]);
    await expect(createRun(root, "first")).rejects.toMatchObject({ code: "EEXIST" });
    await expect(createRun(root, "../escape")).rejects.toThrow("Invalid run ID");
  });
  it("persists failed checks without inventing completed downstream stages", async () => {
    const run = await createRun(await tempDir(), "states");
    await run.stage("navigation", () => run.check("navigation", "FAIL", "Reference mismatch"));
    expect(run.result.stages.navigation.execution).toBe("COMPLETED");
    await expect(run.stage("popup", async () => { throw issue("Popup blocked"); })).rejects.toThrow("Popup blocked");
    const saved = JSON.parse(await fs.readFile(path.join(run.dir, "result.json"), "utf8"));
    expect(saved.stages.popup.execution).toBe("FAILED");
    expect(saved.stages.downloads.execution).toBe("NOT_RUN");
    expect(saved.stages.popup.checks[0].outcome).toBe("BLOCKED");
  });
  it("requires terminal completion, existence, size and run containment", async () => {
    const root = await tempDir();
    const dir = path.join(root, "downloads");
    await fs.mkdir(dir);
    await fs.writeFile(path.join(dir, "good.step"), "model");
    await fs.writeFile(path.join(dir, "empty.step"), "");
    await fs.writeFile(path.join(root, "outside.step"), "model");
    const rows = await accountDownloads([
      { id: 1, filename: path.join(dir, "good.step"), state: "complete" },
      { id: 2, filename: path.join(dir, "pending.step"), state: "in_progress" },
      { id: 3, filename: path.join(dir, "empty.step"), state: "complete" },
      { id: 4, filename: path.join(dir, "missing.step"), state: "complete" },
      { id: 5, filename: path.join(root, "outside.step"), state: "complete" },
      { id: 6, filename: path.join(dir, "interrupted.step"), state: "interrupted", error: "NETWORK_FAILED" }
    ], dir);
    expect(rows.map(row => row.verified)).toEqual([true, false, false, false, false, false]);
    expect(rows[4].relativePath).toBeNull();
    expect(rows[5].error).toBe("NETWORK_FAILED");
    const duplicate = await accountDownloads([
      { id: 7, filename: path.join(dir, "good.step"), state: "complete", bytesReceived: 5 },
      { id: 8, filename: path.join(dir, "good.step"), state: "complete", bytesReceived: 50 }
    ], dir);
    expect(duplicate.every(row => row.duplicatePath && !row.verified)).toBe(true);
    const wrongSize = await accountDownloads([
      { id: 9, filename: path.join(dir, "good.step"), state: "complete", bytesReceived: 50 }
    ], dir);
    expect(wrongSize[0].verified).toBe(false);
  });
  it("terminates a bounded poll and retains the last observation", async () => {
    await expect(poll(async () => ({ pending: true }), () => false, 15, 2))
      .rejects.toMatchObject({ outcome: "BLOCKED", last: { pending: true } });
    let count = 0;
    expect(await poll(async () => ++count, value => value === 2, 200, 1)).toBe(2);
    await expect(poll(() => new Promise(() => {}), () => true, 15)).rejects.toThrow("Timed out");
  });
  it("omits common credentials and image data from diagnostic text", () => {
    expect(redact("Bearer placeholder_token https://example.test/?token=placeholder data:image/png;base64,abc user@example.test"))
      .not.toMatch(/placeholder|base64|user@/);
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
