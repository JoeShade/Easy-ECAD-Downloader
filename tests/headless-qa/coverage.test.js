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
  return { kind: "live", execution: "COMPLETED", stages };
}

describe("live workflow coverage", () => {
  const rendered = { coverage: { inspections: [{ id: "symbol", attempted: true, produced: true }] } };

  it("reports produced workflow evidence while retaining visual review", () => {
    expect(coverageSummary(completedRun(), rendered)).toMatchObject({
      liveWorkflowEvidenceProduced: true, liveEndToEndDemonstrated: false,
      outstanding: { visualReviewPending: true }
    });
  });

  it.each(["RUNNING", "FAILED", "NOT_RUN"])("withholds workflow evidence for overall %s execution", execution => {
    const result = completedRun();
    result.execution = execution;
    expect(coverageSummary(result, rendered).liveWorkflowEvidenceProduced).toBe(false);
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
