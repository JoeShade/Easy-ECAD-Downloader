/*
 * Verify visible input, session-only settings and credential-safe evidence.
 * Placeholder credentials exercise terminal and storage doubles locally.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRun, redact } from "./common.js";
import { provisionSamacsysCredentials, readTerminalLine, withSamacsysCredentials } from "./credentials.js";
import { closeBrowser, safeScreenshot } from "./browser.js";
import { diagnosticCollector, diagnosticRecord } from "./diagnostics.js";
import { loadSettings, resolveSamacsysAuthorizationHeader } from "../../src/core/settings.js";

beforeEach(() => {
  for (const key of ["DEBUG", "NODE_DEBUG", "NODE_DEBUG_NATIVE"]) vi.stubEnv(key, "");
});
afterEach(() => vi.unstubAllEnvs());

// Emit the same keypress events used by readline while observing terminal mode
// and visible output, keeping these tests independent of an interactive console.
function terminal() {
  const input = new EventEmitter();
  Object.assign(input, { isTTY: true, isRaw: false, paused: true,
    setRawMode(value) { this.isRaw = value; }, isPaused() { return this.paused; },
    resume() { this.paused = false; }, pause() { this.paused = true; } });
  let output = "";
  return { input, output: { isTTY: true, write(text) { output += text; } }, text: () => output };
}

function enter(io, value) {
  for (const char of value) io.input.emit("keypress", char, {});
  io.input.emit("keypress", "\r", { name: "return" });
}

function memoryCache(initial = null) {
  let saved = initial;
  return { async read() { return saved ? { ...saved } : null; },
    async write(value) { saved = { ...value }; }, async clear() { saved = null; } };
}

// Resume after each awaited field so synthetic keypresses reach its new listener.
async function login(io, action, cache = memoryCache(), options = {}) {
  const pending = withSamacsysCredentials(true, action, io, cache, options);
  await Promise.resolve();
  enter(io, "qa-user");
  await Promise.resolve();
  enter(io, 'qa-Pass/"123');
  return pending;
}

// Support both callback- and promise-based storage consumers, including the
// production settings loader that consumes values provisioned by the harness.
function storageArea(values) {
  return {
    async get(keys, callback) {
      const result = Array.isArray(keys) ? Object.fromEntries(keys.filter(key => key in values).map(key => [key, values[key]])) :
        Object.fromEntries(Object.entries(keys).map(([key, fallback]) => [key, values[key] ?? fallback]));
      callback?.(result);
      return result;
    },
    async set(data) { Object.assign(values, data); },
    async remove(keys) { for (const key of keys) delete values[key]; },
    async setAccessLevel(options) { expect(options.accessLevel).toBe("TRUSTED_CONTEXTS"); }
  };
}

describe("terminal SamacSys session", () => {
  it("echoes input and restores terminal state after editing Unicode input", async () => {
    const io = terminal();
    const value = readTerminalLine("Username", io);
    expect(io.input.isRaw).toBe(true);
    io.input.emit("keypress", "\u{1f600}", {});
    io.input.emit("keypress", "\b", { name: "backspace" });
    enter(io, "qa-user");
    expect(await value).toBe("qa-user");
    expect(io.text()).toContain("Username: ");
    expect(io.text()).toContain("qa-user\n");
    expect(io.input.isRaw).toBe(false);
    expect(io.input.paused).toBe(true);
    expect(io.input.listenerCount("keypress")).toBe(0);
  });

  it("rejects redirected input and never requests secrets in default mode", async () => {
    const io = terminal();
    io.input.isTTY = false;
    expect(() => readTerminalLine("Username", io)).toThrow("interactive terminal");
    expect(await withSamacsysCredentials(false, value => value, io)).toBeNull();
    expect(io.text()).toBe("");
  });

  it("pauses previously idle stdin so the command can exit, preserving an already flowing stream", async () => {
    for (const flowing of [null, true]) {
      const io = terminal();
      io.input.paused = false;
      io.input.readableFlowing = flowing;
      const pending = readTerminalLine("Username", io);
      enter(io, "qa-user");
      await pending;
      expect(io.input.paused).toBe(flowing !== true);
    }
  });

  it("refuses diagnostic tracing before secrets are entered", async () => {
    const previous = process.env.DEBUG, io = terminal();
    process.env.DEBUG = "puppeteer:*";
    try {
      await expect(withSamacsysCredentials(true, () => {}, io)).rejects.toThrow("Disable Node/Puppeteer debug tracing");
      expect(io.text()).toBe("");
    } finally {
      if (previous === undefined) delete process.env.DEBUG;
      else process.env.DEBUG = previous;
    }
  });

  it("restores a terminal on cancellation and skips the run", async () => {
    const io = terminal();
    let called = false;
    const pending = withSamacsysCredentials(true, () => { called = true; }, io, memoryCache());
    await Promise.resolve();
    io.input.emit("keypress", "\x03", { name: "c", ctrl: true });
    await expect(pending).rejects.toThrow("cancelled");
    expect(called).toBe(false);
    expect(io.input.isRaw).toBe(false);
    expect(io.input.listenerCount("keypress")).toBe(0);
  });

  it("keeps real extension auth in session storage and returns only safe mode evidence", async () => {
    const local = { samacsysFirefoxUsername: "old-placeholder", samacsysFirefoxPassword: "old-password", rememberSamacsysCredentials: true };
    const session = {}, previous = globalThis.chrome;
    globalThis.chrome = { runtime: {}, storage: { local: storageArea(local), session: storageArea(session) } };
    try {
      const credentials = { username: "qa-user", password: "qa-password" };
      const result = await provisionSamacsysCredentials({ evaluate: (fn, arg) => fn(arg) }, credentials);
      expect(result).toEqual({ mode: "samacsys-session", configured: true, persisted: false });
      expect(local).toEqual({ rememberSamacsysCredentials: false });
      const settings = await loadSettings(globalThis.chrome);
      expect(settings.samacsysFirefoxUsername).toBe(credentials.username);
      expect(settings.samacsysFirefoxPassword).toBe(credentials.password);
      expect(resolveSamacsysAuthorizationHeader(settings)).toBe(`Basic ${Buffer.from("qa-user:qa-password").toString("base64")}`);
      expect(await provisionSamacsysCredentials(null, null)).toEqual({ mode: "unauthenticated", configured: false });
    } finally { globalThis.chrome = previous; }
  });

  it("reuses credentials across runs without prompting, including after a run fails", async () => {
    const cache = memoryCache(), first = terminal();
    await expect(login(first, () => { throw new Error("Product navigation failed"); }, cache))
      .rejects.toThrow("Product navigation failed");
    const next = terminal();
    next.input.isTTY = false;
    next.output.isTTY = false;
    let retained;
    await withSamacsysCredentials(true, credentials => {
      retained = credentials;
      expect(credentials).toEqual({ username: "qa-user", password: 'qa-Pass/"123' });
      expect(redact(`echo ${credentials.password}`)).toBe("echo [redacted]");
    }, next, cache);
    expect(next.text()).toBe("Reusing SamacSys credentials from the Windows memory cache.\n");
    expect(retained).toEqual({ username: "", password: "" });
    expect(await cache.read()).toEqual({ username: "qa-user", password: 'qa-Pass/"123' });
    expect(first.text()).toContain("SamacSys username: qa-user");
  });

  it("prompts again after the cache is cleared and never caches cancelled input", async () => {
    const cache = memoryCache({ username: "old-placeholder", password: "old-password" });
    await cache.clear();
    const cancelled = terminal();
    const pending = withSamacsysCredentials(true, () => {}, cancelled, cache);
    await Promise.resolve();
    cancelled.input.emit("keypress", "\x03", { name: "c", ctrl: true });
    await expect(pending).rejects.toThrow("cancelled");
    expect(await cache.read()).toBeNull();
    const next = terminal();
    await login(next, () => {}, cache);
    expect(next.text()).toContain("SamacSys password: ");
    expect(await cache.read()).toEqual({ username: "qa-user", password: 'qa-Pass/"123' });
  });

  it("prompts for the new campaign without reading or clearing the old cache", async () => {
    const cache = memoryCache({ username: "old-placeholder", password: "old-password" });
    const read = vi.spyOn(cache, "read"), clear = vi.spyOn(cache, "clear");
    const cancelled = terminal(), action = vi.fn();
    const pending = withSamacsysCredentials(true, action, cancelled, cache, { prompt: true });
    cancelled.input.emit("keypress", "\x03", { name: "c", ctrl: true });
    await expect(pending).rejects.toThrow("cancelled");
    expect(read).not.toHaveBeenCalled();
    expect(clear).not.toHaveBeenCalled();
    expect(action).not.toHaveBeenCalled();
    expect(await cache.read()).toEqual({ username: "old-placeholder", password: "old-password" });
    const next = terminal();
    await login(next, action, cache, { prompt: true });
    expect(next.text()).toContain("SamacSys username: qa-user");
    expect(await cache.read()).toEqual({ username: "qa-user", password: 'qa-Pass/"123' });
    expect(action).toHaveBeenCalledOnce();
  });

  it("redacts entered values, encoded values and runtime echoes before persistence and disposes references", async () => {
    const io = terminal(), directory = await fs.mkdtemp(path.join(os.tmpdir(), "qa-auth-"));
    let retained;
    try {
      await login(io, async credentials => {
        retained = credentials;
        const run = await createRun(directory, "redaction");
        const message = `echo ${credentials.username} ${credentials.password} ${encodeURIComponent(credentials.password)} ${JSON.stringify(credentials.password)}`;
        run.result.observation = { message };
        await run.log("placeholder-echo", { message });
        await run.save();
        const collector = diagnosticCollector(run);
        collector.record(diagnosticRecord({ type: "service_worker" }, "Runtime.exceptionThrown",
          { exceptionDetails: { text: message } }));
        await collector.flush();
        for (const filename of ["result.json", "execution.log", "browser/diagnostics.json"]) {
          const text = await fs.readFile(path.join(run.dir, filename), "utf8");
          expect(text).not.toContain(credentials.username);
          expect(text).not.toContain(credentials.password);
          expect(text).not.toContain(encodeURIComponent(credentials.password));
          if (filename.endsWith(".json")) expect(() => JSON.parse(text)).not.toThrow();
        }
      });
      expect(retained).toEqual({ username: "", password: "" });
      expect(redact("qa-user")).toBe("qa-user");
      expect(io.text()).toContain("SamacSys username: qa-user\n");
      expect(io.text()).toContain('SamacSys password: qa-Pass/"123\n');
    } finally { await fs.rm(directory, { recursive: true, force: true }); }
  });

  it("sanitizes failures before disposing exact-value protection", async () => {
    const io = terminal();
    await expect(login(io, credentials => { throw new Error(`Failure echo ${credentials.password}`); }))
      .rejects.toThrow("Failure echo [redacted]");
    expect(redact('qa-Pass/"123')).toBe('qa-Pass/"123');
  });

  it("omits screenshots that would save an entered secret as pixels", async () => {
    const io = terminal();
    await login(io, async credentials => {
      let captured = false, check;
      const surface = { evaluate: async () => `Runtime error echo ${credentials.password}`,
        screenshot: async () => { captured = true; } };
      const run = { dir: "unused", check: async (...args) => { check = args; } };
      expect(await safeScreenshot(surface, run, "browser/popup.png", "previews")).toBe(false);
      expect(captured).toBe(false);
      expect(check).toMatchObject(["previews", "REVIEW", expect.any(String), { produced: false }]);
      surface.evaluate = async () => "Ordinary product preview";
      expect(await safeScreenshot(surface, run, "browser/popup.png", "previews")).toBe(true);
      expect(captured).toBe(true);
    });
  });

  it("clears session storage and still closes Chrome if evidence persistence fails", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "qa-auth-cleanup-")), previous = globalThis.chrome;
    let cleared = false, closed = false;
    globalThis.chrome = { storage: { session: { clear: async () => { cleared = true; } } } };
    try {
      await expect(closeBrowser({ profile: directory, worker: { evaluate: fn => fn() },
        browser: { process: () => null, close: async () => { closed = true; } },
        diagnostics: { close: async () => {}, summary: () => ({ count: 0 }) } },
      { result: {}, save: async () => { throw new Error("Disk unavailable"); }, log: async () => {} })).rejects.toThrow("Disk unavailable");
      expect(cleared).toBe(true);
      expect(closed).toBe(true);
      await expect(fs.stat(directory)).rejects.toMatchObject({ code: "ENOENT" });
    } finally { globalThis.chrome = previous; await fs.rm(directory, { recursive: true, force: true }); }
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
