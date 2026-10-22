/*
 * Regression fixtures inject browser outcomes at the real runtime boundary.
 * These deterministic cases exercise observed browser filenames and receipt matching.
 */
import { describe, expect, it, vi } from "vitest";
import cases from "./fixtures/issue_17.json";
import { createCadData } from "./helpers/fixtures.js";
import { createServiceWorkerChrome, loadServiceWorker, sendRuntimeMessage } from "./helpers/service_worker_harness.js";

const footprint = `(footprint "Test"
  (pad "1" smd rect (at 0 0) (size 1 1) (layers F.Cu))
  (model "original.wrl"
    (offset (xyz 1 2 3))
    (scale (xyz 1 2 1))
    (rotate (xyz 10 20 30))
  )
)`;

// Drive the real worker with injected browser outcomes while retaining generated
// Blob/data-URL bytes for exact footprint checks. Each run gets separate state.
function setup({ row = cases[0], loose = false, blob = false, behavior, fetchModel, sourceFootprint = footprint } = {}) {
  const harness = createServiceWorkerChrome({
    storageState: { downloadIndividually: loose, libraryDownloadRoot: "KiCad/Workspace" },
    downloadBehavior: behavior
  });
  const blobs = new Map();
  const urlApi = blob ? {
    createObjectURL: vi.fn(value => { const url = `blob:asset-${blobs.size}`; blobs.set(url, value); return url; }),
    revokeObjectURL: vi.fn()
  } : {};
  loadServiceWorker({ chrome: harness.chrome, urlApi,
    convertEasyedaCadToKicad: vi.fn(() => ({ footprint: { name: "Test", content: sourceFootprint } })),
    fetchImpl: vi.fn(async url => String(url).includes("/api/products/")
      ? { ok: true, json: async () => ({ result: createCadData({ lcscId: row.id, modelName: row.name }) }) }
      : fetchModel ? fetchModel(url) : {
        ok: true, arrayBuffer: async () => new TextEncoder().encode("step").buffer, text: async () => "obj"
      })
  });
  const run = () => sendRuntimeMessage(harness.listeners.runtimeMessage[0], {
    type: "EXPORT_PART", partContext: { provider: "easyedaLcsc", lookup: { lcscId: row.id } },
    options: { symbol: false, footprint: true, model3d: true, datasheet: false }
  });
  const content = async () => {
    const [options] = harness.chrome.downloads.download.mock.calls.find(([o]) => o.filename.endsWith(".kicad_mod"));
    return blob ? blobs.get(options.url).text() : Buffer.from(options.url.split(",")[1], "base64").toString("utf8");
  };
  return { ...harness, run, content, urlApi };
}

