/*
 * Compare rendered copper, drill openings and markings against the footprint
 * geometry reported in #29–32. The fixtures retain only the relevant EasyEDA
 * records from each named part, in their original order and source units.
 */
import { Resvg } from "@resvg/resvg-js";
import { describe, expect, it } from "vitest";
import { buildFootprintPreviewSvg } from "../src/sources/easyeda_common.js";
import parts from "./fixtures/footprint_preview_29_32.json";

const background = [248, 250, 252];
const copper = [15, 23, 42];
const body = [203, 213, 225];

// Sample the final composite in source coordinates so an occluded shape
// fails even when its XML is still present in the generated SVG.
function rasterize(dataStr) {
  const svg = buildFootprintPreviewSvg({ packageDetail: { dataStr } });
  const doc = new window.DOMParser().parseFromString(svg, "image/svg+xml");
  expect(doc.querySelector("parsererror")).toBeNull();
  const root = doc.documentElement;
  const [left, top, width, height] = root.getAttribute("viewBox").split(" ").map(Number);
  const scale = 10;
  root.setAttribute("width", String(width * scale));
  root.setAttribute("height", String(height * scale));
  const image = new Resvg(new window.XMLSerializer().serializeToString(doc)).render();
  const pixels = image.pixels;
  return (x, y) => {
    const column = Math.floor((x - left) * scale);
    const row = Math.floor((y - top) * scale);
    const index = (row * image.width + column) * 4;
    return [...pixels.subarray(index, index + 3)];
  };
}

describe("EasyEDA footprint preview geometry", () => {
  it("opens all twelve thermal vias through the DRV8825PWPR copper pad", () => {
    const data = parts.C81582;
    const vias = data.shape.filter(record => record.startsWith("VIA~"));
    const pixel = rasterize(data);
    expect(vias).toHaveLength(12);
    for (const via of vias) {
      const [, x, y] = via.split("~").map(Number);
      expect(pixel(x, y)).toEqual(background);
      expect(pixel(x + 1, y)).toEqual(copper);
    }
  });

  it("shows both locating holes of the Type-C connector", () => {
    const data = parts.C2765186;
    const pixel = rasterize(data);
    for (const record of data.shape) {
      const fields = record.split("~");
      if (fields[0] === "HOLE") {
        const [x, y, radius] = fields.slice(1, 4).map(Number);
        expect(pixel(x, y)).toEqual(background);
        expect(pixel(x + radius + 0.5, y)).toEqual(body);
      }
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
