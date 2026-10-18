/*
 * Shared service-worker test harness utilities. They provide mocked extension
 * APIs, fetch helpers, and SamacSys fixtures for focused runtime tests.
 */

import { expect, vi } from "vitest";

import { registerServiceWorkerRuntime } from "../../src/service_worker_runtime.js";

export function createServiceWorkerChrome({
  storageState = {},
  sessionStorageState = {},
  cookieState = {},
  downloadBehavior = () => ({})
} = {}) {
  const listeners = {
    runtimeMessage: [],
    downloadsChanged: []
  };
  const storage = { ...storageState };
  const sessionStorage = { ...sessionStorageState };
  const cookieJar = { ...cookieState };
  let nextDownloadId = 1;
  const downloadItems = new Map();

  function changeDownload(id, changes) {
    const item = downloadItems.get(id);
    const delta = { id };
    for (const [key, value] of Object.entries(changes)) {
      delta[key] = { previous: item[key], current: value };
    }
    Object.assign(item, changes);
    for (const listener of [...listeners.downloadsChanged]) listener(delta);
  }

  const chrome = {
    runtime: {
      lastError: null,
      onMessage: {
        addListener(listener) {
          listeners.runtimeMessage.push(listener);
        }
      }
    },
    tabs: {
      sendMessage: vi.fn((tabId, message, callback) => {
        callback?.({ ok: true });
      })
    },
    downloads: {
      download: vi.fn((options, callback) => {
        const downloadId = nextDownloadId++;
        const item = { id: downloadId, filename: `C:/Downloads/${options.filename}`,
          state: "in_progress", exists: true };
        downloadItems.set(downloadId, item);
        const behavior = downloadBehavior(options, item) || {};
        callback?.(downloadId);
        if (behavior.autoComplete !== false) globalThis.queueMicrotask(() => changeDownload(downloadId, {
          state: "complete", ...behavior
        }));
        return downloadId;
      }),
      search: vi.fn(({ id }, callback) => callback(downloadItems.has(id)
        ? [{ ...downloadItems.get(id) }] : [])),
      cancel: vi.fn((id, callback) => {
        changeDownload(id, { state: "interrupted", error: "USER_CANCELED" });
        callback?.();
      }),
      onChanged: {
        addListener(listener) {
          listeners.downloadsChanged.push(listener);
        },
        removeListener(listener) {
          const index = listeners.downloadsChanged.indexOf(listener);
          if (index >= 0) listeners.downloadsChanged.splice(index, 1);
        }
      }
    },
    storage: {
      local: {
        get: vi.fn((defaults, callback) => {
          if (typeof defaults === "string") {
            callback({ [defaults]: storage[defaults] ?? "" });
            return;
          }
          const result = {};
          for (const [key, fallback] of Object.entries(defaults)) {
            result[key] = Object.prototype.hasOwnProperty.call(storage, key)
              ? storage[key]
              : fallback;
          }
          callback(result);
        }),
        set: vi.fn((items, callback) => {
          Object.assign(storage, items);
          callback?.();
        })
      },
      session: {
        get: vi.fn((defaults, callback) => {
          const result = {};
          for (const [key, fallback] of Object.entries(defaults)) {
            result[key] = Object.prototype.hasOwnProperty.call(
              sessionStorage,
              key
            )
              ? sessionStorage[key]
              : fallback;
          }
          callback(result);
        }),
        set: vi.fn((items, callback) => {
          Object.assign(sessionStorage, items);
          callback?.();
        })
      }
    },
    cookies: {
      getAll: vi.fn(({ url }, callback) => {
        callback(cookieJar[url] || cookieJar["*"] || []);
      })
    }
  };

  return { chrome, listeners, storage, sessionStorage, downloadItems, changeDownload };
}

export function createMockUrlApi() {
  class MockURL extends URL {}
  MockURL.createObjectURL = vi.fn(() => "blob:download");
  MockURL.revokeObjectURL = vi.fn();
  return MockURL;
}

export function loadServiceWorker({
  chrome,
  fetchImpl,
  userAgent = "Mozilla/5.0 Chrome/135.0.0.0",
  convertEasyedaCadToKicad = vi.fn(() => ({})),
  convertObjToWrlString = vi.fn(() => "#VRML"),
  readZipEntries = vi.fn(async () => []),
  urlApi = createMockUrlApi()
}) {
  registerServiceWorkerRuntime(chrome, {
    fetchImpl,
    userAgent,
    convertEasyedaCadToKicad,
    convertObjToWrlString,
    readZipEntries,
    urlApi,
    blobCtor: Blob
  });

  return { urlApi };
}

export function sendRuntimeMessage(listener, message) {
  return new Promise((resolve) => {
    const handled = listener(message, null, (response) => resolve({ handled, response }));
    if (handled === false) {
      resolve({ handled, response: undefined });
    }
  });
}

