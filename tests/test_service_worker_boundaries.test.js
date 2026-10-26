/*
 * Regressions for upstream trust, concurrent library exports, and quoted KiCad
 * data. Each case exercises the worker helper at its real orchestration seam.
 */

import { describe, expect, it, vi } from "vitest";
import { writeSymbolArtifact } from "../src/core/export_artifacts.js";
import {
  createSamacsysFetchImpl,
  fetchSamacsysPageMetadata,
  fetchSamacsysZipArchive,
  parseSamacsysPageMetadata,
  rewriteSamacsysFootprintModelPath,
  rewriteSamacsysSymbolFootprintReference,
  stripKicadFootprintModels
} from "../src/sources/samacsys_common.js";
import { buildFootprintPreviewSvg } from "../src/sources/easyeda_common.js";
import { createSymbolLibrary } from "./helpers/fixtures.js";
import {
  createSamacsysPartContext,
  createSamacsysPartHtml,
  createServiceWorkerChrome
} from "./helpers/service_worker_harness.js";

describe("SamacSys request destinations", () => {
  const untrustedUrls = [
    "https://other.example.test/ga/model.php",
    "https://componentsearchengine.com.other.example.test/ga/model.php",
    "http://ms.componentsearchengine.com/ga/model.php",
    Object.assign(new URL("https://ms.componentsearchengine.com/ga/model.php"), {
      username: "user", password: "password"
    }).href,
    "https://ms.componentsearchengine.com:8443/ga/model.php"
  ];

  it.each(untrustedUrls)("rejects an unsafe ZIP form action: %s", url => {
    expect(() => parseSamacsysPageMetadata(
      createSamacsysPartHtml({ zipActionUrl: url }),
      "https://ms.componentsearchengine.com/part.php?partID=1"
    )).toThrow("SamacSys request URL must use HTTPS on componentsearchengine.com.");
  });

  it("rejects an unsafe entry URL before making a request", async () => {
    const fetchImpl = vi.fn();
    await expect(fetchSamacsysPageMetadata(fetchImpl, createSamacsysPartContext("mouser", {
      lookup: { entryUrl: "https://other.example.test/entry.php" }
    }))).rejects.toThrow("SamacSys request URL");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects an unsafe ZIP URL before sending an authenticated retry", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 401 }));
    await expect(fetchSamacsysZipArchive(fetchImpl, {
      zipActionUrl: "https://other.example.test/ga/model.php"
    }, { retryAuthorizationHeader: "Basic placeholder" })).rejects.toThrow("SamacSys request URL");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects unsafe relay targets before reading cookies or forwarding authorization", async () => {
    const { chrome } = createServiceWorkerChrome();
    const fetchImpl = vi.fn();
    const request = createSamacsysFetchImpl(fetchImpl, {
      chromeApi: chrome,
      userAgent: "Firefox/149.0",
      proxyBaseUrl: "https://relay.example.test/",
      authorizationHeader: "Basic placeholder"
    });
    await expect(request(untrustedUrls[0], { credentials: "include" })).rejects.toThrow("SamacSys request URL");
    expect(chrome.cookies.getAll).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("keeps credential-bearing relay payloads bound to the configured endpoint", async () => {
    const { chrome } = createServiceWorkerChrome();
    const fetchImpl = vi.fn(async (_url, options) => {
      // A 307/308 can replay the whole JSON body. The browser's redirect error
      // mode must stop that replay before another endpoint receives credentials.
      expect(options.redirect).toBe("error");
      throw new TypeError("Redirect refused");
    });
    const request = createSamacsysFetchImpl(fetchImpl, {
      chromeApi: chrome,
      userAgent: "Firefox/149.0",
      proxyBaseUrl: "https://relay.example.test/",
      authorizationHeader: "Basic placeholder"
    });
    await expect(request("https://ms.componentsearchengine.com/part.php", {
      credentials: "include"
    })).rejects.toThrow("SamacSys proxy request failed: Redirect refused");
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("retains a ZIP action's existing query and appends encoded form values", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true, arrayBuffer: async () => new TextEncoder().encode("PKzip").buffer
    }));
    await fetchSamacsysZipArchive(fetchImpl, {
      zipActionUrl: "https://ms.componentsearchengine.com/ga/model.php?source=partner",
      zipMethod: "GET",
      zipFormInputs: { tok: "value&more", partID: "1" }
    });
    const requested = new URL(fetchImpl.mock.calls[0][0]);
    expect(requested.searchParams.get("source")).toBe("partner");
    expect(requested.searchParams.get("tok")).toBe("value&more");
    expect(requested.searchParams.get("partID")).toBe("1");
  });
});

