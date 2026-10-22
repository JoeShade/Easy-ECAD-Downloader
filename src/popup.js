// SamacSys/relay work in this file: JoeShade and Josh Webster
/*
 * This script powers the extension popup UI. It fetches the provider-aware
 * part context from the active tab, lets the user choose what to download, and
 * sends a request to the background service worker to start the export while
 * reusing the shared provider and settings helpers from src/core.
 */

import {
  DEFAULT_SETTINGS,
  loadSettings as loadStoredSettings
} from "./core/settings.js";
import {
  getBlockedPartContextError,
  isBlockedPartContext,
  isSamacsysProvider as isSamacsysProviderShared
} from "./core/part_context.js";

const DEFAULT_SOURCE_PART_LABEL = "Part";
const SAMACSYS_PREVIEW_IMAGE_CLASS = "samacsys-preview-image";
const chromeApi = globalThis.chrome;
const popupWindow = globalThis.window;
const popupDocument = globalThis.document;

// Cache UI elements for quick updates.
const manufacturerPartNumberEl = popupDocument.getElementById("manufacturerPartNumber");
const sourcePartLabelEl = popupDocument.getElementById("sourcePartLabel");
const partNumberEl = popupDocument.getElementById("partNumber");
const downloadButton = popupDocument.getElementById("downloadButton");
const statusEl = popupDocument.getElementById("status");
const downloadSymbolEl = popupDocument.getElementById("downloadSymbol");
const downloadFootprintEl = popupDocument.getElementById("downloadFootprint");
const downloadModelEl = popupDocument.getElementById("downloadModel");
const downloadDatasheetEl = popupDocument.getElementById("downloadDatasheet");
const downloadDatasheetOptionEl = popupDocument.getElementById("downloadDatasheetOption");
const downloadDatasheetLabelEl = popupDocument.getElementById("downloadDatasheetLabel");
const settingsButton = popupDocument.getElementById("settingsButton");
const symbolPreviewEl = popupDocument.getElementById("symbolPreview");
const footprintPreviewEl = popupDocument.getElementById("footprintPreview");
const symbolPreviewFallbackEl = popupDocument.getElementById("symbolPreviewFallback");
const footprintPreviewFallbackEl = popupDocument.getElementById("footprintPreviewFallback");

// Store the most recently detected part context.
let currentPartContext = null;
let currentSettings = { ...DEFAULT_SETTINGS };
let exportInProgress = false;
let settingsReady = false;
let settingsLoadError = "";

// Show a status message and optionally mark it as an error.
function setStatus(message, tone = "default") {
  statusEl.textContent = message;
  statusEl.classList.toggle("error", tone === "error");
  statusEl.classList.toggle("warning", tone === "warning");
}

function isBlockedProvider(partContext = currentPartContext) {
  return isBlockedPartContext(
    partContext,
    popupWindow.navigator?.userAgent,
    currentSettings.samacsysFirefoxProxyBaseUrl
  );
}

// Determine if the user selected any download option.
function hasSelection() {
  return (
    downloadSymbolEl.checked ||
    downloadFootprintEl.checked ||
    downloadModelEl.checked ||
    downloadDatasheetEl.checked
  );
}

// Enable the download button only when there is a supported provider and a selection.
function updateDownloadEnabled() {
  downloadButton.disabled =
    !settingsReady || exportInProgress || !currentPartContext?.provider || isBlockedProvider() || !hasSelection();
}

function setPreviewProviderStyle(partContext) {
  const isSamacsysPreview = isSamacsysProviderShared(partContext?.provider);
  symbolPreviewEl.classList.toggle(
    SAMACSYS_PREVIEW_IMAGE_CLASS,
    isSamacsysPreview
  );
  footprintPreviewEl.classList.toggle(
    SAMACSYS_PREVIEW_IMAGE_CLASS,
    isSamacsysPreview
  );
}

function setPreviewLoading(fallbackEl, imgEl) {
  fallbackEl.textContent = "Loading...";
  fallbackEl.classList.remove("hidden");
  imgEl.classList.add("hidden");
  imgEl.removeAttribute("src");
}

function setPreviewUnavailable(fallbackEl, imgEl, message = "Not available") {
  fallbackEl.textContent = message;
  fallbackEl.classList.remove("hidden");
  imgEl.classList.add("hidden");
  imgEl.removeAttribute("src");
}

function setPreviewImage(fallbackEl, imgEl, url) {
  if (!url) {
    setPreviewUnavailable(fallbackEl, imgEl);
    return;
  }
  fallbackEl.textContent = "Loading...";
  fallbackEl.classList.remove("hidden");
  imgEl.classList.remove("hidden");
  imgEl.onload = () => {
    fallbackEl.classList.add("hidden");
  };
  imgEl.onerror = () => {
    setPreviewUnavailable(fallbackEl, imgEl);
  };
  imgEl.src = url;
}

