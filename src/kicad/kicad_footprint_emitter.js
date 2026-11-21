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
  padDrillSize,
  parseSvgPath,
  pointOnArc,
  quoteKiCadAtom,
  toNumber
} from "./shared.js";

// Silkscreen, assembly and documentation regions describe printed graphics.
// Copper, clearance, board-edge and component-model regions have separate PCB semantics.
const MARKING_LAYERS = new Set([3, 4, 12, 13, 14, 15]);

// Both region outlines and elliptical strokes use straight KiCad segments.
// Limit the chord error on the longer axis to 0.01 mm for marking-sized curves.
function arcInterior(arc) {
  const radius = convertToMm(Math.max(arc.radiusX, arc.radiusY));
  const maxAngle = 2 * Math.acos(Math.max(-1, 1 - 0.01 / radius));
  const count = Math.min(1024, Math.max(2, Math.ceil(Math.abs(arc.sweepAngle) / maxAngle)));
  const interior = [];
  for (let i = 1; i < count; i++) {
    const point = pointOnArc(arc, i / count);
    interior.push([point.x, point.y]);
  }
  return interior;
}

// SVG omits a coincident endpoint and joins distinct endpoints with a straight
// line when either radius is zero. Both cases need only the source endpoints.
function arcGeometry(start, step) {
  if (!step.radiusX || !step.radiusY || (start[0] === step.endX && start[1] === step.endY)) return null;
  return computeArc(start[0], start[1], step.radiusX, step.radiusY,
    step.xAxisRotation, step.flagLargeArc, step.flagSweep, step.endX, step.endY);
}

function regionPolygon(region, bbox) {
  if (region.type !== "solid" || !MARKING_LAYERS.has(region.layerId)) return "";
  const path = region.path.replace(/z/g, "Z");
  // A compound path can encode holes. A single KiCad polygon can represent
  // one contour; accepting only supported contours keeps those holes open.
  if (/[^MLAZ\deE.+,\s-]/.test(path) || /Z\s*\S/.test(path) || path.includes("M", 1)) return "";
  const [start, ...steps] = parseSvgPath(path);
  if (start?.type !== "M") return "";
  const coordinates = [[start.startX, start.startY]];
  for (const step of steps) {
    if (step.type === "L") {
      coordinates.push([step.posX, step.posY]);
    } else if (step.type === "A") {
      const arc = arcGeometry(coordinates.at(-1), step);
      if (arc) coordinates.push(...arcInterior(arc));
      coordinates.push([step.endX, step.endY]);
    }
  }

  const points = [];
  for (const [px, py] of coordinates) {
    const xy = `(xy ${(convertToMm(px) - bbox.x).toFixed(4)} ${(convertToMm(py) - bbox.y).toFixed(4)})`;
    if (xy !== points.at(-1)) points.push(xy);
  }
  if (points.at(-1) === points[0]) points.pop();
  if (points.length < 3) return "";
  return `\t(fp_poly (pts ${points.join(" ")}) (layer ${KI_LAYERS[region.layerId]}) (width 0) (fill solid))\n`;
}

// Track and custom-pad records store alternating x/y values in drawing units.
// Reject incomplete geometry before writing a displaced trace or an unbuildable land.
function footprintPoints(text, minimumPoints, record, originX, originY) {
  const coordinates = text.trim().split(/\s+/).map(Number);
  if (coordinates.length < minimumPoints * 2 || coordinates.length % 2 || !coordinates.every(Number.isFinite)) {
    throw new Error(`Invalid ${record} coordinates: expected at least ${minimumPoints} complete x/y pairs`);
  }
  const points = [];
  for (let i = 0; i < coordinates.length; i += 2) {
    points.push([convertToMm(coordinates[i]) - originX, convertToMm(coordinates[i + 1]) - originY]);
  }
  return points;
}

// Every KiCad line is specified by two footprint-local points in millimetres.
function footprintLine(start, end, layerId, strokeWidth) {
  return KI_FOOTPRINT_TEMPLATES.line
    .replace("{startX}", start[0].toFixed(2))
    .replace("{startY}", start[1].toFixed(2))
    .replace("{endX}", end[0].toFixed(2))
    .replace("{endY}", end[1].toFixed(2))
    .replace("{layers}", KI_LAYERS[layerId] || "F.Fab")
    .replace("{strokeWidth}", Math.max(strokeWidth, 0.01).toFixed(2));
}

