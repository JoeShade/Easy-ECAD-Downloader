/*
 * Exercise the production symbol preview with captured issue #16 payloads and
 * focused synthetic paint, native-path, safety and existing-primitive controls.
 */
import crypto from "node:crypto";
import { Resvg } from "@resvg/resvg-js";
import { describe, expect, it, vi } from "vitest";
import cases from "./fixtures/issue_16.json";
import { buildSymbolPreviewSvg } from "../src/sources/easyeda_common.js";
import { convertEasyedaCadToKicad } from "../src/kicad_converter.js";
import { createCadData } from "./helpers/fixtures.js";
import { createServiceWorkerChrome, loadServiceWorker, sendRuntimeMessage } from "./helpers/service_worker_harness.js";

// Parse as XML so malformed SVG attributes fail before pixel-level comparisons.
function svgDocument(svg) {
  const doc = new window.DOMParser().parseFromString(svg, "image/svg+xml");
  expect(doc.querySelector("parsererror")).toBeNull();
  return doc;
}

// Exercise paint and geometry with the same compact payload shape as the source API.
function preview(shapes, bbox = { x: 0, y: 0, width: 40, height: 30 }) {
  return svgDocument(buildSymbolPreviewSvg({ dataStr: { BBox: bbox, shape: shapes } }));
}

// Match the popup's small display size so a primitive must survive real rendering
// to contribute pixels; raster output establishes visibility at that scale.
function raster(doc) {
  doc.documentElement.setAttribute("width", "123");
  doc.documentElement.setAttribute("height", "90");
  return new Resvg(new window.XMLSerializer().serializeToString(doc)).render().pixels;
}

