/*
 * Converts the normalized symbol model into KiCad symbol-library text. EasyEDA
 * parsing is handled elsewhere; this module focuses on KiCad-specific geometry,
 * property formatting, and pin serialization.
 */

import {
  EASYEDA_PIN_TYPE_MAP,
  KI_SYMBOL_CONFIG,
  KI_SYMBOL_GENERATOR,
  KI_SYMBOL_LIB_VERSION,
  applyPinNameStyle,
  computeArc,
  escapeKiCadString,
  indentLines,
  parseSvgPath,
  pointOnArc,
  pxToMm,
  sanitizeFields,
  toNumber
} from "./shared.js";

// Pin paths run from the electrical anchor toward the body. Mirrored parts can
// retain the original rotation metadata even after this signed segment flips.
function pinGeometry(pin) {
  const segment = pin.pinPath.path.match(/([hv])\s*([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)\s*$/i);
  if (!segment) return { length: 0, orientation: (180 + pin.settings.rotation) % 360 };
  const command = segment[1];
  const horizontal = command.toLowerCase() === "h";
  const anchor = horizontal ? pin.settings.posX : pin.settings.posY;
  const delta = Number(segment[2]) - (command === command.toUpperCase() ? anchor : 0);
  return {
    length: pxToMm(Math.abs(delta)),
    orientation: horizontal ? (delta < 0 ? 180 : 0) : (delta < 0 ? 90 : 270)
  };
}

// Translate source positions to millimetres around the symbol origin. KiCad's
// symbol Y axis points upward, so evaluate SVG geometry before reflecting it.
function convertSymbolToKiCad(symbol) {
  const pins = symbol.pins.map((pin) => {
    const style = pin.dot.isDisplayed && pin.clock.isDisplayed
      ? "inverted_clock"
      : pin.dot.isDisplayed
        ? "inverted"
        : pin.clock.isDisplayed
          ? "clock"
          : "line";

    const type = EASYEDA_PIN_TYPE_MAP[pin.settings.type] || "unspecified";

    return {
      name: pin.name.text.replace(/\s+/g, ""),
      number: String(pin.settings.number || "").replace(/\s+/g, ""),
      style,
      type,
      ...pinGeometry(pin),
      posX: pxToMm(toNumber(pin.settings.posX) - toNumber(symbol.bbox.x)),
      posY: -pxToMm(toNumber(pin.settings.posY) - toNumber(symbol.bbox.y))
    };
  });

  const rectangles = symbol.rectangles.map((rect) => {
    const posX0 = pxToMm(rect.posX - symbol.bbox.x);
    const posY0 = -pxToMm(rect.posY - symbol.bbox.y);
    return {
      posX0,
      posY0,
      posX1: posX0 + pxToMm(rect.width),
      posY1: posY0 - pxToMm(rect.height)
    };
  });

  const circles = symbol.circles.map((circle) => ({
    posX: pxToMm(circle.centerX - symbol.bbox.x),
    posY: -pxToMm(circle.centerY - symbol.bbox.y),
    radius: pxToMm(circle.radius),
    strokeWidth: pxToMm(circle.strokeWidth),
    fill: circle.fill
  }));

  const ellipses = symbol.ellipses
    .filter((ellipse) => ellipse.radiusX === ellipse.radiusY)
    .map((ellipse) => ({
      posX: pxToMm(ellipse.centerX - symbol.bbox.x),
      posY: -pxToMm(ellipse.centerY - symbol.bbox.y),
      radius: pxToMm(ellipse.radiusX),
      strokeWidth: pxToMm(ellipse.strokeWidth),
      fill: ellipse.fill
    }));

  const arcs = [];
  const polygons = [];
  const toSymbolPoint = (x, y) => [pxToMm(x - symbol.bbox.x), -pxToMm(y - symbol.bbox.y)];
  for (const arc of symbol.arcs) {
    if (arc.path.length < 2 || arc.path[0].type !== "M" || arc.path[1].type !== "A") {
      continue;
    }
    const move = arc.path[0];
    const ellipseArc = arc.path[1];

    const start = toSymbolPoint(move.startX, move.startY);
    const end = toSymbolPoint(ellipseArc.endX, ellipseArc.endY);
    if (start[0] === end[0] && start[1] === end[1]) continue;
    if (!ellipseArc.radiusX || !ellipseArc.radiusY) {
      polygons.push({ points: [start, end], fill: "none" });
      continue;
    }
    const geometry = computeArc(
      move.startX, move.startY,
      ellipseArc.radiusX, ellipseArc.radiusY,
      ellipseArc.xAxisRotation,
      ellipseArc.flagLargeArc,
      ellipseArc.flagSweep,
      ellipseArc.endX, ellipseArc.endY
    );
    const pointAt = fraction => {
      const point = pointOnArc(geometry, fraction);
      return toSymbolPoint(point.x, point.y);
    };
    if (geometry.radiusX !== geometry.radiusY || arc.fill !== "none") {
      // KiCad symbol arcs are circular. Sample an ellipse to within 0.01 mm
      // chord error; a painted arc uses one closed outline for its whole fill.
      const radius = pxToMm(Math.max(geometry.radiusX, geometry.radiusY));
      const step = Math.min(Math.PI / 8, 2 * Math.acos(Math.max(0, 1 - 0.01 / radius)));
      const count = Math.min(4096, Math.max(2, Math.ceil(Math.abs(geometry.sweepAngle) / step)));
      const points = [start];
      for (let i = 1; i < count; i++) points.push(pointAt(i / count));
      points.push(end);
      if (arc.fill !== "none") points.push(start);
      polygons.push({ points, fill: arc.fill });
    } else {
      // KiCad 10 plots a symbol arc as its minor sweep. Splitting major arcs
      // preserves nearly complete loops and both sides of a winding.
      const count = Math.ceil(Math.abs(geometry.sweepAngle) / Math.PI);
      let from = start;
      for (let i = 0; i < count; i++) {
        const middle = pointAt((i + 0.5) / count);
        const to = i + 1 === count ? end : pointAt((i + 1) / count);
        arcs.push({ startX: from[0], startY: from[1], middleX: middle[0], middleY: middle[1], endX: to[0], endY: to[1] });
        from = to;
      }
    }
  }

  function appendPolyline(points, fill, close) {
    if (points.length < 2) return;
    const first = points[0];
    const last = points.at(-1);
    if (close && (first[0] !== last[0] || first[1] !== last[1])) points.push(first);
    polygons.push({ points, fill });
  }

  function convertPolyline(polyline, close) {
    const raw = String(polyline.points || "").trim().split(/\s+/);
    const points = [];
    for (let i = 0; i + 1 < raw.length; i += 2) {
      points.push(toSymbolPoint(toNumber(raw[i]), toNumber(raw[i + 1])));
    }
    appendPolyline(points, polyline.fill, close);
  }
  for (const line of symbol.polylines) convertPolyline(line, line.fill !== "none");
  for (const polygon of symbol.polygons) convertPolyline(polygon, true);

  for (const path of symbol.paths) {
    // Reuse command parsing so absolute M/L coordinates work with spaces,
    // commas or directly attached command letters. This export stage handles
    // straight segments and Z closure; previews preserve full native SVG paths.
    let points = [];
    // Each M starts a separate outline. Flush it before the next move so
    // disconnected source graphics retain their independent boundaries.
    function appendSubpath() {
      appendPolyline(points, path.fill, path.fill !== "none");
    }
    for (const step of parseSvgPath(path.paths)) {
      if (step.type === "M" || step.type === "L") {
        if (step.type === "M") {
          appendSubpath();
          points = [];
        }
        const x = step.type === "M" ? step.startX : step.posX;
        const y = step.type === "M" ? step.startY : step.posY;
        points.push(toSymbolPoint(x, y));
      } else if (step.type === "Z" && points.length) {
        points.push(points[0]);
      }
    }
    appendSubpath();
  }

  return {
    info: symbol.info,
    pins,
    rectangles,
    circles: circles.concat(ellipses),
    arcs,
    polygons
  };
}

function formatSymbolProperty(key, value, id, posY, rotation, hide = false) {
  const hideFlag = hide ? "hide" : "";
  return `(property
  "${escapeKiCadString(key)}"
  "${escapeKiCadString(value)}"
  (id ${id})
  (at 0 ${posY.toFixed(2)} ${rotation})
  (effects (font (size ${KI_SYMBOL_CONFIG.propertyFontSize} ${KI_SYMBOL_CONFIG.propertyFontSize}) ) ${hideFlag})
)`;
}

function exportSymbolPin(pin) {
  const pinName = applyPinNameStyle(pin.name);
  const pinType = pin.type.startsWith("_") ? pin.type.slice(1) : pin.type;
  return `(pin ${pinType} ${pin.style}
  (at ${pin.posX.toFixed(2)} ${pin.posY.toFixed(2)} ${pin.orientation})
  (length ${pin.length.toFixed(2)})
  (name "${escapeKiCadString(pinName)}" (effects (font (size ${KI_SYMBOL_CONFIG.pinNameSize} ${KI_SYMBOL_CONFIG.pinNameSize}))))
  (number "${escapeKiCadString(pin.number)}" (effects (font (size ${KI_SYMBOL_CONFIG.pinNumSize} ${KI_SYMBOL_CONFIG.pinNumSize}))))
)`;
}

function exportSymbolRectangle(rect) {
  return `(rectangle
  (start ${rect.posX0.toFixed(2)} ${rect.posY0.toFixed(2)})
  (end ${rect.posX1.toFixed(2)} ${rect.posY1.toFixed(2)})
  (stroke (width ${KI_SYMBOL_CONFIG.defaultLineWidth}) (type default) (color 0 0 0 0))
  (fill (type background))
)`;
}

function exportSymbolCircle(circle) {
  return `(circle
  (center ${circle.posX.toFixed(2)} ${circle.posY.toFixed(2)})
  (radius ${circle.radius.toFixed(2)})
  (stroke (width ${circle.strokeWidth.toFixed(3)}) (type default) (color 0 0 0 0))
  (fill (type ${circle.fill}))
)`;
}

function exportSymbolArc(arc) {
  return `(arc
  (start ${arc.startX.toFixed(2)} ${arc.startY.toFixed(2)})
  (mid ${arc.middleX.toFixed(2)} ${arc.middleY.toFixed(2)})
  (end ${arc.endX.toFixed(2)} ${arc.endY.toFixed(2)})
  (stroke (width ${KI_SYMBOL_CONFIG.defaultLineWidth}) (type default) (color 0 0 0 0))
  (fill (type none))
)`;
}

function exportSymbolPolygon(poly) {
  return `(polyline
  (pts
${poly.points
  .map((point) => `    (xy ${point[0].toFixed(2)} ${point[1].toFixed(2)})`)
  .join("\n")}
  )
  (stroke (width ${KI_SYMBOL_CONFIG.defaultLineWidth}) (type default) (color 0 0 0 0))
  (fill (type ${poly.fill}))
)`;
}

// Keep all converted graphics and pins in a common unit, and stack generated
// properties beyond the pin bounds so ordinary labels remain outside the body.
function exportKiCadSymbolLibrary(kiSymbol) {
  const pins = kiSymbol.pins || [];
  const yLow = pins.length ? Math.min(...pins.map((pin) => pin.posY)) : 0;
  const yHigh = pins.length ? Math.max(...pins.map((pin) => pin.posY)) : 0;
  const properties = [];
  let offsetY = KI_SYMBOL_CONFIG.fieldOffsetStart;

  properties.push(
    formatSymbolProperty("Reference", kiSymbol.info.prefix || "U", 0, yHigh + offsetY, 0)
  );
  properties.push(
    formatSymbolProperty("Value", kiSymbol.info.name || "", 1, yLow - offsetY, 0)
  );
  if (kiSymbol.info.package) {
    offsetY += KI_SYMBOL_CONFIG.fieldOffsetIncrement;
    properties.push(
      formatSymbolProperty("Footprint", kiSymbol.info.package, 2, yLow - offsetY, 0, true)
    );
  }
  if (kiSymbol.info.datasheet) {
    offsetY += KI_SYMBOL_CONFIG.fieldOffsetIncrement;
    properties.push(
      formatSymbolProperty("Datasheet", kiSymbol.info.datasheet, 3, yLow - offsetY, 0, true)
    );
  }
  if (kiSymbol.info.manufacturer) {
    offsetY += KI_SYMBOL_CONFIG.fieldOffsetIncrement;
    properties.push(
      formatSymbolProperty("Manufacturer", kiSymbol.info.manufacturer, 4, yLow - offsetY, 0, true)
    );
  }
  if (kiSymbol.info.lcscId) {
    offsetY += KI_SYMBOL_CONFIG.fieldOffsetIncrement;
    properties.push(
      formatSymbolProperty("LCSC Part", kiSymbol.info.lcscId, 5, yLow - offsetY, 0, true)
    );
  }
  if (kiSymbol.info.jlcId) {
    offsetY += KI_SYMBOL_CONFIG.fieldOffsetIncrement;
    properties.push(
      formatSymbolProperty("JLC Part", kiSymbol.info.jlcId, 6, yLow - offsetY, 0, true)
    );
  }

  const symbolId = escapeKiCadString(sanitizeFields(kiSymbol.info.name || "symbol"));
  const graphicItems = [
    ...kiSymbol.rectangles.map(exportSymbolRectangle),
    ...kiSymbol.circles.map(exportSymbolCircle),
    ...kiSymbol.arcs.map(exportSymbolArc),
    ...kiSymbol.polygons.map(exportSymbolPolygon)
  ].join("\n");

  const pinItems = kiSymbol.pins.map(exportSymbolPin).join("\n");
  const symbolBlock = `
(symbol "${symbolId}"
  (in_bom yes)
  (on_board yes)
${properties.map((line) => `  ${line.trim()}`).join("\n")}
  (symbol "${symbolId}_0_1"
${indentLines(graphicItems, 4)}
${indentLines(pinItems, 4)}
  )
)`.trim();

  return `(kicad_symbol_lib
  (version ${KI_SYMBOL_LIB_VERSION})
  (generator "${KI_SYMBOL_GENERATOR}")
${indentLines(symbolBlock, 1)}
)\n`;
}

export { convertSymbolToKiCad, exportKiCadSymbolLibrary };

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
