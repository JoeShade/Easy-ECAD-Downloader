/*
 * Exercise the private-desktop launch contract without native windows. Real
 * receipts and pipe/process stubs cover isolation verification and cleanup.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import puppeteer from "puppeteer";
import { command } from "./common.js";
import { createPrivateWindow, launchPrivateDesktopBrowser } from "./private_desktop.js";

vi.mock("puppeteer", () => ({ default: { launch: vi.fn(), executablePath: vi.fn(), defaultArgs: vi.fn() } }));
vi.mock("./common.js", () => ({ command: vi.fn() }));

const platform = Object.getOwnPropertyDescriptor(process, "platform");
const directories = [];
let processHandle, browser, receipt, filename;

beforeEach(() => {
  Object.defineProperty(process, "platform", { value: "win32", configurable: true });
  vi.resetAllMocks();
  command.mockResolvedValue({ code: 0, stdout: path.join(os.tmpdir(), "python.exe") });
  puppeteer.executablePath.mockResolvedValue("chrome-for-testing");
  vi.spyOn(fs, "stat").mockResolvedValue({ isFile: () => true });
  puppeteer.defaultArgs.mockImplementation(async options => [`--user-data-dir=${options.userDataDir}`, ...options.args]);
  processHandle = Object.assign(new EventEmitter(), { pid: 123, exitCode: null,
    stdin: Object.assign(new EventEmitter(), { destroyed: false, end: vi.fn() }) });
  browser = { process: () => processHandle };
  puppeteer.launch.mockImplementation(async options => {
    const name = options.args[1];
    filename = options.args[2];
    receipt = { name, phase: "running", chromePid: 456, launcherPid: 123, inputDesktop: "Default" };
    await fs.writeFile(filename, JSON.stringify(receipt));
    return browser;
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  Object.defineProperty(process, "platform", platform);
  for (const directory of directories.splice(0)) await fs.rm(directory, { recursive: true, force: true });
});

async function launch() {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), "qa-private-desktop-test-"));
  directories.push(profile);
  return launchPrivateDesktopBrowser({ profile, timeout: 1000, python: "chosen-python", controlledSignals: true });
}

describe("private desktop launcher", () => {
  it("reports a missing Chrome installation before starting the native helper", async () => {
    fs.stat.mockRejectedValue(Object.assign(new Error("missing executable"), { code: "ENOENT" }));
    await expect(launch()).rejects.toThrow("QA Chrome for Testing executable is missing");
    expect(puppeteer.launch).not.toHaveBeenCalled();
  });

  it("uses headed Chrome and a private pipe through the native helper", async () => {
    const result = await launch();
    expect(result.browser).toBe(browser);
    expect(command).toHaveBeenCalledWith("chosen-python", expect.any(Array), { timeout: 10000 });
    expect(puppeteer.defaultArgs).toHaveBeenCalledWith(expect.objectContaining({ headless: false,
      enableExtensions: true, args: ["--no-startup-window"] }));
    const options = puppeteer.launch.mock.calls[0][0];
    expect(options).toMatchObject({ headless: false, pipe: true, waitForInitialPage: false,
      ignoreDefaultArgs: true, handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false });
    expect(options.args[0]).toBe(path.join(import.meta.dirname, "private_desktop.py"));
    expect(options.args.join(" ")).not.toMatch(/--headless|--remote-debugging-port/);
    result.desktop.requestStop();
    expect(processHandle.stdin.end).toHaveBeenCalledWith("stop\n");
    processHandle.stdin.writableEnded = true;
    result.desktop.requestStop();
    expect(processHandle.stdin.end).toHaveBeenCalledOnce();
  });

  it("rejects an unverified desktop and exposes the connected browser for cleanup", async () => {
    const original = puppeteer.launch.getMockImplementation();
    puppeteer.launch.mockImplementation(async options => {
      const browser = await original(options);
      await fs.writeFile(filename, JSON.stringify({ ...receipt, inputDesktop: receipt.name }));
      return browser;
    });
    await expect(launch()).rejects.toMatchObject({ browser, message: "Private desktop launch could not be verified" });
  });

  it("accepts only a matching receipt confirming the entire job and desktop were closed", async () => {
    const { desktop } = await launch();
    expect(await desktop.verifyExit()).toBe(false);
    const exited = { ...receipt, phase: "exited", processExitConfirmed: true, desktopClosed: true, cleanupErrors: [] };
    for (const changes of [{ name: "another-desktop" }, { chromePid: 999 }, { launcherPid: 999 },
      { processExitConfirmed: false }, { desktopClosed: false },
      { cleanupErrors: ["job still active"] }]) {
      await fs.writeFile(filename, JSON.stringify({ ...exited, ...changes }));
      expect(await desktop.verifyExit()).toBe(false);
    }
    await fs.writeFile(filename, JSON.stringify(exited));
    expect(await desktop.verifyExit()).toBe(true);
    await fs.rm(filename);
    expect(await desktop.verifyExit()).toBe(false);
  });

  it("fails without launching a foreground fallback outside Windows", async () => {
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    await expect(launch()).rejects.toThrow("requires Windows");
    expect(puppeteer.launch).not.toHaveBeenCalled();
  });
});

describe("private desktop window", () => {
  function fixture(state = "minimized") {
    const page = { bringToFront: vi.fn() };
    const session = { send: vi.fn(async method => method === "Target.createTarget" ? { targetId: "product" } :
      method === "Browser.getWindowForTarget" ? { windowId: 12, bounds: { windowState: state } } : {}), detach: vi.fn() };
    const browser = { target: () => ({ createCDPSession: async () => session }),
      waitForTarget: async () => ({ asPage: async () => page }) };
    return { page, session, browser };
  }

  it("creates minimized without focus before restoring within the private desktop", async () => {
    const { browser, page, session } = fixture();
    expect(await createPrivateWindow(browser, 1000)).toMatchObject({ page, window: { initialState: "minimized" } });
    expect(session.send).toHaveBeenNthCalledWith(1, "Target.createTarget", {
      url: "about:blank", newWindow: true, windowState: "minimized", background: true, focus: false });
    expect(session.send).toHaveBeenCalledWith("Browser.setWindowBounds", { windowId: 12, bounds: { windowState: "normal" } });
    expect(page.bringToFront).toHaveBeenCalledOnce();
    expect(session.detach).toHaveBeenCalledOnce();
  });

  it("fails explicitly when Chrome ignores minimized startup", async () => {
    const { browser, page, session } = fixture("normal");
    await expect(createPrivateWindow(browser, 1000)).rejects.toThrow("did not start minimized");
    expect(page.bringToFront).not.toHaveBeenCalled();
    expect(session.detach).toHaveBeenCalledOnce();
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
