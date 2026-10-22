/*
 * These tests cover the public EasyEDA-to-KiCad converter facade plus a small
 * geometry regression for shared converter math. They use compact EasyEDA
 * fixtures so parser, emitter, and OBJ-to-WRL behavior stay locked together.
 */

import { describe, expect, it } from "vitest";

import { createCadData } from "./helpers/fixtures.js";
import {
  applyPinNameStyle,
  applyTextStyle,
  convertEasyedaCadToKicad,
  convertObjToWrlString,
  drillToKi,
  parseSvgPath
} from "../src/kicad_converter.js";
import { escapeKiCadString, quoteKiCadAtom, rotate } from "../src/kicad/shared.js";

describe("kicad converter", () => {
  it("applies EasyEDA text styling rules to suffix-marked labels", () => {
    expect(applyTextStyle("RESET#")).toBe("~{RESET}");
    expect(applyPinNameStyle("CLK#/RESET#")).toBe("~{CLK}/~{RESET}");
  });

  it("converts representative symbol data into a KiCad symbol library", () => {
    const result = convertEasyedaCadToKicad(createCadData(), {
      symbol: true
    });

    expect(result.symbol.name).toBe("Logic_Buffer");
    expect(result.symbol.content).toContain('(symbol "Logic_Buffer"');
    expect(result.symbol.content).toMatch(/"LCSC Part"\s+"C12345"/);
    expect(result.symbol.content).toContain("(pin input inverted_clock");
    expect(result.symbol.content).toContain('(name "~{CLK}/~{RESET}"');
  });

  it("converts representative footprint data into KiCad footprint text", () => {
    const result = convertEasyedaCadToKicad(createCadData(), {
      footprint: true
    });

    expect(result.footprint.name).toBe("QFN-16/Example");
    expect(result.footprint.content).toContain("(module easyeda2kicad:QFN-16/Example");
    expect(result.footprint.content).toContain("\t(attr smd)");
    expect(result.footprint.content).toContain("(pad 1 smd rect");
    expect(result.footprint.content).toContain("(primitives");
    expect(result.footprint.content).toContain('(model "${KIPRJMOD}/Model QFN.wrl"');
    // KiCad's offset token stores millimetres; the WRL vertex scale is separate.
    expect(result.footprint.content).toContain("(offset (xyz 1.270 -1.270 0.508))");
    expect(result.footprint.content).toContain("(rotate (xyz 0 270 180))");
    expect(result.footprint.content).toContain("(layer F.Fab)");
    expect(result.footprint.content).toContain("(size 0.76 0.76)");
    expect(result.footprint.content).toContain("(font (size 1.02 1.02)");
    expect(result.footprint.content).not.toMatch(/\{(?:diameter|fontSize)\}/);
  });

  it("keeps key geometry helpers stable for parsed paths and drill output", () => {
    const parsed = parseSvgPath("M 0 0 A 5 5 0 0 1 10 10 L 20 20 Z");

    expect(parsed.map((step) => step.type)).toEqual(["M", "A", "L", "Z"]);
    expect(drillToKi(0.5, 1.5, 2, 1)).toBe("(drill oval 1.00 1.50)");
    expect(drillToKi(0.5, 0, 2, 1)).toBe("(drill 1.00)");
    expect(rotate(1, 0, 90).x).toBeCloseTo(0);
    expect(rotate(1, 0, 90).y).toBeCloseTo(1);
  });

  it.each(["N", "false", "0"])("preserves explicitly unplated pad holes (%s)", plating => {
    const cad = createCadData();
    cad.packageDetail.dataStr.shape = [
      `PAD~OVAL~100~200~6~16~11~~1~1.8~~0~pad-1~11~~${plating}~false`
    ];
    const { footprint } = convertEasyedaCadToKicad(cad, { footprint: true });

    expect(footprint.content).toContain('(pad "" np_thru_hole oval');
    expect(footprint.content).toContain('(layers *.Cu *.Mask) (drill oval 0.91 2.79)');
  });

  it.each(["Y", "true", "1", ""])("preserves plated and legacy unspecified holes (%s)", plating => {
    const cad = createCadData();
    cad.packageDetail.dataStr.shape = [
      `PAD~ELLIPSE~100~200~6~6~11~~1~1.8~~0~pad-1~0~~${plating}~false`
    ];
    const { footprint } = convertEasyedaCadToKicad(cad, { footprint: true });

    expect(footprint.content).toContain('(pad 1 thru_hole circle');
  });

  it("accepts arbitrary whitespace between custom-pad coordinates", () => {
    const cad = createCadData();
    cad.packageDetail.dataStr.shape = [
      "PAD~POLYGON~100~200~10~10~1~~1~0~ 100 195\t105 205  95 205 ~0~pad-1~0~~Y~false"
    ];
    const { footprint } = convertEasyedaCadToKicad(cad, { footprint: true });

    expect(footprint.content).toContain('(pts (xy 0.00 -1.27) (xy 1.27 1.27) (xy -1.27 1.27)');
    expect(footprint.content).not.toContain('NaN');
  });

  it("escapes upstream strings without changing KiCad expression boundaries", () => {
    const cad = createCadData();
    cad.dataStr.head.c_para.name = 'Logic "Buffer"\\A';
    cad.dataStr.head.c_para.BOM_Manufacturer = 'ACME "Semi"\\Lab';
    cad.dataStr.shape[0] = cad.dataStr.shape[0].replace("CLK#/RESET#", 'CLK"\\A');
    cad.packageDetail.dataStr.head.c_para.package = 'Package "$&" (A)\\B';
    cad.packageDetail.dataStr.shape = [
      'PAD~RECT~100~200~20~10~1~~A B~0~~0~pad-1~0~~true~false',
      'TEXT~N~105~205~0.5~0~~3~~4~Label "$&" (A)\\B~~show~text-1~false',
      `SVGNODE~${JSON.stringify({ attrs: { title: 'Model "$&"\\A', c_origin: "100,200" } })}`
    ];

    const { symbol, footprint } = convertEasyedaCadToKicad(cad, { symbol: true, footprint: true });

    expect(symbol.name).toBe("Logic_Buffer__A");
    expect(symbol.content).toContain('(symbol "Logic_Buffer__A"');
    expect(symbol.content).toContain('"Logic \\"Buffer\\"\\\\A"');
    expect(symbol.content).toContain('"ACME \\"Semi\\"\\\\Lab"');
    expect(symbol.content).toContain('(name "CLK\\"\\\\A"');
    expect(footprint.content).toContain('(module "easyeda2kicad:Package \\"$&\\" (A)\\\\B"');
    expect(footprint.content).toContain('(fp_text value "Package \\"$&\\" (A)\\\\B"');
    expect(footprint.content).toContain('(pad "A B" smd rect');
    expect(footprint.content).toContain('(fp_text user "Label \\"$&\\" (A)\\\\B"');
    expect(footprint.content).toContain('(model "${KIPRJMOD}/Model \\"$&\\"\\\\A.wrl"');
  });

  it("keeps multiline text and vertical-bar labels inside a single KiCad value", () => {
    expect(escapeKiCadString("first\nsecond\rthird")).toBe("first\\nsecond\\rthird");
    expect(quoteKiCadAtom("A|B")).toBe('"A|B"');
  });

  it("preserves upstream text that resembles internal footprint template markers", () => {
    const cad = createCadData();
    cad.packageDetail.dataStr.head.c_para.package = "Part {edit} {posY}";
    cad.packageDetail.dataStr.shape = [
      "PAD~RECT~100~200~20~10~1~~{posX}~0~~0~pad-1~0~~true~false",
      "TEXT~N~105~205~0.5~0~~3~~4~{posX} {fontSize}~~show~text-1~false",
      `SVGNODE~${JSON.stringify({ attrs: { title: "{posX}", c_origin: "100,200" } })}`
    ];
    const { footprint } = convertEasyedaCadToKicad(cad, { footprint: true });

    expect(footprint.content).toContain('(module "easyeda2kicad:Part {edit} {posY}"');
    expect(footprint.content).toContain('(fp_text value "Part {edit} {posY}"');
    expect(footprint.content).toContain('(pad {posX} smd rect (at 0.00 0.00');
    expect(footprint.content).toContain('(fp_text user "{posX} {fontSize}" (at 1.27 1.27');
    expect(footprint.content).toContain('(model "${KIPRJMOD}/{posX}.wrl"');
  });

  it("emits tracks and rectangles on one mapped graphic layer in millimetres", () => {
    const cad = createCadData();
    cad.packageDetail.dataStr.shape = [
      "TRACK~1~1~~100 200 110 200~track-1~false",
      "RECT~100~200~10~10~1~rect-1~4~false"
    ];

    const { footprint } = convertEasyedaCadToKicad(cad, { footprint: true });
    const lines = footprint.content.split("\n").filter(line => line.includes("(fp_line"));

    expect(lines).toHaveLength(5);
    expect(lines[0]).toContain("(layer F.Cu) (width 0.25)");
    expect(lines.slice(1).every(line => line.includes("(layer B.SilkS) (width 0.25)"))).toBe(true);
  });

  it("parses compact and whitespace-delimited footprint arcs consistently", () => {
    const cad = createCadData();
    cad.packageDetail.dataStr.shape = ["ARC~1~3~~M100,200 A10,10 0 0 1 120,200~~arc-1~false"];
    const compact = convertEasyedaCadToKicad(cad, { footprint: true }).footprint.content;
    cad.packageDetail.dataStr.shape = ["ARC~1~3~~M 100  200\nA 10 10 0 0 1 120 200~~arc-1~false"];
    const spaced = convertEasyedaCadToKicad(cad, { footprint: true }).footprint.content;

    expect(spaced).toBe(compact);
    expect(spaced).toContain('(fp_arc (start 2.54 0.00) (end 5.08 0.00) (angle -180.00)');
  });

  it("keeps an open polyline unfilled when only its endpoint X coordinates match", () => {
    const cad = createCadData();
    cad.dataStr.shape = ["PL~10 20 20 20 10 30~#000~0~0~none"];

    const { symbol } = convertEasyedaCadToKicad(cad, { symbol: true });

    expect(symbol.content).toContain("(polyline");
    expect(symbol.content).toContain("(fill (type none))");
  });

  it.each([
    "M0 0L10 0L10 10Z",
    "M0,0L10,0L10,10Z",
    "M 0 0L10,0 L10 10 Z"
  ])("exports compact absolute PT commands like their spaced equivalent: %s", path => {
    const cad = createCadData();
    cad.dataStr.shape = [`PT~${path}`];
    const compact = convertEasyedaCadToKicad(cad, { symbol: true }).symbol.content;
    cad.dataStr.shape = ["PT~M 0 0 L 10 0 L 10 10 Z"];
    const spaced = convertEasyedaCadToKicad(cad, { symbol: true }).symbol.content;

    expect(compact).toBe(spaced);
    expect(compact.match(/\(xy\b/g)).toHaveLength(4);
  });

  it("parses compact signed, decimal and exponent SVG coordinates", () => {
    expect(parseSvgPath("M1e1-2.5L.5.6Z")).toEqual([
      { type: "M", startX: 10, startY: -2.5 },
      { type: "L", posX: 0.5, posY: 0.6 },
      { type: "Z" }
    ]);
    expect(parseSvgPath("M0 0 10 0 10 10Z").map(step => step.type))
      .toEqual(["M", "L", "L", "Z"]);
  });

  it("keeps absolute PT subpaths separate and closes each at its own start", () => {
    const cad = createCadData();
    cad.dataStr.head.x = 0;
    cad.dataStr.head.y = 0;
    cad.dataStr.shape = ["PT~M0 0 10 0 10 10ZM20 20L30 20L30 30Z"];
    const { symbol } = convertEasyedaCadToKicad(cad, { symbol: true });
    const outlines = [...symbol.content.matchAll(/\(pts([\s\S]*?)\n\s*\)/g)]
      .map(match => [...match[1].matchAll(/\(xy ([\d.-]+) ([\d.-]+)\)/g)]
        .map(point => point.slice(1).map(Number)));

    expect(outlines).toEqual([
      [[0, 0], [2.54, 0], [2.54, -2.54], [0, 0]],
      [[5.08, -5.08], [7.62, -5.08], [7.62, -7.62], [5.08, -5.08]]
    ]);
  });

  it.each([
    { radius: 1, sweep: 0, middleY: -1.27 },
    { radius: 1, sweep: 1, middleY: 1.27 },
    { radius: 10, sweep: 0, middleY: -0.34 },
    { radius: 10, sweep: 1, middleY: 0.34 }
  ])("keeps circular arc radius $radius and sweep $sweep faithful to SVG", ({ radius, sweep, middleY }) => {
    const cad = createCadData();
    cad.dataStr.head.x = 0;
    cad.dataStr.head.y = 0;
    // SVG expands a radius of 1 to 5 to join endpoints ten units apart. The
    // semicircle midpoint then sits five units above/below their midpoint.
    cad.dataStr.shape = [`A~M 0 0 A ${radius} ${radius} 0 0 ${sweep} 10 0~#000~0~0~none`];
    const { symbol } = convertEasyedaCadToKicad(cad, { symbol: true });
    const middle = symbol.content.match(/\(mid ([\d.-]+) ([\d.-]+)\)/).slice(1).map(Number);

    expect(middle).toEqual([1.27, middleY]);
    expect(symbol.content).toContain("(start 0.00 0.00)");
    expect(symbol.content).toContain("(end 2.54 0.00)");
  });

  it("converts OBJ material groups into WRL output", () => {
    const objData = `
newmtl body
Ka 0.1 0.1 0.1
Kd 0.4 0.5 0.6
Ks 0.7 0.8 0.9
d 1.0
endmtl
v 2.54 0 0
v 0 2.54 0
v 0 0 2.54
usemtl body
f 1 2 3
`.trim();

    const wrl = convertObjToWrlString(objData);

    expect(wrl).toContain("#VRML V2.0 utf8");
    expect(wrl).toContain("diffuseColor 0.4 0.5 0.6");
    expect(wrl).toContain("0.5000 -0.5000 0.0000");
    expect(wrl).toContain("-0.5000 -0.5000 1.0000");
    expect(wrl).toContain("Shape{");
  });

  it("writes each referenced OBJ point once and supplies missing-material colors", () => {
    const wrl = convertObjToWrlString("v 0 0 0\nv 2.54 0 0\nv 0 2.54 0\nusemtl body\nf 1 2 3");
    const points = wrl.match(/point \[\s*([\s\S]*?)\s*\]/)[1].split(", ");

    expect(points).toEqual([
      "-0.5000 -0.5000 0.0000",
      "0.5000 -0.5000 0.0000",
      "-0.5000 0.5000 0.0000"
    ]);
    expect(wrl).toContain("0 1 2 -1,");
    expect(wrl).toContain("diffuseColor 0.8 0.8 0.8");
    expect(wrl).toContain("specularColor 0 0 0");
  });

  it("exports default-material OBJ faces and signed indices relative to each face", () => {
    // The fourth vertex follows the first face, so its negative indices refer
    // to the three vertices available at that point in the source stream.
    const mesh = "v 0 0 0\nv 2.54 0 0\nv 0 2.54 0\nf -3 -2 -1  \nv 0 0 2.54\nusemtl body\nf\t1/1/1 2/2/2 4/4/4 # face";
    const wrl = convertObjToWrlString(mesh);

    expect(wrl.match(/Shape\{/g)).toHaveLength(2);
    expect(wrl).toContain('0.5000 -0.5000 0.0000, -0.5000 0.5000 0.0000');
    expect(wrl.match(/0 1 2 -1,/g)).toHaveLength(2);
  });

  it.each(["0", "4", "-4", "1bad"])("rejects invalid OBJ face indices (%s)", index => {
    expect(() => convertObjToWrlString(`v 0 0 0\nv 2.54 0 0\nv 0 2.54 0\nusemtl body\nf 1 2 ${index}`))
      .toThrow(/OBJ face vertex index/);
  });

  it("accepts indented OBJ records and rejects malformed vertex coordinates", () => {
    const mesh = "  v 0 0 0\n\tv 2.54 0 0\n v 0 2.54 0\n usemtl body\n f 1 2 3";
    expect(convertObjToWrlString(mesh)).toContain('0 1 2 -1,');
    expect(convertObjToWrlString(mesh)).toContain('-0.5000 -0.5000 0.0000');
    expect(() => convertObjToWrlString(mesh.replace('2.54 0 0', 'invalid 0 0')))
      .toThrow(/OBJ vertex coordinates/);
  });

  it("centers large OBJ meshes without exceeding the JavaScript argument limit", () => {
    // Real model meshes can exceed the argument limit of Math.min(...vertices).
    const mesh = Array.from({ length: 150000 }, (_, index) => `v ${index} 0 0`).join("\n");
    expect(() => convertObjToWrlString(`${mesh}\nusemtl body\nf 1 2 150000`)).not.toThrow();
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
