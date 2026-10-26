/*
 * Converts the normalized footprint model into KiCad footprint text. This
 * module owns KiCad-specific coordinate transforms, pad/geometry formatting,
 * and 3D model placement output.
 */

import {
  KI_FOOTPRINT_TEMPLATES,
  KI_LAYERS,
  KI_PAD_LAYER,
  KI_PAD_LAYER_THT,
  KI_PAD_SHAPE,
  angleToKi,
  computeArc,
  convertToMm,
  escapeKiCadString,
  fpToKi,
  parseSvgPath,
  quoteKiCadAtom,
  toNumber
} from "./shared.js";

// A nonzero holeLength denotes a slot. Its longer dimension follows the pad's
// longer local axis, and KiCad's oval drill lists local X then local Y size.
function drillToKi(holeRadius, holeLength, padHeight, padWidth) {
  if (holeRadius > 0 && holeLength && holeLength !== 0) {
    const maxDistanceHole = Math.max(holeRadius * 2, holeLength);
    const pos0 = padHeight - maxDistanceHole;
    const pos90 = padWidth - maxDistanceHole;
    const maxDistance = Math.max(pos0, pos90);
    if (maxDistance === pos0) {
      return `(drill oval ${(holeRadius * 2).toFixed(2)} ${holeLength.toFixed(2)})`;
    }
    return `(drill oval ${holeLength.toFixed(2)} ${(holeRadius * 2).toFixed(2)})`;
  }
  if (holeRadius > 0) {
    return `(drill ${(2 * holeRadius).toFixed(2)})`;
  }
  return "";
}

// Convert named scalar lengths once. Raw point/path records retain source units
// until serialization. KiCad's model offset token also stores millimetres;
// obj_to_wrl.js owns the separate WRL vertex scale of 2.54 mm per unit.
function convertFootprintToKiCad(footprint) {
  const bbox = {
    x: convertToMm(footprint.bbox.x),
    y: convertToMm(footprint.bbox.y)
  };

  const pads = footprint.pads.map((pad) => ({
    ...pad,
    centerX: convertToMm(pad.centerX),
    centerY: convertToMm(pad.centerY),
    width: convertToMm(pad.width),
    height: convertToMm(pad.height),
    holeRadius: convertToMm(pad.holeRadius),
    holeLength: convertToMm(pad.holeLength)
  }));
  const tracks = footprint.tracks.map((track) => ({
    ...track,
    strokeWidth: convertToMm(track.strokeWidth)
  }));
  const holes = footprint.holes.map((hole) => ({
    ...hole,
    centerX: convertToMm(hole.centerX),
    centerY: convertToMm(hole.centerY),
    radius: convertToMm(hole.radius)
  }));
  const vias = footprint.vias.map((via) => ({
    ...via,
    centerX: convertToMm(via.centerX),
    centerY: convertToMm(via.centerY),
    diameter: convertToMm(via.diameter),
    radius: convertToMm(via.radius)
  }));
  const circles = footprint.circles.map((circle) => ({
    ...circle,
    cx: convertToMm(circle.cx),
    cy: convertToMm(circle.cy),
    radius: convertToMm(circle.radius),
    strokeWidth: convertToMm(circle.strokeWidth)
  }));
  const rectangles = footprint.rectangles.map((rect) => ({
    ...rect,
    x: convertToMm(rect.x),
    y: convertToMm(rect.y),
    width: convertToMm(rect.width),
    height: convertToMm(rect.height),
    strokeWidth: convertToMm(rect.strokeWidth)
  }));
  const texts = footprint.texts.map((text) => ({
    ...text,
    centerX: convertToMm(text.centerX),
    centerY: convertToMm(text.centerY),
    strokeWidth: convertToMm(text.strokeWidth),
    fontSize: convertToMm(text.fontSize)
  }));

  const model3d = footprint.model3d
    ? {
        ...footprint.model3d,
        translation: {
          x: convertToMm(footprint.model3d.translation.x) - bbox.x,
          y: -(convertToMm(footprint.model3d.translation.y) - bbox.y),
          z: convertToMm(footprint.model3d.translation.z)
        },
        rotation: {
          x: (360 - toNumber(footprint.model3d.rotation.x)) % 360,
          y: (360 - toNumber(footprint.model3d.rotation.y)) % 360,
          z: (360 - toNumber(footprint.model3d.rotation.z)) % 360
        }
      }
    : null;

  return {
    info: footprint.info,
    bbox,
    pads,
    tracks,
    holes,
    vias,
    circles,
    arcs: footprint.arcs,
    rectangles,
    texts,
    model3d
  };
}

