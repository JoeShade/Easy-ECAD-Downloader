// Core export/conversion work in this file: JoeShade and Josh Webster
/*
 * Shared export-writing helpers used by the provider adapters. This module
 * centralizes settings resolution, library path handling, symbol-library merge
 * behavior, and the repeated loose-file versus library-mode write paths.
 */

import {
  buildLibraryPaths,
  DEFAULT_LIBRARY_DOWNLOAD_ROOT,
  loadSettings
} from "./settings.js";
import {
  extractSymbolBlock,
  loadStoredSymbolLibrary,
  mergeSymbolIntoLibrary,
  saveStoredSymbolLibrary
} from "./library_store.js";

const symbolLibraryWrites = new WeakMap();

// Serialize the read/merge/save/download-start sequence per browser and library.
// Every queued export reads its predecessor's saved symbols; failed writes leave
// the queue usable, and unrelated library folders can still export concurrently.
async function serializeSymbolLibraryWrite(chromeApi, key, write) {
  let writes = symbolLibraryWrites.get(chromeApi);
  if (!writes) {
    writes = new Map();
    symbolLibraryWrites.set(chromeApi, writes);
  }
  const previous = writes.get(key) || Promise.resolve();
  const current = previous.catch(() => {}).then(write);
  writes.set(key, current);
  try {
    return await current;
  } finally {
    if (writes.get(key) === current) writes.delete(key);
  }
}

function resolveExportOptions(options = {}) {
  const resolvedOptions = {
    symbol: options.symbol !== false,
    footprint: options.footprint !== false,
    model3d: options.model3d !== false,
    datasheet: options.datasheet === true
  };

  if (
    !resolvedOptions.symbol &&
    !resolvedOptions.footprint &&
    !resolvedOptions.model3d &&
    !resolvedOptions.datasheet
  ) {
    throw new Error("No download options selected.");
  }

  return resolvedOptions;
}

async function createExportContext(chromeApi) {
  const settings = await loadSettings(chromeApi);
  const libraryPaths = buildLibraryPaths(settings.libraryDownloadRoot);

  return {
    settings,
    libraryPaths,
    symbolLibraryKey: `symbolLibrary:${libraryPaths.symbolFile}`
  };
}

function getLibraryName(libraryPaths, fallbackName = DEFAULT_LIBRARY_DOWNLOAD_ROOT) {
  return libraryPaths.symbolFile.split("/").pop()?.replace(/\.kicad_sym$/, "") || fallbackName;
}

async function writeSymbolArtifact({
  chromeApi,
  downloads,
  exportContext,
  symbolContent,
  individualFilename
}) {
  if (exportContext.settings.downloadIndividually) {
    await downloads.downloadTextFile(
      individualFilename,
      symbolContent,
      "application/octet-stream"
    );
    return 1;
  }

  return serializeSymbolLibraryWrite(chromeApi, exportContext.symbolLibraryKey, async () => {
    const symbolBlock = extractSymbolBlock(symbolContent);
    const existingLibrary = await loadStoredSymbolLibrary(
      chromeApi,
      exportContext.symbolLibraryKey
    );
    const mergedLibrary = mergeSymbolIntoLibrary(
      existingLibrary || symbolContent,
      symbolBlock
    );
    await saveStoredSymbolLibrary(
      chromeApi,
      exportContext.symbolLibraryKey,
      mergedLibrary
    );
    await downloads.downloadTextFile(
      exportContext.libraryPaths.symbolFile,
      mergedLibrary,
      "application/octet-stream",
      "overwrite"
    );
    return 1;
  });
}

async function writeTextArtifact({
  downloads,
  exportContext,
  content,
  individualFilename,
  libraryPath
}) {
  await downloads.downloadTextFile(
    exportContext.settings.downloadIndividually ? individualFilename : libraryPath,
    content,
    "application/octet-stream"
  );
  return 1;
}

async function writeBinaryArtifact({
  downloads,
  exportContext,
  data,
  individualFilename,
  libraryPath
}) {
  await downloads.downloadBinaryFile(
    exportContext.settings.downloadIndividually ? individualFilename : libraryPath,
    data,
    "application/octet-stream"
  );
  return 1;
}

// Existing writers keep their numeric started-count contract. Model selection
// explicitly opts into a separate terminal receipt, including unsuccessful ones.
async function writeCompletedModelArtifact({
  downloads, exportContext, data, individualFilename, libraryPath, binary = false
}) {
  const write = binary ? downloads.downloadBinaryFile : downloads.downloadTextFile;
  return write(
    exportContext.settings.downloadIndividually ? individualFilename : libraryPath,
    data, "application/octet-stream", undefined, { waitForCompletion: true }
  );
}

async function writeUrlArtifact({
  downloads,
  exportContext,
  url,
  individualFilename,
  libraryPath
}) {
  await downloads.downloadUrlFile(
    exportContext.settings.downloadIndividually ? individualFilename : libraryPath,
    url
  );
  return 1;
}

export {
  createExportContext,
  getLibraryName,
  resolveExportOptions,
  writeBinaryArtifact,
  writeCompletedModelArtifact,
  writeSymbolArtifact,
  writeTextArtifact,
  writeUrlArtifact
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
