/*
 * These tests cover Firefox SamacSys relay, cookie forwarding, explicit auth,
 * and proxy error behavior.
 */

import { describe, expect, it, vi } from "vitest";

import {
  createSamacsysFetchImpl,
  createSamacsysPartContext,
  createServiceWorkerChrome,
  loadServiceWorker,
  MOUSER_FOOTPRINT,
  MOUSER_SYMBOL,
  sendRuntimeMessage
} from "./helpers/service_worker_harness.js";

describe("service worker Firefox SamacSys flow", () => {
  it.each(["GET_PART_PREVIEWS", "EXPORT_PART"])("uses the settings snapshot that admitted %s", async type => {
    const proxyBaseUrl = "https://proxy.example.test/relay";
    const { chrome, listeners } = createServiceWorkerChrome();
    // The user clears the relay after this request's settings read. Its next
    // request must see that change, while the admitted request uses its relay.
    chrome.storage.local.get.mockImplementationOnce((defaults, callback) =>
      callback({ ...defaults, samacsysFirefoxProxyBaseUrl: proxyBaseUrl }));
    const fetchImpl = createSamacsysFetchImpl({ proxyBaseUrl, symbolImage: "AA==", footprintImage: "AA==", zipStatus: 200 });
    loadServiceWorker({ chrome, fetchImpl, userAgent: "Firefox", readZipEntries: async () => [
      { name: "KiCad/test.kicad_sym", data: new TextEncoder().encode(MOUSER_SYMBOL) }
    ] });
    const message = { type, partContext: createSamacsysPartContext("mouser"),
      options: { symbol: true, footprint: false, model3d: false } };
    expect((await sendRuntimeMessage(listeners.runtimeMessage[0], message)).response.ok).toBe(true);
    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual(expect.arrayContaining([proxyBaseUrl]));
    expect(fetchImpl.mock.calls.every(([url]) => url === proxyBaseUrl)).toBe(true);
    expect((await sendRuntimeMessage(listeners.runtimeMessage[0], message)).response.error).toContain("require a configured proxy");
  });

  it("returns the sign-in-required error when Firefox SamacSys export is unauthorized", async () => {
    const { chrome, listeners } = createServiceWorkerChrome({
      storageState: {
        downloadIndividually: true,
        libraryDownloadRoot: "KiCad/Workspace",
        samacsysFirefoxProxyBaseUrl: "https://proxy.example.test/relay"
      }
    });
    const fetchImpl = createSamacsysFetchImpl({
      proxyBaseUrl: "https://proxy.example.test/relay",
      zipStatus: 401
    });

    loadServiceWorker({
      chrome,
      fetchImpl,
      userAgent: "Mozilla/5.0 Firefox/149.0"
    });

    const result = await sendRuntimeMessage(listeners.runtimeMessage[0], {
      type: "EXPORT_PART",
      partContext: createSamacsysPartContext("mouser"),
      options: {
        symbol: true,
        footprint: false,
        model3d: false,
        datasheet: false
      }
    });

    expect(result.response).toEqual({
      ok: false,
      error:
        "Mouser/SamacSys download requires you to be signed in before CAD files can be downloaded."
    });
  });

  it("returns structured unsupported responses for Mouser requests on Firefox", async () => {
    const { chrome, listeners } = createServiceWorkerChrome();
    const fetchImpl = vi.fn();
    loadServiceWorker({
      chrome,
      fetchImpl,
      userAgent: "Mozilla/5.0 Firefox/149.0"
    });

    const previewResult = await sendRuntimeMessage(listeners.runtimeMessage[0], {
      type: "GET_PART_PREVIEWS",
      partContext: createSamacsysPartContext("mouser")
    });
    const exportResult = await sendRuntimeMessage(listeners.runtimeMessage[0], {
      type: "EXPORT_PART",
      partContext: createSamacsysPartContext("mouser"),
      options: {
        symbol: true,
        footprint: true,
        model3d: true,
        datasheet: false
      }
    });

    expect(previewResult.response).toEqual({
      ok: false,
      error:
        "SamacSys distributor downloads in Firefox require a configured proxy relay. Configure the Firefox SamacSys proxy URL in Advanced settings or use Chrome."
    });
    expect(exportResult.response).toEqual({
      ok: false,
      error:
        "SamacSys distributor downloads in Firefox require a configured proxy relay. Configure the Firefox SamacSys proxy URL in Advanced settings or use Chrome."
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("allows Firefox SamacSys previews through the configured proxy relay", async () => {
    const { chrome, listeners } = createServiceWorkerChrome({
      storageState: {
        samacsysFirefoxProxyBaseUrl: "https://proxy.example.test/relay"
      }
    });
    const fetchImpl = createSamacsysFetchImpl({
      proxyBaseUrl: "https://proxy.example.test/relay",
      symbolImage: "AAAA",
      footprintImage: "BBBB",
      expectedProxyAuthorizationHeader: "",
      expectedNoForwardAuthorizationHeader: true
    });
    loadServiceWorker({
      chrome,
      fetchImpl,
      userAgent: "Mozilla/5.0 Firefox/149.0"
    });

    const result = await sendRuntimeMessage(listeners.runtimeMessage[0], {
      type: "GET_PART_PREVIEWS",
      partContext: createSamacsysPartContext("mouser")
    });

    expect(result.response).toEqual({
      ok: true,
      previews: {
        symbolUrl: "data:image/png;base64,AAAA",
        footprintUrl: "data:image/png;base64,BBBB"
      },
      metadata: {
        datasheetAvailable: false
      }
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://proxy.example.test/relay",
      expect.objectContaining({
        method: "POST"
      })
    );
  });

  it("forwards SamacSys cookies through the Firefox proxy relay", async () => {
    const { chrome, listeners } = createServiceWorkerChrome({
      storageState: {
        samacsysFirefoxProxyBaseUrl: "https://proxy.example.test/relay"
      },
      sessionStorageState: {
        samacsysFirefoxProxyAuthorizationHeader: "Bearer relay-secret",
        samacsysFirefoxUsername: "user@example.com",
        samacsysFirefoxPassword: "secret123"
      },
      cookieState: {
        "*": [
          { name: "PHPSESSID", value: "relay-session" },
          { name: "partner", value: "mouser" }
        ]
      }
    });
    const fetchImpl = createSamacsysFetchImpl({
      proxyBaseUrl: "https://proxy.example.test/relay",
      symbolImage: "AAAA",
      footprintImage: "BBBB",
      expectedProxyAuthorizationHeader: "Bearer relay-secret",
      expectedCookieHeader: "PHPSESSID=relay-session; partner=mouser",
      expectedAuthorizationHeader: "Basic dXNlckBleGFtcGxlLmNvbTpzZWNyZXQxMjM="
    });
    loadServiceWorker({
      chrome,
      fetchImpl,
      userAgent: "Mozilla/5.0 Firefox/149.0"
    });

    const result = await sendRuntimeMessage(listeners.runtimeMessage[0], {
      type: "GET_PART_PREVIEWS",
      partContext: createSamacsysPartContext("mouser")
    });

    expect(result.response.ok).toBe(true);
    expect(chrome.cookies.getAll).toHaveBeenCalled();
  });

  it("builds the SamacSys Authorization header from stored credentials", async () => {
    const { chrome, listeners } = createServiceWorkerChrome({
      storageState: {
        samacsysFirefoxProxyBaseUrl: "https://proxy.example.test/relay"
      },
      sessionStorageState: {
        samacsysFirefoxUsername: "user@example.com",
        samacsysFirefoxPassword: "secret123"
      }
    });
    const fetchImpl = createSamacsysFetchImpl({
      proxyBaseUrl: "https://proxy.example.test/relay",
      symbolImage: "AAAA",
      footprintImage: "BBBB",
      expectedAuthorizationHeader: "Basic dXNlckBleGFtcGxlLmNvbTpzZWNyZXQxMjM="
    });
    loadServiceWorker({
      chrome,
      fetchImpl,
      userAgent: "Mozilla/5.0 Firefox/149.0"
    });

    const result = await sendRuntimeMessage(listeners.runtimeMessage[0], {
      type: "GET_PART_PREVIEWS",
      partContext: createSamacsysPartContext("mouser")
    });

    expect(result.response.ok).toBe(true);
  });

  it("allows Firefox SamacSys export through the configured proxy relay", async () => {
    const { chrome, listeners } = createServiceWorkerChrome({
      storageState: {
        downloadIndividually: true,
        libraryDownloadRoot: "KiCad/Workspace",
        samacsysFirefoxProxyBaseUrl: "https://proxy.example.test/relay"
      }
    });
    const readZipEntries = vi.fn(async () => [
      {
        name: "STM32C552KEU6/KiCad/STM32C552KEU6.kicad_sym",
        data: new TextEncoder().encode(MOUSER_SYMBOL)
      },
      {
        name: "STM32C552KEU6/KiCad/QFN50P500X500X60-33N-D.kicad_mod",
        data: new TextEncoder().encode(MOUSER_FOOTPRINT)
      },
      {
        name: "STM32C552KEU6/3D/STM32C552KEU6.stp",
        data: new TextEncoder().encode("step")
      }
    ]);
    const fetchImpl = createSamacsysFetchImpl({
      proxyBaseUrl: "https://proxy.example.test/relay",
      zipStatus: 200
    });
    loadServiceWorker({
      chrome,
      fetchImpl,
      readZipEntries,
      userAgent: "Mozilla/5.0 Firefox/149.0"
    });

    const result = await sendRuntimeMessage(listeners.runtimeMessage[0], {
      type: "EXPORT_PART",
      partContext: createSamacsysPartContext("mouser"),
      options: {
        symbol: true,
        footprint: true,
        model3d: true,
        datasheet: false
      }
    });

    expect(result.response).toEqual({
      ok: true,
      warnings: [],
      downloadCount: 3
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://proxy.example.test/relay",
      expect.objectContaining({
        method: "POST"
      })
    );
  });

  it("surfaces proxy transport failures distinctly from upstream SamacSys errors", async () => {
    const { chrome, listeners } = createServiceWorkerChrome({
      storageState: {
        samacsysFirefoxProxyBaseUrl: "https://proxy.example.test/relay"
      }
    });
    const fetchImpl = createSamacsysFetchImpl({
      proxyBaseUrl: "https://proxy.example.test/relay",
      proxyFailureMessage: "socket hang up"
    });
    loadServiceWorker({
      chrome,
      fetchImpl,
      userAgent: "Mozilla/5.0 Firefox/149.0"
    });

    const result = await sendRuntimeMessage(listeners.runtimeMessage[0], {
      type: "GET_PART_PREVIEWS",
      partContext: createSamacsysPartContext("mouser")
    });

    expect(result.response).toEqual({
      ok: false,
      error: "SamacSys proxy request failed: socket hang up"
    });
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