// Emit the legacy footprint syntax accepted by KiCad with graphics relative to
// the footprint origin. String replacements use callbacks for upstream text so
// literal '$&' retains its characters. Insert upstream text last so embedded
// strings such as '{posX}' remain text after all template markers are resolved.
function exportKiCadFootprint(kiFootprint, model3dPath) {
  let output = "";
  output += KI_FOOTPRINT_TEMPLATES.moduleInfo
    .replace("{edit}", "5DC5F6A4")
    .replace("{packageName}", () => quoteKiCadAtom(`easyeda2kicad:${kiFootprint.info.name}`));

  if (kiFootprint.info.fpType) {
    output += KI_FOOTPRINT_TEMPLATES.fpType.replace(
      "{componentType}",
      kiFootprint.info.fpType === "smd" ? "smd" : "through_hole"
    );
  }

  const yLow = kiFootprint.pads.length
    ? Math.min(...kiFootprint.pads.map((pad) => pad.centerY - kiFootprint.bbox.y))
    : -2;
  const yHigh = kiFootprint.pads.length
    ? Math.max(...kiFootprint.pads.map((pad) => pad.centerY - kiFootprint.bbox.y))
    : 2;

  output += KI_FOOTPRINT_TEMPLATES.reference
    .replace("{posX}", "0")
    .replace("{posY}", (yLow - 4).toFixed(2));
  output += KI_FOOTPRINT_TEMPLATES.value
    .replace("{posX}", "0")
    .replace("{posY}", (yHigh + 4).toFixed(2))
    .replace("{packageName}", () => quoteKiCadAtom(kiFootprint.info.name));
  output += KI_FOOTPRINT_TEMPLATES.fabRef;

  for (const track of kiFootprint.tracks) {
    const points = String(track.points || "").trim().split(/\s+/).map(fpToKi);
    for (let i = 0; i < points.length - 2; i += 2) {
      output += KI_FOOTPRINT_TEMPLATES.line
        .replace("{startX}", (points[i] - kiFootprint.bbox.x).toFixed(2))
        .replace("{startY}", (points[i + 1] - kiFootprint.bbox.y).toFixed(2))
        .replace("{endX}", (points[i + 2] - kiFootprint.bbox.x).toFixed(2))
        .replace("{endY}", (points[i + 3] - kiFootprint.bbox.y).toFixed(2))
        .replace("{layers}", KI_LAYERS[track.layerId] || "F.Fab")
        .replace("{strokeWidth}", Math.max(track.strokeWidth, 0.01).toFixed(2));
    }
  }

  for (const rect of kiFootprint.rectangles) {
    const startX = rect.x - kiFootprint.bbox.x;
    const startY = rect.y - kiFootprint.bbox.y;
    const width = rect.width;
    const height = rect.height;
    const points = [
      [startX, startY, startX + width, startY],
      [startX + width, startY, startX + width, startY + height],
      [startX + width, startY + height, startX, startY + height],
      [startX, startY + height, startX, startY]
    ];
    for (const [sx, sy, ex, ey] of points) {
      output += KI_FOOTPRINT_TEMPLATES.line
        .replace("{startX}", sx.toFixed(2))
        .replace("{startY}", sy.toFixed(2))
        .replace("{endX}", ex.toFixed(2))
        .replace("{endY}", ey.toFixed(2))
        .replace("{layers}", KI_LAYERS[rect.layerId] || "F.Fab")
        .replace("{strokeWidth}", Math.max(rect.strokeWidth, 0.01).toFixed(2));
    }
  }

  for (const pad of kiFootprint.pads) {
    let shape = KI_PAD_SHAPE[pad.shape] || "custom";
    let width = Math.max(pad.width, 0.01);
    let height = Math.max(pad.height, 0.01);
    let orientation = angleToKi(pad.rotation);
    let polygon = "";

    if (shape === "custom") {
      // EasyEDA polygon pad points are absolute drawing coordinates. KiCad pad
      // primitives are local to their pad anchor, with the rotation already in the points.
      const points = pad.points.trim().split(/\s+/).map(fpToKi);
      if (points.length) {
        width = 0.005;
        height = 0.005;
        orientation = 0;
        const path = [];
        for (let i = 0; i < points.length; i += 2) {
          const x = (points[i] - kiFootprint.bbox.x) - (pad.centerX - kiFootprint.bbox.x);
          const y = (points[i + 1] - kiFootprint.bbox.y) - (pad.centerY - kiFootprint.bbox.y);
          path.push(`(xy ${x.toFixed(2)} ${y.toFixed(2)})`);
        }
        polygon =
          "\n\t\t(primitives \n\t\t\t(gr_poly \n\t\t\t\t(pts " +
          path.join(" ") +
          "\n\t\t\t\t) \n\t\t\t\t(width 0.1) \n\t\t\t)\n\t\t)\n\t";
      }
    }

    const layers =
      pad.holeRadius <= 0
        ? KI_PAD_LAYER[pad.layerId] || ""
        : KI_PAD_LAYER_THT[pad.layerId] || "";

    const drill = drillToKi(
      pad.holeRadius,
      pad.holeLength,
      height,
      width
    );

    // Mechanical through holes retain their geometry and copper clearances;
    // KiCad identifies them with np_thru_hole and an empty electrical number.
    const isMechanicalHole = pad.holeRadius > 0 && !pad.isPlated;
    let number = isMechanicalHole ? "" : pad.number || "";
    if (number.includes("(") && number.includes(")")) {
      number = number.split("(")[1].split(")")[0];
    }

    output += KI_FOOTPRINT_TEMPLATES.pad
      .replace("{type}", isMechanicalHole ? "np_thru_hole" : pad.holeRadius > 0 ? "thru_hole" : "smd")
      .replace("{shape}", shape)
      .replace("{posX}", (pad.centerX - kiFootprint.bbox.x).toFixed(2))
      .replace("{posY}", (pad.centerY - kiFootprint.bbox.y).toFixed(2))
      .replace("{orientation}", orientation === "" ? "" : orientation.toFixed(2))
      .replace("{width}", width.toFixed(2))
      .replace("{height}", height.toFixed(2))
      .replace("{layers}", layers)
      .replace("{drill}", drill ? ` ${drill}` : "")
      .replace("{polygon}", polygon)
      .replace("{number}", () => quoteKiCadAtom(number));
  }

  for (const hole of kiFootprint.holes) {
    const holeSize = (hole.radius * 2).toFixed(2);
    output += KI_FOOTPRINT_TEMPLATES.hole
      .replace("{posX}", (hole.centerX - kiFootprint.bbox.x).toFixed(2))
      .replace("{posY}", (hole.centerY - kiFootprint.bbox.y).toFixed(2))
      .replace(/{size}/g, holeSize);
  }

  for (const via of kiFootprint.vias) {
    output += KI_FOOTPRINT_TEMPLATES.via
      .replace("{posX}", (via.centerX - kiFootprint.bbox.x).toFixed(2))
      .replace("{posY}", (via.centerY - kiFootprint.bbox.y).toFixed(2))
      .replace(/{diameter}/g, via.diameter.toFixed(2))
      .replace("{size}", (via.radius * 2).toFixed(2));
  }

  for (const circle of kiFootprint.circles) {
    const cx = circle.cx - kiFootprint.bbox.x;
    const cy = circle.cy - kiFootprint.bbox.y;
    output += KI_FOOTPRINT_TEMPLATES.circle
      .replace("{cx}", cx.toFixed(2))
      .replace("{cy}", cy.toFixed(2))
      .replace("{endX}", (cx + circle.radius).toFixed(2))
      .replace("{endY}", cy.toFixed(2))
      .replace("{layers}", KI_LAYERS[circle.layerId] || "F.Fab")
      .replace("{strokeWidth}", Math.max(circle.strokeWidth, 0.01).toFixed(2));
  }

  for (const arc of kiFootprint.arcs) {
    // EasyEDA describes an SVG endpoint arc. Legacy KiCad footprints instead
    // store its center, final endpoint, and the signed angle around that center.
    const [move, ellipseArc] = parseSvgPath(arc.path);
    if (move?.type !== "M" || ellipseArc?.type !== "A") {
      throw new Error("Unsupported footprint arc path: expected absolute M and A commands");
    }
    const startX = fpToKi(move.startX) - kiFootprint.bbox.x;
    const startY = fpToKi(move.startY) - kiFootprint.bbox.y;
    const radiusX = fpToKi(ellipseArc.radiusX);
    const radiusY = fpToKi(ellipseArc.radiusY);
    const endX = fpToKi(ellipseArc.endX) - kiFootprint.bbox.x;
    const endY = fpToKi(ellipseArc.endY) - kiFootprint.bbox.y;
    let extent = 0;
    let cx = 0;
    let cy = 0;
    if (radiusY !== 0) {
      const arcInfo = computeArc(
        startX,
        startY,
        radiusX,
        radiusY,
        ellipseArc.xAxisRotation,
        ellipseArc.flagLargeArc,
        ellipseArc.flagSweep,
        endX,
        endY
      );
      cx = arcInfo.cx;
      cy = arcInfo.cy;
      extent = arcInfo.angleExtent;
    }

    output += KI_FOOTPRINT_TEMPLATES.arc
      .replace("{startX}", cx.toFixed(2))
      .replace("{startY}", cy.toFixed(2))
      .replace("{endX}", endX.toFixed(2))
      .replace("{endY}", endY.toFixed(2))
      .replace("{angle}", extent.toFixed(2))
      .replace("{layers}", KI_LAYERS[arc.layerId] || "F.Fab")
      .replace("{strokeWidth}", Math.max(fpToKi(arc.strokeWidth), 0.01).toFixed(2));
  }

  for (const text of kiFootprint.texts) {
    let layers = KI_LAYERS[text.layerId] || "F.Fab";
    if (text.type === "N") {
      layers = layers.replace(".SilkS", ".Fab");
    }
    const mirror = layers.startsWith("B") ? " mirror" : "";
    output += KI_FOOTPRINT_TEMPLATES.text
      .replace("{posX}", (text.centerX - kiFootprint.bbox.x).toFixed(2))
      .replace("{posY}", (text.centerY - kiFootprint.bbox.y).toFixed(2))
      .replace("{orientation}", angleToKi(text.rotation).toFixed(2))
      .replace("{layers}", layers)
      .replace("{display}", text.isDisplayed === false ? " hide" : "")
      .replace(/{fontSize}/g, Math.max(text.fontSize, 1).toFixed(2))
      .replace("{thickness}", Math.max(text.strokeWidth, 0.01).toFixed(2))
      .replace("{mirror}", mirror)
      .replace("{text}", () => quoteKiCadAtom(text.text));
  }

  if (kiFootprint.model3d && model3dPath) {
    output += KI_FOOTPRINT_TEMPLATES.model3d
      .replace("{posX}", kiFootprint.model3d.translation.x.toFixed(3))
      .replace("{posY}", kiFootprint.model3d.translation.y.toFixed(3))
      .replace("{posZ}", kiFootprint.model3d.translation.z.toFixed(3))
      .replace("{rotX}", kiFootprint.model3d.rotation.x.toFixed(0))
      .replace("{rotY}", kiFootprint.model3d.rotation.y.toFixed(0))
      .replace("{rotZ}", kiFootprint.model3d.rotation.z.toFixed(0))
      .replace("{file3d}", () => escapeKiCadString(`${model3dPath}/${kiFootprint.model3d.name}.wrl`));
  }

  output += ")";
  return output;
}

export { convertFootprintToKiCad, drillToKi, exportKiCadFootprint };

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
