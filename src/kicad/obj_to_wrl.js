/*
 * Converts EasyEDA OBJ/MTL-style model data into WRL text for KiCad. This is
 * kept separate from the footprint exporter so 3D conversion can be tested and
 * evolved independently of symbol and footprint generation.
 */

const KI_3D_UNIT_MM = 2.54;

// Read the three spatial coordinates of each vertex. Validate before computing
// shared bounds so one malformed record produces an explicit model error.
function parseObjVertices(objData) {
  return (objData.match(/^[ \t]*v[ \t]+.*$/gm) || []).map((line) => {
    const vertex = line
      .trim().replace(/^v\s+/, "")
      .split("#")[0]
      .trim()
      .split(/\s+/)
      .slice(0, 3)
      .map(Number);
    if (vertex.length !== 3 || !vertex.every(Number.isFinite)) {
      throw new Error("Invalid OBJ vertex coordinates");
    }
    return vertex;
  });
}

// Place the source mesh around X/Y zero and on the Z=0 seating plane. The
// footprint's separate model placement then positions this normalized mesh.
function getCenteredBottomAlignedOffset(vertices) {
  if (!vertices.length) {
    return { x: 0, y: 0, z: 0 };
  }

  // Meshes may contain more vertices than JavaScript allows function arguments.
  // Accumulate bounds in one pass so large models use the same finite work per vertex.
  const mins = [...vertices[0]];
  const maxs = [...vertices[0]];
  for (const vertex of vertices) {
    for (let index = 0; index < 3; index++) {
      mins[index] = Math.min(mins[index], vertex[index]);
      maxs[index] = Math.max(maxs[index], vertex[index]);
    }
  }
  return {
    x: -(mins[0] + maxs[0]) / 2,
    y: -(mins[1] + maxs[1]) / 2,
    z: -mins[2]
  };
}

// KiCad WRL coordinates use 2.54 mm units; apply alignment before rescaling.
function formatWrlVertex(vertex, offset) {
  return [
    (vertex[0] + offset.x) / KI_3D_UNIT_MM,
    (vertex[1] + offset.y) / KI_3D_UNIT_MM,
    (vertex[2] + offset.z) / KI_3D_UNIT_MM
  ]
    .map((value) => value.toFixed(4))
    .join(" ");
}

// EasyEDA combines OBJ geometry with endmtl-delimited material records. Emit
// each usemtl group as a WRL shape with its own compact, zero-based point table.
function convertObjToWrl(objData) {
  const materials = new Map();
  const materialBlocks = /^[ \t]*newmtl[ \t]+([^#\r\n]+)[^\r\n]*\r?\n([\s\S]*?)^[ \t]*endmtl\b/gm;
  for (const [, name, body] of objData.matchAll(materialBlocks)) {
    const material = {};
    for (const line of body.split(/\r?\n/)) {
      const [kind, ...values] = line.split("#")[0].trim().split(/\s+/);
      if (kind !== "Kd" && kind !== "Ks") continue;
      // VRML diffuse (Kd) and specular (Ks) colors are RGB triples in [0, 1].
      // Unusable optional colors retain the corresponding default material value.
      const rgb = values.map(Number);
      if (rgb.length === 3 && rgb.every(value => value >= 0 && value <= 1)) {
        material[kind] = rgb.join(" ");
      }
    }
    materials.set(name.trim(), material);
  }

  const objVertices = parseObjVertices(objData);
  const vertexOffset = getCenteredBottomAlignedOffset(objVertices);
  const vertices = objVertices.map((vertex) =>
    formatWrlVertex(vertex, vertexOffset)
  );

  const wrlShapes = [];

  const shapes = objData.split(/^[ \t]*usemtl[ \t]+/m);
  let vertexCount = 0;
  for (const [shapeIndex, shape] of shapes.entries()) {
    const lines = shape.split(/\r?\n/).map(line => line.trim());
    // Faces before the first usemtl use the default material. Remaining chunks
    // begin with the material name consumed by the split above.
    const material = shapeIndex > 0 ? materials.get(lines.shift().split("#")[0].trim()) || {} : {};
    const coordIndex = [];
    const points = [];
    const linkMap = new Map();

    for (const line of lines) {
      if (/^v\s/.test(line)) vertexCount++;
      if (!/^f\s/.test(line)) {
        continue;
      }
      const face = line
        .replace(/^f\s+/, "")
        .split("#")[0].trim()
        .split(/\s+/)
        .map((part) => {
          const indexText = part.split("/")[0];
          const index = /^-?\d+$/.test(indexText) ? Number(indexText) : NaN;
          // Negative OBJ indices count backward from the vertices already
          // declared at this face, while positive indices are one-based.
          const resolved = index < 0 ? vertexCount + index + 1 : index;
          if (!Number.isInteger(resolved) || resolved < 1 || resolved > vertexCount) {
            throw new Error("Invalid OBJ face vertex index");
          }
          return resolved;
        });

      if (face.length < 3) throw new Error("An OBJ face requires at least three vertex indices");
      // OBJ faces address the global one-based vertex table. A per-shape map
      // reuses each referenced point while writing WRL's local zero-based indices.
      const faceIndex = face.map(idx => {
        if (!linkMap.has(idx)) {
          linkMap.set(idx, points.length);
          points.push(vertices[idx - 1]);
        }
        return linkMap.get(idx);
      });
      faceIndex.push("-1");
      coordIndex.push(faceIndex.join(" ") + ",");
    }
    if (!coordIndex.length) continue;
    wrlShapes.push(`
Shape{
    appearance Appearance {
        material  Material {
            diffuseColor ${material.Kd || "0.8 0.8 0.8"}
            specularColor ${material.Ks || "0 0 0"}
            ambientIntensity 0.2
            transparency 0
            shininess 0.5
        }
    }
    geometry IndexedFaceSet {
        ccw TRUE
        solid FALSE
        coord DEF co Coordinate {
            point [
                ${points.join(", ")}
            ]
        }
        coordIndex [
            ${coordIndex.join("")}
        ]
    }
}`);
  }

  // Footprints prefer a successfully converted WRL over STEP. A response
  // containing only headers or vertices must take the adapter's fallback path.
  if (!wrlShapes.length) throw new Error("OBJ contains no polygon faces");
  return "#VRML V2.0 utf8\n# 3D model generated by Easy ECAD Downloader\n" + wrlShapes.join("");
}

export { convertObjToWrl };

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
