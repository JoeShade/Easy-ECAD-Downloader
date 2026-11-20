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

function polygonPoints(content) {
  return [...content.matchAll(/\(xy ([\d.-]+) ([\d.-]+)\)/g)].map(match => match.slice(1).map(Number));
}

describe("EasyEDA footprint markings", () => {
  it("preserves the notched outline and orientation of a Phoenix Contact terminal arrow", () => {
    const content = exportShapes(4000, 2970, [
      "SOLIDREGION~3~~M 4002.9975 2972.685 L 4002.9975 2964.811 L 4001.029 2964.811 L 4001.029 2964.811 L 4004.966 2960.874 L 4004.966 2960.874 L 4008.903 2964.811 L 4006.9345 2964.811 L4006.9345,2972.685 Z~solid~gge70~~~~0"
    ]);
    expect(content).toContain("(layer F.SilkS) (width 0) (fill solid)");
    expect(polygonPoints(content)).toEqual([
      [0.7614, 0.682], [0.7614, -1.318], [0.2614, -1.318], [1.2614, -2.318],
      [2.2614, -1.318], [1.7614, -1.318], [1.7614, 0.682]
    ]);
  });

  it("retains a two-arc pin-one dot as one filled disc", () => {
    const content = exportShapes(3980, 3010, [
      "SOLIDREGION~3~~M 3978.1496 3009.9606 A 2.1261 2.1261 0 1 1 3982.4017 3009.9606 A 2.1261 2.1261 0 1 1 3978.1496 3009.9606 Z~solid~gge1110~~~~0"
    ]);
    const pts = polygonPoints(content);
    const ys = pts.map(([, y]) => y);
    expect(content.match(/\(fp_poly/g)).toHaveLength(1);
    expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(1.08, 1);
    expect(pts.every(([x, y]) => Math.abs(Math.hypot(x - 0.07, y + 0.01) - 0.54) < 0.02)).toBe(true);
  });

  it("excludes model geometry, cutouts, electrical records and contours with holes from printed markings", () => {
    const shape = "M0,0L10,0L10,10L0,10Z";
    const content = exportShapes(0, 0, [
      `SOLIDREGION~99~~${shape}~solid`, `SOLIDREGION~100~~${shape}~solid`,
      `SOLIDREGION~1~GND~${shape}~solid`, `SOLIDREGION~3~~${shape}~cutout`,
      `SOLIDREGION~4~~${shape}M2,2L2,8L8,8Z~solid`
    ]);
    expect(content).not.toContain("(fp_poly");
  });

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
