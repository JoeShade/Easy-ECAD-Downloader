/*
 * These tests cover popup state, settings normalization, preview rendering, and
 * export messaging. They use jsdom and mocked chrome APIs so UI behavior stays
 * testable without loading the extension in Chrome or Firefox.
 */

import { describe, expect, it, vi } from "vitest";
import { JSDOM } from "jsdom";
import { loadContentScript } from "./helpers/content_script_harness.js";
import cases from "./fixtures/issue_13.json";
import farnellProducts from "./fixtures/issue_15.json";

import {
  flushAsyncWork,
  importRepoModule,
  readRepoFile,
} from "./helpers/test_harness.js";

function createPopupChrome() {
  const state = {
    queryCalls: [],
    tabMessages: [],
    runtimeMessages: [],
    openOptionsPageCalls: [],
    createdTabs: [],
    storageGetCalls: [],
    storageSetCalls: []
  };

  const chrome = {
    runtime: {
      lastError: null,
      getURL: vi.fn((path) => `chrome-extension://test/${path}`),
      openOptionsPage: vi.fn(() => {
        state.openOptionsPageCalls.push({});
      }),
      sendMessage: vi.fn((message, callback) => {
        state.runtimeMessages.push({ message, callback });
      })
    },
    tabs: {
      query: vi.fn((queryInfo, callback) => {
        state.queryCalls.push({ queryInfo, callback });
      }),
      sendMessage: vi.fn((tabId, message, callback) => {
        state.tabMessages.push({ tabId, message, callback });
      }),
      create: vi.fn((createProperties) => {
        state.createdTabs.push(createProperties);
      })
    },
    storage: {
      local: {
        get: vi.fn((defaults, callback) => {
          state.storageGetCalls.push({ defaults, callback });
        }),
        set: vi.fn((items, callback) => {
          state.storageSetCalls.push(items);
          callback?.();
        })
      }
    }
  };

  return { chrome, state };
}

async function loadPopup({ userAgent = "Mozilla/5.0 Chrome/135.0.0.0" } = {}) {
  const dom = new JSDOM(readRepoFile("src/popup.html"), {
    url: "https://example.test/popup.html"
  });
  Object.defineProperty(dom.window.navigator, "userAgent", {
    configurable: true,
    value: userAgent
  });
  const { chrome, state } = createPopupChrome();
  const testApi = {};
  globalThis.chrome = chrome;
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.Event = dom.window.Event;
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: dom.window.navigator
  });
  globalThis.__popupTestApi = testApi;
  await importRepoModule("src/popup.js");
  delete globalThis.__popupTestApi;

  return {
    dom,
    chrome,
    state,
    hooks: testApi
  };
}

function dispatchChange(dom, element) {
  element.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
}

const EASYEDA_PART_CONTEXT = {
  provider: "easyedaLcsc",
  sourcePartLabel: "LCSC part",
  sourcePartNumber: "C12345",
  manufacturerPartNumber: "SN74LVC1G14DBVR",
  lookup: {
    lcscId: "C12345"
  }
};

const MOUSER_PART_CONTEXT = {
  provider: "mouserSamacsys",
  sourcePartLabel: "Mouser part",
  sourcePartNumber: "511-STM32U3C5RIT6Q",
  manufacturerPartNumber: "STM32U3C5RIT6Q",
  lookup: {
    manufacturerName: "STMicroelectronics",
    entryUrl:
      "https://ms.componentsearchengine.com/entry_u_newDesign.php?mna=STMicroelectronics&mpn=STM32U3C5RIT6Q&pna=mouser&vrq=multi&fmt=zip&lang=en-GB"
  }
};