export function createSamacsysPartContext(distributor, overrides = {}) {
  const fixtures = {
    mouser: {
      provider: "mouserSamacsys",
      sourcePartLabel: "Mouser part",
      sourcePartNumber: "511-STM32U3C5RIT6Q",
      manufacturerPartNumber: "STM32U3C5RIT6Q",
      lookup: {
        manufacturerName: "STMicroelectronics",
        entryUrl:
          "https://ms.componentsearchengine.com/entry_u_newDesign.php?mna=STMicroelectronics&mpn=STM32U3C5RIT6Q&pna=mouser&vrq=multi&fmt=zip&lang=en-GB",
        partnerName: "mouser",
        samacsysBaseUrl: "https://ms.componentsearchengine.com"
      }
    },
    farnell: {
      provider: "farnellSamacsys",
      sourcePartLabel: "Farnell part",
      sourcePartNumber: "1848693",
      manufacturerPartNumber: "FQP27P06",
      lookup: {
        manufacturerName: "ONSEMI",
        entryUrl:
          "https://farnell.componentsearchengine.com/entry_u_newDesign.php?mna=ONSEMI&mpn=FQP27P06&pna=farnell&vrq=multi&fmt=zip&lang=en-GB",
        authRefreshUrl:
          "https://farnell.componentsearchengine.com/icon.php?lang=en-GB&mna=ONSEMI&mpn=FQP27P06&pna=farnell&logo=farnell&q3=SHOW3D",
        partnerName: "farnell",
        samacsysBaseUrl: "https://farnell.componentsearchengine.com"
      }
    }
  };
  const fixture = fixtures[distributor];
  return {
    ...fixture,
    ...overrides,
    lookup: {
      ...fixture.lookup,
      ...overrides.lookup
    }
  };
}

export function createSamacsysPartHtml({
  token = "tok123",
  partId = "21790508",
  zipActionUrl = "https://ms.componentsearchengine.com/ga/model.php"
} = {}) {
  return `
    <html>
      <body>
        <form id="zipForm" action="${zipActionUrl}" method="GET">
          <input type="hidden" name="partner" value="Mouser" />
          <input type="hidden" name="tok" value="${token}" />
          <input type="hidden" name="partID" value="${partId}" />
          <input type="hidden" name="fmt" value="zip" />
          <input type="hidden" name="lang" value="en-GB" />
          <input type="hidden" name="datasheet" value="" />
          <input type="hidden" name="emb" value="1" />
          <input type="hidden" name="pna" value="Mouser" />
        </form>
      </body>
    </html>
  `;
}

export function createMockHeaders(entries = {}) {
  return {
    get(name) {
      const match = Object.entries(entries).find(
        ([key]) => key.toLowerCase() === String(name || "").toLowerCase()
      );
      return match ? match[1] : null;
    }
  };
}

export function createDirectSamacsysZipFetchImpl({
  baseUrl = "https://ms.componentsearchengine.com",
  partId = "21790508",
  zipStatuses = [200],
  expectedZipAuthorizationHeaders = []
} = {}) {
  const zipCalls = [];

  const fetchImpl = vi.fn(async (url, options = {}) => {
    const requestUrl = String(url);

    if (requestUrl.includes("entry_u_newDesign.php")) {
      expect(options.headers?.Authorization).toBeUndefined();
      return {
        ok: true,
        status: 200,
        url: `${baseUrl}/part.php?partID=${partId}`,
        headers: createMockHeaders(),
        text: async () => "<html><body>entry ok</body></html>"
      };
    }

    if (requestUrl.includes("preview_newDesign.php")) {
      expect(options.credentials).toBe("include");
      expect(options.headers?.Authorization).toBeUndefined();
      return {
        ok: true,
        status: 200,
        url: requestUrl,
        headers: createMockHeaders(),
        text: async () =>
          createSamacsysPartHtml({
            partId,
            zipActionUrl: `${baseUrl}/ga/model.php`
          })
      };
    }

    if (requestUrl.includes("/ga/model.php")) {
      expect(options.credentials).toBe("include");
      const authorizationHeader =
        options.headers?.Authorization || options.headers?.authorization || "";
      zipCalls.push({ url: requestUrl, authorizationHeader });
      const attemptIndex = zipCalls.length - 1;
      if (expectedZipAuthorizationHeaders[attemptIndex] !== undefined) {
        expect(authorizationHeader).toBe(expectedZipAuthorizationHeaders[attemptIndex]);
      }
      const status = zipStatuses[Math.min(attemptIndex, zipStatuses.length - 1)];
      if (status === 200) {
        return {
          ok: true,
          status: 200,
          headers: createMockHeaders(),
          arrayBuffer: async () => new TextEncoder().encode("PKzip").buffer
        };
      }
      return {
        ok: false,
        status,
        headers: createMockHeaders()
      };
    }

    throw new Error(`Unexpected URL: ${url}`);
  });

  fetchImpl.getZipCalls = () => zipCalls.slice();
  return fetchImpl;
}