describe("shared library writes", () => {
  function setup() {
    const { chrome, storage } = createServiceWorkerChrome();
    const downloads = { downloadTextFile: vi.fn(async () => 1) };
    const exportContext = {
      settings: { downloadIndividually: false },
      symbolLibraryKey: "symbolLibrary:Parts/Parts.kicad_sym",
      libraryPaths: { symbolFile: "Parts/Parts.kicad_sym" }
    };
    const write = symbolName => writeSymbolArtifact({
      chromeApi: chrome, downloads, exportContext,
      symbolContent: createSymbolLibrary(symbolName),
      individualFilename: `${symbolName}.kicad_sym`
    });
    return { chrome, storage, downloads, exportContext, write };
  }

  it("retains both symbols when exports overlap on the same library", async () => {
    const h = setup();
    await Promise.all([h.write("First"), h.write("Second")]);
    const stored = h.storage[h.exportContext.symbolLibraryKey];
    expect(stored).toContain('(symbol "First"');
    expect(stored).toContain('(symbol "Second"');
    expect(h.downloads.downloadTextFile.mock.calls.at(-1)[1]).toBe(stored);
  });

  it("preserves the prior library when storage cannot be read", async () => {
    const h = setup();
    h.chrome.storage.local.get.mockImplementation((_defaults, callback) => {
      h.chrome.runtime.lastError = { message: "Storage unavailable" };
      callback({});
      h.chrome.runtime.lastError = null;
    });
    await expect(h.write("First")).rejects.toThrow("Failed to load symbol library");
    expect(h.chrome.storage.local.set).not.toHaveBeenCalled();
    expect(h.downloads.downloadTextFile).not.toHaveBeenCalled();
  });

  it("reports a failed save and allows the next queued export to proceed", async () => {
    const h = setup();
    h.chrome.storage.local.set.mockImplementationOnce((_items, callback) => {
      h.chrome.runtime.lastError = { message: "Storage full" };
      callback();
      h.chrome.runtime.lastError = null;
    });
    const first = h.write("First");
    const second = h.write("Second");
    await expect(first).rejects.toThrow("Failed to save symbol library");
    await expect(second).resolves.toBe(1);
    expect(h.storage[h.exportContext.symbolLibraryKey]).toContain('(symbol "Second"');
  });
});

describe("SamacSys KiCad model edits", () => {
  const footprint = `(footprint "Part"
  (property "Value" "literal (model text)")
  (model "folder/part (revision).step" (offset (xyz 0 0 0)))
  (pad "1" smd rect (at 1 2) (size 1 1))
)`;

  it("removes real model blocks while retaining quoted text and pad geometry", () => {
    expect(stripKicadFootprintModels(footprint)).toBe(`(footprint "Part"
  (property "Value" "literal (model text)")
  (pad "1" smd rect (at 1 2) (size 1 1))
)`);
  });

  it("replaces a quoted model filename without changing surrounding transforms", () => {
    const rewritten = rewriteSamacsysFootprintModelPath(footprint, "part $1 (new).step", "Parts");
    expect(rewritten).toContain('(property "Value" "literal (model text)")');
    expect(rewritten).toContain('(model "../Parts.3dshapes/part $1 (new).step" (offset (xyz 0 0 0)))');
    expect(rewritten).toContain('(pad "1" smd rect');
  });

  it("retains literal dollar signs and escapes quotes in symbol footprint references", () => {
    const rewritten = rewriteSamacsysSymbolFootprintReference(
      '(property "Footprint" "old" (at 0 0 0))', 'part $1 "revision"', "Parts"
    );
    expect(rewritten).toBe('(property "Footprint" "Parts:part $1 \\"revision\\"" (at 0 0 0))');
  });
});

describe("EasyEDA footprint preview inputs", () => {
  it("normalizes numeric bounds before SVG viewBox arithmetic", () => {
    const svg = buildFootprintPreviewSvg({ packageDetail: { dataStr: {
      BBox: { x: "10", y: "20", width: "40", height: "30" }, shape: []
    } } });
    const doc = new window.DOMParser().parseFromString(svg, "image/svg+xml");
    expect(doc.documentElement.getAttribute("viewBox")).toBe("2 12 56 46");
  });

  it("preserves quoted arc data as one SVG attribute", () => {
    const path = 'M 0 0 A 1 1 0 0 0 2 2" /><image href="https://other.example.test/image"/>';
    const svg = buildFootprintPreviewSvg({ packageDetail: { dataStr: {
      BBox: { x: 0, y: 0, width: 40, height: 30 },
      shape: [`ARC~1~3~~${path}`]
    } } });
    const doc = new window.DOMParser().parseFromString(svg, "image/svg+xml");
    expect(doc.querySelector("parsererror")).toBeNull();
    expect(doc.querySelector("path").getAttribute("d")).toBe(path);
    expect(doc.querySelector("image")).toBeNull();
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
