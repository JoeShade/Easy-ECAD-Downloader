/*
 * Parses the EasyEDA symbol payload into a normalized intermediate model. This
 * keeps EasyEDA token handling separate from the KiCad symbol emitter so the
 * output layer can stay focused on KiCad text generation.
 */

import { parseSvgPath, toBool, toNumber } from "./shared.js";

// EasyEDA separates fields with '~' and groups pin sub-records with '^^'. Keep
// these positional wire-format details here; emitters receive named fields and
// the source origin recorded in bbox for their later coordinate conversion.
function parseEasyedaSymbol(cadData) {
  const info = cadData?.dataStr?.head?.c_para || {};
  const lcsc = cadData?.lcsc || {};
  const bbox = {
    x: toNumber(cadData?.dataStr?.head?.x),
    y: toNumber(cadData?.dataStr?.head?.y)
  };

  const symbol = {
    info: {
      name: info.name || "",
      prefix: String(info.pre || "").replace("?", ""),
      package: info.package || "",
      manufacturer: info.BOM_Manufacturer || "",
      datasheet: lcsc.url || "",
      lcscId: lcsc.number || "",
      jlcId: info["BOM_JLCPCB Part Class"] || ""
    },
    bbox,
    pins: [],
    rectangles: [],
    circles: [],
    arcs: [],
    ellipses: [],
    polylines: [],
    polygons: [],
    paths: []
  };

  const shapes = cadData?.dataStr?.shape || [];
  for (const line of shapes) {
    const designator = line.split("~")[0];
    if (designator === "P") {
      // The source pin path, visible label, inversion dot, and clock marker live
      // in separate sub-records even when an optional marker is hidden.
      const segments = line.split("^^");
      const settingsFields = segments[0].split("~").slice(1);
      const pinPathFields = (segments[2] || "").split("~");
      const pinNameFields = (segments[3] || "").split("~");
      const pinDotBisFields = (segments[5] || "").split("~");
      const pinClockFields = (segments[6] || "").split("~");

      symbol.pins.push({
        settings: {
          isDisplayed: toBool(settingsFields[0]),
          type: toNumber(settingsFields[1]),
          number: String(settingsFields[2] || "").trim(),
          posX: toNumber(settingsFields[3]),
          posY: toNumber(settingsFields[4]),
          rotation: toNumber(settingsFields[5]),
          id: settingsFields[6] || "",
          isLocked: toBool(settingsFields[7])
        },
        pinPath: {
          path: String(pinPathFields[0] || "").replace(/v/g, "h"),
          color: pinPathFields[1] || ""
        },
        name: {
          isDisplayed: toBool(pinNameFields[0]),
          posX: toNumber(pinNameFields[1]),
          posY: toNumber(pinNameFields[2]),
          rotation: toNumber(pinNameFields[3]),
          text: pinNameFields[4] || "",
          textAnchor: pinNameFields[5] || "",
          font: pinNameFields[6] || "",
          fontSize: String(pinNameFields[7] || "").includes("pt")
            ? toNumber(String(pinNameFields[7]).replace("pt", ""), 7)
            : toNumber(pinNameFields[7], 7)
        },
        dot: {
          isDisplayed: toBool(pinDotBisFields[0]),
          circleX: toNumber(pinDotBisFields[1]),
          circleY: toNumber(pinDotBisFields[2])
        },
        clock: {
          isDisplayed: toBool(pinClockFields[0]),
          path: pinClockFields[1] || ""
        }
      });
    } else if (designator === "R") {
      const fields = line.split("~").slice(1);
      symbol.rectangles.push({
        posX: toNumber(fields[0]),
        posY: toNumber(fields[1]),
        width: toNumber(fields[4]),
        height: toNumber(fields[5])
      });
    } else if (designator === "PL") {
      const fields = line.split("~").slice(1);
      symbol.polylines.push({
        points: fields[0],
        fillColor: String(fields[4] || "").toLowerCase() !== "none"
      });
    } else if (designator === "PG") {
      const fields = line.split("~").slice(1);
      symbol.polygons.push({
        points: fields[0],
        fillColor: true
      });
    } else if (designator === "PT") {
      const fields = line.split("~").slice(1);
      symbol.paths.push({
        paths: fields[0]
      });
    } else if (designator === "C") {
      const fields = line.split("~").slice(1);
      symbol.circles.push({
        centerX: toNumber(fields[0]),
        centerY: toNumber(fields[1]),
        radius: toNumber(fields[2]),
        fillColor: String(fields[5] || "").toLowerCase() !== "none"
      });
    } else if (designator === "E") {
      const fields = line.split("~").slice(1);
      symbol.ellipses.push({
        centerX: toNumber(fields[0]),
        centerY: toNumber(fields[1]),
        radiusX: toNumber(fields[2]),
        radiusY: toNumber(fields[3])
      });
    } else if (designator === "A") {
      const fields = line.split("~").slice(1);
      symbol.arcs.push({
        path: parseSvgPath(fields[0]),
        fillColor: String(fields[4] || "").toLowerCase() !== "none"
      });
    }
  }

  return symbol;
}

export { parseEasyedaSymbol };

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