const FARNELL_PART_CONTEXT = {
  provider: "farnellSamacsys",
  sourcePartLabel: "Farnell part",
  sourcePartNumber: "1848693",
  manufacturerPartNumber: "FQP27P06",
  lookup: {
    manufacturerName: "ONSEMI",
    entryUrl:
      "https://farnell.componentsearchengine.com/entry_u_newDesign.php?mna=ONSEMI&mpn=FQP27P06&pna=farnell&vrq=multi&fmt=zip&lang=en-GB",
    partnerName: "farnell",
    samacsysBaseUrl: "https://farnell.componentsearchengine.com"
  }
};

async function applyStoredSettings(
  state,
  settings = {
    downloadIndividually: false,
    libraryDownloadRoot: "easyECADDownloader",
    samacsysFirefoxProxyBaseUrl: "",
    samacsysFirefoxProxyAuthorizationHeader: "",
    samacsysFirefoxUsername: "",
    samacsysFirefoxPassword: ""
  }
) {
  state.storageGetCalls[0].callback(settings);
  await flushAsyncWork();
}

function activatePopupTab(state, tabId) {
  state.queryCalls[0].callback([{ id: tabId }]);
}

describe("popup", () => {
  it("displays the captured LCSC summary MPN and forwards its catalogue lookup (issue #18)", async () => {
    const page = loadContentScript(readRepoFile("tests/fixtures/issue_18_lcsc.html"),
      { url: "https://www.lcsc.com/product-detail/C34846.html" });
    const partContext = page.requestContext();
    const { state, hooks, dom } = await loadPopup();
    await applyStoredSettings(state);
    activatePopupTab(state, 7);
    state.tabMessages[0].callback(partContext);
    expect(hooks.elements.manufacturerPartNumberEl.textContent).toBe("3296W-1-103LF");
    expect(hooks.elements.partNumberEl.textContent).toBe("C34846");
    expect(state.runtimeMessages[0].message).toEqual({ type: "GET_PART_PREVIEWS", partContext });
    expect(partContext.lookup).toEqual({ lcscId: "C34846" });
    state.runtimeMessages[0].callback({ ok: true, previews: {}, metadata: { datasheetAvailable: false } });
    await flushAsyncWork();
    expect(hooks.elements.downloadButton.disabled).toBe(false);
    hooks.elements.downloadButton.click();
    expect(state.runtimeMessages[1].message).toMatchObject({ type: "EXPORT_PART", partContext });
    page.dom.window.close();
    dom.window.close();
  });

  it.each(farnellProducts)("displays and forwards the full $brand issue #15 identity", async product => {
    const page = loadContentScript("", { url: product.url,
      headMarkup: `<meta property="og:description" content="Buy ${product.mpn} - YAGEO - Resistor.">` });
    const partContext = page.requestContext();
    const { state, hooks } = await loadPopup();
    await applyStoredSettings(state);
    activatePopupTab(state, 7);
    state.tabMessages[0].callback(partContext);
    expect(hooks.elements.manufacturerPartNumberEl.textContent).toBe(product.mpn);
    expect(hooks.elements.partNumberEl.textContent).toBe(product.orderCode);
    expect(hooks.elements.sourcePartLabelEl.textContent).toBe(product.label);
    expect(partContext.lookup.manufacturerName).toBe("YAGEO");
    const params = new URL(partContext.lookup.entryUrl).searchParams;
    expect(params.get("mpn")).toBe(product.mpn);
    expect(params.get("mna")).toBe("YAGEO");
    expect(state.runtimeMessages[0].message).toEqual({ type: "GET_PART_PREVIEWS", partContext });
    state.runtimeMessages[0].callback({ ok: true, previews: {}, metadata: { datasheetAvailable: false } });
    await flushAsyncWork();
    expect(hooks.elements.downloadButton.disabled).toBe(false);
    hooks.elements.downloadButton.click();
    expect(state.runtimeMessages[1].message).toMatchObject({ type: "EXPORT_PART", partContext });
    page.dom.window.close();
  });

  it.each(["0451001.MRL", "RC1206FR-0710KL", "G5V-1 DC5", null])(
    "displays exact detected MPN %s while retaining catalogue-based previews and export", async mpn => {
      const page = loadContentScript(`<dl><dt>LCSC Part #</dt><dd>C132649</dd>
        ${mpn === null ? "" : `<dt>MPN</dt><dd>${mpn}</dd>`}</dl>`,
      { url: "https://lcsc.com/product-detail/C132649.html" });
      const partContext = page.requestContext();
      const { state, hooks } = await loadPopup();
      await applyStoredSettings(state);
      activatePopupTab(state, 7);
      state.tabMessages[0].callback(partContext);
      expect(hooks.elements.manufacturerPartNumberEl.textContent).toBe(mpn || "Not found");
      expect(hooks.elements.partNumberEl.textContent).toBe("C132649");
      expect(state.runtimeMessages[0].message).toEqual({ type: "GET_PART_PREVIEWS", partContext });
      expect(state.runtimeMessages[0].message.partContext.lookup.lcscId).toBe("C132649");
      state.runtimeMessages[0].callback({ ok: true, previews: {}, metadata: { datasheetAvailable: false } });
      await flushAsyncWork();
      expect(hooks.elements.downloadButton.disabled).toBe(false);
      hooks.elements.downloadButton.click();
      expect(state.runtimeMessages[1].message).toMatchObject({ type: "EXPORT_PART", partContext });
      expect(state.runtimeMessages[1].message.partContext.lookup.lcscId).toBe("C132649");
      page.dom.window.close();
    });

  it.each(cases)("displays and forwards the resolved $case identity for previews and export", async row => {
    const partContext = { ...EASYEDA_PART_CONTEXT, sourcePartNumber: row.id,
      manufacturerPartNumber: row.mpn, lookup: { lcscId: row.id } };
    const { state, hooks } = await loadPopup();
    await applyStoredSettings(state);
    activatePopupTab(state, 7);
    state.tabMessages[0].callback(partContext);
    expect(hooks.elements.partNumberEl.textContent).toBe(row.id);
    expect(hooks.elements.manufacturerPartNumberEl.textContent).toBe(row.mpn);
    expect(state.runtimeMessages[0].message).toEqual({ type: "GET_PART_PREVIEWS", partContext });
    expect(state.runtimeMessages[0].message.partContext.lookup.lcscId).toBe(row.id);
    state.runtimeMessages[0].callback({ ok: true, previews: {}, metadata: { datasheetAvailable: false } });
    await flushAsyncWork();
    hooks.elements.downloadButton.click();
    expect(state.runtimeMessages[1].message).toMatchObject({ type: "EXPORT_PART", partContext });
    expect(state.runtimeMessages[1].message.partContext.lookup.lcscId).toBe(row.id);
  });

  it("makes no preview or export request for an unavailable context", async () => {
    const partContext = { provider: null, sourcePartLabel: null, sourcePartNumber: null,
      manufacturerPartNumber: null, lookup: null };
    const { state, hooks } = await loadPopup();
    await applyStoredSettings(state);
    activatePopupTab(state, 7);
    state.tabMessages[0].callback(partContext);
    expect(hooks.elements.downloadButton.disabled).toBe(true);
    hooks.elements.downloadButton.click();
    expect(state.runtimeMessages).toHaveLength(0);
  });

  it("starts in a loading state and requests the active tab plus saved settings", async () => {
    const { state, hooks } = await loadPopup();

    expect(state.queryCalls).toHaveLength(1);
    expect(state.queryCalls[0].queryInfo).toEqual({
      active: true,
      currentWindow: true
    });
    expect(state.storageGetCalls).toHaveLength(1);
    expect(hooks.elements.manufacturerPartNumberEl.textContent).toBe("Searching...");
    expect(hooks.elements.sourcePartLabelEl.textContent).toBe("Part");
    expect(hooks.elements.partNumberEl.textContent).toBe("Searching...");
    expect(hooks.elements.settingsButton.textContent.trim()).toBe("Open settings");
    expect(hooks.elements.downloadButton.disabled).toBe(true);
    expect(hooks.elements.symbolPreviewFallbackEl.textContent).toBe("Loading...");
    expect(hooks.elements.footprintPreviewFallbackEl.textContent).toBe("Loading...");
  });

  it("opens the dedicated settings page from the popup", async () => {
    const { state, hooks } = await loadPopup();

    hooks.elements.settingsButton.click();

    expect(state.createdTabs).toEqual([
      {
        url: "chrome-extension://test/src/settings.html"
      }
    ]);
    expect(state.openOptionsPageCalls).toHaveLength(0);
  });

  it("loads an EasyEDA part context and enables download only when a selection exists", async () => {
    const { dom, state, hooks } = await loadPopup();

    await applyStoredSettings(state, {
      downloadIndividually: true,
      libraryDownloadRoot: "KiCad\\easyECAD"
    });

    activatePopupTab(state, 7);
    expect(state.tabMessages[0]).toMatchObject({
      tabId: 7,
      message: { type: "GET_PART_CONTEXT" }
    });

    const partContext = EASYEDA_PART_CONTEXT;
    state.tabMessages[0].callback(partContext);
    expect(state.runtimeMessages[0].message).toEqual({
      type: "GET_PART_PREVIEWS",
      partContext
    });

    state.runtimeMessages[0].callback({
      ok: true,
      previews: {
        symbolUrl: "data:image/svg+xml;utf8,%3Csvg%20%2F%3E",
        footprintUrl: "data:image/svg+xml;utf8,%3Csvg%20%2F%3E"
      },
      metadata: {
        datasheetAvailable: true
      }
    });
    await flushAsyncWork();

    expect(hooks.getCurrentPartContext()).toEqual(partContext);
    expect(hooks.elements.sourcePartLabelEl.textContent).toBe("LCSC part");
    expect(hooks.elements.manufacturerPartNumberEl.textContent).toBe(
      "SN74LVC1G14DBVR"
    );
    expect(hooks.elements.partNumberEl.textContent).toBe("C12345");
    expect(hooks.elements.downloadButton.disabled).toBe(false);
    expect(hooks.elements.symbolPreviewEl.src).toContain("data:image/svg+xml");
    expect(hooks.elements.footprintPreviewEl.src).toContain("data:image/svg+xml");
    expect(
      hooks.elements.symbolPreviewEl.classList.contains("samacsys-preview-image")
    ).toBe(false);
    expect(
      hooks.elements.footprintPreviewEl.classList.contains(
        "samacsys-preview-image"
      )
    ).toBe(false);

    hooks.elements.downloadSymbolEl.checked = false;
    hooks.elements.downloadFootprintEl.checked = false;
    hooks.elements.downloadModelEl.checked = false;
    dispatchChange(dom, hooks.elements.downloadSymbolEl);
    dispatchChange(dom, hooks.elements.downloadFootprintEl);
    dispatchChange(dom, hooks.elements.downloadModelEl);
    expect(hooks.elements.downloadButton.disabled).toBe(true);

    hooks.elements.downloadSymbolEl.checked = true;
    dispatchChange(dom, hooks.elements.downloadSymbolEl);
    expect(hooks.elements.downloadButton.disabled).toBe(false);
  });

  it("renders a Mouser provider context, uses PNG previews, and disables datasheet export", async () => {
    const { state, hooks } = await loadPopup();

    await applyStoredSettings(state);
    activatePopupTab(state, 8);

    const partContext = MOUSER_PART_CONTEXT;

    state.tabMessages[0].callback(partContext);
    expect(state.runtimeMessages[0].message).toEqual({
      type: "GET_PART_PREVIEWS",
      partContext
    });

    state.runtimeMessages[0].callback({
      ok: true,
      previews: {
        symbolUrl: "data:image/png;base64,AAAA",
        footprintUrl: "data:image/png;base64,BBBB"
      },
      metadata: {
        datasheetAvailable: false
      }
    });
    await flushAsyncWork();

    expect(hooks.elements.sourcePartLabelEl.textContent).toBe("Mouser part");
    expect(hooks.elements.partNumberEl.textContent).toBe("511-STM32U3C5RIT6Q");
    expect(hooks.elements.downloadDatasheetEl.disabled).toBe(true);
    expect(hooks.elements.downloadDatasheetLabelEl.textContent).toBe(
      "Datasheet (not available)"
    );
    expect(hooks.elements.symbolPreviewEl.src).toContain("data:image/png;base64");
    expect(hooks.elements.footprintPreviewEl.src).toContain("data:image/png;base64");
    expect(
      hooks.elements.symbolPreviewEl.classList.contains("samacsys-preview-image")
    ).toBe(true);
    expect(
      hooks.elements.footprintPreviewEl.classList.contains(
        "samacsys-preview-image"
      )
    ).toBe(true);

    hooks.elements.downloadDatasheetEl.checked = false;
    hooks.elements.downloadButton.click();
    expect(state.runtimeMessages[1].message).toEqual({
      type: "EXPORT_PART",
      partContext,
      options: {
        symbol: true,
        footprint: true,
        model3d: true,
        datasheet: false
      }
    });
  });

  it("keeps Mouser datasheet export disabled when previews fail", async () => {
    const { state, hooks } = await loadPopup();

    await applyStoredSettings(state);
    activatePopupTab(state, 8);

    const partContext = MOUSER_PART_CONTEXT;

    state.tabMessages[0].callback(partContext);
    expect(hooks.elements.downloadDatasheetEl.disabled).toBe(true);
    expect(hooks.elements.downloadDatasheetLabelEl.textContent).toBe(
      "Datasheet (not available)"
    );

    state.runtimeMessages[0].callback({
      ok: false,
      error: "Preview failed."
    });
    await flushAsyncWork();

    expect(hooks.elements.downloadDatasheetEl.disabled).toBe(true);
    expect(hooks.elements.downloadDatasheetEl.checked).toBe(false);
    expect(hooks.elements.downloadDatasheetLabelEl.textContent).toBe(
      "Datasheet (not available)"
    );
  });

  it("blocks Mouser downloads on Firefox with the proxy-required message", async () => {
    const { state, hooks } = await loadPopup({
      userAgent: "Mozilla/5.0 Firefox/149.0"
    });

    await applyStoredSettings(state);
    activatePopupTab(state, 10);
    state.tabMessages[0].callback(MOUSER_PART_CONTEXT);

    expect(hooks.elements.statusEl.textContent).toContain(
      "configured proxy relay"
    );
    expect(hooks.elements.downloadButton.disabled).toBe(true);
    expect(hooks.elements.symbolPreviewFallbackEl.textContent).toBe("Unavailable");
    expect(hooks.elements.footprintPreviewFallbackEl.textContent).toBe(
      "Unavailable"
    );
    expect(state.runtimeMessages).toHaveLength(0);
  });

  it("allows Firefox SamacSys previews when an advanced proxy URL is configured", async () => {
    const { state, hooks } = await loadPopup({
      userAgent: "Mozilla/5.0 Firefox/149.0"
    });

    await applyStoredSettings(state, {
      downloadIndividually: false,
      libraryDownloadRoot: "easyECADDownloader",
      samacsysFirefoxProxyBaseUrl: "https://proxy.example.test/relay"
    });
    activatePopupTab(state, 12);
    state.tabMessages[0].callback(MOUSER_PART_CONTEXT);

    expect(state.runtimeMessages[0].message).toEqual({
      type: "GET_PART_PREVIEWS",
      partContext: MOUSER_PART_CONTEXT
    });

    state.runtimeMessages[0].callback({
      ok: true,
      previews: {
        symbolUrl: "data:image/png;base64,AAAA",
        footprintUrl: "data:image/png;base64,BBBB"
      },
      metadata: {
        datasheetAvailable: false
      }
    });
    await flushAsyncWork();

    expect(hooks.elements.statusEl.textContent).toBe("");
    expect(hooks.elements.downloadButton.disabled).toBe(false);
  });

  it("treats Farnell SamacSys pages like Mouser for preview defaults and Firefox blocking", async () => {
    const { state, hooks } = await loadPopup({
      userAgent: "Mozilla/5.0 Firefox/149.0"
    });

    await applyStoredSettings(state);
    activatePopupTab(state, 11);
    state.tabMessages[0].callback(FARNELL_PART_CONTEXT);

    expect(hooks.elements.downloadDatasheetEl.disabled).toBe(true);
    expect(hooks.elements.statusEl.textContent).toContain(
      "configured proxy relay"
    );
    expect(hooks.elements.downloadButton.disabled).toBe(true);
    expect(state.runtimeMessages).toHaveLength(0);
  });

  it("shows identifiers as unavailable when the content script cannot respond", async () => {
    const { chrome, state, hooks } = await loadPopup();

    await applyStoredSettings(state);
    activatePopupTab(state, 11);
    chrome.runtime.lastError = { message: "No receiver." };
    state.tabMessages[0].callback(undefined);

    expect(hooks.elements.manufacturerPartNumberEl.textContent).toBe("Unavailable");
    expect(hooks.elements.partNumberEl.textContent).toBe("Unavailable");
    expect(hooks.elements.statusEl.textContent).toBe(
      "Open a supported product page."
    );
    expect(hooks.elements.downloadButton.disabled).toBe(true);
  });

  it("surfaces export errors in the popup status area", async () => {
    const { state, hooks } = await loadPopup();

    await applyStoredSettings(state);
    activatePopupTab(state, 9);
    const partContext = {
      ...EASYEDA_PART_CONTEXT,
      sourcePartNumber: "C90000",
      manufacturerPartNumber: "LM358PWR",
      lookup: {
        lcscId: "C90000"
      }
    };
    state.tabMessages[0].callback(partContext);
    state.runtimeMessages[0].callback({
      ok: true,
      previews: {
        symbolUrl: "data:image/svg+xml;utf8,%3Csvg%20%2F%3E",
        footprintUrl: "data:image/svg+xml;utf8,%3Csvg%20%2F%3E"
      },
      metadata: {
        datasheetAvailable: true
      }
    });
    await flushAsyncWork();

    hooks.elements.downloadButton.click();
    state.runtimeMessages[1].callback({
      ok: false,
      error: "Download failed."
    });
    await flushAsyncWork();

    expect(hooks.elements.statusEl.textContent).toBe("Download failed.");
    expect(hooks.elements.statusEl.classList.contains("error")).toBe(true);
  });

  it("does not say a download started when the worker reports no files", async () => {
    const { state, hooks } = await loadPopup();

    await applyStoredSettings(state);
    activatePopupTab(state, 9);
    state.tabMessages[0].callback(EASYEDA_PART_CONTEXT);
    state.runtimeMessages[0].callback({
      ok: true,
      previews: {
        symbolUrl: "data:image/svg+xml;utf8,%3Csvg%20%2F%3E",
        footprintUrl: "data:image/svg+xml;utf8,%3Csvg%20%2F%3E"
      },
      metadata: {
        datasheetAvailable: false
      }
    });
    await flushAsyncWork();

    hooks.elements.downloadButton.click();
    state.runtimeMessages[1].callback({
      ok: true,
      warnings: [],
      downloadCount: 0
    });
    await flushAsyncWork();

    expect(hooks.elements.statusEl.textContent).toBe(
      "No files were available to download."
    );
    expect(hooks.elements.statusEl.classList.contains("warning")).toBe(true);
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
