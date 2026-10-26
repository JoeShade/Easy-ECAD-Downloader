/*
 * Verify that credential setup waits for the dedicated console and forwards
 * only public launch arguments and completion status to the parent harness.
 */
import path from "node:path";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openCredentialTerminal } from "./auth_terminal.js";

const spawn = vi.fn();
const platform = Object.getOwnPropertyDescriptor(process, "platform");
let child;
const open = options => openCredentialTerminal({ ...options, spawnProcess: spawn });

beforeEach(() => {
  Object.defineProperty(process, "platform", { value: "win32", configurable: true });
  vi.stubEnv("SystemRoot", "C:\\Windows");
  for (const key of ["DEBUG", "NODE_DEBUG", "NODE_DEBUG_NATIVE"]) vi.stubEnv(key, "");
  child = Object.assign(new EventEmitter(), {
    stdin: Object.assign(new EventEmitter(), { destroyed: false, writableEnded: false, end: vi.fn() }),
    stdout: Object.assign(new EventEmitter(), { resume: vi.fn() }),
    stderr: Object.assign(new EventEmitter(), { resume: vi.fn() }), kill: vi.fn()
  });
  spawn.mockReturnValue(child);
});

afterEach(() => {
  Object.defineProperty(process, "platform", platform);
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe("credential terminal startup", () => {
  it("waits for successful console completion without capturing entered output", async () => {
    let completed = false;
    const pending = open().then(() => { completed = true; });
    await Promise.resolve();
    expect(completed).toBe(false);
    const [executable, args, options] = spawn.mock.calls[0];
    expect(executable).toContain("powershell.exe");
    expect(args).toContain(path.join(import.meta.dirname, "auth_terminal.ps1"));
    expect(args).toContain(process.execPath);
    expect(args).toContain(path.join(import.meta.dirname, "auth.js"));
    expect(options).toEqual({ windowsHide: true, shell: false, stdio: ["pipe", "pipe", "pipe"] });
    expect(child.stdout.listenerCount("data")).toBe(0);
    expect(child.stderr.listenerCount("data")).toBe(0);
    expect(child.stdout.resume).toHaveBeenCalledOnce();
    child.emit("close", 0);
    await pending;
    expect(completed).toBe(true);
  });

  it.each([1, 130, null])("blocks matrix startup when the console exits with %s", async code => {
    const pending = open();
    child.emit("close", code);
    await expect(pending).rejects.toThrow("matrix startup must stop");
  });

  it("signals cancellation through the owned console control pipe", async () => {
    const listeners = process.listeners("SIGINT");
    const before = listeners.length;
    const pending = open();
    process.listeners("SIGINT").find(listener => !listeners.includes(listener))();
    expect(child.stdin.end).toHaveBeenCalledWith("stop\n");
    child.emit("close", 1);
    await expect(pending).rejects.toThrow("cancelled");
    expect(process.listenerCount("SIGINT")).toBe(before);
  });

  it("times out without treating the user's silence as successful entry", async () => {
    vi.useFakeTimers();
    const pending = open({ timeout: 1000 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(child.stdin.end).toHaveBeenCalledWith("stop\n");
    child.emit("close", 1);
    await expect(pending).rejects.toThrow("timed out");
  });

  it("refuses debug tracing before opening any credential window", () => {
    vi.stubEnv("DEBUG", "puppeteer:*");
    expect(() => open()).toThrow("Disable Node/Puppeteer debug tracing");
    expect(spawn).not.toHaveBeenCalled();
  });

  it("reports launch errors without forwarding arbitrary helper error text", async () => {
    const pending = open();
    child.emit("error", new Error("untrusted helper output"));
    child.emit("close", -1);
    await expect(pending).rejects.toThrow("could not be opened");
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
