// SamacSys/relay work in this file: JoeShade and Josh Webster
/*
 * Shared popup and worker settings helpers. This module keeps the Downloads-
 * relative library-root rules in one place so UI validation and backend path
 * resolution stay aligned.
 */

const DEFAULT_LIBRARY_DOWNLOAD_ROOT = "easyECADDownloader";
const DEFAULT_SAMACSYS_FIREFOX_PROXY_BASE_URL = "";
const DEFAULT_SAMACSYS_FIREFOX_PROXY_AUTHORIZATION_HEADER = "";
const DEFAULT_SAMACSYS_FIREFOX_USERNAME = "";
const DEFAULT_SAMACSYS_FIREFOX_PASSWORD = "";
const DEFAULT_REMEMBER_SAMACSYS_CREDENTIALS = false;
const DEFAULT_REMEMBER_SAMACSYS_FIREFOX_PROXY_AUTHORIZATION_HEADER = false;

const DEFAULT_SECRET_SETTINGS = {
  samacsysFirefoxProxyAuthorizationHeader:
    DEFAULT_SAMACSYS_FIREFOX_PROXY_AUTHORIZATION_HEADER,
  samacsysFirefoxUsername: DEFAULT_SAMACSYS_FIREFOX_USERNAME,
  samacsysFirefoxPassword: DEFAULT_SAMACSYS_FIREFOX_PASSWORD
};

const DEFAULT_SETTINGS = {
  downloadIndividually: false,
  libraryDownloadRoot: DEFAULT_LIBRARY_DOWNLOAD_ROOT,
  samacsysFirefoxProxyBaseUrl: DEFAULT_SAMACSYS_FIREFOX_PROXY_BASE_URL,
  ...DEFAULT_SECRET_SETTINGS,
  rememberSamacsysCredentials: DEFAULT_REMEMBER_SAMACSYS_CREDENTIALS,
  rememberSamacsysFirefoxProxyAuthorizationHeader:
    DEFAULT_REMEMBER_SAMACSYS_FIREFOX_PROXY_AUTHORIZATION_HEADER
};

const SESSION_SECRET_SETTINGS = { ...DEFAULT_SECRET_SETTINGS };

// Browser download paths are relative to Downloads. Normalize both separator
// styles and require named segments; invalid roots resolve to the shared default.
function parseLibraryDownloadRoot(value) {
  const input = String(value || "");
  const raw = input.trim();
  const normalized = raw.replace(/[\\/]+/g, "/").replace(/^\/+|\/+$/g, "");
  // Require portable filename characters before trimming, including at the
  // input edges, to preserve the intended model layout across browser platforms.
  const hasInvalidCharacters = /[<>:"|?*]/.test(input) ||
    [...input].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);
  const isAbsolute =
    raw.startsWith("/") || raw.startsWith("\\") || /^[a-zA-Z]:/.test(raw);
  const hasValidSegments =
    Boolean(normalized) &&
    normalized.split("/").every((segment) => segment !== "." && segment !== "..");
  const isValid = Boolean(raw && !isAbsolute && !hasInvalidCharacters && hasValidSegments);

  return {
    value: isValid ? normalized : DEFAULT_LIBRARY_DOWNLOAD_ROOT,
    isValid
  };
}

function normalizeLibraryDownloadRoot(value) {
  return parseLibraryDownloadRoot(value).value;
}

// Relay endpoints may use HTTP(S); URL parsing canonicalizes the configured
// endpoint and removes its browser-only fragment before requests use it.
function parseSamacsysFirefoxProxyBaseUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) {
    return {
      value: DEFAULT_SAMACSYS_FIREFOX_PROXY_BASE_URL,
      isValid: true
    };
  }

  try {
    const url = new URL(raw);
    if (!/^https?:$/i.test(url.protocol)) {
      throw new Error("Invalid protocol");
    }
    url.hash = "";
    return {
      value: url.toString(),
      isValid: true
    };
  } catch (error) {
    return {
      value: DEFAULT_SAMACSYS_FIREFOX_PROXY_BASE_URL,
      isValid: false
    };
  }
}

function normalizeSamacsysFirefoxProxyBaseUrl(value) {
  return parseSamacsysFirefoxProxyBaseUrl(value).value;
}

function parseAuthorizationHeaderValue(value) {
  const normalized = String(value || "")
    .trim()
    .replace(/^authorization\s*:\s*/i, "");
  if (/[\r\n]/.test(normalized)) {
    return "";
  }
  return normalized;
}

function parseSamacsysProxyAuthorizationHeader(value) {
  return parseAuthorizationHeaderValue(value);
}

function parseSamacsysCredentialValue(value, fallback = "") {
  return String(value || "").trim() || fallback;
}

function resolveSamacsysAuthorizationHeader(settings = {}) {
  return buildSamacsysBasicAuthorizationHeader(
    settings.samacsysFirefoxUsername,
    settings.samacsysFirefoxPassword
  );
}

function encodeBase64(value) {
  if (typeof globalThis.btoa === "function") {
    return globalThis.btoa(value);
  }
  return Buffer.from(value, "binary").toString("base64");
}

