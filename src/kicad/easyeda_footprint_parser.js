/*
 * Parses the EasyEDA footprint payload into a normalized intermediate shape.
 * The emitter layer then converts this parsed structure into KiCad footprint
 * text using named geometry and metadata fields defined here.
 */

import { toBool, toNumber } from "./shared.js";

// Decode '~'-delimited source records into named fields while retaining source
// units. The emitter converts lengths together, keeping metadata rotations in degrees.
function parseEasyedaFootprint(cadData) {
  const dataStr = cadData?.packageDetail?.dataStr;
  const info = dataStr?.head?.c_para || {};
  const isSmd =
    Boolean(cadData?.SMT) &&
    !String(cadData?.packageDetail?.title || "").includes("-TH_");

  const footprint = {
    info: {
      name: info.package || "",
      fpType: isSmd ? "smd" : "tht",
      model3dName: info["3DModel"] || ""
    },
    bbox: {
      x: toNumber(dataStr?.head?.x),
      y: toNumber(dataStr?.head?.y)
    },
    model3d: null,
    pads: [],
    tracks: [],
    holes: [],
    vias: [],
    circles: [],
    arcs: [],
    rectangles: [],
    texts: []
  };

  const shapes = dataStr?.shape || [];
  for (const line of shapes) {
    const parts = line.split("~");
    const designator = parts[0];
    const fields = parts.slice(1);

    if (designator === "PAD") {
      footprint.pads.push({
        shape: fields[0],
        centerX: toNumber(fields[1]),
        centerY: toNumber(fields[2]),
        width: toNumber(fields[3]),
        height: toNumber(fields[4]),
        layerId: toNumber(fields[5]),
        net: fields[6] || "",
        number: fields[7] || "",
        holeRadius: toNumber(fields[8]),
        points: fields[9] || "",
        rotation: toNumber(fields[10]),
        id: fields[11] || "",
        holeLength: toNumber(fields[12]),
        holePoint: fields[13] || "",
        // EasyEDA uses Y/N for plating; older records can leave this field
        // empty. Explicit negative values select a mechanical hole, while
        // legacy omitted values preserve the existing plated-hole behavior.
        isPlated: !/^(?:n|false|0)$/i.test(String(fields[14] || "").trim()),
        isLocked: toBool(fields[15])
      });
    } else if (designator === "TRACK") {
      footprint.tracks.push({
        strokeWidth: toNumber(fields[0]),
        layerId: toNumber(fields[1]),
        net: fields[2] || "",
        points: fields[3] || "",
        id: fields[4] || "",
        isLocked: toBool(fields[5])
      });
    } else if (designator === "HOLE") {
      footprint.holes.push({
        centerX: toNumber(fields[0]),
        centerY: toNumber(fields[1]),
        radius: toNumber(fields[2]),
        id: fields[3] || "",
        isLocked: toBool(fields[4])
      });
    } else if (designator === "VIA") {
      footprint.vias.push({
        centerX: toNumber(fields[0]),
        centerY: toNumber(fields[1]),
        diameter: toNumber(fields[2]),
        net: fields[3] || "",
        radius: toNumber(fields[4]),
        id: fields[5] || "",
        isLocked: toBool(fields[6])
      });
    } else if (designator === "CIRCLE") {
      footprint.circles.push({
        cx: toNumber(fields[0]),
        cy: toNumber(fields[1]),
        radius: toNumber(fields[2]),
        strokeWidth: toNumber(fields[3]),
        layerId: toNumber(fields[4]),
        id: fields[5] || "",
        isLocked: toBool(fields[6])
      });
    } else if (designator === "ARC") {
      footprint.arcs.push({
        strokeWidth: toNumber(fields[0]),
        layerId: toNumber(fields[1]),
        net: fields[2] || "",
        path: fields[3] || "",
        helperDots: fields[4] || "",
        id: fields[5] || "",
        isLocked: toBool(fields[6])
      });
    } else if (designator === "RECT") {
      footprint.rectangles.push({
        x: toNumber(fields[0]),
        y: toNumber(fields[1]),
        width: toNumber(fields[2]),
        height: toNumber(fields[3]),
        strokeWidth: toNumber(fields[4]),
        id: fields[5] || "",
        layerId: toNumber(fields[6]),
        isLocked: toBool(fields[7])
      });
    } else if (designator === "TEXT") {
      footprint.texts.push({
        type: fields[0] || "",
        centerX: toNumber(fields[1]),
        centerY: toNumber(fields[2]),
        strokeWidth: toNumber(fields[3]),
        rotation: toNumber(fields[4]),
        mirror: fields[5] || "",
        layerId: toNumber(fields[6]),
        net: fields[7] || "",
        fontSize: toNumber(fields[8]),
        text: fields[9] || "",
        textPath: fields[10] || "",
        isDisplayed: toBool(fields[11]),
        id: fields[12] || "",
        isLocked: toBool(fields[13])
      });
    } else if (designator === "SVGNODE") {
      // EasyEDA embeds the optional model placement as JSON inside the shape list.
      try {
        const attrs = JSON.parse(fields[0]).attrs;
        footprint.model3d = {
          name: attrs.title || "",
          uuid: attrs.uuid || "",
          translation: {
            x: toNumber(String(attrs.c_origin || "0,0").split(",")[0]),
            y: toNumber(String(attrs.c_origin || "0,0").split(",")[1]),
            z: toNumber(attrs.z)
          },
          rotation: {
            x: toNumber(String(attrs.c_rotation || "0,0,0").split(",")[0]),
            y: toNumber(String(attrs.c_rotation || "0,0,0").split(",")[1]),
            z: toNumber(String(attrs.c_rotation || "0,0,0").split(",")[2])
          }
        };
      } catch (error) {
        // Malformed optional model metadata leaves the 2D footprint available.
      }
    }
  }

  return footprint;
}

export { parseEasyedaFootprint };

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
