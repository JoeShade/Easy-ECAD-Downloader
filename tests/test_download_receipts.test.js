/*
 * Browser lifecycle races and portable path checks for ID-scoped model receipts.
 * Controlled DownloadItem state is independent of requested filenames.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDownloadApi } from "../src/core/downloads.js";
import { completedModelFilename } from "../src/core/download_receipts.js";
import { createServiceWorkerChrome } from "./helpers/service_worker_harness.js";

// Hold every model in progress until the test publishes its terminal state.
// Blob mode also exposes URL revocation so tests can inspect cleanup ordering.
function setup(blob = false) {
  const h = createServiceWorkerChrome({ downloadBehavior: () => ({ autoComplete: false }) });
  const urlApi = blob ? { createObjectURL: vi.fn(() => "blob:test"), revokeObjectURL: vi.fn() } : {};
  const api = createDownloadApi(h.chrome, urlApi, Blob);
  const write = (filename = "model.wrl", timeoutMs = 100) =>
    api.downloadTextFile(filename, "model", "application/octet-stream", undefined, { waitForCompletion: true, timeoutMs });
  return { ...h, api, write, urlApi };
}

afterEach(() => vi.useRealTimers());

describe("download terminal receipts", () => {
  it.each([false, true])("releases failed starts without installing a receipt waiter (blob=%s)", async blob => {
    const h = setup(blob);
    h.chrome.downloads.download.mockImplementation((_options, callback) => {
      h.chrome.runtime.lastError = { message: "Download blocked." };
      callback();
      h.chrome.runtime.lastError = null;
    });
    await expect(h.write()).rejects.toThrow("Download blocked.");
    expect(h.chrome.downloads.search).not.toHaveBeenCalled();
    expect(h.listeners.downloadsChanged).toHaveLength(1);
    if (blob) expect(h.urlApi.revokeObjectURL).toHaveBeenCalledOnce();
  });

  it.each([false, true])("handles completion before the start callback (blob=%s)", async blob => {
    const h = setup(blob);
    h.chrome.downloads.download.mockImplementation((options, callback) => {
      h.downloadItems.set(12, { id: 12, state: "complete", filename: "C:/Downloads/final.wrl", exists: true });
      h.listeners.downloadsChanged[0]({ id: 12, state: { current: "complete" } });
      callback(12);
    });
    expect(await h.write()).toMatchObject({ downloadId: 12, filename: "C:/Downloads/final.wrl", state: "complete" });
    expect(h.listeners.downloadsChanged).toHaveLength(1);
    if (blob) expect(h.urlApi.revokeObjectURL).toHaveBeenCalledOnce();
  });

  it("requeries an in-flight snapshot after a concurrent filename/completion event", async () => {
    const h = setup();
    const queries = [];
    h.chrome.downloads.search.mockImplementation(({ id }, callback) => {
      const snapshot = { ...h.downloadItems.get(id) };
      queries.push(() => callback([snapshot]));
    });
    const pending = h.write();
    h.changeDownload(1, { state: "complete", filename: "C:/Downloads/new.wrl" });
    queries.shift()();
    expect(queries).toHaveLength(1);
    queries.shift()();
    expect(await pending).toMatchObject({ state: "complete", filename: "C:/Downloads/new.wrl" });
    expect(h.listeners.downloadsChanged).toHaveLength(1);
  });

  it("polls for completion when Chrome emits no terminal event", async () => {
    vi.useFakeTimers();
    const h = setup();
    const pending = h.write("model.wrl", 5000);
    Object.assign(h.downloadItems.get(1), { state: "complete", filename: "C:/Downloads/no-event.wrl" });
    await vi.advanceTimersByTimeAsync(1000);
    expect(await pending).toMatchObject({ state: "complete", filename: "C:/Downloads/no-event.wrl" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ignores out-of-order event contents and uses the queried per-ID state", async () => {
    const h = setup();
    const pending = h.write();
    Object.assign(h.downloadItems.get(1), { state: "complete" });
    for (const listener of [...h.listeners.downloadsChanged]) listener({ id: 1, state: { current: "in_progress" } });
    expect(await pending).toMatchObject({ state: "complete" });
  });

  it("does not associate interleaved downloads with another receipt", async () => {
    const h = setup();
    const first = h.write("one.wrl");
    const second = h.write("two.wrl");
    h.changeDownload(2, { state: "complete", filename: "C:/Downloads/second (1).wrl" });
    h.changeDownload(1, { state: "complete", filename: "C:/Downloads/first.wrl" });
    expect(await first).toMatchObject({ downloadId: 1, requestedFilename: "one.wrl", filename: "C:/Downloads/first.wrl" });
    expect(await second).toMatchObject({ downloadId: 2, requestedFilename: "two.wrl", filename: "C:/Downloads/second (1).wrl" });
    expect(h.listeners.downloadsChanged).toHaveLength(1);
  });

  it.each(["USER_CANCELED", "FILE_FAILED"])("reports terminal %s and releases the Blob", async error => {
    const h = setup(true);
    const pending = h.write();
    expect(h.urlApi.revokeObjectURL).not.toHaveBeenCalled();
    h.changeDownload(1, { state: "interrupted", error });
    expect(await pending).toMatchObject({ state: "interrupted", error });
    expect(h.urlApi.revokeObjectURL).toHaveBeenCalledOnce();
    expect(h.listeners.downloadsChanged).toHaveLength(1);
  });

  it.each(["missing", "query-error", "throws", "hung"])("bounds verification for a %s query", async failure => {
    vi.useFakeTimers();
    const h = setup(true);
    h.chrome.downloads.search.mockImplementation((_query, callback) => {
      if (failure === "hung") return;
      if (failure === "throws") throw new Error("API unavailable");
      if (failure === "query-error") h.chrome.runtime.lastError = { message: "Unavailable" };
      callback([]);
      h.chrome.runtime.lastError = null;
    });
    const pending = h.write();
    await vi.advanceTimersByTimeAsync(101);
    const receipt = await pending;
    expect(receipt.state).toBe("unverified");
    expect(receipt.error).toContain(failure === "hung" ? "timed out" : failure === "missing" ? "missing" : "query failed");
    expect(h.chrome.downloads.cancel).toHaveBeenCalledOnce();
    expect(h.urlApi.revokeObjectURL).toHaveBeenCalledOnce();
    expect(h.listeners.downloadsChanged).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("times out in-progress models without revoking until cancellation succeeds", async () => {
    vi.useFakeTimers();
    const h = setup(true);
    let cancelCallback;
    h.chrome.downloads.cancel.mockImplementation((_id, callback) => { cancelCallback = callback; });
    const pending = h.write();
    await vi.advanceTimersByTimeAsync(101);
    expect(await pending).toMatchObject({ state: "unverified", error: expect.stringContaining("timed out") });
    expect(h.urlApi.revokeObjectURL).not.toHaveBeenCalled();
    cancelCallback();
    expect(h.urlApi.revokeObjectURL).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds missing start callbacks and cancels late starts", async () => {
    vi.useFakeTimers();
    const h = setup(true);
    let callback;
    h.chrome.downloads.download.mockImplementation((_options, cb) => { callback = cb; });
    const pending = h.write().catch(error => error);
    await vi.advanceTimersByTimeAsync(101);
    expect((await pending).message).toContain("callback timed out");
    expect(h.urlApi.revokeObjectURL).not.toHaveBeenCalled();
    h.downloadItems.set(4, { id: 4, state: "in_progress" });
    callback(4);
    expect(h.chrome.downloads.cancel).toHaveBeenCalledWith(4, expect.any(Function));
    expect(h.urlApi.revokeObjectURL).toHaveBeenCalledOnce();
  });

  it("retains the Blob until a terminal event if timeout cancellation fails", async () => {
    vi.useFakeTimers();
    const h = setup(true);
    h.chrome.downloads.cancel.mockImplementation((_id, callback) => {
      h.chrome.runtime.lastError = { message: "Cancellation failed" };
      callback();
      h.chrome.runtime.lastError = null;
    });
    const pending = h.write();
    await vi.advanceTimersByTimeAsync(101);
    expect(await pending).toMatchObject({ state: "unverified" });
    expect(h.urlApi.revokeObjectURL).not.toHaveBeenCalled();
    h.changeDownload(1, { state: "complete" });
    expect(h.urlApi.revokeObjectURL).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps ordinary artifact writes started-only", async () => {
    const h = setup();
    expect(await h.api.downloadBinaryFile("part.step", new Uint8Array([1]), "application/octet-stream")).toBe(1);
    expect(h.downloadItems.get(1).state).toBe("in_progress");
    expect(h.chrome.downloads.search).not.toHaveBeenCalled();
  });

  it("keeps a started Blob alive when its optional cleanup query throws", async () => {
    const h = setup(true);
    h.chrome.downloads.search.mockImplementation(() => { throw new Error("Unavailable"); });
    expect(await h.api.downloadTextFile("part.txt", "part", "text/plain")).toBe(1);
    expect(h.urlApi.revokeObjectURL).not.toHaveBeenCalled();
    h.changeDownload(1, { state: "complete" });
    expect(h.urlApi.revokeObjectURL).toHaveBeenCalledOnce();
  });
});

describe("portable completed-model paths", () => {
  function receipt(filename, initialFilename = filename, requestedFilename = "KiCad/Workspace/Workspace.3dshapes/model.wrl") {
    return { state: "complete", exists: true, filename, initialFilename, requestedFilename };
  }

  it.each([
    "C:\\Downloads\\KiCad\\Workspace\\Workspace.3dshapes\\model (2).wrl",
    "//server/share/Downloads/KiCad/Workspace/Workspace.3dshapes/model (2).wrl",
    "/Downloads/KiCad/Workspace/Workspace.3dshapes/model (2).wrl"
  ])("accepts a renamed basename in an unchanged nested directory: %s", filename => {
    expect(completedModelFilename(receipt(filename))).toBe("model (2).wrl");
  });

  it.each([
    "C:/Elsewhere/model.wrl", "relative/model.wrl", "C:model.wrl",
    "C:/Downloads/../KiCad/Workspace/Workspace.3dshapes/model.wrl",
    "C:/Downloads/NotKiCad/Workspace/Workspace.3dshapes/model.wrl",
    "C:/Downloads/KiCad/Workspace/Workspace.3dshapes/model.step",
    "//server/model.wrl", "C:/Downloads/KiCad/Workspace/Workspace.3dshapes/model.wrl:stream"
  ])("rejects incompatible or unsafe paths: %s", filename => {
    expect(completedModelFilename(receipt(filename))).toBe("");
  });

  it("rejects an observed loose-file directory change", () => {
    expect(completedModelFilename(receipt("D:/Elsewhere/model.wrl", "C:/Downloads/model.wrl", "model.wrl"))).toBe("");
  });

  it("rejects a missing file or interrupted receipt regardless of its name", () => {
    const valid = receipt("C:/Downloads/KiCad/Workspace/Workspace.3dshapes/model.wrl");
    expect(completedModelFilename({ ...valid, exists: false })).toBe("");
    expect(completedModelFilename({ ...valid, state: "interrupted" })).toBe("");
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