describe("EasyEDA symbol previews", () => {
  it.each(cases)("retains every source graphic, paint and draw order for $finding ($mpn)", row => {
    const doc = svgDocument(buildSymbolPreviewSvg(row.cadData));
    expect(row.cadData.lcsc.number).toBe(row.id);
    expect(row.cadData.dataStr.head.c_para["Manufacturer Part"]).toBe(row.mpn);
    expect(doc.documentElement.getAttribute("viewBox")).toBe(row.expected.viewBox);
    const elements = [...doc.querySelector("g").children];
    expect(elements).toHaveLength(row.cadData.dataStr.shape.length);
    row.cadData.dataStr.shape.forEach((record, index) => {
      const [type, geometry] = record.split("~");
      if (type === "PT") {
        expect(elements[index].tagName).toBe("path");
        expect(elements[index].getAttribute("d")).toBe(geometry.trim());
      } else if (type === "PL") {
        expect(elements[index].tagName).toBe("polyline");
        expect(elements[index].getAttribute("points")).toBe(geometry.trim().replace(/(\S+)\s+(\S+)/g, "$1,$2"));
        expect(elements[index].getAttribute("fill")).toBe("none");
      } else if (type === "P") {
        expect(elements[index].getAttribute("d")).toBe(record.split("^^")[2].split("~")[0]);
      }
    });
    for (const graphic of row.expected.graphics) {
      const element = elements[graphic.index];
      expect(element.getAttribute("fill"), graphic.role).toBe(graphic.fill);
      const complete = raster(doc);
      const control = doc.cloneNode(true);
      control.querySelector("g").children[graphic.index].remove();
      const omitted = raster(control);
      let changedPixels = 0;
      // Alpha changes identify pixels contributed by this shape while allowing
      // minor antialiasing variation at the edge of another overlapping primitive.
      for (let i = 3; i < complete.length; i += 4) {
        if (Math.abs(complete[i] - omitted[i]) > 64) changedPixels++;
      }
      expect(changedPixels, `${graphic.role} must contribute visible pixels at popup size`).toBeGreaterThan(2);
    }
  });

  it.each(cases)("delivers the source paths through GET_PART_PREVIEWS for $id without mutating export input", async row => {
    const cadData = globalThis.structuredClone(row.cadData);
    const original = globalThis.structuredClone(cadData);
    const before = convertEasyedaCadToKicad(cadData, { symbol: true }).symbol.content;
    const { chrome, listeners } = createServiceWorkerChrome();
    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => ({ result: cadData }) }));
    loadServiceWorker({ chrome, fetchImpl });
    const result = await sendRuntimeMessage(listeners.runtimeMessage[0], {
      type: "GET_PART_PREVIEWS", partContext: { provider: "easyedaLcsc", lookup: { lcscId: row.id } }
    });
    expect(result.response.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledWith(row.provenance.url, expect.any(Object));
    const dataUrl = result.response.previews.symbolUrl;
    expect(dataUrl).toMatch(/^data:image\/svg\+xml;utf8,/);
    const doc = svgDocument(decodeURIComponent(dataUrl.slice(dataUrl.indexOf(",") + 1)));
    for (const graphic of row.expected.graphics) {
      expect(doc.querySelector("g").children[graphic.index].getAttribute("d"))
        .toBe(row.cadData.dataStr.shape[graphic.index].split("~")[1].trim());
    }
    expect(cadData).toEqual(original);
    expect(convertEasyedaCadToKicad(cadData, { symbol: true }).symbol.content).toBe(before);
    expect(crypto.createHash("sha256").update(before).digest("hex")).toBe(row.expected.exportSha256);
  });

  it.each([
    "M 1 2 L 20 2 L 10 15 Z", "M1,2L20,2 10,15Z", "m1 2h19v13l-10-5z",
    "M1 2C3 4 5 6 7 8S9 10 11 12Q13 14 15 16T17 18",
    "M1 2a3 4 30 0 1 8 9z M20 20l2 3m1 1h2"
  ])("preserves native SVG commands verbatim: %s", path => {
    const doc = preview([`PT~${path}~#880000~1~0~none`]);
    expect(doc.querySelector("path").getAttribute("d")).toBe(path);
    expect(doc.querySelector("path").getAttribute("fill")).toBe("none");
    expect(() => raster(doc)).not.toThrow();
  });

  it.each(["PT", "PL", "PG"])("keeps foreground, background and absent fills local to %s", type => {
    const geometry = type === "PT" ? "M 1 1 L 10 1 L 5 10 Z" : "1 1 10 1 5 10";
    const fills = ["#880000", "#FFF", "white", "none", "transparent", "", undefined, "url(https://example.test/paint)", '#000" onload="alert(1)'];
    const doc = preview(fills.map(fill => `${type}~${geometry}~#880000~1~0${fill === undefined ? "" : `~${fill}`}`));
    expect([...doc.querySelector("g").children].map(el => el.getAttribute("fill")))
      .toEqual(["#111827", "#f8fafc", "#f8fafc", "none", "none", "none", "none", "none", "none"]);
    expect(doc.querySelector("g").getAttribute("fill")).toBe("none");
    expect(doc.querySelector("[onload]")).toBeNull();
  });

  it("keeps hollow background regions opaque and preserves occlusion order", () => {
    const doc = preview([
      "PT~M0 0H20V20H0Z~#880000~1~0~#880000",
      "PG~4 4 16 4 16 16 4 16~#880000~1~0~#ffffff"
    ], { x: 0, y: 0, width: 20, height: 20 });
    const pixels = raster(doc);
    const center = (45 * 123 + 61) * 4;
    expect([...pixels.slice(center, center + 4)]).toEqual([248, 250, 252, 255]);
  });

  it("isolates empty/malformed paths and escapes path attributes for PT, pins and arcs", () => {
    const malicious = 'M1 2"/><image href="https://example.test/x" onload="alert(1)"/><!--&';
    const doc = preview([
      "PT", "PT~   ~#000~1~0~#000", "PT~invalid path~#000~1~0~none",
      `PT~${malicious}~#000~1~0~none`,
      `P~show^^0^^${malicious}~#000^^0^^0^^0`,
      `A~${malicious}~#000~1~0~none`,
      "C~20~20~2~#000~1~0~none"
    ]);
    expect(doc.querySelectorAll("path")).toHaveLength(4);
    expect(doc.querySelectorAll("image, script, [onload]")).toHaveLength(0);
    expect([...doc.querySelectorAll("path")].slice(1).map(el => el.getAttribute("d")))
      .toEqual([malicious, malicious, malicious]);
    expect(doc.querySelector("circle").getAttribute("r")).toBe("2");
    expect([...raster(doc)].some((value, index) => index % 4 === 3 && value > 200)).toBe(true);
  });

  it("normalizes numeric bounds without NaN, concatenation or invalid dimensions", () => {
    expect(preview([], { x: "10", y: "20", width: "40", height: "30" }).documentElement.getAttribute("viewBox"))
      .toBe("5 15 50 40");
    expect(preview([], { x: "oops", y: Infinity, width: -2, height: "bad" }).documentElement.getAttribute("viewBox"))
      .toBe("-5 -5 130 90");
  });

  it("retains pins/inversion dots, rectangles, open/closed polylines, circles and arcs", () => {
    const cad = createCadData();
    cad.dataStr.shape.pop();
    const doc = svgDocument(buildSymbolPreviewSvg(cad));
    expect([...doc.querySelector("g").children].map(el => el.outerHTML)).toEqual([
      '<path xmlns="http://www.w3.org/2000/svg" d="M 20 30 h10" stroke-width="1"/>',
      '<circle xmlns="http://www.w3.org/2000/svg" cx="19" cy="30" r="2" fill="#111827" stroke="none"/>',
      '<rect xmlns="http://www.w3.org/2000/svg" x="30" y="25" width="40" height="20" stroke-width="1"/>',
      '<polyline xmlns="http://www.w3.org/2000/svg" points="30,25 70,25 70,45" stroke-width="1" fill="none"/>',
      '<polygon xmlns="http://www.w3.org/2000/svg" points="30,25 50,15 70,25" stroke-width="1" fill="none"/>',
      '<circle xmlns="http://www.w3.org/2000/svg" cx="50" cy="35" r="5" stroke-width="1"/>',
      '<path xmlns="http://www.w3.org/2000/svg" d="M 30 35 A 5 5 0 0 1 40 45" stroke-width="1"/>'
    ]);
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
