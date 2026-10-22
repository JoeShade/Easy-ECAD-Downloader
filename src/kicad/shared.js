/*
 * Shared converter constants and math/text helpers used across the EasyEDA
 * parsers and KiCad emitters. This file intentionally holds the common unit,
 * geometry, and formatting utilities that would otherwise drift between stages.
 */

const KI_SYMBOL_LIB_VERSION = "20211014";
const KI_SYMBOL_GENERATOR = "Easy ECAD Downloader";

const KI_SYMBOL_CONFIG = {
  pinLength: 2.54,
  pinNameSize: 1.27,
  pinNumSize: 1.27,
  propertyFontSize: 1.27,
  fieldOffsetStart: 5.08,
  fieldOffsetIncrement: 2.54,
  defaultLineWidth: 0
};

const KI_FOOTPRINT_TEMPLATES = {
  moduleInfo: "(module {packageName} (layer F.Cu) (tedit {edit})\n",
  fpType: "\t(attr {componentType})\n",
  reference:
    "\t(fp_text reference REF** (at {posX} {posY}) (layer F.SilkS)\n\t\t(effects (font (size 1 1) (thickness 0.15)))\n\t)\n",
  value:
    "\t(fp_text value {packageName} (at {posX} {posY}) (layer F.Fab)\n\t\t(effects (font (size 1 1) (thickness 0.15)))\n\t)\n",
  fabRef:
    "\t(fp_text user %R (at 0 0) (layer F.Fab)\n\t\t(effects (font (size 1 1) (thickness 0.15)))\n\t)\n",
  pad:
    "\t(pad {number} {type} {shape} (at {posX} {posY} {orientation}) (size {width} {height}) (layers {layers}){drill}{polygon})\n",
  line:
    "\t(fp_line (start {startX} {startY}) (end {endX} {endY}) (layer {layers}) (width {strokeWidth}))\n",
  hole:
    "\t(pad \"\" np_thru_hole circle (at {posX} {posY}) (size {size} {size}) (drill {size}) (layers *.Mask))\n",
  via:
    "\t(pad \"\" thru_hole circle (at {posX} {posY}) (size {diameter} {diameter}) (drill {size}) (layers *.Cu *.Paste *.Mask))\n",
  circle:
    "\t(fp_circle (center {cx} {cy}) (end {endX} {endY}) (layer {layers}) (width {strokeWidth}))\n",
  arc:
    "\t(fp_arc (start {startX} {startY}) (end {endX} {endY}) (angle {angle}) (layer {layers}) (width {strokeWidth}))\n",
  text:
    "\t(fp_text user {text} (at {posX} {posY} {orientation}) (layer {layers}){display}\n\t\t(effects (font (size {fontSize} {fontSize}) (thickness {thickness})) (justify left{mirror}))\n\t)\n",
  model3d:
    "\t(model \"{file3d}\"\n\t\t(offset (xyz {posX} {posY} {posZ}))\n\t\t(scale (xyz 1 1 1))\n\t\t(rotate (xyz {rotX} {rotY} {rotZ}))\n\t)\n"
};

const KI_PAD_SHAPE = {
  ELLIPSE: "circle",
  RECT: "rect",
  OVAL: "oval",
  POLYGON: "custom"
};

const KI_PAD_LAYER = {
  1: "F.Cu F.Paste F.Mask",
  2: "B.Cu B.Paste B.Mask",
  3: "F.SilkS",
  11: "*.Cu *.Paste *.Mask",
  13: "F.Fab",
  15: "Dwgs.User"
};

const KI_PAD_LAYER_THT = {
  1: "F.Cu F.Mask",
  2: "B.Cu B.Mask",
  3: "F.SilkS",
  11: "*.Cu *.Mask",
  13: "F.Fab",
  15: "Dwgs.User"
};

const KI_LAYERS = {
  1: "F.Cu",
  2: "B.Cu",
  3: "F.SilkS",
  4: "B.SilkS",
  5: "F.Paste",
  6: "B.Paste",
  7: "F.Mask",
  8: "B.Mask",
  10: "Edge.Cuts",
  11: "Edge.Cuts",
  12: "Cmts.User",
  13: "F.Fab",
  14: "B.Fab",
  15: "Dwgs.User",
  101: "F.Fab"
};

const EASYEDA_PIN_TYPE_MAP = {
  0: "unspecified",
  1: "input",
  2: "output",
  3: "bidirectional",
  4: "power_in"
};

