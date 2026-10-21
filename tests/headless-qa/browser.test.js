/*
 * Check profile isolation and cleanup using browser stubs. The storage
 * stub reproduces the Windows extension database path limit seen in preflight.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import puppeteer from "puppeteer";
import { closeBrowser, launchExtension, productEvidence } from "./browser.js";
import { accountDownloads } from "./download_accounting.js";
import { preserveDownloads } from "./download_preservation.js";

vi.mock("puppeteer", () => ({ default: { launch: vi.fn(), executablePath: () => "chrome-for-testing" } }));
vi.mock("./private_desktop.js", () => ({
  launchPrivateDesktopBrowser: async ({ profile, ...options }) => {
    const browser = await puppeteer.launch({ ...options, userDataDir: profile });
    return { browser, desktop: { name: "test-desktop", info: { name: "test-desktop" },
      verifyExit: async () => true, requestStop: () => browser.process()?.kill() } };
  },
  createPrivateWindow: async () => ({ page: {}, window: { initialState: "minimized", restoredOnPrivateDesktop: true } })
}));
vi.mock("./diagnostics.js", () => ({ attachDiagnostics: async () => ({
  close: async () => {}, summary: () => ({ count: 0 })
}) }));

const directories = [];
const profiles = [];
const downloadRoots = [];
const extensionId = "a".repeat(32);
const settings = { downloadIndividually: false, libraryDownloadRoot: "easyECADDownloader" };

async function runFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "qa-browser-test-"));
  directories.push(root);
  const dir = path.join(root, "campaign-" + "x".repeat(70), "preflight-" + "y".repeat(60));
  await fs.mkdir(path.join(dir, "downloads"), { recursive: true });
  return { dir, result: {}, save: async () => {}, log: vi.fn(async () => {}), check: vi.fn(async () => {}) };
}

// Model the worker's startup calls and reproduce the Windows database path limit
// before returning the browser lifecycle surface consumed by the harness.
function browserStub(profile) {
  const worker = { evaluate: vi.fn()
    .mockResolvedValueOnce({ openPopup: "function", runtimeId: extensionId, version: "1.0.0" })
    .mockImplementationOnce(async () => {
      const databaseLock = path.join(profile, "Default", "Local Extension Settings", extensionId, "LOCK");
      if (databaseLock.length >= 260) throw new Error("IO error: .../LOCK: File not found.");
      return settings;
    }) };
  return { installExtension: async () => extensionId,
    waitForTarget: async () => ({ worker: async () => worker }),
    version: async () => "Chrome/test", process: () => null, close: vi.fn(async () => {}) };
}

beforeEach(() => vi.clearAllMocks());
afterEach(async () => {
  vi.useRealTimers();
  document.body.innerHTML = "";
  for (const dir of [...profiles.splice(0), ...downloadRoots.splice(0), ...directories.splice(0)]) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

describe("product-page classification", () => {
  it.each(["visibility: hidden", "opacity: 0"])("keeps product evidence when its login dialog uses %s", async style => {
    document.body.innerHTML = `<h1>Product</h1><dl><dt>MPN</dt><dd>ABC-1</dd></dl>
      <div style="${style}"><input type="password"></div>`;
    const password = document.querySelector('input[type="password"]');
    // Visibility and opacity retain layout boxes in Chrome; reproduce that DOM
    // geometry because jsdom itself supplies zero-sized layout rectangles.
    password.getBoundingClientRect = () => ({ width: 200, height: 30 });
    const evidence = await productEvidence({ evaluate: action => action() }, 200);
    expect(evidence).toMatchObject({ classification: "PRODUCT", login: false });
  });

  it("classifies a displayed password form as LOGIN", async () => {
    document.body.innerHTML = '<h1>Sign in</h1><input type="password">';
    document.querySelector("input").getBoundingClientRect = () => ({ width: 200, height: 30 });
    expect(await productEvidence({ evaluate: action => action() }, 200)).toMatchObject({ classification: "LOGIN", login: true });
  });
});

describe("isolated Chrome profiles", () => {
  it("initializes storage for long evidence paths and keeps each run's downloads and profile isolated", async () => {
    const run = await runFixture();
    puppeteer.launch.mockImplementation(async options => {
      profiles.push(options.userDataDir);
      const preferences = JSON.parse(await fs.readFile(path.join(options.userDataDir, "Default", "Preferences"), "utf8"));
      downloadRoots.push(preferences.download.default_directory);
      expect(path.dirname(preferences.download.default_directory)).toBe(os.tmpdir());
      expect(preferences.download.default_directory).not.toContain(run.dir);
      expect(preferences.download).toEqual({ default_directory: expect.any(String),
        prompt_for_download: false, directory_upgrade: true });
      return browserStub(options.userDataDir);
    });
    const first = await launchExtension(run, 1000);
    const second = await launchExtension(run, 1000);
    expect(first.profile).not.toBe(second.profile);
    expect(first.downloadRoot).not.toBe(second.downloadRoot);
    expect(path.relative(run.dir, first.profile).startsWith("..")).toBe(true);
    expect(first.settings).toEqual(settings);
    expect(first.browserMode).toMatchObject({ headless: false, pipe: true,
      desktop: { name: "test-desktop" }, window: { initialState: "minimized" } });
    await closeBrowser(first, run);
    await expect(fs.stat(first.profile)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(first.downloadRoot)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(second.profile)).resolves.toBeDefined();
    await expect(fs.stat(path.join(run.dir, "downloads"))).resolves.toBeDefined();
    await closeBrowser(second, run);
    await expect(fs.stat(second.profile)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("removes only its temporary profile when Chrome fails to launch", async () => {
    const run = await runFixture();
    const evidence = path.join(run.dir, "preserve.txt");
    await fs.writeFile(evidence, "existing evidence");
    puppeteer.launch.mockImplementation(async options => {
      profiles.push(options.userDataDir);
      const preferences = JSON.parse(await fs.readFile(path.join(options.userDataDir, "Default", "Preferences"), "utf8"));
      downloadRoots.push(preferences.download.default_directory);
      throw new Error("Chrome startup failed");
    });
    await expect(launchExtension(run, 1000)).rejects.toThrow("Chrome startup failed");
    await expect(fs.stat(profiles[0])).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(downloadRoots[0])).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readFile(evidence, "utf8")).toBe("existing evidence");
  });

  it("closes Chrome and removes its profile when extension initialization fails", async () => {
    const run = await runFixture();
    let browser;
    puppeteer.launch.mockImplementation(async options => {
      profiles.push(options.userDataDir);
      browser = browserStub(options.userDataDir);
      browser.installExtension = async () => { throw new Error("Extension installation failed"); };
      return browser;
    });
    await expect(launchExtension(run, 1000)).rejects.toThrow("Extension installation failed");
    expect(browser.close).toHaveBeenCalledOnce();
    await expect(fs.stat(profiles[0])).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("retains unpreserved downloads for recovery and removes successfully preserved acquisitions", async () => {
    const run = await runFixture();
    puppeteer.launch.mockImplementation(async options => {
      profiles.push(options.userDataDir);
      return browserStub(options.userDataDir);
    });
    const retained = await launchExtension(run, 1000);
    downloadRoots.push(retained.downloadRoot);
    await fs.writeFile(path.join(retained.downloadRoot, "original.step"), "original model");
    await closeBrowser(retained, run);
    expect(await fs.readFile(path.join(retained.downloadRoot, "original.step"), "utf8")).toBe("original model");
    expect(run.log).toHaveBeenCalledWith("browser-download-directory-retained", expect.objectContaining({ downloadRoot: retained.downloadRoot }));
    const preserved = await launchExtension(run, 1000);
    downloadRoots.push(preserved.downloadRoot);
    const filename = path.join(preserved.downloadRoot, "original.step");
    await fs.writeFile(filename, "preserved model");
    const accounting = await preserveDownloads(await accountDownloads([{ id: 1, filename, state: "complete" }], preserved.downloadRoot),
      preserved.downloadRoot, path.join(run.dir, "downloads"));
    run.result.stages = { downloads: accounting };
    preserved.downloadsPreserved = true;
    await closeBrowser(preserved, run);
    await expect(fs.stat(preserved.downloadRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("retains a late acquisition even when the earlier preservation snapshot was complete", async () => {
    const run = await runFixture();
    puppeteer.launch.mockImplementation(async options => {
      profiles.push(options.userDataDir);
      return browserStub(options.userDataDir);
    });
    const context = await launchExtension(run, 1000);
    downloadRoots.push(context.downloadRoot);
    context.downloadsPreserved = true;
    run.result.stages = { downloads: { assets: [] } };
    await fs.writeFile(path.join(context.downloadRoot, "late.step"), "late geometry");
    await closeBrowser(context, run);
    expect(await fs.readFile(path.join(context.downloadRoot, "late.step"), "utf8")).toBe("late geometry");
    expect(run.log).toHaveBeenCalledWith("browser-download-directory-retained", expect.objectContaining({
      inventory: expect.objectContaining({ cleanupSafe: false, unpreservedPaths: ["late.step"] })
    }));
    expect(run.check).toHaveBeenCalledWith("downloads", "BLOCKED", expect.any(String),
      expect.objectContaining({ cause: "download preservation" }));
  });

  it("waits for process exit after a failed close before deleting the profile", async () => {
    const run = await runFixture(), processHandle = new EventEmitter();
    processHandle.spawnargs = ["chrome-for-testing"];
    processHandle.exitCode = null;
    processHandle.signalCode = null;
    processHandle.kill = vi.fn();
    puppeteer.launch.mockImplementation(async options => {
      profiles.push(options.userDataDir);
      const browser = browserStub(options.userDataDir);
      browser.process = () => processHandle;
      browser.close = async () => { throw new Error("Close failed"); };
      return browser;
    });
    const context = await launchExtension(run, 1000);
    downloadRoots.push(context.downloadRoot);
    const closing = closeBrowser(context, run);
    await vi.waitFor(() => expect(processHandle.kill).toHaveBeenCalledOnce());
    await expect(fs.stat(context.profile)).resolves.toBeDefined();
    processHandle.exitCode = 1;
    processHandle.emit("exit", 1, null);
    await closing;
    await expect(fs.stat(context.profile)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("retains temporary directories when Chrome process exit stays unconfirmed", async () => {
    const run = await runFixture(), processHandle = new EventEmitter();
    Object.assign(processHandle, { spawnargs: ["chrome-for-testing"], exitCode: null, signalCode: null, kill: vi.fn() });
    puppeteer.launch.mockImplementation(async options => {
      profiles.push(options.userDataDir);
      const browser = browserStub(options.userDataDir);
      browser.process = () => processHandle;
      browser.close = async () => { throw new Error("Close failed"); };
      return browser;
    });
    const context = await launchExtension(run, 1000);
    downloadRoots.push(context.downloadRoot);
    vi.useFakeTimers();
    const closing = closeBrowser(context, run);
    await vi.advanceTimersByTimeAsync(10000);
    await closing;
    vi.useRealTimers();
    await expect(fs.stat(context.profile)).resolves.toBeDefined();
    await expect(fs.stat(context.downloadRoot)).resolves.toBeDefined();
    expect(run.check).toHaveBeenCalledWith("environment", "BLOCKED", expect.any(String),
      expect.objectContaining({ cause: "browser cleanup" }));
    expect(processHandle.listenerCount("exit")).toBe(0);
  });

  it("requires the native process-tree receipt even after the launcher exits", async () => {
    const run = await runFixture();
    puppeteer.launch.mockImplementation(async options => {
      profiles.push(options.userDataDir);
      return browserStub(options.userDataDir);
    });
    const context = await launchExtension(run, 1000);
    downloadRoots.push(context.downloadRoot);
    context.desktop.verifyExit = async () => false;
    await closeBrowser(context, run);
    await expect(fs.stat(context.profile)).resolves.toBeDefined();
    await expect(fs.stat(context.downloadRoot)).resolves.toBeDefined();
    expect(run.check).toHaveBeenCalledWith("environment", "BLOCKED", expect.any(String),
      expect.objectContaining({ cause: "browser cleanup" }));
  });

  it("retains startup directories when native launch cleanup cannot be confirmed", async () => {
    const run = await runFixture();
    puppeteer.launch.mockImplementation(async options => {
      profiles.push(options.userDataDir);
      const preferences = JSON.parse(await fs.readFile(path.join(options.userDataDir, "Default/Preferences"), "utf8"));
      downloadRoots.push(preferences.download.default_directory);
      throw Object.assign(new Error("Private launch failed"), { desktop: { verifyExit: async () => false } });
    });
    await expect(launchExtension(run, 1000)).rejects.toThrow("Private launch failed");
    await expect(fs.stat(profiles[0])).resolves.toBeDefined();
    await expect(fs.stat(downloadRoots[0])).resolves.toBeDefined();
    expect(run.log).toHaveBeenCalledWith("browser-cleanup-retained", expect.any(Object));
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
