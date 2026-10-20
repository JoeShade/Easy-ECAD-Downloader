"""Inventory downloaded models, preserve references and fit inspection cameras.

Derived identity-transform fixtures provide importer evidence. Original model
association and alignment remain explicit visual-review responsibilities.
"""
import os
import math
import re
from pathlib import Path

from fixture import children, create_board, model_files, parse_sexpr

MODEL_SUFFIXES = {".step", ".stp", ".wrl"}
NUMBER = r"[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[EeDd][-+]?\d+)?"


def model_framing_hint(model):
    """Read conservative source hints for cameras; CAD measurement requires inspection."""
    result = {"radiusMm": None, "centerMm": [0, 0, 0], "method": "unavailable", "limitations": []}
    try:
        text = Path(model).read_text(encoding="utf-8-sig", errors="replace")
        def number(value):
            # STEP also permits D as the scientific-notation exponent separator.
            return float(value.replace("D", "E").replace("d", "e"))
        radii, points = [], []
        center = [0, 0, 0]
        if Path(model).suffix.lower() in (".step", ".stp"):
            # Control points may extend beyond the visible solid. These deliberately
            # generous extents size an inspection fixture around the original model.
            units = re.findall(r"SI_UNIT\s*\(\s*(\.[A-Z]+\.|\$)\s*,\s*\.METRE\.\s*\)", text, re.I)
            scales = {".MILLI.": 1, ".CENTI.": 10, ".DECI.": 100, "$": 1000, ".MICRO.": .001}
            if not units or len(set(unit.upper() for unit in units)) != 1 or units[0].upper() not in scales:
                raise ValueError("STEP units are absent, mixed or unsupported; camera uses image-fit fallback")
            unit = scales[units[0].upper()]
            for coordinates in re.findall(r"CARTESIAN_POINT\s*\(\s*'(?:''|[^'])*'\s*,\s*\(([^()]*)\)\s*\)", text, re.I):
                values = [number(value) for value in coordinates.split(",")]
                if len(values) == 3:
                    points.append(values)
            if points:
                center = [(min(point[axis] for point in points) + max(point[axis] for point in points)) / 2 for axis in range(3)]
                radii = [math.dist(point, center) for point in points]
            # Surface/curve radii supply extents beyond explicitly recorded points.
            curved = [number(value) for value in re.findall(
                rf"(?:CIRCLE|SPHERICAL_SURFACE|CYLINDRICAL_SURFACE|CONICAL_SURFACE|TOROIDAL_SURFACE)\s*\([^;]*?,\s*({NUMBER})\s*\)", text, re.I)]
            radius = (max(radii, default=0) + 2 * max((abs(value) for value in curved), default=0)) * unit
            center = [value * unit for value in center]
            result["method"] = "STEP source coordinates and curve allowances"
            result["limitations"].append("STEP hints are conservative, not evaluated solid bounds; assembly mappings and unsupported units require visual review")
        else:
            # KiCad interprets VRML coordinates in 0.1 inch units. Rotation preserves
            # this radial bound; sums/products conservatively include nested moves.
            text = re.sub(r"#[^\n]*", "", text)
            for coordinates in re.findall(r"\bpoint\s*\[([^]]*)\]", text, re.I):
                values = [number(value) for value in re.findall(NUMBER, coordinates)]
                points.extend(values[index:index + 3] for index in range(0, len(values) - 2, 3))
            for size in re.findall(rf"\bBox\s*\{{\s*size\s+({NUMBER})\s+({NUMBER})\s+({NUMBER})", text, re.I):
                half = [abs(number(value)) / 2 for value in size]
                points.extend([[x * half[0], y * half[1], z * half[2]]
                               for x in (-1, 1) for y in (-1, 1) for z in (-1, 1)])
            def vectors(name):
                """Read explicit three-axis VRML transform fields for a radial bound."""
                return [[number(value) for value in vector] for vector in re.findall(
                    rf"\b{name}\s+({NUMBER})\s+({NUMBER})\s+({NUMBER})", text, re.I)]
            translation = sum(math.sqrt(sum(value * value for value in vector)) for vector in vectors("translation"))
            centers = 2 * sum(math.sqrt(sum(value * value for value in vector)) for vector in vectors("center"))
            scale = math.prod(max(1, *(abs(value) for value in vector)) for vector in vectors("scale"))
            radii = [math.sqrt(sum(value * value for value in point)) for point in points]
            radius = (max(radii, default=0) + translation + centers) * scale * 2.54
            # Flat meshes and one unrotated transform have a directly computed
            # center. Other scenes retain the conservative origin-centered bound.
            transforms = len(re.findall(r"\bTransform\s*\{", text))
            if points and transforms <= 1 and not re.search(r"\b(?:rotation|center)\s", text):
                scale_vector = (vectors("scale") or [[1, 1, 1]])[0]
                movement = (vectors("translation") or [[0, 0, 0]])[0]
                moved = [[point[axis] * scale_vector[axis] + movement[axis] for axis in range(3)] for point in points]
                center = [(min(point[axis] for point in moved) + max(point[axis] for point in moved)) / 2 for axis in range(3)]
                radii = [math.dist(point, center) for point in moved]
                radius = max(radii) * 2.54
                center = [value * 2.54 for value in center]
            result["method"] = "VRML source coordinates with conservative transform allowance"
            result["limitations"].append("VRML hints cover coordinate meshes and explicit boxes; other primitives and importer differences require visual review")
        if not radii or not math.isfinite(radius) or not 0 < radius <= 100000:
            raise ValueError("No usable bounded model coordinates; camera uses image-fit fallback")
        result["radiusMm"] = radius
        result["centerMm"] = center
    except (OSError, ValueError, OverflowError) as error:
        result["limitations"].append(str(error))
    return result


