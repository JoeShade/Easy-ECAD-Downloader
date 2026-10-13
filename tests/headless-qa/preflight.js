/*
 * Verify the installed extension APIs by opening an actual headless popup on
 * a blank tab. This is environment evidence, never live product validation.
 */
import path from "node:path";
import { atomicJson, createRun, options, redact } from "./common.js";
import { closeBrowser, launchExtension, openPopup, popupState } from "./browser.js";
import { finish, metadata, pythonPreflight } from "./run.js";

const opts = options();
const run = await createRun(opts.out, opts.id, "preflight");
const meta = await metadata(run);
let context;
try {
  await run.stage("environment", async () => {
    await pythonPreflight(run, opts, meta);
    context = await launchExtension(run, opts.timeout);
    const page = await context.browser.newPage();
    const popup = await openPopup(context, page, opts.timeout);
    await popup.screenshot({ path: path.join(run.dir, "browser/popup.png"), fullPage: true });
    Object.assign(meta, { chrome: await context.browser.version(), extensionId: context.id, effectiveSettings: context.settings });
    await atomicJson(path.join(run.dir, "metadata.json"), meta);
    await run.check("environment", "PASS", "Actual extension action popup is available headlessly", { dom: await popupState(popup) });
  });
  run.result.execution = "COMPLETED";
} catch (error) {
  run.result.execution = "FAILED";
  await run.log("preflight-error", { message: redact(error.message) });
} finally { await closeBrowser(context, run); }
await finish(run);

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
