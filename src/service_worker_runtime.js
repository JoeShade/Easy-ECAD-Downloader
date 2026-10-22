// SamacSys/relay work in this file: JoeShade and Josh Webster
/*
 * This runtime module is the browser-local backend boundary. It normalizes the
 * popup message payload, applies runtime-specific gating, and dispatches work
 * to the provider adapters with shared worker dependencies.
 */

import {
  EASYEDA_PROVIDER,
  FARNELL_PROVIDER,
  MOUSER_PROVIDER,
  getBlockedPartContextError,
  normalizePartContext
} from "./core/part_context.js";
import { createDownloadApi } from "./core/downloads.js";
import { loadSettings } from "./core/settings.js";
import { readZipEntries } from "./vendor/zip_reader.js";
import { createEasyedaAdapter } from "./sources/easyeda_adapter.js";
import { createSamacsysDistributorAdapter } from "./sources/samacsys_distributor_adapter.js";
import { convertEasyedaCadToKicad, convertObjToWrlString } from "./kicad_converter.js";

function createSourceAdapters(deps) {
  return {
    [EASYEDA_PROVIDER]: createEasyedaAdapter(deps),
    [FARNELL_PROVIDER]: createSamacsysDistributorAdapter(deps),
    [MOUSER_PROVIDER]: createSamacsysDistributorAdapter(deps)
  };
}

function createRuntimeDeps(overrides = {}) {
  const chromeApi = overrides.chromeApi || globalThis.chrome;
  const deps = {
    chromeApi,
    fetchImpl: overrides.fetchImpl || globalThis.fetch,
    downloads:
      overrides.downloads ||
      createDownloadApi(
        chromeApi,
        overrides.urlApi || globalThis.URL,
        overrides.blobCtor || globalThis.Blob
      ),
    readZipEntries: overrides.readZipEntries || readZipEntries,
    userAgent: overrides.userAgent || globalThis.navigator?.userAgent,
    convertEasyedaCadToKicad:
      overrides.convertEasyedaCadToKicad || convertEasyedaCadToKicad,
    convertObjToWrlString: overrides.convertObjToWrlString || convertObjToWrlString
  };

  return {
    ...deps,
    sourceAdapters: overrides.sourceAdapters || createSourceAdapters(deps)
  };
}

function getSourceAdapter(provider, deps) {
  if (deps?.sourceAdapters?.[provider]) {
    return deps.sourceAdapters[provider];
  }
  return createSourceAdapters(deps)[provider];
}

async function getPartPreviews(partContext, deps = createRuntimeDeps()) {
  const normalizedPartContext = normalizePartContext(partContext);
  if (!normalizedPartContext) {
    throw new Error("No supported part found on the page.");
  }
  const settings = deps.settings || (await loadSettings(deps.chromeApi));

  const blockedError = getBlockedPartContextError(
    normalizedPartContext,
    deps.userAgent || globalThis.navigator?.userAgent,
    settings.samacsysFirefoxProxyBaseUrl
  );
  if (blockedError) {
    throw new Error(blockedError);
  }

  const adapter = getSourceAdapter(normalizedPartContext.provider, deps);
  if (!adapter) {
    throw new Error("Unsupported provider.");
  }
  return adapter.getPreviews(normalizedPartContext);
}

async function exportPart(partContext, options = {}, deps = createRuntimeDeps()) {
  const normalizedPartContext = normalizePartContext(partContext);
  if (!normalizedPartContext) {
    throw new Error("No supported part found on the page.");
  }
  const settings = deps.settings || (await loadSettings(deps.chromeApi));

  const blockedError = getBlockedPartContextError(
    normalizedPartContext,
    deps.userAgent || globalThis.navigator?.userAgent,
    settings.samacsysFirefoxProxyBaseUrl
  );
  if (blockedError) {
    throw new Error(blockedError);
  }

  const adapter = getSourceAdapter(normalizedPartContext.provider, deps);
  if (!adapter) {
    throw new Error("Unsupported provider.");
  }

  return adapter.exportPart(normalizedPartContext, options);
}

// Each listener shares the worker's adapters and download cleanup subscription.
// Returning true keeps the message channel open until async work sends its one
// structured success or failure response to the popup.
function registerServiceWorkerRuntime(chromeApi = globalThis.chrome, overrides = {}) {
  const deps = createRuntimeDeps({ ...overrides, chromeApi });

  chromeApi.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "GET_PART_PREVIEWS") {
      getPartPreviews(message.partContext, deps)
        .then((result) => {
          sendResponse({
            ok: true,
            previews: result.previews,
            metadata: result.metadata
          });
        })
        .catch((error) => {
          console.error("Easy ECAD Downloader preview error:", error);
          sendResponse({ ok: false, error: error?.message || "Preview failed." });
        });
      return true;
    }

    if (message?.type === "EXPORT_PART") {
      exportPart(message.partContext, message.options, deps)
        .then((result) => sendResponse({ ok: true, ...result }))
        .catch((error) => {
          console.error("Easy ECAD Downloader extension error:", error);
          sendResponse({ ok: false, error: error?.message || "Download failed." });
        });
      return true;
    }

    return false;
  });
}

export {
  createRuntimeDeps,
  createSourceAdapters,
  exportPart,
  getPartPreviews,
  registerServiceWorkerRuntime
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
