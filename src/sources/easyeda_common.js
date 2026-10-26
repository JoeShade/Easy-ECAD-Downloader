/*
 * Shared EasyEDA fetch and preview helpers. This module owns upstream EasyEDA
 * payload retrieval, preview generation, datasheet metadata, and 3D-model
 * metadata lookup used by the EasyEDA provider adapter.
 */

import {
  makeBase64DataUrl,
  makeSvgDataUrl,
  normalizeUrl,
  sanitizeFilenamePart
} from "../core/preview_data.js";

const EASYEDA_API_ENDPOINT =
  "https://easyeda.com/api/products/{lcscId}/components?version=6.4.19.5";
const EASYEDA_MODEL_OBJ_ENDPOINT = "https://modules.easyeda.com/3dmodel/{uuid}";
const EASYEDA_MODEL_STEP_ENDPOINT =
  "https://modules.easyeda.com/qAxj6KHrDKw4blvCG8QJPs7Y/{uuid}";
const FOOTPRINT_PREVIEW_BACKGROUND = "#f8fafc";
const FOOTPRINT_PREVIEW_COPPER = "#0f172a";
const FOOTPRINT_PREVIEW_BODY = "#cbd5e1";

function toNumber(value, fallback = 0) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function parsePoints(pointsText) {
  const raw = String(pointsText || "").trim().split(/\s+/);
  const points = [];
  for (let i = 0; i < raw.length - 1; i += 2) {
    points.push([toNumber(raw[i]), toNumber(raw[i + 1])]);
  }
  return points;
}

function pointsToSvg(points) {
  return points.map((point) => point.join(",")).join(" ");
}