// Legacy KiCad arcs run from the source endpoint back around the circle.
// Ellipses use connected lines because a circular KiCad arc has only one radius.
function footprintArc(record, bbox) {
  const [move, ...steps] = parseSvgPath(record.path);
  if (move?.type !== "M" || steps[0]?.type !== "A") {
    throw new Error("Unsupported footprint arc path: expected absolute M and A commands");
  }
  const local = ([x, y]) => [convertToMm(x) - bbox.x, convertToMm(y) - bbox.y];
  const width = convertToMm(record.strokeWidth);
  let subpath = [move.startX, move.startY];
  let start = subpath;
  let output = "";
  for (const step of steps) {
    if (step.type === "M") {
      subpath = [step.startX, step.startY];
      start = subpath;
      continue;
    }
    let end = subpath;
    if (step.type === "L") end = [step.posX, step.posY];
    if (step.type === "A") end = [step.endX, step.endY];
    if (start[0] === end[0] && start[1] === end[1]) continue;
    const arc = step.type === "A" ? arcGeometry(start, step) : null;
    if (arc && arc.radiusX === arc.radiusY) {
      const [centerX, centerY] = local([arc.cx, arc.cy]);
      const [endX, endY] = local(end);
      output += KI_FOOTPRINT_TEMPLATES.arc
        .replace("{startX}", centerX.toFixed(2))
        .replace("{startY}", centerY.toFixed(2))
        .replace("{endX}", endX.toFixed(2))
        .replace("{endY}", endY.toFixed(2))
        .replace("{angle}", arc.angleExtent.toFixed(2))
        .replace("{layers}", KI_LAYERS[record.layerId] || "F.Fab")
        .replace("{strokeWidth}", Math.max(width, 0.01).toFixed(2));
    } else {
      const points = [start, ...(arc ? arcInterior(arc) : []), end].map(local);
      for (let i = 1; i < points.length; i++) {
        output += footprintLine(points[i - 1], points[i], record.layerId, width);
      }
    }
    start = end;
  }
  return output;
}

// A nonzero holeLength denotes a slot. Its longer dimension follows the pad's
// longer local axis, and KiCad's oval drill lists local X then local Y size.
function drillToKi(holeRadius, holeLength, padHeight, padWidth) {
  const size = padDrillSize(holeRadius, holeLength, padHeight, padWidth);
  if (!size) return "";
  return holeLength > 0
    ? `(drill oval ${size.width.toFixed(2)} ${size.height.toFixed(2)})`
    : `(drill ${size.width.toFixed(2)})`;
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
    solidRegions: footprint.solidRegions,
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

  for (const region of kiFootprint.solidRegions) {
    output += regionPolygon(region, kiFootprint.bbox);
  }

  for (const track of kiFootprint.tracks) {
    const points = footprintPoints(track.points, 2, "TRACK", kiFootprint.bbox.x, kiFootprint.bbox.y);
    for (let i = 1; i < points.length; i++) {
      output += footprintLine(points[i - 1], points[i], track.layerId, track.strokeWidth);
    }
  }

  for (const rect of kiFootprint.rectangles) {
    const startX = rect.x - kiFootprint.bbox.x;
    const startY = rect.y - kiFootprint.bbox.y;
    const width = rect.width;
    const height = rect.height;
    if (rect.fill !== "none" && MARKING_LAYERS.has(rect.layerId)) {
      output += `\t(fp_rect (start ${startX.toFixed(2)} ${startY.toFixed(2)})` +
        ` (end ${(startX + width).toFixed(2)} ${(startY + height).toFixed(2)})` +
        ` (layer ${KI_LAYERS[rect.layerId]}) (width ${rect.strokeWidth.toFixed(2)}) (fill solid))\n`;
      continue;
    }
    const corners = [[startX, startY], [startX + width, startY], [startX + width, startY + height],
      [startX, startY + height], [startX, startY]];
    for (let i = 1; i < corners.length; i++) {
      output += footprintLine(corners[i - 1], corners[i], rect.layerId, rect.strokeWidth);
    }
  }

  for (const pad of kiFootprint.pads) {
    const shape = KI_PAD_SHAPE[pad.shape] || "custom";
    let width = Math.max(pad.width, 0.01);
    let height = Math.max(pad.height, 0.01);
    let orientation = angleToKi(pad.rotation);
    let polygon = "";

    if (shape === "custom") {
      // EasyEDA polygon pad points are absolute drawing coordinates. KiCad pad
      // primitives are local to their pad anchor, with the rotation already in the points.
      const points = footprintPoints(pad.points, 3, "custom pad", pad.centerX, pad.centerY);
      width = 0.005;
      height = 0.005;
      orientation = 0;
      const path = points.map(([x, y]) => `(xy ${x.toFixed(2)} ${y.toFixed(2)})`);
      polygon =
        "\n\t\t(primitives \n\t\t\t(gr_poly \n\t\t\t\t(pts " +
        path.join(" ") +
        "\n\t\t\t\t) \n\t\t\t\t(width 0.1) \n\t\t\t)\n\t\t)\n\t";
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
      .replace("{orientation}", orientation.toFixed(2))
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
    output += footprintArc(arc, kiFootprint.bbox);
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