// Basic authentication joins the credential fields with a colon, encodes that
// text as UTF-8 bytes, then Base64-encodes the byte string for the HTTP header.
function buildSamacsysBasicAuthorizationHeader(username, password) {
  const normalizedUsername = parseSamacsysCredentialValue(
    username,
    DEFAULT_SAMACSYS_FIREFOX_USERNAME
  );
  const normalizedPassword = parseSamacsysCredentialValue(
    password,
    DEFAULT_SAMACSYS_FIREFOX_PASSWORD
  );
  if (!normalizedUsername || !normalizedPassword) {
    return "";
  }

  const utf8Bytes = new TextEncoder().encode(
    `${normalizedUsername}:${normalizedPassword}`
  );
  let binary = "";
  for (const byte of utf8Bytes) {
    binary += String.fromCharCode(byte);
  }
  return `Basic ${encodeBase64(binary)}`;
}

function getSessionStorageArea(chromeApi) {
  return chromeApi?.storage?.session || null;
}

function getStorageArea(area, defaults, chromeApi) {
  return new Promise((resolve, reject) => {
    if (!area?.get) {
      resolve({ ...defaults });
      return;
    }
    area.get(defaults, (settings) => {
      if (chromeApi.runtime.lastError) {
        reject(new Error(`Failed to load settings: ${chromeApi.runtime.lastError.message}`));
        return;
      }
      resolve(settings || { ...defaults });
    });
  });
}

function parseBooleanSetting(value, fallback) {
  return typeof value === "boolean" ? value : fallback;
}

// Ordinary preferences and remember flags come from local storage. Each remember
// flag chooses the authoritative area for its secrets; missing areas use defaults.
// Storage read errors reject so callers preserve the last saved preferences and
// credentials until a complete settings snapshot can be loaded successfully.
async function loadSettings(chromeApi) {
  const [settings, sessionSettings] = await Promise.all([
    getStorageArea(chromeApi.storage.local, DEFAULT_SETTINGS, chromeApi),
    getStorageArea(
      getSessionStorageArea(chromeApi),
      SESSION_SECRET_SETTINGS,
      chromeApi
    )
  ]);
  const rememberSamacsysCredentials = parseBooleanSetting(
    settings.rememberSamacsysCredentials,
    DEFAULT_SETTINGS.rememberSamacsysCredentials
  );
  const rememberSamacsysFirefoxProxyAuthorizationHeader = parseBooleanSetting(
    settings.rememberSamacsysFirefoxProxyAuthorizationHeader,
    DEFAULT_SETTINGS.rememberSamacsysFirefoxProxyAuthorizationHeader
  );
  const credentialSettings = rememberSamacsysCredentials
    ? settings
    : sessionSettings;
  const proxyAuthorizationSettings =
    rememberSamacsysFirefoxProxyAuthorizationHeader ? settings : sessionSettings;

  return {
    downloadIndividually: parseBooleanSetting(
      settings.downloadIndividually,
      DEFAULT_SETTINGS.downloadIndividually
    ),
    libraryDownloadRoot: normalizeLibraryDownloadRoot(
      settings.libraryDownloadRoot
    ),
    samacsysFirefoxProxyBaseUrl: normalizeSamacsysFirefoxProxyBaseUrl(
      settings.samacsysFirefoxProxyBaseUrl
    ),
    samacsysFirefoxProxyAuthorizationHeader:
      parseSamacsysProxyAuthorizationHeader(
        proxyAuthorizationSettings.samacsysFirefoxProxyAuthorizationHeader
      ),
    samacsysFirefoxUsername: parseSamacsysCredentialValue(
      credentialSettings.samacsysFirefoxUsername,
      DEFAULT_SAMACSYS_FIREFOX_USERNAME
    ),
    samacsysFirefoxPassword: parseSamacsysCredentialValue(
      credentialSettings.samacsysFirefoxPassword,
      DEFAULT_SAMACSYS_FIREFOX_PASSWORD
    ),
    rememberSamacsysCredentials,
    rememberSamacsysFirefoxProxyAuthorizationHeader
  };
}

function buildLibraryPaths(libraryDownloadRoot = DEFAULT_LIBRARY_DOWNLOAD_ROOT) {
  const libraryName = libraryDownloadRoot.split("/").pop() || DEFAULT_LIBRARY_DOWNLOAD_ROOT;
  return {
    symbolFile: `${libraryDownloadRoot}/${libraryName}.kicad_sym`,
    footprintDir: `${libraryDownloadRoot}/${libraryName}.pretty`,
    modelDir: `${libraryDownloadRoot}/${libraryName}.3dshapes`,
    datasheetDir: `${libraryDownloadRoot}/datasheets`
  };
}

export {
  DEFAULT_LIBRARY_DOWNLOAD_ROOT,
  DEFAULT_SAMACSYS_FIREFOX_PROXY_BASE_URL,
  DEFAULT_SAMACSYS_FIREFOX_PROXY_AUTHORIZATION_HEADER,
  DEFAULT_SAMACSYS_FIREFOX_USERNAME,
  DEFAULT_SAMACSYS_FIREFOX_PASSWORD,
  DEFAULT_REMEMBER_SAMACSYS_CREDENTIALS,
  DEFAULT_REMEMBER_SAMACSYS_FIREFOX_PROXY_AUTHORIZATION_HEADER,
  DEFAULT_SETTINGS,
  buildSamacsysBasicAuthorizationHeader,
  parseLibraryDownloadRoot,
  parseSamacsysFirefoxProxyBaseUrl,
  parseSamacsysCredentialValue,
  parseSamacsysProxyAuthorizationHeader,
  resolveSamacsysAuthorizationHeader,
  normalizeLibraryDownloadRoot,
  normalizeSamacsysFirefoxProxyBaseUrl,
  loadSettings,
  buildLibraryPaths
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
