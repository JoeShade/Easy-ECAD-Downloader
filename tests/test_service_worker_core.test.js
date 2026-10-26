/*
 * These tests cover service-worker settings, download wrappers, and SamacSys
 * archive helper behavior.
 */

import { describe, expect, it } from "vitest";

import { createSymbolLibrary } from "./helpers/fixtures.js";
import {
  buildLibraryPaths,
  loadSettings,
  normalizeLibraryDownloadRoot,
  parseLibraryDownloadRoot,
  parseSamacsysProxyAuthorizationHeader,
  parseSamacsysFirefoxProxyBaseUrl
} from "../src/core/settings.js";
import {
  extractSymbolBlock,
  mergeSymbolIntoLibrary
} from "../src/core/library_store.js";
import { createDownloadApi } from "../src/core/downloads.js";
import {
  extractSamacsysKiCadAssets,
  parseSamacsysPageMetadata,
  rewriteSamacsysFootprintModelPath,
  rewriteSamacsysSymbolFootprintReference,
  stripKicadFootprintModels
} from "../src/sources/samacsys_common.js";
import {
  createSamacsysPartHtml,
  createServiceWorkerChrome,
  MOUSER_FOOTPRINT,
  MOUSER_SYMBOL
} from "./helpers/service_worker_harness.js";

