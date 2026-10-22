// SamacSys/relay work in this file: JoeShade and Josh Webster
/*
 * Shared SamacSys distributor helpers used by both Mouser and Farnell flows.
 * This module owns entry-page parsing, preview fetching, ZIP extraction, and
 * KiCad asset rewriting for the pre-generated upstream SamacSys bundles.
 */

import {
  rewriteFirstKicadFootprintModelPath,
  stripKicadFootprintModels
} from "../core/kicad_footprint_models.js";
import { makeBase64DataUrl } from "../core/preview_data.js";
import { isFirefoxRuntime } from "../core/part_context.js";
import { readZipEntries } from "../vendor/zip_reader.js";

const DEFAULT_SAMACSYS_BASE_URL = "https://ms.componentsearchengine.com";
const DEFAULT_SAMACSYS_PROXY_REQUEST_URL_HEADER = "x-upstream-url";

// Entry URLs and page form actions cross the upstream authentication boundary.
// Validate their parsed origin before cookies or configured credentials are read.
function ensureSamacsysUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol === "https:" && !url.username && !url.password && !url.port &&
        /(^|\.)componentsearchengine\.com$/i.test(url.hostname)) {
      return url.toString();
    }
  } catch { /* Invalid URLs share the destination-validation error below. */ }
  throw new Error("SamacSys request URL must use HTTPS on componentsearchengine.com.");
}

function getSamacsysBaseUrl(partContext, fallbackUrl = DEFAULT_SAMACSYS_BASE_URL) {
  const configuredBaseUrl = partContext?.lookup?.samacsysBaseUrl;
  if (configuredBaseUrl) {
    return new URL(ensureSamacsysUrl(configuredBaseUrl)).origin;
  }
  try {
    return new URL(partContext?.lookup?.entryUrl || fallbackUrl).origin;
  } catch (error) {
    return fallbackUrl;
  }
}

function ensureAbsoluteUrl(url, origin = DEFAULT_SAMACSYS_BASE_URL) {
  if (!url) {
    return "";
  }
  return ensureSamacsysUrl(new URL(url, origin).toString());
}

function encodeProxyRequestBody(body) {
  if (body === null || body === undefined) {
    return {
      bodyText: null,
      bodyBase64: null
    };
  }
  if (typeof body === "string") {
    return {
      bodyText: body,
      bodyBase64: null
    };
  }

  const bytes = body instanceof Uint8Array ? body : new Uint8Array(body);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return {
    bodyText: null,
    bodyBase64: btoa(binary)
  };
}

function normalizeForwardHeaders(headers) {
  if (!headers) {
    return {};
  }
  if (typeof headers.entries === "function") {
    return Object.fromEntries(headers.entries());
  }
  return Object.fromEntries(
    Object.entries(headers).filter(([, value]) => value !== undefined)
  );
}

function hasHeader(headers, headerName) {
  return Object.keys(headers || {}).some(
    (key) => String(key).toLowerCase() === String(headerName).toLowerCase()
  );
}

function buildCookieHeader(cookies = []) {
  return cookies
    .filter((cookie) => cookie?.name)
    .map((cookie) => `${cookie.name}=${cookie.value || ""}`)
    .join("; ");
}

async function getCookieHeader(chromeApi, requestUrl) {
  if (!chromeApi?.cookies?.getAll) {
    return "";
  }

  return new Promise((resolve) => {
    chromeApi.cookies.getAll({ url: requestUrl }, (cookies) => {
      if (chromeApi.runtime?.lastError) {
        console.warn(
          "Failed to read SamacSys cookies for Firefox proxy relay:",
          chromeApi.runtime.lastError
        );
        resolve("");
        return;
      }
      resolve(buildCookieHeader(cookies));
    });
  });
}

// The relay's outer response URL identifies the helper. Its dedicated header
// identifies the resolved upstream page used for part-ID and form parsing.
function wrapProxyResponse(response, requestUrl) {
  return {
    ok: response.ok,
    status: response.status,
    headers: response.headers,
    url:
      response.headers?.get?.(DEFAULT_SAMACSYS_PROXY_REQUEST_URL_HEADER) ||
      requestUrl,
    text() {
      return response.text();
    },
    json() {
      return response.json();
    },
    arrayBuffer() {
      return response.arrayBuffer();
    }
  };
}

