/*
 * Summarize produced workflow evidence separately from visual assessment.
 * Full inspection remains pending until a person assesses the saved artifacts.
 */
// Grouped exports give datasheets a dedicated directory and generated basename.
// Use that identity before the provider's document suffix, which can resemble CAD.
export function verifiedAssetCategory(asset, settings) {
  if (!asset.verified) return null;
  const name = asset.filename;
  if (settings?.downloadIndividually === false && settings.libraryDownloadRoot &&
      asset.relativePath?.toLowerCase() === `${settings.libraryDownloadRoot}/datasheets/${name}`.toLowerCase()) {
    return /-datasheet(?:\.[a-z0-9]{1,8})?$/i.test(name) ? "downloadDatasheet" : null;
  }
  if (/\.kicad_sym$/i.test(name)) return "downloadSymbol";
  if (/\.kicad_mod$/i.test(name)) return "downloadFootprint";
  if (/\.(?:step|stp|wrl)$/i.test(name)) return "downloadModel";
  if (/\.(?:pdf|html?)$/i.test(name)) return "downloadDatasheet";
  return null;
}

// Require completed overall execution, every stage and each expected artifact
// before claiming live workflow evidence. Visual correctness remains a separate
// outstanding task even when all automated evidence has been produced.
export function coverageSummary(result, rendered = null) {
  const stages = result.stages;
  const selected = stages.downloads.selected || [];
  const assets = stages.downloads.assets || [];
  const inspections = rendered?.coverage?.inspections || [];
  const required = result.kind === "preflight" ? ["environment"] : Object.keys(stages);
  const pendingStages = required.filter(name => stages[name].execution !== "COMPLETED");
  const categories = assets.map(asset => verifiedAssetCategory(asset, stages.downloads.settings));
  const missingAssets = selected.filter(option => !categories.includes(option));
  const visualReviewPending = result.kind !== "preflight" && (inspections.length > 0 || stages.previews.execution === "COMPLETED");
  const modelLimitations = (rendered?.models || []).filter(model => model.outcome !== "PASS").map(model => model.relativePath);
  const cadAssets = categories.some(category => category && category !== "downloadDatasheet");
  const decodedPreviews = ["symbolPreview", "footprintPreview"].every(id => stages.previews.checks.some(check => check.id === id && check.decoded));
  const workflowEvidence = result.kind === "live" && result.execution === "COMPLETED" && !pendingStages.length &&
    selected.length > 0 && !missingAssets.length && result.diagnostics?.errors === 0 &&
    decodedPreviews && inspections.length > 0 && inspections.every(item => item.produced) &&
    Object.values(stages).every(stage => stage.checks.every(check => !["FAIL", "BLOCKED"].includes(check.outcome)));
  return { fullyInspected: false, expected: { stages: required, assetCategories: selected, inspections: rendered ? inspections.length : cadAssets ? null : 0 },
    attempted: { stages: required.filter(name => stages[name].execution !== "NOT_RUN"),
      assetCategories: stages.downloads.clickAttempted ? selected : [],
      inspections: inspections.filter(item => item.attempted).length },
    produced: { finalAssets: assets.filter(asset => asset.verified).map(asset => asset.relativePath),
      assetCategories: selected.filter(option => !missingAssets.includes(option)),
      inspections: inspections.filter(item => item.produced).length },
    outstanding: { stages: pendingStages, assetCategories: missingAssets,
      inspections: rendered ? inspections.filter(item => !item.produced).map(item => item.id) :
        cadAssets ? ["Rendering plan unavailable; verified CAD assets remain uninspected"] : [],
      modelReview: modelLimitations, visualReviewPending },
    liveWorkflowEvidenceProduced: workflowEvidence,
    liveEndToEndDemonstrated: workflowEvidence && !visualReviewPending && !modelLimitations.length,
    limitation: "Coverage counts evidence production; visual correctness remains pending" };
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