describe("service worker core helpers", () => {
  it.each([
    ...'<>:"|?*', "\u0000", "\t", "\n", "\u001f", "\u007f"
  ])("rejects a library folder containing invalid character %j", character => {
    expect(parseLibraryDownloadRoot(`KiCad/Part${character}Folder`)).toEqual({
      value: "easyECADDownloader", isValid: false
    });
  });

  it("rejects control characters at the edges before trimming the folder", () => {
    expect(parseLibraryDownloadRoot("\nKiCad/Parts\t")).toEqual({
      value: "easyECADDownloader", isValid: false
    });
  });

  it.each([
    ["  KiCad\\\\Workspace//Parts  ", "KiCad/Workspace/Parts"],
    ["KiCad/Parts (revision 2)", "KiCad/Parts (revision 2)"],
    ["KiCad/Prüfung_2026-10", "KiCad/Prüfung_2026-10"]
  ])("retains a portable nested library path: %s", (input, normalized) => {
    expect(parseLibraryDownloadRoot(input)).toEqual({ value: normalized, isValid: true });
  });

  it("normalizes library roots and builds KiCad library paths", () => {
    expect(normalizeLibraryDownloadRoot("KiCad\\Workspace")).toBe("KiCad/Workspace");
    expect(normalizeLibraryDownloadRoot("../outside")).toBe("easyECADDownloader");
    expect(parseSamacsysFirefoxProxyBaseUrl(" https://proxy.example.test/relay#frag ")).toEqual({
      value: "https://proxy.example.test/relay",
      isValid: true
    });
    expect(parseSamacsysFirefoxProxyBaseUrl("not-a-url")).toEqual({
      value: "",
      isValid: false
    });
    expect(
      parseSamacsysProxyAuthorizationHeader(" Authorization: Bearer relay123 ")
    ).toBe("Bearer relay123");
    expect(buildLibraryPaths("KiCad/Workspace")).toEqual({
      symbolFile: "KiCad/Workspace/Workspace.kicad_sym",
      footprintDir: "KiCad/Workspace/Workspace.pretty",
      modelDir: "KiCad/Workspace/Workspace.3dshapes",
      datasheetDir: "KiCad/Workspace/datasheets"
    });
  });

  it("loads the optional Firefox SamacSys proxy setting from storage", async () => {
    const { chrome } = createServiceWorkerChrome({
      storageState: {
        samacsysFirefoxProxyBaseUrl: "https://proxy.example.test/relay",
        samacsysFirefoxProxyAuthorizationHeader: "Authorization: Bearer proxy123",
        rememberSamacsysFirefoxProxyAuthorizationHeader: true
      }
    });

    await expect(loadSettings(chrome)).resolves.toEqual({
      downloadIndividually: false,
      libraryDownloadRoot: "easyECADDownloader",
      samacsysFirefoxProxyBaseUrl: "https://proxy.example.test/relay",
      samacsysFirefoxProxyAuthorizationHeader: "Bearer proxy123",
      samacsysFirefoxUsername: "",
      samacsysFirefoxPassword: "",
      rememberSamacsysCredentials: false,
      rememberSamacsysFirefoxProxyAuthorizationHeader: true
    });
  });

  it.each(["local", "session"])("rejects settings read failures from %s storage", async area => {
    const { chrome } = createServiceWorkerChrome();
    chrome.storage[area].get.mockImplementation((_defaults, callback) => {
      chrome.runtime.lastError = { message: "Storage unavailable" };
      callback();
      chrome.runtime.lastError = null;
    });

    await expect(loadSettings(chrome)).rejects.toThrow("Failed to load settings: Storage unavailable");
  });

  it("uses empty session secrets when the optional session storage API is absent", async () => {
    const { chrome } = createServiceWorkerChrome();
    delete chrome.storage.session;
    expect((await loadSettings(chrome)).samacsysFirefoxPassword).toBe("");
  });

  it("surfaces data-URL fallback download failures", async () => {
    const { chrome } = createServiceWorkerChrome();
    chrome.downloads.download.mockImplementation((_options, callback) => {
      chrome.runtime.lastError = { message: "Download blocked." };
      callback?.();
      chrome.runtime.lastError = null;
    });
    const downloads = createDownloadApi(chrome, {}, undefined);

    await expect(
      downloads.downloadTextFile("part.kicad_sym", "(symbol)", "application/octet-stream")
    ).rejects.toThrow("Download blocked.");
  });


  it("merges symbol blocks without duplicating existing ids", () => {
    const symbolBlock = extractSymbolBlock(MOUSER_SYMBOL);
    const merged = mergeSymbolIntoLibrary(createSymbolLibrary(), symbolBlock);

    expect(symbolBlock).toContain('(symbol "STM32C552KEU6"');
    expect(merged).toContain('(symbol "ExistingSymbol"');
    expect(merged).toContain('(symbol "STM32C552KEU6"');
    expect(mergeSymbolIntoLibrary(merged, symbolBlock)).toBe(merged);
  });

  it("merges compact libraries and distinguishes nested unit IDs from root symbols", () => {
    const existing = '(kicad_symbol_lib (symbol "Parent" (symbol "Parent_0_1" (rectangle))))';
    const incoming = '(kicad_symbol_lib (symbol "Parent_0_1" (property "Value" "new (symbol)")))';
    const block = extractSymbolBlock(incoming);
    expect(block).toBe('(symbol "Parent_0_1" (property "Value" "new (symbol)"))');
    const merged = mergeSymbolIntoLibrary(existing, block);
    expect(merged).toContain('(property "Value" "new (symbol)")');
    expect(merged).toContain('(symbol "Parent" (symbol "Parent_0_1" (rectangle)))');
    expect(mergeSymbolIntoLibrary(merged, block)).toBe(merged);
  });

  it("merges each new root symbol from a multi-symbol library independently", () => {
    const existing = '(kicad_symbol_lib (symbol "Existing" (property "Value" "original")))';
    const incoming = '(kicad_symbol_lib (symbol "Existing" (property "Value" "replacement")) (symbol "New"))';
    const merged = mergeSymbolIntoLibrary(existing, extractSymbolBlock(incoming));
    expect(merged).toContain('(property "Value" "original")');
    expect(merged).not.toContain('"replacement"');
    expect(merged).toContain('(symbol "New")');
  });

  it("rewrites Mouser symbol and footprint library references", () => {
    expect(
      rewriteSamacsysSymbolFootprintReference(
        MOUSER_SYMBOL,
        "QFN50P500X500X60-33N-D",
        "Workspace"
      )
    ).toContain('Workspace:QFN50P500X500X60-33N-D');
    expect(
      rewriteSamacsysFootprintModelPath(
        MOUSER_FOOTPRINT,
        "STM32C552KEU6.stp",
        "Workspace"
      )
    ).toContain("../Workspace.3dshapes/STM32C552KEU6.stp");
    expect(stripKicadFootprintModels(MOUSER_FOOTPRINT)).not.toContain("(model");
  });

  it("parses the SamacSys ZIP form metadata from the part page", () => {
    expect(
      parseSamacsysPageMetadata(
        createSamacsysPartHtml(),
        "https://ms.componentsearchengine.com/part.php?partID=21790508",
        "https://ms.componentsearchengine.com"
      )
    ).toEqual({
      partId: "21790508",
      token: "tok123",
      pageUrl: "https://ms.componentsearchengine.com/part.php?partID=21790508",
      baseUrl: "https://ms.componentsearchengine.com",
      zipActionUrl: "https://ms.componentsearchengine.com/ga/model.php",
      zipMethod: "GET",
      zipFormInputs: {
        partner: "Mouser",
        tok: "tok123",
        partID: "21790508",
        fmt: "zip",
        lang: "en-GB",
        datasheet: "",
        emb: "1",
        pna: "Mouser"
      }
    });
  });

  it("extracts SamacSys assets from top-level KiCad and 3D ZIP directories", async () => {
    const textEncoder = new TextEncoder();
    const assets = await extractSamacsysKiCadAssets(
      new Uint8Array([0x50, 0x4b]),
      async () => [
        {
          name: "KiCad/STM32C552KEU6.kicad_sym",
          data: textEncoder.encode(MOUSER_SYMBOL)
        },
        {
          name: "KiCad/QFN50P500X500X60-33N-D.kicad_mod",
          data: textEncoder.encode(MOUSER_FOOTPRINT)
        },
        {
          name: "3D/STM32C552KEU6.step",
          data: new Uint8Array([1, 2, 3])
        },
        {
          name: "3D/STM32C552KEU6.wrl",
          data: textEncoder.encode("#VRML")
        }
      ]
    );

    expect(assets.symbols[0].filename).toBe("STM32C552KEU6.kicad_sym");
    expect(assets.footprints[0].filename).toBe("QFN50P500X500X60-33N-D.kicad_mod");
    expect(assets.stepModels[0].filename).toBe("STM32C552KEU6.step");
    expect(assets.wrlModels[0].filename).toBe("STM32C552KEU6.wrl");
  });
});

// SamacSys/relay work in this file: JoeShade and Josh Webster
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
