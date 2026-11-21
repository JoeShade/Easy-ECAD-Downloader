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
const marking = [17, 24, 39];
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

  it("shows both locating holes and the four plated shell slots of the Type-C connector", () => {
    const data = parts.C2765186;
    const pixel = rasterize(data);
    for (const record of data.shape) {
      const fields = record.split("~");
      if (fields[0] === "HOLE") {
        const [x, y, radius] = fields.slice(1, 4).map(Number);
        expect(pixel(x, y)).toEqual(background);
        expect(pixel(x + radius + 0.5, y)).toEqual(body);
      } else if (fields[0] === "PAD") {
        const x = Number(fields[2]);
        const y = Number(fields[3]);
        const radius = Number(fields[9]);
        const halfLength = Number(fields[13]) / 2;
        expect(pixel(x, y + halfLength - 0.4)).toEqual(background);
        expect(pixel(x + radius + 0.4, y)).toEqual(copper);
      }
    }
  });

  it("keeps the relay's rotated horizontal slot and round annuli visible through its body artwork", () => {
    const pixel = rasterize(parts.C125716);
    expect(pixel(4009, 2975)).toEqual(background);
    expect(pixel(4005.512, 2977.5)).toEqual(copper);
    expect(pixel(3964.961, 3025)).toEqual(background);
    expect(pixel(3967.961, 3025)).toEqual(copper);
    expect(pixel(3970, 3025)).toEqual(body);
  });

  it("keeps the DIP notch, pin 1 dot and switch button circle above the body region", () => {
    const dip = rasterize(parts.C46749);
    expect(dip(3925.55, 2966.02)).toEqual(marking);
    expect(dip(3926.16, 2972.49)).toEqual(marking);
    const button = rasterize(parts.C231329);
    expect(button(4007.764, 3007)).toEqual(marking);
    expect(button(4004.614, 3007)).toEqual(body);
  });

  it("preserves uninterrupted copper across all sixteen KMS-1102NL surface pads", () => {
    const data = parts.C19725172;
    const pixel = rasterize(data);
    const pads = data.shape.filter(record => record.startsWith("PAD~"));
    expect(pads).toHaveLength(16);
    for (const pad of pads) {
      const [, , x, y] = pad.split("~").map(Number);
      for (const offset of [-2, 0, 2]) expect(pixel(x, y + offset)).toEqual(copper);
    }
  });

  it("preserves the gap between the Keystone 5015 copper pad and its silk perimeter", () => {
    const pixel = rasterize(parts.C2906768);
    expect(pixel(4000, 3000)).toEqual(copper);
    expect(pixel(3993, 3000)).toEqual(background);
    expect(pixel(3992.25, 3000)).toEqual(marking);
  });

  it("paints the interior of a filled silkscreen rectangle and preserves hollow outlines", () => {
    const pixel = rasterize({
      BBox: { x: 0, y: 0, width: 30, height: 10 },
      shape: ["RECT~0~0~10~10~3~solid-rect~0~0~solid", "RECT~20~0~10~10~3~open-rect~0~1~none"]
    });
    expect(pixel(5, 5)).toEqual(marking);
    expect(pixel(25, 5)).toEqual(background);
    expect(pixel(20, 5)).toEqual(marking);
  });

  it("fills the same marking for coordinate-list and SVG region records", () => {
    const pixel = rasterize({
      BBox: { x: 0, y: 0, width: 30, height: 10 },
      shape: ["SOLIDREGION~3~~0 0 10 0 10 10 0 10~solid", "SOLIDREGION~3~~M20 0L30 0 30 10 20 10Z~solid"]
    });
    expect(pixel(5, 5)).toEqual(copper);
    expect(pixel(25, 5)).toEqual(copper);
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
