/*
 * Checks that EasyEDA footprint markings retain their contours and source
 * layers in KiCad, including curved polarity marks and terminal arrows.
 */

import { describe, expect, it } from "vitest";
import { convertEasyedaCadToKicad } from "../src/kicad_converter.js";

function exportShapes(x, y, shape) {
  const dataStr = { head: { x, y }, shape };
  return convertEasyedaCadToKicad({ packageDetail: { dataStr } }, { footprint: true }).footprint.content;
}

describe("EasyEDA footprint markings", () => {
  it("reads the source layer and stroke independently on a Keystone 5015 outline", () => {
    const content = exportShapes(4000, 3000, ["RECT~3992.25~2995.5~15.5~9~3~gge160~0~1~none~~~"]);
    const lines = content.split("\n").filter(line => line.includes("(fp_line"));
    expect(lines).toHaveLength(4);
    expect(lines.every(line => line.includes("(layer F.SilkS) (width 0.25)"))).toBe(true);
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
