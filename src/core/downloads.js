// Core export/conversion work in this file: JoeShade and Josh Webster
/*
 * Shared download helpers for the service worker. These wrap chrome.downloads
 * so adapters can write text, binary, and URL-backed artifacts without
 * duplicating Blob/data-URL fallback logic or object-URL cleanup.
 */

import { arrayBufferToBase64, textToBase64 } from "./preview_data.js";
import { MODEL_DOWNLOAD_TIMEOUT_MS, waitForDownload } from "./download_receipts.js";

function createDownloadApi(chromeApi, urlApi = globalThis.URL, blobCtor = globalThis.Blob) {
  const activeDownloadUrls = new Map();
  const canUseBlobUrl =
    typeof urlApi !== "undefined" &&
    typeof urlApi.createObjectURL === "function" &&
    typeof blobCtor !== "undefined";

  chromeApi.downloads.onChanged.addListener((delta) => {
    if (!delta?.state?.current) {
      return;
    }
    if (delta.state.current !== "complete" && delta.state.current !== "interrupted") {
      return;
    }
    releaseDownloadUrl(delta.id);
  });

  function releaseDownloadUrl(downloadId) {
    const url = activeDownloadUrls.get(downloadId);
    if (!url) return;
    activeDownloadUrls.delete(downloadId);
    urlApi.revokeObjectURL(url);
  }

  function inspectDownloadForCleanup(downloadId) {
    try {
      chromeApi.downloads.search({ id: downloadId }, items => {
        if (chromeApi.runtime.lastError) return;
        if (items?.some(item => item.id === downloadId &&
          (item.state === "complete" || item.state === "interrupted"))) {
          releaseDownloadUrl(downloadId);
        }
      });
    } catch { /* A cleanup query must not fail or revoke an in-progress write. */ }
  }

  function downloadGeneratedUrl(filename, url, conflictAction, completion, objectUrl = false) {
    const awaitCompletion = completion?.waitForCompletion === true;
    const timeoutMs = completion?.timeoutMs ?? MODEL_DOWNLOAD_TIMEOUT_MS;
    const deadline = Date.now() + timeoutMs;
    return new Promise((resolve, reject) => {
      let expired = false;
      const timer = awaitCompletion ? setTimeout(() => {
        expired = true;
        reject(new Error("Download failed to start: browser callback timed out."));
      }, Math.min(timeoutMs, 10000)) : undefined;
      try {
        chromeApi.downloads.download(
          {
            url,
            filename,
            conflictAction: conflictAction || "uniquify"
          },
          (downloadId) => {
            clearTimeout(timer);
            if (chromeApi.runtime.lastError || !downloadId) {
              if (objectUrl) urlApi.revokeObjectURL(url);
              reject(
                new Error(
                  chromeApi.runtime.lastError?.message || "Download failed to start."
                )
              );
              return;
            }
            if (objectUrl) activeDownloadUrls.set(downloadId, url);
            if (expired) {
              try {
                chromeApi.downloads.cancel(downloadId, () => {
                  if (!chromeApi.runtime.lastError) releaseDownloadUrl(downloadId);
                });
              } catch { /* Terminal events still release the URL if cancellation fails. */ }
              return;
            }
            if (awaitCompletion) {
              resolve(waitForDownload(chromeApi, downloadId, filename,
                () => releaseDownloadUrl(downloadId), Math.max(1, deadline - Date.now())));
            } else {
              // Completion may precede the start callback, so the event alone is
              // insufficient for Blob cleanup. Keep ordinary writes started-only.
              if (objectUrl) inspectDownloadForCleanup(downloadId);
              resolve(downloadId);
            }
          }
        );
      } catch (error) {
        clearTimeout(timer);
        if (objectUrl) urlApi.revokeObjectURL(url);
        reject(error);
      }
    });
  }

  // The optional fifth argument opts models into terminal receipts. Existing
  // calls resolve at start with an ID; artifact writers continue returning counts.
  async function downloadTextFile(filename, text, mimeType, conflictAction, completion) {
    if (canUseBlobUrl) {
      const blob = new blobCtor([text], { type: mimeType });
      return downloadGeneratedUrl(filename, urlApi.createObjectURL(blob), conflictAction, completion, true);
    }
    const base64 = textToBase64(text);
    const url = `data:${mimeType};base64,${base64}`;
    return downloadGeneratedUrl(filename, url, conflictAction, completion);
  }

  async function downloadBinaryFile(filename, buffer, mimeType, conflictAction, completion) {
    if (canUseBlobUrl) {
      const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
      const blob = new blobCtor([bytes], { type: mimeType });
      return downloadGeneratedUrl(filename, urlApi.createObjectURL(blob), conflictAction, completion, true);
    }
    const base64 = arrayBufferToBase64(buffer);
    const url = `data:${mimeType};base64,${base64}`;
    return downloadGeneratedUrl(filename, url, conflictAction, completion);
  }

  async function downloadUrlFile(filename, url, conflictAction) {
    return new Promise((resolve, reject) => {
      chromeApi.downloads.download(
        {
          url,
          filename,
          conflictAction: conflictAction || "uniquify"
        },
        (downloadId) => {
          if (chromeApi.runtime.lastError || !downloadId) {
            reject(
              new Error(
                chromeApi.runtime.lastError?.message || "Download failed to start."
              )
            );
            return;
          }
          resolve(downloadId);
        }
      );
    });
  }

  return {
    downloadTextFile,
    downloadBinaryFile,
    downloadUrlFile
  };
}

export { createDownloadApi };

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
