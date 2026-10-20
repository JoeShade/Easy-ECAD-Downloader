/*
 * Exercise malformed browser payloads and filesystem names independently of
 * Chrome. Other smoke tests cover merged-library ordering and retention.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { accountDownloads, symbolDownloadEvidence } from "./download_accounting.js";

const temporary = [];
afterEach(async () => {
  for (const root of temporary.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

describe("download evidence failure isolation", () => {
  it("retains a malformed data URL as a payload error", () => {
    expect(symbolDownloadEvidence({ filename: "part.kicad_sym", symbolDataUrl: "data:text/plain,%invalid" }))
      .toMatchObject({ payloadError: expect.any(String) });
  });

  it("accounts for remaining files when one symbol payload has malformed percent encoding", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "qa-accounting-"));
    temporary.push(root);
    const symbol = path.join(root, "part.kicad_sym"), model = path.join(root, "part.step");
    await fs.writeFile(symbol, '(kicad_symbol_lib (symbol "part"))');
    await fs.writeFile(model, "geometry");
    const accounting = await accountDownloads([
      { id: 1, filename: symbol, state: "complete", symbolDataUrl: "data:text/plain,%invalid" },
      { id: 2, filename: model, state: "complete", bytesReceived: 8 }
    ], root);
    expect(accounting.events[0].payloadError).toEqual(expect.any(String));
    expect(accounting.assets[1]).toMatchObject({ verified: true, relativePath: "part.step" });
  });

  it("accepts contained filenames beginning with two dots", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "qa-accounting-"));
    temporary.push(root);
    const filename = path.join(root, "..part.step");
    await fs.writeFile(filename, "geometry");
    const accounting = await accountDownloads([{ id: 1, filename, state: "complete", bytesReceived: 8 }], root);
    expect(accounting.assets[0]).toMatchObject({ verified: true, relativePath: "..part.step" });
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