function setDatasheetAvailability(isAvailable) {
  if (isAvailable === false) {
    downloadDatasheetEl.checked = false;
    downloadDatasheetEl.disabled = true;
    downloadDatasheetOptionEl.classList.add("disabled");
    downloadDatasheetLabelEl.textContent = "Datasheet (not available)";
    updateDownloadEnabled();
    return;
  }

  downloadDatasheetEl.disabled = false;
  downloadDatasheetOptionEl.classList.remove("disabled");
  downloadDatasheetLabelEl.textContent = "Datasheet";
  updateDownloadEnabled();
}

function getPreviewDefaultDatasheetAvailability(partContext) {
  return isSamacsysProviderShared(partContext?.provider) ? false : null;
}

function setIdentifierDisplay(sourcePartLabel, sourcePartNumber, manufacturerPartNumber) {
  sourcePartLabelEl.textContent = sourcePartLabel || DEFAULT_SOURCE_PART_LABEL;
  manufacturerPartNumberEl.textContent = manufacturerPartNumber || "Not found";
  partNumberEl.textContent = sourcePartNumber || "Not found";
}

function setUnavailableDisplay(statusMessage) {
  currentPartContext = null;
  setPreviewProviderStyle(null);
  sourcePartLabelEl.textContent = DEFAULT_SOURCE_PART_LABEL;
  manufacturerPartNumberEl.textContent = "Unavailable";
  partNumberEl.textContent = "Unavailable";
  downloadButton.disabled = true;
  setStatus(statusMessage, "error");
  setDatasheetAvailability(false);
  setPreviewUnavailable(symbolPreviewFallbackEl, symbolPreviewEl, "Unavailable");
  setPreviewUnavailable(footprintPreviewFallbackEl, footprintPreviewEl, "Unavailable");
}

function requestPreviews(partContext) {
  const fallbackDatasheetAvailability =
    getPreviewDefaultDatasheetAvailability(partContext);
  setPreviewLoading(symbolPreviewFallbackEl, symbolPreviewEl);
  setPreviewLoading(footprintPreviewFallbackEl, footprintPreviewEl);
  setDatasheetAvailability(fallbackDatasheetAvailability);
  chromeApi.runtime.sendMessage(
    { type: "GET_PART_PREVIEWS", partContext },
    (response) => {
      if (chromeApi.runtime.lastError || !response?.ok) {
        setPreviewUnavailable(symbolPreviewFallbackEl, symbolPreviewEl);
        setPreviewUnavailable(footprintPreviewFallbackEl, footprintPreviewEl);
        setDatasheetAvailability(fallbackDatasheetAvailability);
        return;
      }
      setPreviewImage(
        symbolPreviewFallbackEl,
        symbolPreviewEl,
        response.previews?.symbolUrl || null
      );
      setPreviewImage(
        footprintPreviewFallbackEl,
        footprintPreviewEl,
        response.previews?.footprintUrl || null
      );
      setDatasheetAvailability(
        isSamacsysProviderShared(partContext?.provider)
          ? false
          : response.metadata?.datasheetAvailable === true
      );
    }
  );
}

// Apply settings values to the UI controls.
function applySettingsToUi(settings) {
  currentSettings = {
    ...DEFAULT_SETTINGS,
    ...settings
  };
  if (currentPartContext) {
    setPartContext(currentPartContext);
  } else {
    updateDownloadEnabled();
  }
}

// Detection and storage reads can finish in either order. Previews and exports
// start once saved settings are available, preserving the configured layout/auth.
async function loadSettings() {
  try {
    const settings = await loadStoredSettings(chromeApi);
    settingsReady = true;
    applySettingsToUi(settings);
  } catch {
    settingsLoadError = "Failed to load settings. Reopen the popup to try again.";
    setStatus(settingsLoadError, "error");
    updateDownloadEnabled();
  }
}

function openSettingsPage() {
  if (typeof chromeApi.tabs?.create === "function") {
    chromeApi.tabs.create({
      url: chromeApi.runtime.getURL("src/settings.html")
    });
    return;
  }

  chromeApi.runtime.openOptionsPage?.();
}

function setExportResultStatus(response) {
  const warnings = Array.isArray(response.warnings)
    ? response.warnings.filter(Boolean)
    : [];
  const downloadCount = Number(response.downloadCount) || 0;

  if (warnings.length && downloadCount > 0) {
    setStatus(`Download started. ${warnings.join(" ")}`, "warning");
  } else if (warnings.length) {
    setStatus(warnings.join(" "), "warning");
  } else if (downloadCount > 0) {
    setStatus("Download started.");
  } else {
    setStatus("No files were available to download.", "warning");
  }
}