function escapeSvgAttribute(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function symbolPreviewFill(value) {
  const fill = String(value || "").trim().toLowerCase();
  // Keep the monochrome preview: solid source paint uses the foreground;
  // white masks underlying geometry with the popup's preview background.
  if (fill === "white" || fill === "#fff" || fill === "#ffffff") {
    return "#f8fafc";
  }
  return /^(?:#[0-9a-f]{3}(?:[0-9a-f]{3})?|black|silver|gray|maroon|red|purple|fuchsia|green|lime|olive|yellow|navy|blue|teal|aqua)$/.test(fill)
    ? "#111827"
    : "none";
}

function buildSvgDocument(viewBox, body, options = {}) {
  const { background, stroke = "#111827" } = options;
  const bgRect = background
    ? `<rect x="${viewBox.x}" y="${viewBox.y}" width="${viewBox.width}" height="${viewBox.height}" fill="${background}" />`
    : "";
  return `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox.x} ${viewBox.y} ${viewBox.width} ${viewBox.height}" preserveAspectRatio="xMidYMid meet">
  ${bgRect}
  <g fill="none" stroke="${stroke}" stroke-linecap="round" stroke-linejoin="round">
    ${body}
  </g>
</svg>`.trim();
}

function buildSymbolPreviewSvg(cadData) {
  const dataStr = cadData?.dataStr;
  if (!dataStr) {
    return null;
  }
  const bbox = dataStr.BBox || { x: 0, y: 0, width: 120, height: 80 };
  const pad = 5;
  const width = toNumber(bbox.width, 120);
  const height = toNumber(bbox.height, 80);
  const viewBox = {
    x: toNumber(bbox.x) - pad,
    y: toNumber(bbox.y) - pad,
    width: (width > 0 ? width : 120) + pad * 2,
    height: (height > 0 ? height : 80) + pad * 2
  };
  const shapes = dataStr.shape || [];
  const svgParts = [];

  for (const line of shapes) {
    const designator = line.split("~")[0];
    if (designator === "P") {
      const segments = line.split("^^");
      const pinPathFields = (segments[2] || "").split("~");
      const pinDotFields = (segments[5] || "").split("~");
      const pinPath = String(pinPathFields[0] || "").trim();
      if (pinPath) {
        svgParts.push(`<path d="${escapeSvgAttribute(pinPath)}" stroke-width="1" />`);
      }
      if (pinDotFields[0] === "show") {
        const cx = toNumber(pinDotFields[1]);
        const cy = toNumber(pinDotFields[2]);
        svgParts.push(`<circle cx="${cx}" cy="${cy}" r="2" fill="#111827" stroke="none" />`);
      }
    } else if (designator === "R") {
      const fields = line.split("~").slice(1);
      const x = toNumber(fields[0]);
      const y = toNumber(fields[1]);
      const width = toNumber(fields[4]);
      const height = toNumber(fields[5]);
      svgParts.push(`<rect x="${x}" y="${y}" width="${width}" height="${height}" stroke-width="1" />`);
    } else if (designator === "PL" || designator === "PG") {
      const fields = line.split("~").slice(1);
      const points = pointsToSvg(parsePoints(fields[0]));
      const tag = designator === "PG" ? "polygon" : "polyline";
      svgParts.push(`<${tag} points="${points}" stroke-width="1" fill="${symbolPreviewFill(fields[4])}" />`);
    } else if (designator === "PT") {
      const fields = line.split("~").slice(1);
      const path = String(fields[0] || "").trim();
      if (path) {
        // Native SVG preserves curves, relative commands and subpaths. The
        // separate KiCad exporter owns its restricted CAD conversion rules.
        svgParts.push(`<path d="${escapeSvgAttribute(path)}" stroke-width="1" fill="${symbolPreviewFill(fields[4])}" />`);
      }
    } else if (designator === "C") {
      const fields = line.split("~").slice(1);
      const cx = toNumber(fields[0]);
      const cy = toNumber(fields[1]);
      const radius = toNumber(fields[2]);
      svgParts.push(`<circle cx="${cx}" cy="${cy}" r="${radius}" stroke-width="1" />`);
    } else if (designator === "A") {
      const fields = line.split("~").slice(1);
      const path = String(fields[0] || "").trim();
      if (path) {
        svgParts.push(`<path d="${escapeSvgAttribute(path)}" stroke-width="1" />`);
      }
    }
  }

  return buildSvgDocument(viewBox, svgParts.join("\n"));
}

function buildFootprintPreviewSvg(cadData) {
  const dataStr = cadData?.packageDetail?.dataStr;
  if (!dataStr) {
    return null;
  }
  const bbox = dataStr.BBox || { x: 0, y: 0, width: 120, height: 120 };
  const pad = 8;
  const width = toNumber(bbox.width, 120);
  const height = toNumber(bbox.height, 120);
  const viewBox = {
    x: toNumber(bbox.x) - pad,
    y: toNumber(bbox.y) - pad,
    width: (width > 0 ? width : 120) + pad * 2,
    height: (height > 0 ? height : 120) + pad * 2
  };
  const shapes = dataStr.shape || [];
  const svgParts = [];

  for (const line of shapes) {
    const parts = line.split("~");
    const designator = parts[0];
    const fields = parts.slice(1);

    if (designator === "PAD") {
      const shape = fields[0];
      const centerX = toNumber(fields[1]);
      const centerY = toNumber(fields[2]);
      const width = toNumber(fields[3]);
      const height = toNumber(fields[4]);
      const padPoints = parsePoints(fields[9]);
      const rotation = toNumber(fields[10]);
      const holeRadius = toNumber(fields[8]);
      // Oval point fields can contain axis guide points. Their visible outline
      // comes from the center, size and rotation.
      if (padPoints.length >= 3 && shape !== "OVAL" && shape !== "ELLIPSE") {
        const polygon = pointsToSvg(padPoints);
        svgParts.push(`<polygon points="${polygon}" fill="#0f172a" stroke="none" />`);
      } else if (shape === "ELLIPSE" || shape === "OVAL") {
        const transform = rotation ? ` transform="rotate(${rotation} ${centerX} ${centerY})"` : "";
        svgParts.push(
          `<ellipse cx="${centerX}" cy="${centerY}" rx="${width / 2}" ry="${height / 2}" fill="${FOOTPRINT_PREVIEW_COPPER}" stroke="none"${transform} />`
        );
      } else {
        const x = centerX - width / 2;
        const y = centerY - height / 2;
        const rect = `<rect x="${x}" y="${y}" width="${width}" height="${height}" fill="${FOOTPRINT_PREVIEW_COPPER}" stroke="none"`;
        if (rotation) {
          svgParts.push(`${rect} transform="rotate(${rotation} ${centerX} ${centerY})" />`);
        } else {
          svgParts.push(`${rect} />`);
        }
      }
      if (holeRadius > 0) {
        svgParts.push(
          `<circle cx="${centerX}" cy="${centerY}" r="${holeRadius}" fill="#f8fafc" stroke="#0f172a" stroke-width="0.4" />`
        );
      }
    } else if (designator === "SOLIDREGION") {
      const layerId = toNumber(fields[0]);
      const path = String(fields[2] || "").trim();
      const regionType = String(fields[3] || "solid").trim().toLowerCase();
      if (path) {
        const fill = regionType === "cutout"
          ? FOOTPRINT_PREVIEW_BACKGROUND
          : layerId === 99
            ? FOOTPRINT_PREVIEW_BODY
            : FOOTPRINT_PREVIEW_COPPER;
        svgParts.push(`<path d="${escapeSvgAttribute(path)}" fill="${fill}" stroke="none" />`);
      }
    } else if (designator === "TRACK") {
      const strokeWidth = toNumber(fields[0], 0.2);
      const points = pointsToSvg(parsePoints(fields[3]));
      if (points) {
        svgParts.push(`<polyline points="${points}" stroke-width="${strokeWidth}" />`);
      }
    } else if (designator === "CIRCLE") {
      const cx = toNumber(fields[0]);
      const cy = toNumber(fields[1]);
      const radius = toNumber(fields[2]);
      const strokeWidth = toNumber(fields[3], 0.2);
      svgParts.push(
        `<circle cx="${cx}" cy="${cy}" r="${radius}" stroke-width="${strokeWidth}" />`
      );
    } else if (designator === "ARC") {
      const strokeWidth = toNumber(fields[0], 0.2);
      const path = String(fields[3] || "").trim();
      if (path) {
        svgParts.push(`<path d="${escapeSvgAttribute(path)}" stroke-width="${strokeWidth}" />`);
      }
    } else if (designator === "RECT") {
      const x = toNumber(fields[0]);
      const y = toNumber(fields[1]);
      const width = toNumber(fields[2]);
      const height = toNumber(fields[3]);
      const strokeWidth = toNumber(fields[4], 0.2);
      svgParts.push(
        `<rect x="${x}" y="${y}" width="${width}" height="${height}" stroke-width="${strokeWidth}" />`
      );
    }
  }

  return buildSvgDocument(viewBox, svgParts.join("\n"), {
    background: FOOTPRINT_PREVIEW_BACKGROUND
  });
}

async function fetchCadData(fetchImpl, lcscId) {
  const response = await fetchImpl(EASYEDA_API_ENDPOINT.replace("{lcscId}", lcscId), {
    headers: {
      Accept: "application/json"
    }
  });
  if (!response.ok) {
    throw new Error(`EasyEDA API error: ${response.status}`);
  }
  const payload = await response.json();
  if (!payload?.result) {
    const preview = JSON.stringify(payload)?.slice(0, 500);
    throw new Error(
      `EasyEDA API returned no component data. Payload: ${preview}`
    );
  }
  return payload.result;
}

// EasyEDA embeds model UUID/title attributes in JSON within an SVGNODE shape.
// Scan only those records and let malformed optional model metadata warn locally.
function find3dModelInfo(packageDetail) {
  const shapes = packageDetail?.dataStr?.shape || [];
  for (const line of shapes) {
    const [designator, rawJson] = line.split("~");
    if (designator !== "SVGNODE" || !rawJson) {
      continue;
    }
    try {
      const attrs = JSON.parse(rawJson).attrs;
      if (attrs?.uuid) {
        return { uuid: attrs.uuid, name: attrs.title || attrs.uuid };
      }
    } catch (error) {
      console.warn("Failed to parse 3D model metadata:", error);
    }
  }
  return null;
}

function getDatasheetInfo(cadData, lcscId) {
  const rawUrl = [
    cadData?.packageDetail?.dataStr?.head?.c_para?.link,
    cadData?.dataStr?.head?.c_para?.link,
    cadData?.lcsc?.url
  ].find((value) => String(value || "").trim());
  const url = normalizeUrl(rawUrl);
  if (!url) {
    return { url: "", filename: "" };
  }

  let extension = ".pdf";
  try {
    const pathname = new URL(url).pathname;
    const lastSegment = pathname.split("/").pop() || "";
    const match = lastSegment.match(/(\.[a-zA-Z0-9]{1,8})$/);
    if (match) {
      extension = match[1];
    }
  } catch (error) {
    console.warn("Failed to parse datasheet URL:", error);
  }

  const baseName = sanitizeFilenamePart(
    cadData?.packageDetail?.title ||
      cadData?.dataStr?.head?.c_para?.package ||
      cadData?.title ||
      lcscId,
    lcscId
  );

  return {
    url,
    filename: `${baseName}-datasheet${extension}`
  };
}

function ensureEasyedaLcscId(partContext) {
  const lcscId = partContext?.lookup?.lcscId;
  if (!lcscId) {
    throw new Error("No LCSC part number found on the page.");
  }
  return lcscId;
}

async function buildEasyedaPreviewResponse(fetchImpl, partContext) {
  const lcscId = ensureEasyedaLcscId(partContext);
  const cadData = await fetchCadData(fetchImpl, lcscId);
  return {
    previews: {
      symbolUrl: makeSvgDataUrl(buildSymbolPreviewSvg(cadData)),
      footprintUrl: makeSvgDataUrl(buildFootprintPreviewSvg(cadData))
    },
    metadata: {
      datasheetAvailable: Boolean(getDatasheetInfo(cadData, lcscId).url)
    }
  };
}

export {
  EASYEDA_MODEL_OBJ_ENDPOINT,
  EASYEDA_MODEL_STEP_ENDPOINT,
  buildEasyedaPreviewResponse,
  buildFootprintPreviewSvg,
  buildSymbolPreviewSvg,
  ensureEasyedaLcscId,
  fetchCadData,
  find3dModelInfo,
  getDatasheetInfo,
  makeBase64DataUrl
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