describe("EasyEDA completed model association", () => {
  for (const loose of [false, true]) for (const blob of [false, true]) for (const renamed of [false, true]) {
    it.each(cases)(`uses delivered $case filename (loose=${loose}, blob=${blob}, renamed=${renamed})`, async row => {
      const name = renamed ? row.delivered : `${row.name}.wrl`;
      const h = setup({ row, loose, blob, behavior: (options, item) => options.filename.endsWith(".wrl")
        ? { filename: item.filename.replace(/[^/]+$/, name) } : {} });
      expect((await h.run()).response).toEqual({ ok: true, warnings: [], downloadCount: 3 });
      const modelPath = loose ? "${KIPRJMOD}/" + name : `../Workspace.3dshapes/${name}`;
      expect(await h.content()).toBe(footprint.replace("original.wrl", modelPath));
    });
  }

  it("uses the new counter-suffixed asset instead of an older model", async () => {
    const h = setup({ behavior: (options, item) => options.filename.endsWith(".wrl")
      ? { filename: item.filename.replace(/\.wrl$/, " (1).wrl") } : {} });
    h.downloadItems.set(900, { id: 900, state: "complete", filename: `C:/Downloads/KiCad/Workspace/Workspace.3dshapes/${cases[0].name}.wrl` });
    await h.run();
    expect(await h.content()).toContain(`${cases[0].name} (1).wrl`);
    expect(h.chrome.downloads.search.mock.calls.every(([query]) => query.id !== 900)).toBe(true);
    expect(h.chrome.downloads.download.mock.calls.every(([options]) => options.conflictAction === "uniquify")).toBe(true);
  });

  for (const blob of [false, true]) {
    it(`falls back to STEP after terminal WRL disk failure (blob=${blob})`, async () => {
      const h = setup({ blob, behavior: options => options.filename.endsWith(".wrl")
        ? { state: "interrupted", error: "FILE_FAILED" } : {} });
      const { response } = await h.run();
      expect(response.ok).toBe(true);
      expect(response.downloadCount).toBe(3);
      expect(response.warnings).toEqual(["3D WRL model unavailable: FILE_FAILED."]);
      expect(await h.content()).toContain(`${cases[0].name}.step`);
      if (blob) expect(h.urlApi.revokeObjectURL).toHaveBeenCalledTimes(3);
    });
  }

  it.each(["STEP", "WRL"])("retains the other format after %s HTTP failure", async failed => {
    const h = setup({ fetchModel: async url => {
      const format = String(url).includes("/3dmodel/") ? "WRL" : "STEP";
      return { ok: format !== failed, status: 503, arrayBuffer: async () => new ArrayBuffer(1), text: async () => "obj" };
    } });
    const { response } = await h.run();
    expect(response.warnings).toEqual([`3D ${failed} model download failed (HTTP 503).`]);
    expect(response.downloadCount).toBe(2);
    expect(await h.content()).toContain(failed === "STEP" ? ".wrl" : ".step");
  });

  it("retains the footprint when both upstream model requests fail", async () => {
    const h = setup({ fetchModel: async () => { throw new Error("Network unavailable."); } });
    const { response } = await h.run();
    expect(response.ok).toBe(true);
    expect(response.downloadCount).toBe(1);
    expect(response.warnings).toHaveLength(2);
    expect(await h.content()).not.toContain("(model");
    expect(await h.content()).toContain('(pad "1"');
  });

  it("strips all stale references when both model writes are interrupted", async () => {
    const h = setup({ behavior: options => /\.(step|wrl)$/.test(options.filename)
      ? { state: "interrupted", error: "USER_CANCELED" } : {},
    sourceFootprint: footprint.slice(0, -1) + '\n(model "another.wrl" (scale (xyz 1 1 1)))\n)' });
    const { response } = await h.run();
    expect(response).toMatchObject({ ok: true, downloadCount: 3 });
    expect(response.warnings).toHaveLength(2);
    expect(await h.content()).not.toContain("(model");
    expect(await h.content()).toContain('(pad "1"');
  });

  it("retains the footprint and reports browser start errors separately", async () => {
    const h = setup();
    const start = h.chrome.downloads.download.getMockImplementation();
    h.chrome.downloads.download.mockImplementation((options, callback) => {
      if (!options.filename.endsWith(".step") && !options.filename.endsWith(".wrl")) return start(options, callback);
      h.chrome.runtime.lastError = { message: "Download failed to start." };
      callback();
      h.chrome.runtime.lastError = null;
    });
    const { response } = await h.run();
    expect(response.downloadCount).toBe(1);
    expect(response.warnings).toEqual([
      "3D STEP model download start failed: Download failed to start.",
      "3D WRL model download start failed: Download failed to start."
    ]);
    expect(await h.content()).not.toContain("(model");
  });

  it("omits references for completed models redirected outside the library", async () => {
    const h = setup({ behavior: (options, item) => /\.(step|wrl)$/.test(options.filename)
      ? { filename: `D:/Elsewhere/${item.filename.split("/").pop()}` } : {} });
    const { response } = await h.run();
    expect(response.downloadCount).toBe(3);
    expect(response.warnings).toHaveLength(2);
    expect(response.warnings.every(w => w.includes("location could not be verified"))).toBe(true);
    expect(await h.content()).not.toContain("(model");
  });

  it("escapes quotes and preserves transforms when the converter path was unquoted", async () => {
    const h = setup({ sourceFootprint: footprint.replace('"original.wrl"', "original.wrl"),
      behavior: (options, item) => options.filename.endsWith(".wrl")
        ? { filename: `/Downloads/KiCad/Workspace/Workspace.3dshapes/model "quoted" (1).wrl` }
        : { filename: item.filename.replace("C:/Downloads", "/Downloads") } });
    // The filename's parent stays the same; quotes are legal in POSIX names.
    h.chrome.downloads.search.mockImplementation(({ id }, callback) => {
      const item = h.downloadItems.get(id);
      callback([{ ...item, filename: item.filename.replace("C:/Downloads", "/Downloads") }]);
    });
    await h.run();
    expect(await h.content()).toBe(footprint.replace("original.wrl", '../Workspace.3dshapes/model \\"quoted\\" (1).wrl'));
  });

  it("keeps the runtime response pending until the model completes", async () => {
    const h = setup({ behavior: options => options.filename.endsWith(".wrl") ? { autoComplete: false } : {} });
    let response;
    const pending = h.run().then(result => { response = result.response; });
    await vi.waitFor(() => expect(h.downloadItems.size).toBe(2));
    expect(response).toBeUndefined();
    expect(h.chrome.downloads.download.mock.calls.some(([o]) => o.filename.endsWith(".kicad_mod"))).toBe(false);
    h.changeDownload(2, { state: "complete", filename: "C:/Downloads/KiCad/Workspace/Workspace.3dshapes/renamed.wrl" });
    await pending;
    expect(response.ok).toBe(true);
    expect(await h.content()).toContain("/renamed.wrl");
  });

  it.each([false, true])("rejects a different WRL root from the completed STEP (loose=%s)", async loose => {
    const h = setup({ loose, behavior: (options, item) => options.filename.endsWith(".wrl")
      ? { filename: item.filename.replace("C:/Downloads", "D:/Other") } : {} });
    // Simulate a redirect already present in the first WRL query as well.
    const search = h.chrome.downloads.search.getMockImplementation();
    h.chrome.downloads.search.mockImplementation((query, callback) => search(query, items => callback(items.map(item => ({
      ...item, filename: item.filename.endsWith(".wrl") ? item.filename.replace("C:/Downloads", "D:/Other") : item.filename
    })))));
    const { response } = await h.run();
    expect(response.warnings).toHaveLength(1);
    expect(await h.content()).toContain(`${cases[0].name}.step`);
  });

  it("preserves the existing first-model-only rewrite behavior", async () => {
    const extra = '\n  (model "second.wrl" (offset (xyz 4 5 6)))';
    const sourceFootprint = footprint.slice(0, -1) + extra + "\n)";
    const h = setup({ sourceFootprint });
    await h.run();
    expect(await h.content()).toBe(sourceFootprint.replace("original.wrl", `../Workspace.3dshapes/${cases[0].name}.wrl`));
  });

  it("falls back after a bounded WRL verification timeout and replies to the popup", async () => {
    vi.useFakeTimers();
    try {
      const h = setup({ behavior: options => options.filename.endsWith(".wrl") ? { autoComplete: false } : {} });
      const pending = h.run();
      await vi.advanceTimersByTimeAsync(1);
      expect(h.downloadItems.size).toBe(2);
      await vi.advanceTimersByTimeAsync(60001);
      const { response } = await pending;
      expect(response.ok).toBe(true);
      expect(response.downloadCount).toBe(3);
      expect(response.warnings).toEqual(["3D WRL model unavailable: Browser download verification timed out."]);
      expect(await h.content()).toContain(`${cases[0].name}.step`);
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it("keeps concurrent runtime exports associated with their own model IDs", async () => {
    const h = setup({ behavior: options => options.filename.endsWith(".wrl") ? { autoComplete: false } : {} });
    const first = h.run();
    const second = h.run();
    await vi.waitFor(() => expect(h.downloadItems.size).toBe(4));
    const wrls = [...h.downloadItems.values()].filter(item => item.filename.endsWith(".wrl"));
    const directory = "C:/Downloads/KiCad/Workspace/Workspace.3dshapes/";
    h.changeDownload(wrls[1].id, { state: "complete", filename: directory + "second.wrl" });
    expect((await second).response.ok).toBe(true);
    h.changeDownload(wrls[0].id, { state: "complete", filename: directory + "first.wrl" });
    expect((await first).response.ok).toBe(true);
    const texts = h.chrome.downloads.download.mock.calls.filter(([o]) => o.filename.endsWith(".kicad_mod"))
      .map(([o]) => Buffer.from(o.url.split(",")[1], "base64").toString("utf8"));
    expect(texts[0]).toContain("/second.wrl");
    expect(texts[1]).toContain("/first.wrl");
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
