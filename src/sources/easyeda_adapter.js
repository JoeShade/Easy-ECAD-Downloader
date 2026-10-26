/*
 * Provider adapter for EasyEDA-backed JLCPCB/LCSC parts. It owns the EasyEDA
 * fetch/convert/export flow while delegating shared settings, library, and
 * artifact-writing behavior to the worker core helpers.
 */

import {
  buildEasyedaPreviewResponse,
  EASYEDA_MODEL_OBJ_ENDPOINT,
  EASYEDA_MODEL_STEP_ENDPOINT,
  ensureEasyedaLcscId,
  fetchCadData,
  find3dModelInfo,
  getDatasheetInfo
} from "./easyeda_common.js";
import {
  createExportContext,
  getLibraryName,
  resolveExportOptions,
  writeCompletedModelArtifact,
  writeSymbolArtifact,
  writeTextArtifact,
  writeUrlArtifact
} from "../core/export_artifacts.js";
import { rewriteFirstKicadFootprintModelPath } from "../core/kicad_footprint_models.js";
import { sanitizeFilenamePart } from "../core/preview_data.js";
import { completedModelFilename } from "../core/download_receipts.js";

function buildSafeFilename(name, extension, fallback) {
  return `${sanitizeFilenamePart(name, fallback)}.${extension}`;
}

function resolveEasyedaFootprintModelPath(exportContext, modelFilename) {
  if (!modelFilename) {
    return "";
  }
  if (exportContext.settings.downloadIndividually) {
    return "${KIPRJMOD}/" + modelFilename;
  }

  const libraryName = getLibraryName(exportContext.libraryPaths);
  return `../${libraryName}.3dshapes/${modelFilename}`;
}

// Export models before their dependent footprint so completed receipts determine
// its portable model reference. Optional model failures become warnings while
// the requested symbol, footprint, and datasheet paths retain their own outcomes.
function createEasyedaAdapter(deps) {
  const {
    chromeApi,
    fetchImpl,
    downloads,
    convertEasyedaCadToKicad,
    convertObjToWrlString
  } = deps;

  return {
    async getPreviews(partContext) {
      return buildEasyedaPreviewResponse(fetchImpl, partContext);
    },

    async exportPart(partContext, options = {}) {
      const lcscId = ensureEasyedaLcscId(partContext);
      const exportContext = await createExportContext(chromeApi);
      const resolvedOptions = resolveExportOptions(options);

      let downloadCount = 0;
      const warnings = [];

      const cadData = await fetchCadData(fetchImpl, lcscId);
      const datasheetInfo = getDatasheetInfo(cadData, lcscId);
      const kicadFiles = convertEasyedaCadToKicad(cadData, {
        symbol: resolvedOptions.symbol,
        footprint: resolvedOptions.footprint
      });
      const modelInfo = find3dModelInfo(cadData.packageDetail);
      const safeModelName = modelInfo
        ? sanitizeFilenamePart(modelInfo.name, modelInfo.uuid || "model")
        : "";
      let footprintModelFilename = "";
      let modelReceipt;

      if (kicadFiles.symbol) {
        const symbolFilename = buildSafeFilename(
          `${lcscId}-${kicadFiles.symbol.name}`,
          "kicad_sym",
          lcscId
        );
        downloadCount += await writeSymbolArtifact({
          chromeApi,
          downloads,
          exportContext,
          symbolContent: kicadFiles.symbol.content,
          individualFilename: symbolFilename
        });
      }

      if (resolvedOptions.model3d) {
        if (modelInfo) {
          for (const extension of ["step", "wrl"]) {
            const label = extension.toUpperCase();
            let failureStage = "fetch";
            try {
              const endpoint = extension === "step" ? EASYEDA_MODEL_STEP_ENDPOINT : EASYEDA_MODEL_OBJ_ENDPOINT;
              const response = await fetchImpl(endpoint.replace("{uuid}", modelInfo.uuid));
              if (!response.ok) {
                warnings.push(`3D ${label} model download failed (HTTP ${response.status}).`);
                continue;
              }
              failureStage = extension === "step" ? "read" : "conversion";
              const data = extension === "step" ? await response.arrayBuffer()
                : convertObjToWrlString(await response.text());
              failureStage = "download start";
              const receipt = await writeCompletedModelArtifact({
                downloads, exportContext, data, binary: extension === "step",
                individualFilename: `${safeModelName}.${extension}`,
                libraryPath: `${exportContext.libraryPaths.modelDir}/${safeModelName}.${extension}`
              });
              // Counts retain their existing meaning: browser downloads started,
              // including a model that later fails verification or is interrupted.
              downloadCount += 1;
              const deliveredName = completedModelFilename(receipt, modelReceipt);
              if (deliveredName) {
                footprintModelFilename = deliveredName;
                modelReceipt = receipt;
              } else {
                warnings.push(receipt.state === "complete"
                  ? `3D ${label} model location could not be verified; model reference omitted for this asset.`
                  : `3D ${label} model unavailable: ${(receipt.error || receipt.state).replace(/\.+$/, "")}.`);
              }
            } catch (error) {
              warnings.push(`3D ${label} model ${failureStage} failed: ${error?.message || String(error)}`);
            }
          }
        } else {
          warnings.push("3D model not available for this part.");
        }
      }

      if (kicadFiles.footprint) {
        const footprintFilename = buildSafeFilename(
          kicadFiles.footprint.name,
          "kicad_mod",
          "footprint"
        );
        const modelPath = resolveEasyedaFootprintModelPath(
          exportContext,
          footprintModelFilename
        );
        const footprintContent = rewriteFirstKicadFootprintModelPath(
          kicadFiles.footprint.content,
          modelPath
        );

        downloadCount += await writeTextArtifact({
          downloads,
          exportContext,
          content: footprintContent,
          individualFilename: footprintFilename,
          libraryPath: `${exportContext.libraryPaths.footprintDir}/${footprintFilename}`
        });
      }

      if (resolvedOptions.datasheet) {
        if (!datasheetInfo.url) {
          warnings.push("Datasheet not available for this part.");
        } else {
          try {
            downloadCount += await writeUrlArtifact({
              downloads,
              exportContext,
              url: datasheetInfo.url,
              individualFilename: datasheetInfo.filename,
              libraryPath: `${exportContext.libraryPaths.datasheetDir}/${datasheetInfo.filename}`
            });
          } catch (error) {
            console.warn("Datasheet download failed:", error);
            warnings.push("Datasheet download failed.");
          }
        }
      }

      return { warnings, downloadCount };
    }
  };
}

export { createEasyedaAdapter };

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