function resolveUpstreamAuthorizationHeader(authorizationHeader = "") {
  return String(authorizationHeader || "").trim();
}

function buildRetryHeaders(headers, authorizationHeader) {
  const normalizedHeaders = normalizeForwardHeaders(headers);
  if (!authorizationHeader || hasHeader(normalizedHeaders, "authorization")) {
    return normalizedHeaders;
  }
  return {
    ...normalizedHeaders,
    Authorization: authorizationHeader
  };
}

// Direct requests use the browser's upstream session. Firefox relays receive
// matching cookies and upstream auth inside JSON; the relay's own token remains
// on the outer POST header, keeping both authentication purposes distinct.
function createSamacsysFetchImpl(
  fetchImpl,
  {
    chromeApi,
    userAgent,
    proxyBaseUrl = "",
    proxyAuthorizationHeader = "",
    authorizationHeader = ""
  } = {}
) {
  if (!isFirefoxRuntime(userAgent) || !proxyBaseUrl) {
    return (url, options) => fetchImpl(ensureSamacsysUrl(url), options);
  }

  return async (url, options = {}) => {
    const requestUrl = ensureSamacsysUrl(url);
    const forwardHeaders = normalizeForwardHeaders(options.headers);
    const upstreamAuthorizationHeader =
      resolveUpstreamAuthorizationHeader(authorizationHeader);
    if (options.credentials === "include" && !hasHeader(forwardHeaders, "cookie")) {
      const cookieHeader = await getCookieHeader(chromeApi, requestUrl);
      if (cookieHeader) {
        forwardHeaders.Cookie = cookieHeader;
      }
    }
    if (upstreamAuthorizationHeader && !hasHeader(forwardHeaders, "authorization")) {
      forwardHeaders.Authorization = upstreamAuthorizationHeader;
    }
    const requestOptions = {
      method: options.method || "GET",
      headers: forwardHeaders,
      credentials: options.credentials || "omit",
      ...encodeProxyRequestBody(options.body)
    };

    let response;
    try {
      const relayHeaders = {
        "Content-Type": "application/json",
        Accept: "*/*"
      };
      if (proxyAuthorizationHeader) {
        relayHeaders.Authorization = proxyAuthorizationHeader;
      }
      response = await fetchImpl(proxyBaseUrl, {
        method: "POST",
        // Upstream cookies and auth live in JSON. Bind that body to the exact
        // configured relay endpoint by treating transport redirects as errors.
        redirect: "error",
        headers: relayHeaders,
        body: JSON.stringify({
          url: requestUrl,
          ...requestOptions
        })
      });
    } catch (error) {
      throw new Error(
        `SamacSys proxy request failed: ${error?.message || "Network error."}`,
        { cause: error }
      );
    }

    return wrapProxyResponse(response, requestUrl);
  };
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractTagAttributeValue(tagText, attributeName) {
  const match = String(tagText || "").match(
    new RegExp(`${attributeName}\\s*=\\s*["']([^"']*)["']`, "i")
  );
  return match ? match[1] : "";
}

// Carry SamacSys's named form inputs forward using their upstream field names.
// The worker only needs this known form's action, method and input values.
function parseFormById(html, formId) {
  const match = String(html || "").match(
    new RegExp(
      `<form\\b[^>]*id=["']${escapeRegExp(formId)}["'][^>]*>[\\s\\S]*?<\\/form>`,
      "i"
    )
  );
  if (!match) {
    return null;
  }

  const formText = match[0];
  const openTagMatch = formText.match(/<form\b[^>]*>/i);
  const openTag = openTagMatch ? openTagMatch[0] : "";
  const inputs = {};

  for (const inputMatch of formText.matchAll(/<input\b[^>]*name=["']([^"']+)["'][^>]*>/gi)) {
    const tagText = inputMatch[0];
    const name = inputMatch[1];
    inputs[name] = extractTagAttributeValue(tagText, "value");
  }

  return {
    action: extractTagAttributeValue(openTag, "action"),
    method: extractTagAttributeValue(openTag, "method") || "GET",
    inputs
  };
}

function parseSamacsysPartId(url, zipForm) {
  try {
    const partId = new URL(url).searchParams.get("partID");
    if (partId) {
      return partId;
    }
  } catch (error) {
    console.warn("Failed to parse SamacSys part URL:", error);
  }

  return zipForm?.inputs?.partID || "";
}

function buildSamacsysPreviewPageUrl(baseUrl, partId, partnerName = "mouser") {
  return `${baseUrl}/preview_newDesign.php?o3=0&partID=${encodeURIComponent(partId)}&ev=0&fmt=zip&pna=${encodeURIComponent(partnerName)}`;
}

// Bind the preview token and named ZIP inputs to an approved upstream action.
// The final page URL supplies the part ID when the form omits that hidden field.
function parseSamacsysPageMetadata(html, finalUrl, baseUrl = DEFAULT_SAMACSYS_BASE_URL) {
  ensureSamacsysUrl(finalUrl);
  ensureSamacsysUrl(baseUrl);
  const zipForm = parseFormById(html, "zipForm");
  const partId = parseSamacsysPartId(finalUrl, zipForm);
  const token = zipForm?.inputs?.tok || "";
  if (!partId) {
    throw new Error("SamacSys part ID was not found.");
  }
  if (!zipForm?.action) {
    throw new Error("SamacSys ZIP download form was not found.");
  }
  if (!token) {
    throw new Error("SamacSys preview token was not found.");
  }

  return {
    partId,
    token,
    pageUrl: finalUrl,
    baseUrl,
    zipActionUrl: ensureAbsoluteUrl(zipForm.action, baseUrl),
    zipMethod: String(zipForm.method || "GET").toUpperCase(),
    zipFormInputs: {
      ...zipForm.inputs,
      tok: token,
      partID: zipForm.inputs.partID || partId,
      fmt: zipForm.inputs.fmt || "zip"
    }
  };
}

// The distributor entry resolves a stable part ID; the second preview page
// supplies its current token and ZIP form, which can differ from the entry HTML.
async function fetchSamacsysPageMetadata(fetchImpl, partContext) {
  const entryUrl = partContext?.lookup?.entryUrl;
  if (!entryUrl) {
    throw new Error("SamacSys entry URL was not found on the page.");
  }
  ensureSamacsysUrl(entryUrl);
  const baseUrl = getSamacsysBaseUrl(partContext, entryUrl);
  ensureSamacsysUrl(baseUrl);
  const partnerName = partContext?.lookup?.partnerName || "mouser";

  const response = await fetchImpl(entryUrl, {
    credentials: "include",
    headers: {
      Accept: "text/html"
    }
  });
  if (!response.ok) {
    throw new Error(`SamacSys entry request failed: ${response.status}`);
  }

  const entryHtml = await response.text();
  const entryFinalUrl = ensureSamacsysUrl(response.url || entryUrl);
  const entryZipForm = parseFormById(entryHtml, "zipForm");
  const partId = parseSamacsysPartId(entryFinalUrl, entryZipForm);
  if (!partId) {
    throw new Error("SamacSys part ID was not found.");
  }

  const previewPageUrl = buildSamacsysPreviewPageUrl(baseUrl, partId, partnerName);
  const previewResponse = await fetchImpl(previewPageUrl, {
    credentials: "include",
    headers: {
      Accept: "text/html"
    }
  });
  if (!previewResponse.ok) {
    throw new Error(`SamacSys preview page request failed: ${previewResponse.status}`);
  }

  const previewHtml = await previewResponse.text();
  return parseSamacsysPageMetadata(
    previewHtml,
    previewResponse.url || previewPageUrl,
    baseUrl
  );
}

async function fetchSamacsysPreview(fetchImpl, url) {
  const response = await fetchImpl(url, {
    credentials: "include",
    headers: {
      Accept: "application/json"
    }
  });
  if (!response.ok) {
    throw new Error(`SamacSys preview request failed: ${response.status}`);
  }
  const payload = await response.json();
  return payload?.Image || "";
}

async function buildSamacsysPreviewResponse(fetchImpl, partContext) {
  const metadata = await fetchSamacsysPageMetadata(fetchImpl, partContext);
  const symbolUrl = `${metadata.baseUrl}/symbol.php?scale=4&format=JSON&partID=${encodeURIComponent(metadata.partId)}&showKeepout=0&u=0&tok=${encodeURIComponent(metadata.token)}`;
  const footprintUrl = `${metadata.baseUrl}/footprint.php?scale=100&format=JSON&partID=${encodeURIComponent(metadata.partId)}&showKeepout=0&u=0&tok=${encodeURIComponent(metadata.token)}&sz=N`;

  const [symbolImage, footprintImage] = await Promise.all([
    fetchSamacsysPreview(fetchImpl, symbolUrl),
    fetchSamacsysPreview(fetchImpl, footprintUrl)
  ]);

  return {
    previews: {
      symbolUrl: makeBase64DataUrl("image/png", symbolImage),
      footprintUrl: makeBase64DataUrl("image/png", footprintImage)
    },
    metadata: {
      datasheetAvailable: false
    }
  };
}

function ensureZipPayload(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const signature = String.fromCharCode(...bytes.subarray(0, 2));
  if (signature !== "PK") {
    throw new Error("SamacSys ZIP download did not return a ZIP archive.");
  }
  return bytes;
}

function basenameFromZipPath(filePath) {
  return zipPathSegments(filePath).pop() || "";
}

function filenameWithoutExtension(filename) {
  return String(filename || "").replace(/\.[^.]+$/, "");
}

function zipPathSegments(filePath) {
  return String(filePath || "")
    .replace(/\\/g, "/")
    .split("/")
    .filter(Boolean);
}

function isZipPathInsideDirectory(filePath, directoryName) {
  const normalizedDirectoryName = String(directoryName || "").toLowerCase();
  const segments = zipPathSegments(filePath);
  return segments.some(
    (segment, index) =>
      segment.toLowerCase() === normalizedDirectoryName &&
      index < segments.length - 1
  );
}

function hasZipFileExtension(filePath, extensions) {
  const lowerPath = String(filePath || "").toLowerCase();
  return extensions.some((extension) => lowerPath.endsWith(extension));
}

function buildQueryString(entries) {
  return Object.entries(entries)
    .filter(([, value]) => value !== null && value !== undefined)
    .map(
      ([key, value]) =>
        `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`
    )
    .join("&");
}

function decodeZipText(bytes) {
  return new TextDecoder().decode(bytes);
}

// Bundles can nest KiCad/ and 3D/ beneath a part folder. Select supported member
// types from either layout, then flatten filenames into the export directories.
async function extractSamacsysKiCadAssets(zipBuffer, readZipEntriesImpl = readZipEntries) {
  const entries = await readZipEntriesImpl(zipBuffer);
  const symbolEntries = entries.filter(
    (entry) =>
      isZipPathInsideDirectory(entry.name, "KiCad") &&
      hasZipFileExtension(entry.name, [".kicad_sym"])
  );
  const footprintEntries = entries.filter(
    (entry) =>
      isZipPathInsideDirectory(entry.name, "KiCad") &&
      hasZipFileExtension(entry.name, [".kicad_mod"])
  );
  const stepEntries = entries.filter(
    (entry) =>
      isZipPathInsideDirectory(entry.name, "3D") &&
      hasZipFileExtension(entry.name, [".stp", ".step"])
  );
  const wrlEntries = entries.filter(
    (entry) =>
      isZipPathInsideDirectory(entry.name, "3D") &&
      entry.name.toLowerCase().endsWith(".wrl")
  );

  if (
    !symbolEntries.length &&
    !footprintEntries.length &&
    !stepEntries.length &&
    !wrlEntries.length
  ) {
    throw new Error("SamacSys ZIP did not contain KiCad assets.");
  }

  return {
    symbols: symbolEntries.map((entry) => ({
      path: entry.name,
      filename: basenameFromZipPath(entry.name),
      name: filenameWithoutExtension(basenameFromZipPath(entry.name)),
      content: decodeZipText(entry.data)
    })),
    footprints: footprintEntries.map((entry) => ({
      path: entry.name,
      filename: basenameFromZipPath(entry.name),
      name: filenameWithoutExtension(basenameFromZipPath(entry.name)),
      content: decodeZipText(entry.data)
    })),
    stepModels: stepEntries.map((entry) => ({
      path: entry.name,
      filename: basenameFromZipPath(entry.name),
      name: filenameWithoutExtension(basenameFromZipPath(entry.name)),
      data: entry.data
    })),
    wrlModels: wrlEntries.map((entry) => ({
      path: entry.name,
      filename: basenameFromZipPath(entry.name),
      name: filenameWithoutExtension(basenameFromZipPath(entry.name)),
      content: decodeZipText(entry.data)
    }))
  };
}

function rewriteSamacsysSymbolFootprintReference(symbolLibraryText, footprintName, libraryName) {
  if (!footprintName || !libraryName) {
    return symbolLibraryText;
  }
  const reference = `${libraryName}:${footprintName}`.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  // A callback keeps dollar signs literal while the escaped value stays one
  // KiCad string token inside the existing property block.
  return String(symbolLibraryText).replace(
    /(\(property "Footprint" ")((?:\\.|[^"\\])*)(")/,
    (_match, prefix, _oldReference, suffix) => `${prefix}${reference}${suffix}`
  );
}

function rewriteSamacsysFootprintModelPath(footprintText, modelFilename, libraryName) {
  if (!modelFilename || !libraryName) {
    return footprintText;
  }
  return rewriteFirstKicadFootprintModelPath(
    footprintText, `../${libraryName}.3dshapes/${modelFilename}`
  );
}

function getSamacsysAuthenticationErrorMessage() {
  return "Mouser/SamacSys download requires you to be signed in before CAD files can be downloaded.";
}

// Reproduce the upstream GET/POST form submission. Direct Chrome requests can
// retry one authentication challenge with configured Basic auth; the adapter
// supplies an empty retry header when Firefox's relay owns authentication.
async function fetchSamacsysZipArchive(
  fetchImpl,
  metadata,
  { retryAuthorizationHeader = "" } = {}
) {
  const body = buildQueryString(metadata.zipFormInputs || {});
  const method = String(metadata.zipMethod || "GET").toUpperCase();
  const actionUrl = new URL(ensureSamacsysUrl(metadata.zipActionUrl));
  if (method === "GET" && body) {
    actionUrl.search += `${actionUrl.search ? "&" : ""}${body}`;
  }
  const requestUrl = actionUrl.toString();
  const requestOptions = {
    method,
    credentials: "include"
  };

  if (method !== "GET") {
    requestOptions.headers = {
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8"
    };
    requestOptions.body = body;
  }

  let response = await fetchImpl(requestUrl, requestOptions);
  if (!response.ok && response.status === 401 && retryAuthorizationHeader) {
    response = await fetchImpl(requestUrl, {
      ...requestOptions,
      headers: buildRetryHeaders(
        requestOptions.headers,
        retryAuthorizationHeader
      )
    });
  }

  if (!response.ok) {
    if (response.status === 401) {
      throw new Error(getSamacsysAuthenticationErrorMessage());
    }
    throw new Error(`SamacSys ZIP request failed: ${response.status}`);
  }

  return ensureZipPayload(await response.arrayBuffer());
}

export {
  basenameFromZipPath,
  buildSamacsysPreviewResponse,
  createSamacsysFetchImpl,
  extractSamacsysKiCadAssets,
  fetchSamacsysPageMetadata,
  fetchSamacsysZipArchive,
  filenameWithoutExtension,
  getSamacsysAuthenticationErrorMessage,
  parseSamacsysPageMetadata,
  rewriteSamacsysFootprintModelPath,
  rewriteSamacsysSymbolFootprintReference,
  stripKicadFootprintModels
};

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
