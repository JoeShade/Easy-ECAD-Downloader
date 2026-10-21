/*
 * Verify the installed extension APIs through a real headed popup on a private
 * Windows desktop. This establishes the environment; run.js owns product QA.
 */
import path from "node:path";
import { atomicJson, createRun, options, redact } from "./common.js";
import { closeBrowser, launchExtension, openPopup, popupState } from "./browser.js";
import { finish, metadata, pythonPreflight } from "./run.js";

const opts = options();
const run = await createRun(opts.out, opts.id, "preflight");
const meta = await metadata(run);
let context, interrupted = false;
const interrupt = () => { interrupted = true; context?.desktop?.requestStop(); };
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, interrupt);
try {
  await run.stage("environment", async () => {
    await pythonPreflight(run, opts, meta);
    if (interrupted) throw new Error("Preflight interrupted by terminal");
    context = await launchExtension(run, opts.timeout, null, true, opts.python);
    if (interrupted) throw new Error("Preflight interrupted by terminal");
    const page = context.page;
    const popup = await openPopup(context, page, opts.timeout);
    await popup.screenshot({ path: path.join(run.dir, "browser/popup.png"), fullPage: true });
    Object.assign(meta, { chrome: await context.browser.version(), extensionId: context.id,
      effectiveSettings: context.settings, browserMode: context.browserMode });
    await atomicJson(path.join(run.dir, "metadata.json"), meta);
    await run.check("environment", "PASS", "Actual extension action popup is available on a private Windows desktop", { dom: await popupState(popup) });
  });
  run.result.execution = "COMPLETED";
} catch (error) {
  run.result.execution = "FAILED";
  await run.log("preflight-error", { message: redact(error.message) });
} finally {
  try { await closeBrowser(context, run); }
  finally { for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.off(signal, interrupt); }
}
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
