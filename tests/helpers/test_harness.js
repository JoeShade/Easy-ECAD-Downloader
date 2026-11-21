/*
 * Shared test utilities read repository files and import fresh copies of
 * browser modules after each test installs its own browser globals.
 */

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");

export function readRepoFile(relativePath) {
  return fs.readFileSync(path.join(REPO_ROOT, relativePath), "utf8");
}

let moduleImportNonce = 0;

// A distinct URL bypasses ESM's module cache so each test binds fresh browser
// globals. Shared imported dependencies retain their own ordinary module cache.
export async function importRepoModule(relativePath) {
  const moduleUrl = pathToFileURL(path.join(REPO_ROOT, relativePath));
  moduleUrl.searchParams.set("t", String(moduleImportNonce++));
  return import(moduleUrl.href);
}

export function normalizeNewlines(text) {
  return String(text).replace(/\r\n/g, "\n");
}

export async function flushAsyncWork() {
  await Promise.resolve();
  await Promise.resolve();
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