def image_framing(filename, margin=.05):
    """Check silhouette margins; establishing expected model presence requires review."""
    from PIL import Image
    with Image.open(filename) as image:
        if "A" not in image.getbands():
            return {"contained": False, "reason": "Renderer did not provide alpha silhouette"}
        alpha = image.getchannel("A")
        # Ignore faint antialiasing while retaining partly transparent geometry.
        box = alpha.point(lambda value: 255 if value >= 8 else 0).getbbox()
        width, height = image.size
    contained = bool(box and box[0] >= width * margin and box[1] >= height * margin and
                     box[2] <= width * (1 - margin) and box[3] <= height * (1 - margin))
    return {"contained": contained, "silhouette": list(box) if box else None,
            "dimensions": [width, height], "marginFraction": margin,
            "limitation": "Silhouette containment does not establish model presence, full geometry, or correct original placement"}


def scene_framing_hint(board):
    """Start far enough out for models wholly outside the board's default camera."""
    result = {"zoom": 1., "models": [], "limitations": []}
    try:
        parsed = parse_sexpr(Path(board).read_text(encoding="utf-8-sig"))
        outline = children(parsed, "gr_rect")[0]
        start = list(map(float, children(outline, "start")[0][1:3]))
        end = list(map(float, children(outline, "end")[0][1:3]))
        board_center = [(start[axis] + end[axis]) / 2 for axis in range(2)] + [0]
        board_span = max(abs(end[axis] - start[axis]) for axis in range(2))
        scene_radius = 0
        for footprint in children(parsed, "footprint") + children(parsed, "module"):
            for reference in model_files(footprint, Path(board).parent):
                hint = model_framing_hint(reference["resolved"])
                result["models"].append({"reference": reference["reference"], **hint})
                if hint["radiusMm"] is None:
                    continue
                fields = {node[0]: list(map(float, node[1][1:4])) for node in reference["transforms"]
                          if node[0] in ("scale", "rotate", "offset", "at")}
                scale = fields.get("scale", [1, 1, 1])
                center = [hint["centerMm"][axis] * scale[axis] for axis in range(3)]
                radius = hint["radiusMm"] * max(abs(value) for value in scale)
                if any(fields.get("rotate", [0, 0, 0])):
                    radius += math.sqrt(sum(value * value for value in center))
                    center = [0, 0, 0]
                # Legacy model `at` coordinates use inches; `offset` is mm.
                offset = fields.get("offset", [value * 25.4 for value in fields.get("at", [0, 0, 0])])
                center = [center[axis] + offset[axis] for axis in range(3)]
                center[1] = -center[1]
                scene_radius = max(scene_radius, math.dist(center, board_center) + radius)
        if scene_radius > 0 and board_span > 0:
            result["zoom"] = min(1., board_span / (2.6 * scene_radius))
        result["limitations"].append("Camera hints do not establish that imported geometry exists; source mappings may require additional review")
    except (OSError, ValueError, IndexError, TypeError) as error:
        result["limitations"].append(f"Scene camera hint unavailable: {error}")
    return result


