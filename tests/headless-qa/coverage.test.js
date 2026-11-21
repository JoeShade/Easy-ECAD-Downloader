/*
 * Keep live evidence claims tied to overall execution and complete stage data.
 * Synthetic reports establish summary rules independently of browser services.
 */
import { describe, expect, it } from "vitest";
import { stageNames } from "./common.js";
import { coverageSummary } from "./coverage.js";

function completedRun() {
  const stages = Object.fromEntries(stageNames.map(name => [name, { execution: "COMPLETED", checks: [] }]));
  stages.previews.checks = ["symbolPreview", "footprintPreview"].map(id => ({ id, decoded: true, outcome: "PASS" }));
  stages.downloads.selected = ["downloadSymbol"];
  stages.downloads.assets = [{ filename: "part.kicad_sym", relativePath: "part.kicad_sym", verified: true }];
  return { kind: "live", execution: "COMPLETED", diagnostics: { errors: 0 }, stages };
}

describe("live workflow coverage", () => {
  const rendered = { coverage: { inspections: [{ id: "symbol", attempted: true, produced: true }] } };

  it("reports produced workflow evidence while retaining visual review", () => {
    expect(coverageSummary(completedRun(), rendered)).toMatchObject({
      liveWorkflowEvidenceProduced: true, liveEndToEndDemonstrated: false,
      outstanding: { visualReviewPending: true }
    });
  });

  it.each(["htm", "docx", "step", "pdf"])("classifies the grouped .%s datasheet independently of CAD files", extension => {
    const result = completedRun(), downloads = result.stages.downloads;
    downloads.selected = ["downloadSymbol", "downloadFootprint", "downloadModel", "downloadDatasheet"];
    downloads.settings = { downloadIndividually: false, libraryDownloadRoot: "parts/export" };
    const filename = `P001-datasheet.${extension}`;
    downloads.assets = [{ filename, relativePath: `parts/export/datasheets/${filename}`, verified: true }];
    const coverage = coverageSummary(result);
    expect(coverage.produced.assetCategories).toEqual(["downloadDatasheet"]);
    expect(coverage.expected.inspections).toBe(0);
    downloads.assets[0].verified = false;
    expect(coverageSummary(result).produced.assetCategories).toEqual([]);
  });

  it("keeps legacy PDF and HTML records and actual model-directory matches", () => {
    const result = completedRun(), downloads = result.stages.downloads;
    downloads.selected = ["downloadModel", "downloadDatasheet"];
    for (const filename of ["document.pdf", "document.html"]) {
      downloads.assets = [{ filename, relativePath: filename, verified: true }];
      expect(coverageSummary(result).produced.assetCategories).toEqual(["downloadDatasheet"]);
    }
    downloads.settings = { downloadIndividually: false, libraryDownloadRoot: "parts" };
    downloads.assets = [{ filename: "part-datasheet.step", relativePath: "parts/parts.3dshapes/part-datasheet.step", verified: true }];
    expect(coverageSummary(result).produced.assetCategories).toEqual(["downloadModel"]);
  });

  it.each(["RUNNING", "FAILED", "NOT_RUN"])("withholds workflow evidence for overall %s execution", execution => {
    const result = completedRun();
    result.execution = execution;
    expect(coverageSummary(result, rendered).liveWorkflowEvidenceProduced).toBe(false);
  });

  it("requires selected downloads and a recorded zero runtime error count", () => {
    const noSelection = completedRun();
    noSelection.stages.downloads.selected = [];
    expect(coverageSummary(noSelection, rendered).liveWorkflowEvidenceProduced).toBe(false);
    for (const diagnostics of [undefined, {}, { errors: 1 }]) {
      expect(coverageSummary({ ...completedRun(), diagnostics }, rendered).liveWorkflowEvidenceProduced).toBe(false);
    }
  });
});

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
