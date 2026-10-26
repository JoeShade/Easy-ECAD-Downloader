/*
 * These tests cover SamacSys WRL-only export edge cases. They live separately
 * from the main direct-flow suite to keep both focused files within the
 * repository line-count limit.
 */

import { describe, expect, it, vi } from "vitest";

import {
  createSamacsysFetchImpl,
  createSamacsysPartContext,
  createServiceWorkerChrome,
  loadServiceWorker,
  MOUSER_FOOTPRINT,
  sendRuntimeMessage
} from "./helpers/service_worker_harness.js";

function decodeDataUrl(dataUrl) {
  return Buffer.from(String(dataUrl).split(",")[1] || "", "base64").toString(
    "utf8"
  );
}

describe("service worker SamacSys WRL exports", () => {
  it("keeps Mouser library footprint model references when only a WRL model is present", async () => {
    const { chrome, listeners } = createServiceWorkerChrome({
      storageState: {
        downloadIndividually: false,
        libraryDownloadRoot: "KiCad/Workspace"
      }
    });
    const readZipEntries = vi.fn(async () => [
      {
        name: "STM32C552KEU6/KiCad/QFN50P500X500X60-33N-D.kicad_mod",
        data: new TextEncoder().encode(MOUSER_FOOTPRINT)
      },
      {
        name: "STM32C552KEU6/3D/STM32C552KEU6.wrl",
        data: new TextEncoder().encode("#VRML V2.0")
      }
    ]);
    const fetchImpl = createSamacsysFetchImpl({
      zipStatus: 200
    });

    loadServiceWorker({
      chrome,
      fetchImpl,
      readZipEntries,
      urlApi: {}
    });

    const result = await sendRuntimeMessage(listeners.runtimeMessage[0], {
      type: "EXPORT_PART",
      partContext: createSamacsysPartContext("mouser"),
      options: {
        symbol: false,
        footprint: true,
        model3d: true,
        datasheet: false
      }
    });

    expect(result.response).toEqual({
      ok: true,
      warnings: [],
      downloadCount: 2
    });

    const downloadCalls = chrome.downloads.download.mock.calls.map(
      ([options]) => options
    );
    const footprintCall = downloadCalls.find((options) =>
      options.filename.endsWith("Workspace.pretty/QFN50P500X500X60-33N-D.kicad_mod")
    );
    const footprintContent = decodeDataUrl(footprintCall.url);
    expect(footprintContent).toContain(
      "../Workspace.3dshapes/STM32C552KEU6.wrl"
    );
    expect(footprintContent).not.toContain("STM32C552KEU6.stp");

    const filenames = downloadCalls.map((options) => options.filename);
    expect(filenames).toContain(
      "KiCad/Workspace/Workspace.3dshapes/STM32C552KEU6.wrl"
    );
  });

  it("exports Mouser WRL-only model archives when only 3D output is selected", async () => {
    const { chrome, listeners } = createServiceWorkerChrome({
      storageState: {
        downloadIndividually: true
      }
    });
    const readZipEntries = vi.fn(async () => [
      {
        name: "STM32C552KEU6/3D/STM32C552KEU6.wrl",
        data: new TextEncoder().encode("#VRML V2.0")
      }
    ]);
    const fetchImpl = createSamacsysFetchImpl({
      zipStatus: 200
    });

    loadServiceWorker({
      chrome,
      fetchImpl,
      readZipEntries
    });

    const result = await sendRuntimeMessage(listeners.runtimeMessage[0], {
      type: "EXPORT_PART",
      partContext: createSamacsysPartContext("mouser"),
      options: {
        symbol: false,
        footprint: false,
        model3d: true,
        datasheet: false
      }
    });

    expect(result.response).toEqual({
      ok: true,
      warnings: [],
      downloadCount: 1
    });

    const filenames = chrome.downloads.download.mock.calls.map(
      ([options]) => options.filename
    );
    expect(filenames).toEqual(["STM32C552KEU6.wrl"]);
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