def model_inventory(source, file_hashes, verified_paths=None):
    """Keep every downloaded model visible, including assets ineligible for inspection."""
    inventory = []
    for relative, digest in sorted(file_hashes.items()):
        if Path(relative).suffix.lower() not in MODEL_SUFFIXES:
            continue
        eligible = verified_paths is None or relative in verified_paths
        inventory.append({"relativePath": relative, "sha256": digest, "downloaded": True,
                          "format": Path(relative).suffix.lower()[1:], "downloadVerified": eligible,
                          "references": [], "exercisedBy": [], "outcome": "NOT_RUN",
                          "geometryAppearance": "UNVERIFIED", "limitations": [
                              "Importer commands and decoded images alone do not establish that geometry appeared or that placement is correct"]})
    return inventory


def associate_models(inventory, footprints, copied, original=None):
    """Match exact resolved paths against copied/original assets and retain missing links."""
    by_path = {(copied / record["relativePath"]).resolve(): record for record in inventory}
    if original is not None:
        by_path.update({(original / record["relativePath"]).resolve(): record for record in inventory})
    missing = []
    for footprint in footprints:
        try:
            parsed = parse_sexpr(footprint.read_text(encoding="utf-8-sig"))
            for model in model_files(parsed, footprint.parent):
                reference = {"footprint": footprint.relative_to(copied).as_posix(), **model}
                record = by_path.get(Path(model["resolved"]))
                if record:
                    record["references"].append(reference)
                else:
                    missing.append({**reference, "outcome": "REVIEW", "limitation": "Original reference does not resolve to an inventoried downloaded model"})
        except (ValueError, OSError) as error:
            for record in inventory:
                record["limitations"].append(f"Reference mapping incomplete for {footprint.name}: {error}")
    return missing


def derived_model_fixture(model, directory, include_model=True):
    """Create a labelled identity-transform importer board around source framing hints."""
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=True)
    reference = os.path.relpath(model, directory).replace("\\", "/")
    framing = model_framing_hint(model)
    radius = max(.5, ((framing["radiusMm"] or 3) + abs(framing["centerMm"][2])) * 1.1)
    center_x, center_y, _ = framing["centerMm"]
    # PCB Y points down while model Y points up. Only synthetic inspection
    # artwork follows this camera hint; the imported model retains identity.
    center_y = -center_y
    # An unassociated model uses identity transforms for importer evidence.
    # Original footprint references and placement retain separate review coverage.
    model_block = f'(model "{reference}" (offset (xyz 0 0 0)) (scale (xyz 1 1 1)) (rotate (xyz 0 0 0)))' if include_model else ""
    text = f'''(footprint "Derived_Model_Inspection" (version 20240108) (generator "headless_qa") (layer "F.Cu")
      (fp_rect (start {center_x-radius:.6f} {center_y-radius:.6f}) (end {center_x+radius:.6f} {center_y+radius:.6f}) (stroke (width 0.1) (type default)) (fill none) (layer "F.Fab"))
      {model_block})\n'''
    footprint = directory / "derived.kicad_mod"
    footprint.write_text(text, encoding="utf-8")
    record = create_board(footprint, directory / "derived.kicad_pcb")
    return {"kind": "derived-model-inspection", "association": "none inferred", "fixture": record,
            "framingHint": framing,
            "reference": reference, "transforms": children(parse_sexpr(text), "model")[0][2:] if include_model else [],
            "limitation": "Identity transforms exercise the model importer; original reference and alignment remain unverified"}


def footprint_views(parsed):
    """Include back-side layers whenever artwork or through-hole pads require them."""
    layers = set()
    def visit(node):
        if not isinstance(node, list) or not node:
            return
        if node[0] in ("layer", "layers"):
            layers.update(value for value in node[1:] if isinstance(value, str))
        for child in node[1:]:
            visit(child)
    visit(parsed)
    views = {"copper-silk": "F.Cu,F.SilkS", "fabrication": "F.Fab", "courtyard": "F.CrtYd,F.Fab"}
    if any(layer.startswith("B.") or layer in ("*.Cu", "F&B.Cu") for layer in layers):
        views.update({"back-copper-silk": "B.Cu,B.SilkS", "back-fabrication": "B.Fab", "back-courtyard": "B.CrtYd,B.Fab"})
    return views


def final_model_outcomes(inventory):
    """Separate ineligible/unattempted/failed imports from completed visual-review work."""
    for record in inventory:
        if not record["downloadVerified"]:
            record["outcome"] = "BLOCKED"
            record["limitations"].append("Final download asset not verified; inspection not authorised by inventory")
        elif not record["exercisedBy"]:
            record["outcome"] = "NOT_RUN"
            record["limitations"].append("No importer fixture completed")
        elif any(exercise["execution"] == "FAILED" for exercise in record["exercisedBy"]):
            record["outcome"] = "FAIL"
        else:
            record["outcome"] = "REVIEW"