// Update UI state based on whether a supported provider was found.
function setPartContext(partContext) {
  currentPartContext = partContext?.provider ? partContext : null;
  setPreviewProviderStyle(currentPartContext);

  if (!currentPartContext) {
    setIdentifierDisplay(DEFAULT_SOURCE_PART_LABEL, null, null);
    downloadButton.disabled = true;
    setStatus("No supported part found on this page.", "error");
    setDatasheetAvailability(false);
    setPreviewUnavailable(symbolPreviewFallbackEl, symbolPreviewEl, "Not found");
    setPreviewUnavailable(footprintPreviewFallbackEl, footprintPreviewEl, "Not found");
    return;
  }

  setIdentifierDisplay(
    currentPartContext.sourcePartLabel,
    currentPartContext.sourcePartNumber,
    currentPartContext.manufacturerPartNumber
  );

  if (!settingsReady) {
    setStatus(settingsLoadError || "Loading settings...", settingsLoadError ? "error" : "default");
    updateDownloadEnabled();
    return;
  }

  if (isBlockedProvider(currentPartContext)) {
    setStatus(
      getBlockedPartContextError(
        currentPartContext,
        popupWindow.navigator?.userAgent,
        currentSettings.samacsysFirefoxProxyBaseUrl
      ),
      "error"
    );
    setDatasheetAvailability(false);
    setPreviewUnavailable(symbolPreviewFallbackEl, symbolPreviewEl, "Unavailable");
    setPreviewUnavailable(footprintPreviewFallbackEl, footprintPreviewEl, "Unavailable");
    updateDownloadEnabled();
    return;
  }

  updateDownloadEnabled();
  setStatus("");
  requestPreviews(currentPartContext);
}

// Ask the content script in the active tab for the provider-aware part context.
function requestPartContextFromTab(tabId) {
  chromeApi.tabs.sendMessage(tabId, { type: "GET_PART_CONTEXT" }, (response) => {
    if (chromeApi.runtime.lastError) {
      setUnavailableDisplay("Open a supported product page.");
      return;
    }
    setPartContext(response || null);
  });
}

// On popup open, query the active tab and request the current part context.
chromeApi.tabs.query({ active: true, currentWindow: true }, (tabs) => {
  const tab = tabs[0];
  if (!tab?.id) {
    setUnavailableDisplay("No active tab detected.");
    return;
  }
  requestPartContextFromTab(tab.id);
});

// Load settings when the popup opens.
loadSettings();

// Keep button state in sync with checkbox changes.
downloadSymbolEl.addEventListener("change", updateDownloadEnabled);
downloadFootprintEl.addEventListener("change", updateDownloadEnabled);
downloadModelEl.addEventListener("change", updateDownloadEnabled);
downloadDatasheetEl.addEventListener("change", updateDownloadEnabled);
settingsButton.addEventListener("click", openSettingsPage);

// When clicked, validate selections and ask the background worker to export.
downloadButton.addEventListener("click", () => {
  if (!settingsReady || exportInProgress || !currentPartContext?.provider || isBlockedProvider()) {
    return;
  }

  if (!hasSelection()) {
    setStatus("Select at least one download option.", "error");
    return;
  }

  // Selection changes preserve the pending request until the worker replies.
  exportInProgress = true;
  updateDownloadEnabled();
  setStatus("Starting download...");

  chromeApi.runtime.sendMessage(
    {
      type: "EXPORT_PART",
      partContext: currentPartContext,
      options: {
        symbol: downloadSymbolEl.checked,
        footprint: downloadFootprintEl.checked,
        model3d: downloadModelEl.checked,
        datasheet: downloadDatasheetEl.checked
      }
    },
    (response) => {
      exportInProgress = false;
      updateDownloadEnabled();
      if (chromeApi.runtime.lastError) {
        setStatus("Download failed. Check the console.", "error");
        return;
      }
      if (response?.ok) {
        setExportResultStatus(response);
      } else {
        setStatus(response?.error || "Download failed.", "error");
      }
    }
  );
});

if (globalThis.__popupTestApi) {
  Object.assign(globalThis.__popupTestApi, {
    setPartContext,
    updateDownloadEnabled,
    setDatasheetAvailability,
    hasSelection,
    getCurrentPartContext: () => currentPartContext,
    elements: {
      manufacturerPartNumberEl,
      sourcePartLabelEl,
      partNumberEl,
      downloadButton,
      statusEl,
      downloadSymbolEl,
      downloadFootprintEl,
      downloadModelEl,
      downloadDatasheetEl,
      downloadDatasheetOptionEl,
      downloadDatasheetLabelEl,
      settingsButton,
      symbolPreviewEl,
      footprintPreviewEl,
      symbolPreviewFallbackEl,
      footprintPreviewFallbackEl
    },
    openSettingsPage
  });
}
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