export function createSamacsysFetchImpl({
  baseUrl = "https://ms.componentsearchengine.com",
  proxyBaseUrl = "",
  partId = "21790508",
  symbolImage,
  footprintImage,
  zipStatus,
  zipPayload = "PKzip",
  wrlStatus,
  wrlText = "#VRML V2.0",
  proxyFailureMessage = "",
  expectedProxyAuthorizationHeader,
  expectedCookieHeader = "",
  expectedAuthorizationHeader = "",
  expectedNoForwardAuthorizationHeader = false
} = {}) {
  function createProxyResponse(url, response) {
    return {
      ok: response.ok,
      status: response.status,
      headers: createMockHeaders({
        "x-upstream-url": response.url || url
      }),
      text: response.text,
      json: response.json,
      arrayBuffer: response.arrayBuffer
    };
  }

  return vi.fn(async (url, options = {}) => {
    const requestUrl = String(url);
    if (proxyBaseUrl && requestUrl === proxyBaseUrl) {
      if (proxyFailureMessage) {
        throw new Error(proxyFailureMessage);
      }
      const proxyRequest = JSON.parse(options.body);
      expect(options.method).toBe("POST");
      expect(proxyRequest.url).toBeTruthy();
      if (expectedProxyAuthorizationHeader !== undefined) {
        expect(options.headers.Authorization || "").toBe(
          expectedProxyAuthorizationHeader
        );
      }
      const upstreamOptions = {
        credentials: proxyRequest.credentials,
        headers: proxyRequest.headers,
        method: proxyRequest.method
      };
      if (expectedCookieHeader) {
        expect(proxyRequest.headers.Cookie).toBe(expectedCookieHeader);
      }
      if (expectedAuthorizationHeader) {
        expect(proxyRequest.headers.Authorization).toBe(
          expectedAuthorizationHeader
        );
      } else if (expectedNoForwardAuthorizationHeader) {
        expect(proxyRequest.headers.Authorization).toBeUndefined();
      }
      if (proxyRequest.bodyText !== null) {
        upstreamOptions.body = proxyRequest.bodyText;
      }
      if (proxyRequest.bodyBase64) {
        upstreamOptions.body = Uint8Array.from(
          Buffer.from(proxyRequest.bodyBase64, "base64")
        );
      }
      return createProxyResponse(
        proxyRequest.url,
        await createSamacsysFetchImpl({
          baseUrl,
          partId,
          symbolImage,
          footprintImage,
          zipStatus,
          zipPayload,
          wrlStatus,
          wrlText
        })(proxyRequest.url, upstreamOptions)
      );
    }
    if (requestUrl.includes("entry_u_newDesign.php")) {
      return {
        ok: true,
        status: 200,
        url: `${baseUrl}/part.php?partID=${partId}`,
        headers: createMockHeaders(),
        text: async () => "<html><body>entry ok</body></html>"
      };
    }
    if (requestUrl.includes("preview_newDesign.php")) {
      expect(options.credentials).toBe("include");
      return {
        ok: true,
        status: 200,
        url: requestUrl,
        headers: createMockHeaders(),
        text: async () =>
          createSamacsysPartHtml({
            partId,
            zipActionUrl: `${baseUrl}/ga/model.php`
          })
      };
    }
    if (requestUrl.includes("/symbol.php") && symbolImage !== undefined) {
      return {
        ok: true,
        status: 200,
        headers: createMockHeaders(),
        json: async () => ({ Image: symbolImage })
      };
    }
    if (requestUrl.includes("/footprint.php") && footprintImage !== undefined) {
      return {
        ok: true,
        status: 200,
        headers: createMockHeaders(),
        json: async () => ({ Image: footprintImage })
      };
    }
    if (requestUrl.includes("/ga/model.php") && zipStatus !== undefined) {
      expect(options.credentials).toBe("include");
      if (zipStatus === 200) {
        return {
          ok: true,
          status: 200,
          headers: createMockHeaders(),
          arrayBuffer: async () => new TextEncoder().encode(zipPayload).buffer
        };
      }
      return {
        ok: false,
        status: zipStatus
      };
    }
    if (requestUrl.includes(`/3D/0/${partId}.wrl`) && wrlStatus !== undefined) {
      if (wrlStatus === 200) {
        return {
          ok: true,
          status: 200,
          headers: createMockHeaders(),
          text: async () => wrlText
        };
      }
      return {
        ok: false,
        status: wrlStatus
      };
    }
    throw new Error(`Unexpected URL: ${url}`);
  });
}

export const MOUSER_SYMBOL = `(kicad_symbol_lib (version 20211014) (generator SamacSys_ECAD_Model)
  (symbol "STM32C552KEU6" (in_bom yes) (on_board yes)
    (property "Reference" "IC" (at 0 0 0))
    (property "Value" "STM32C552KEU6" (at 0 -2.54 0))
    (property "Footprint" "QFN50P500X500X60-33N-D" (at 0 -5.08 0))
  )
)
`;

export const MOUSER_FOOTPRINT = `(module "QFN50P500X500X60-33N-D" (layer F.Cu)
  (fp_text reference IC** (at 0 0) (layer F.SilkS))
  (model STM32C552KEU6.stp
    (at (xyz 0 0 0))
    (scale (xyz 1 1 1))
    (rotate (xyz 0 0 0))
  )
)
`;

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
