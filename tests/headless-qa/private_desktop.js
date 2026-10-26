/*
 * Launch headed Chrome on a private Windows desktop through a small native
 * helper. Puppeteer retains its debugging pipe and process-lifecycle ownership;
 * an exit receipt additionally verifies the helper's complete Chrome job.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import puppeteer from "puppeteer";
import { command } from "./common.js";

// Bind cleanup permission to the unique desktop name and, after startup, the
// exact native process IDs. A missing or incomplete receipt retains recovery data.
function desktopLifecycle(name, filename) {
  return {
    name, filename, process: null, info: null,
    requestStop() {
      const child = this.process;
      if (child && child.exitCode == null && !child.stdin?.destroyed && !child.stdin?.writableEnded) child.stdin?.end("stop\n");
    },
    async verifyExit() {
      const value = await fs.readFile(filename, "utf8").then(JSON.parse).catch(() => null);
      return Boolean(value?.name === name && ["exited", "failed"].includes(value.phase) &&
        value.processExitConfirmed === true && value.desktopClosed === true &&
        (!this.info || (value.chromePid === this.info.chromePid && value.launcherPid === this.info.launcherPid)) &&
        Array.isArray(value.cleanupErrors) && value.cleanupErrors.length === 0);
    }
  };
}

// The helper receives only public launch arguments. Credential entry stays in
// the original Node terminal; Chrome communicates through inherited private pipes.
export async function launchPrivateDesktopBrowser({ profile, timeout, controlledSignals = false, python = "python" }) {
  if (process.platform !== "win32") throw new Error("Private-desktop browser QA requires Windows");
  const interpreter = await command(python, ["-c", "import sys; print(sys.executable)"], { timeout: 10000 });
  const executable = interpreter.stdout.trim();
  if (interpreter.code !== 0 || !path.isAbsolute(executable)) throw new Error("QA Python executable is unavailable");
  const chrome = await puppeteer.executablePath();
  if (!await fs.stat(chrome).then(value => value.isFile()).catch(() => false)) {
    throw new Error("QA Chrome for Testing executable is missing; run npx.cmd puppeteer browsers install chrome");
  }
  const name = `EasyEcadQa-${randomUUID().replaceAll("-", "")}`;
  const desktop = desktopLifecycle(name, path.join(profile, "private-desktop.json"));
  let browser;
  try {
    const chromeArgs = await puppeteer.defaultArgs({ headless: false, enableExtensions: true,
      userDataDir: profile, args: ["--no-startup-window"] });
    browser = await puppeteer.launch({ executablePath: executable, ignoreDefaultArgs: true,
      args: [path.join(import.meta.dirname, "private_desktop.py"), name, desktop.filename, chrome, ...chromeArgs],
      headless: false, pipe: true, enableExtensions: true, waitForInitialPage: false,
      handleSIGINT: !controlledSignals, handleSIGTERM: !controlledSignals, handleSIGHUP: !controlledSignals,
      userDataDir: profile, timeout, protocolTimeout: Math.max(timeout, 180000),
      defaultViewport: { width: 1280, height: 900 } });
    desktop.process = browser.process();
    desktop.process.stdin.on("error", () => {}); // A completed launcher can close the stop channel first.
    const status = JSON.parse(await fs.readFile(desktop.filename, "utf8"));
    if (status.name !== name || status.phase !== "running" || status.inputDesktop === name ||
        typeof status.inputDesktop !== "string" || !Number.isInteger(status.chromePid) ||
        status.launcherPid !== desktop.process.pid) throw new Error("Private desktop launch could not be verified");
    desktop.info = { name, inputDesktop: status.inputDesktop, chromePid: status.chromePid,
      launcherPid: status.launcherPid, headless: false, pipe: true, executable: chrome };
    return { browser, desktop };
  } catch (error) {
    // Returning the connected browser lets the normal cleanup path close it and
    // await the launcher. A failed launch retains its profile until an exit receipt.
    error.browser = browser;
    error.desktop = desktop;
    const status = await fs.readFile(desktop.filename, "utf8").then(JSON.parse).catch(() => null);
    if (status?.error) error.message += `; private desktop launcher: ${status.error}`;
    throw error;
  }
}

// Create the first window minimized on the verified private desktop.
// Restore only inside the private desktop so native popup and surface rendering
// use an active compositor capable of reliable screenshots.
export async function createPrivateWindow(browser, timeout) {
  const session = await browser.target().createCDPSession();
  let windowFailure, result;
  try {
    const target = await session.send("Target.createTarget", { url: "about:blank", newWindow: true,
      windowState: "minimized", background: true, focus: false });
    const initial = await session.send("Browser.getWindowForTarget", { targetId: target.targetId });
    if (initial.bounds.windowState !== "minimized") throw new Error("QA window did not start minimized");
    const page = await (await browser.waitForTarget(target => target.type() === "page" &&
      target.url() === "about:blank", { timeout })).asPage();
    await session.send("Browser.setWindowBounds", { windowId: initial.windowId, bounds: { windowState: "normal" } });
    await page.bringToFront();
    result = { page, window: { id: initial.windowId, initialState: "minimized", restoredOnPrivateDesktop: true } };
  } catch (error) { windowFailure = error; }
  // Browser shutdown can dispose the session during a failed window command.
  // Preserve that first failure; surface cleanup errors after successful setup.
  try { await session.detach(); }
  catch (error) { windowFailure ||= error; }
  if (windowFailure) throw windowFailure;
  return result;
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