function toNumber(value, fallback = 0) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function toBool(value) {
  if (value === true || value === false) {
    return value;
  }
  const str = String(value || "").toLowerCase();
  if (str === "show" || str === "true" || str === "1") {
    return true;
  }
  if (str === "hide" || str === "false" || str === "0" || str === "") {
    return false;
  }
  return Boolean(value);
}

// Library identifiers have stricter character rules than display properties.
// Keep the original property text and replace KiCad's forbidden ID characters
// here, alongside the existing whitespace removal and slash normalization.
function sanitizeFields(name) {
  return String(name || "").replace(/\s+/g, "").replace(/[/<>"\\:]/g, "_");
}

// KiCad uses quoted S-expression strings: escaping backslashes first preserves
// literal quotes and backslashes supplied by upstream names and property text.
function escapeKiCadString(value) {
  return String(value ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r");
}

// Existing footprint atoms stay readable; whitespace or delimiters require a
// quoted string so a part label remains one value in the surrounding expression.
function quoteKiCadAtom(value) {
  const text = String(value ?? "");
  return /^[^\s()"\\|#]+$/.test(text) ? text : `"${escapeKiCadString(text)}"`;
}

// EasyEDA marks an active-low label with a trailing '#'; KiCad wraps its
// overbar text in '~{...}', preserving slash-separated labels independently.
function applyTextStyle(text) {
  if (text.endsWith("#")) {
    return `~{${text.slice(0, -1)}}`;
  }
  return text;
}

function applyPinNameStyle(pinName) {
  return String(pinName || "")
    .split("/")
    .map((value) => applyTextStyle(value))
    .join("/");
}

// One EasyEDA drawing unit is ten mils (0.254 mm).
function pxToMm(dim) {
  return 10.0 * Number(dim) * 0.0254;
}

function convertToMm(dim) {
  return Number(dim) * 10 * 0.0254;
}

// Read the absolute move, line, elliptical-arc and close commands used by the
// converter's supported EasyEDA path subset. Each repeated argument group
// becomes a separate record for the geometry conversion stage.
function parseSvgPath(svgPath) {
  // SVG numbers may touch at a sign or decimal point; e/E belongs to an
  // exponent. Keep command splitting separate from numeric tokenization.
  const matches = String(svgPath || "").matchAll(/([a-df-z])([^a-df-z]*)/gi);
  const parsed = [];

  for (const match of matches) {
    const cmd = match[1];
    const args = match[2].match(/[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?/gi) || [];
    if (cmd === "M") {
      for (let i = 0; i + 1 < args.length; i += 2) {
        // Extra coordinate pairs after moveto are implicit line segments.
        parsed.push(i === 0
          ? { type: "M", startX: toNumber(args[i]), startY: toNumber(args[i + 1]) }
          : { type: "L", posX: toNumber(args[i]), posY: toNumber(args[i + 1]) });
      }
    } else if (cmd === "A") {
      for (let i = 0; i + 6 < args.length; i += 7) {
        parsed.push({
          type: "A",
          radiusX: toNumber(args[i]),
          radiusY: toNumber(args[i + 1]),
          xAxisRotation: toNumber(args[i + 2]),
          flagLargeArc: args[i + 3] === "1",
          flagSweep: args[i + 4] === "1",
          endX: toNumber(args[i + 5]),
          endY: toNumber(args[i + 6])
        });
      }
    } else if (cmd === "L") {
      for (let i = 0; i + 1 < args.length; i += 2) {
        parsed.push({
          type: "L",
          posX: toNumber(args[i]),
          posY: toNumber(args[i + 1])
        });
      }
    } else if (cmd === "Z") {
      parsed.push({ type: "Z" });
    }
  }

  return parsed;
}

function toRadians(angle) {
  return (angle / 180) * Math.PI;
}

function toDegrees(angle) {
  return (angle / Math.PI) * 180;
}

// Convert an SVG arc's endpoints and radii to its center and signed sweep.
// Endpoint coordinates permit two possible centers; the large-arc and sweep
// flags choose the center and travel direction required by the source path.
function computeArc(
  startX,
  startY,
  radiusX,
  radiusY,
  angle,
  largeArcFlag,
  sweepFlag,
  endX,
  endY
) {
  const dx2 = (startX - endX) / 2.0;
  const dy2 = (startY - endY) / 2.0;

  const phi = toRadians(angle % 360.0);
  const cosPhi = Math.cos(phi);
  const sinPhi = Math.sin(phi);

  const x1 = cosPhi * dx2 + sinPhi * dy2;
  const y1 = -sinPhi * dx2 + cosPhi * dy2;

  let rx = Math.abs(radiusX);
  let ry = Math.abs(radiusY);
  let prx = rx * rx;
  let pry = ry * ry;
  const px1 = x1 * x1;
  const py1 = y1 * y1;

  const radiiCheck = prx && pry ? px1 / prx + py1 / pry : 0;
  if (radiiCheck > 1) {
    // SVG expands radii that are too short to connect the given endpoints.
    rx = Math.sqrt(radiiCheck) * rx;
    ry = Math.sqrt(radiiCheck) * ry;
    prx = rx * rx;
    pry = ry * ry;
  }

  const sign = largeArcFlag === sweepFlag ? -1 : 1;
  let sq = 0;
  if (prx * py1 + pry * px1 > 0) {
    sq = (prx * pry - prx * py1 - pry * px1) / (prx * py1 + pry * px1);
  }
  sq = Math.max(sq, 0);

  const coef = sign * Math.sqrt(sq);
  const cx1 = coef * ((rx * y1) / ry);
  const cy1 = rx !== 0 ? coef * -((ry * x1) / rx) : 0;

  const sx2 = (startX + endX) / 2.0;
  const sy2 = (startY + endY) / 2.0;
  const cx = sx2 + (cosPhi * cx1 - sinPhi * cy1);
  const cy = sy2 + (sinPhi * cx1 + cosPhi * cy1);

  const ux = rx !== 0 ? (x1 - cx1) / rx : 0;
  const uy = ry !== 0 ? (y1 - cy1) / ry : 0;
  const vx = rx !== 0 ? (-x1 - cx1) / rx : 0;
  const vy = ry !== 0 ? (-y1 - cy1) / ry : 0;

  const n = Math.sqrt((ux * ux + uy * uy) * (vx * vx + vy * vy));
  const p = ux * vx + uy * vy;
  const signAngle = ux * vy - uy * vx < 0 ? -1 : 1;
  let angleExtent = n !== 0 ? toDegrees(signAngle * Math.acos(p / n)) : 719;
  if (!sweepFlag && angleExtent > 0) {
    angleExtent -= 360;
  } else if (sweepFlag && angleExtent < 0) {
    angleExtent += 360;
  }

  const extentSign = angleExtent < 0 ? 1 : -1;
  // KiCad's legacy footprint arc angle uses the opposite sign to SVG's sweep.
  angleExtent = (Math.abs(angleExtent) % 360) * extentSign;

  return { cx, cy, angleExtent };
}

// Modern symbol arcs identify a point halfway around a circular sweep instead
// of storing a center and angle; averaging these angles supplies that third point.
function getMiddleArcPos(centerX, centerY, radius, angleStart, angleEnd) {
  const middleX =
    centerX + radius * Math.cos(((angleStart + angleEnd) / 2) * (Math.PI / 180));
  const middleY =
    centerY + radius * Math.sin(((angleStart + angleEnd) / 2) * (Math.PI / 180));
  return { middleX, middleY };
}

function indentLines(text, indentLevel) {
  if (!text.trim()) {
    return "";
  }
  const indent = "  ".repeat(indentLevel);
  return text
    .split("\n")
    .map((line) => (line.trim() ? `${indent}${line}` : line))
    .join("\n");
}

// EasyEDA rotations in the 0..360 range become KiCad's signed -180..180 range.
function angleToKi(rotation) {
  const value = toNumber(rotation);
  if (!Number.isFinite(value)) {
    return "";
  }
  return value > 180 ? -(360 - value) : value;
}

function rotate(x, y, degrees) {
  const radians = (degrees * Math.PI) / 180;
  return {
    x: x * Math.cos(radians) - y * Math.sin(radians),
    y: x * Math.sin(radians) + y * Math.cos(radians)
  };
}

function fpToKi(value) {
  const num = toNumber(value);
  return Number.isFinite(num) ? Math.round(num * 10 * 0.0254 * 100) / 100 : num;
}

export {
  EASYEDA_PIN_TYPE_MAP,
  KI_FOOTPRINT_TEMPLATES,
  KI_LAYERS,
  KI_PAD_LAYER,
  KI_PAD_LAYER_THT,
  KI_PAD_SHAPE,
  KI_SYMBOL_CONFIG,
  KI_SYMBOL_GENERATOR,
  KI_SYMBOL_LIB_VERSION,
  angleToKi,
  applyPinNameStyle,
  applyTextStyle,
  computeArc,
  convertToMm,
  escapeKiCadString,
  fpToKi,
  getMiddleArcPos,
  indentLines,
  parseSvgPath,
  pxToMm,
  quoteKiCadAtom,
  rotate,
  sanitizeFields,
  toBool,
  toDegrees,
  toNumber
};

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
