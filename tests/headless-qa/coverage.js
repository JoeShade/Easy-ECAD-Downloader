/*
 * Compact execution coverage. Produced evidence and completed execution never
 * imply that a component or a blocked provider flow was fully inspected.
 */
export const assetTypes = { downloadSymbol: /\.kicad_sym$/i, downloadFootprint: /\.kicad_mod$/i,
  downloadModel: /\.(?:step|stp|wrl)$/i, downloadDatasheet: /\.(?:pdf|html)$/i };

export function coverageSummary(result, rendered = null) {
  const stages = result.stages;
  const selected = stages.downloads.selected || [];
  const assets = stages.downloads.assets || [];
  const inspections = rendered?.coverage?.inspections || [];
  const required = result.kind === "preflight" ? ["environment"] : Object.keys(stages);
  const pendingStages = required.filter(name => stages[name].execution !== "COMPLETED");
  const missingAssets = selected.filter(option => !assets.some(asset => asset.verified && assetTypes[option]?.test(asset.filename)));
  const visualReviewPending = result.kind !== "preflight" && (inspections.length > 0 || stages.previews.execution === "COMPLETED");
  const modelLimitations = (rendered?.models || []).filter(model => model.outcome !== "PASS").map(model => model.relativePath);
  const cadAssets = assets.some(asset => asset.verified && /\.(?:kicad_sym|kicad_mod|step|stp|wrl)$/i.test(asset.filename));
  const decodedPreviews = ["symbolPreview", "footprintPreview"].every(id => stages.previews.checks.some(check => check.id === id && check.decoded));
  const workflowEvidence = result.kind === "live" && !pendingStages.length && !missingAssets.length &&
    !result.diagnostics?.errors && decodedPreviews && inspections.length > 0 && inspections.every(item => item.produced) &&
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
      assets.some(asset => asset.verified && /\.(?:kicad_sym|kicad_mod|step|stp|wrl)$/i.test(asset.filename)) ? ["Rendering plan unavailable; verified CAD assets remain uninspected"] : [],
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
