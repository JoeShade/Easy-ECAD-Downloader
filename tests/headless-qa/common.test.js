/*
 * Exercise evidence persistence and repository output boundaries using temporary
 * files. Concurrent saves reproduce asynchronous diagnostic and stage updates.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { atomicJson, createRun, repoRoot } from "./common.js";

const temporary = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(temporary.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

async function tempDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "qa-persistence-"));
  temporary.push(dir);
  return dir;
}

describe("harness persistence", () => {
  it("serializes simultaneous snapshots and leaves the latest complete value", async () => {
    const dir = await tempDir(), filename = path.join(dir, "result.json");
    const state = { sequence: 0 };
    const writes = [];
    for (let sequence = 0; sequence < 12; sequence++) {
      state.sequence = sequence;
      writes.push(atomicJson(filename, state));
    }
    const results = await Promise.allSettled(writes);
    expect(results.every(result => result.status === "fulfilled")).toBe(true);
    expect(JSON.parse(await fs.readFile(filename, "utf8"))).toEqual({ sequence: 11 });
    expect(await fs.readdir(dir)).toEqual(["result.json"]);
  });

  it("removes a failed save's temporary file and permits a later save", async () => {
    const dir = await tempDir(), filename = path.join(dir, "result.json");
    vi.spyOn(fs, "rename").mockRejectedValueOnce(new Error("Rename unavailable"));
    await expect(atomicJson(filename, { sequence: 1 })).rejects.toThrow("Rename unavailable");
    expect(await fs.readdir(dir)).toEqual([]);
    await atomicJson(filename, { sequence: 2 });
    expect(JSON.parse(await fs.readFile(filename, "utf8"))).toEqual({ sequence: 2 });
  });

  it.each(["qa-unignored", "..qa-unignored"])("requires ignored output for the repository child %s", async prefix => {
    const out = path.join(repoRoot, `${prefix}-${process.pid}`);
    // Guard observation keeps a rejection test from creating any output tree.
    const mkdir = vi.spyOn(fs, "mkdir").mockRejectedValue(new Error("Unexpected directory creation"));
    await expect(createRun(out, "probe")).rejects.toThrow("Output inside repository must be gitignored");
    expect(mkdir).not.toHaveBeenCalled();
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
