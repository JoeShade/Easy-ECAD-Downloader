/*
 * Populate or clear the Windows memory-only SamacSys cache independently of
 * product navigation. Terminal input remains visible at the user's request.
 */
import { parseArgs } from "node:util";
import { windowsCredentialCache } from "./credential_cache.js";
import { withSamacsysCredentials } from "./credentials.js";
import { redact } from "./common.js";

async function main() {
  const { values } = parseArgs({ options: { clear: { type: "boolean", default: false } } });
  if (values.clear) {
    await windowsCredentialCache().clear();
    console.log("SamacSys memory cache cleared. The next authenticated QA run will prompt again.");
  } else {
    await withSamacsysCredentials(true, () => console.log("SamacSys QA credentials are ready for reuse."));
  }
}

main().catch(error => { console.error(redact(error.message)); process.exitCode = 1; });

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
