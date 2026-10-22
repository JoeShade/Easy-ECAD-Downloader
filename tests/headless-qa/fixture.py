"""Build bounded inspection boards and preserve original footprint/model placement.

Legacy arc syntax changes only inside embedded fixture copies. render.py owns
CLI execution and evidence; unsupported geometry raises a fixture capability limit.
"""
import json
import math
import os
import re
from pathlib import Path


class UnsupportedGeometry(ValueError):
    """Identify fixture capability limits separately from component defect evidence."""


def parse_sexpr(text):
    """Read nested KiCad expressions, keeping quoted parentheses inside string atoms."""
    tokens = re.findall(r'"(?:\\.|[^"\\])*"|\(|\)|[^\s()]+', text)
    # Each opening parenthesis pushes one list; closing it restores the parent.
    # Quoted tokens are decoded together so their parentheses remain string data.
    stack, root = [], None
    for token in tokens:
        if token == "(":
            node = []
            if stack:
                stack[-1].append(node)
            elif root is not None:
                raise ValueError("Multiple S-expression roots")
            else:
                root = node
            stack.append(node)
        elif token == ")":
            if not stack:
                raise ValueError("Unbalanced S-expression")
            stack.pop()
        else:
            if not stack:
                raise ValueError("Atom outside S-expression")
            stack[-1].append(json.loads(token) if token.startswith('"') else token)
    if stack or not root:
        raise ValueError("Unbalanced or empty S-expression")
    return root


def children(node, name):
    return [value for value in node[1:] if isinstance(value, list) and value and value[0] == name]


def coordinate(value):
    """Read a finite X/Y pair; malformed geometry fails before fixture output is written."""
    try:
        result = tuple(map(float, value[1:3]))
        if len(result) != 2 or not all(math.isfinite(v) for v in result):
            raise ValueError()
        return result
    except (TypeError, ValueError):
        raise ValueError("Malformed or nonfinite footprint coordinate")


def field(value, name):
    found = children(value, name)
    if len(found) != 1:
        raise ValueError(f"Missing or duplicate {name} in {value[0]}")
    return found[0]


def legacy_arc(value):
    """Read legacy arcs as a center, starting point and signed angular sweep."""
    center, initial = coordinate(field(value, "start")), coordinate(field(value, "end"))
    sweep = math.radians(float(field(value, "angle")[1]))
    if not math.isfinite(sweep) or not 0 < abs(sweep) <= math.tau + 1e-9:
        raise ValueError("Malformed legacy arc sweep")
    return center, initial, sweep


def child_spans(text):
    """Locate direct child expressions while keeping quoted parentheses in strings."""
    depth, start, name = 0, None, None
    result = []
    for match in re.finditer(r'"(?:\\.|[^"\\])*"|\(|\)|[^\s()]+', text):
        token = match.group()
        if token == "(":
            depth += 1
            if depth == 2:
                start, name = match.start(), None
        elif token == ")":
            if depth == 2:
                result.append((name, start, match.end()))
            depth -= 1
        elif depth == 2 and name is None:
            name = token
    return result


def normalize_legacy_arcs(text):
    """Translate equivalent arc syntax in fixture text and record every translation."""
    changes, replacements = [], []
    root = parse_sexpr(text)
    version = int(field(root, "version")[1]) if children(root, "version") else 0
    for name, start, end in child_spans(text):
        if name != "fp_arc":
            continue
        original = text[start:end]
        arc = parse_sexpr(original)
        if children(arc, "mid"):
            continue
        # KiCad's LEGACY_ARC_FORMATTING cutoff permits translation for old files;
        # modern versions with angle-based arcs remain explicit input failures.
        if version > 20210925:
            raise ValueError("Legacy arc syntax conflicts with modern footprint version")
        center, initial, sweep = legacy_arc(arc)
        dx, dy = initial[0]-center[0], initial[1]-center[1]

        def point(angle):
            # Rotate the center-relative starting vector to sample the same arc.
            return (center[0]+dx*math.cos(angle)-dy*math.sin(angle),
                    center[1]+dx*math.sin(angle)+dy*math.cos(angle))

        mid, finish = point(sweep/2), point(sweep)
        # Coincident endpoints denote a complete circle in modern KiCad arcs.
        if abs(sweep) == math.tau:
            finish = initial
        fields = {"start": ("start", initial), "end": ("mid", mid), "angle": ("end", finish)}
        normalized = original
        # Replace from right to left so earlier source positions remain valid
        # as normalized coordinate strings change the expression's length.
        for child_name, child_start, child_end in reversed(child_spans(original)):
            if child_name in fields:
                token, xy = fields[child_name]
                replacement = f'({token} {xy[0]:.10f} {xy[1]:.10f})'
                normalized = normalized[:child_start]+replacement+normalized[child_end:]
        replacements.append((start, end, normalized))
        changes.append({"kind": "legacy-arc-syntax", "center": list(center), "initial": list(initial),
                        "sweepDegrees": math.degrees(sweep), "zeroRadius": center == initial,
                        "representation": "start/mid/end", "geometryRepaired": False})
    for start, end, replacement in reversed(replacements):
        text = text[:start]+replacement+text[end:]
    return text, changes


def bounds(node, margin=True, observations=None):
    """Enclose supported footprint geometry with a board margin for inspection.

Circle/arc extrema and rotated pad corners expand the outline. Unsupported
primitives raise a harness limitation; malformed coordinates raise an input error.
"""
    points = []
    def arc(value):
        """Find the circle through modern arc points and include swept axis extrema."""
        start, end = coordinate(field(value, "start")), coordinate(field(value, "end"))
        midpoint = children(value, "mid")
        if midpoint:
            mid = coordinate(field(value, "mid"))
            if start == mid == end:
                points.append(start)
                if observations is not None:
                    observations.append({"kind": "zero-radius-arc", "point": list(start), "geometryRepaired": False})
                return
            if start == end:
                center = ((start[0]+mid[0])/2, (start[1]+mid[1])/2)
                radius = math.dist(start, mid)/2
                points.extend(((center[0]-radius, center[1]-radius), (center[0]+radius, center[1]+radius)))
                return
            x1, y1 = start
            x2, y2 = mid
            x3, y3 = end
            determinant = 2 * (x1*(y2-y3) + x2*(y3-y1) + x3*(y1-y2))
            if abs(determinant) < 1e-10:
                raise ValueError("Degenerate arc: coincident or collinear points")
            a, b, c = x1*x1+y1*y1, x2*x2+y2*y2, x3*x3+y3*y3
            # Equal distances from all three points give the circle center.
            # The midpoint then selects which of the two endpoint sweeps is used.
            center = ((a*(y2-y3)+b*(y3-y1)+c*(y1-y2))/determinant,
                      (a*(x3-x2)+b*(x1-x3)+c*(x2-x1))/determinant)
            def angle(point):
                return math.atan2(point[1]-center[1], point[0]-center[0])
            start_angle, mid_angle, end_angle = map(angle, (start, mid, end))
            sweep = (end_angle-start_angle) % math.tau
            if (mid_angle-start_angle) % math.tau > sweep + 1e-9:
                sweep -= math.tau
            radius = math.dist(start, center)
            points.extend((start, mid, end))
        else:
            # Legacy KiCad arcs use start as centre and end as the initial point.
            center, initial, sweep = legacy_arc(value)
            radius = math.dist(initial, center)
            if radius == 0:
                points.append(center)
                if observations is not None:
                    observations.append({"kind": "zero-radius-arc", "point": list(center), "geometryRepaired": False})
                return
            start_angle = math.atan2(initial[1]-center[1], initial[0]-center[0])
            points.extend((initial, (center[0]+radius*math.cos(start_angle+sweep), center[1]+radius*math.sin(start_angle+sweep))))
        if radius <= 1e-10 or not math.isfinite(radius):
            raise ValueError("Degenerate arc radius")
        for extremum in (0, math.pi/2, math.pi, 3*math.pi/2):
            # X/Y extrema occur at quarter turns, restricted to the signed sweep.
            distance = (extremum-start_angle) % math.tau if sweep > 0 else (start_angle-extremum) % math.tau
            if distance <= abs(sweep) + 1e-9:
                points.append((center[0]+radius*math.cos(extremum), center[1]+radius*math.sin(extremum)))

    def visit(value):
        """Collect supported graphics recursively and expand pad sizes around placement."""
        if not isinstance(value, list) or not value:
            return
        kind = value[0]
        if kind == "fp_circle":
            center, end = coordinate(field(value, "center")), coordinate(field(value, "end"))
            radius = math.dist(center, end)
            if radius <= 1e-10 or not math.isfinite(radius):
                raise ValueError("Degenerate circle radius")
            points.extend(((center[0]-radius, center[1]-radius), (center[0]+radius, center[1]+radius)))
            return
        if kind == "fp_arc":
            arc(value)
            return
        if kind.startswith("fp_") and kind not in ("fp_line", "fp_rect", "fp_poly", "fp_curve", "fp_text", "fp_text_box"):
            raise UnsupportedGeometry(f"Unsupported footprint geometry: {kind}")
        if kind in ("fp_line", "fp_rect"):
            coordinate(field(value, "start")), coordinate(field(value, "end"))
        if kind in ("fp_poly", "fp_curve"):
            vertices = children(field(value, "pts"), "xy")
            if len(vertices) < (4 if kind == "fp_curve" else 3):
                raise ValueError(f"Malformed {kind} points")
            # Cubic Bezier curves lie inside their control-point convex hull.
        if kind in ("start", "end", "center", "xy", "at"):
            points.append(coordinate(value))
        if value[0] == "pad":
            at, size = field(value, "at"), field(value, "size")
            x, y = coordinate(at)
            width, height = coordinate(size)
            rotation = math.radians(float(at[3])) if len(at) > 3 else 0
            if min(width, height) <= 0 or not math.isfinite(rotation):
                raise ValueError("Malformed pad dimensions or rotation")
            if children(value, "primitives"):
                raise UnsupportedGeometry("Unsupported custom pad geometry")
            half_x = (abs(math.cos(rotation))*width + abs(math.sin(rotation))*height)/2
            half_y = (abs(math.sin(rotation))*width + abs(math.cos(rotation))*height)/2
            # Project the rotated rectangle onto each axis, then translate those
            # half-extents around the pad center to enclose all four corners.
            points.extend(((x-half_x, y-half_y), (x+half_x, y+half_y)))
        for child in value[1:]:
            visit(child)
    # Only footprint artwork and pads establish the board's two-dimensional outline.
    for child in node[1:]:
        if isinstance(child, list) and child[0] != "model":
            visit(child)
    if not points:
        raise ValueError("No footprint coordinates found")
    xs, ys = zip(*points)
    padding = max(2, max(max(xs)-min(xs), max(ys)-min(ys)) * .15) if margin else 0
    result = [min(xs)-padding, min(ys)-padding, max(xs)+padding, max(ys)+padding]
    if not all(math.isfinite(value) for value in result):
        raise ValueError("Malformed geometry produced nonfinite bounds")
    return result


def model_files(node, board_dir):
    """Resolve recorded model paths in the board's directory and retain transforms."""
    records = []
    for model in children(node, "model"):
        if len(model) < 2 or not isinstance(model[1], str) or not model[1]:
            raise ValueError("Malformed footprint model reference")
        original = model[1]
        expanded = original.replace("${KIPRJMOD}", str(board_dir)).replace("$(KIPRJMOD)", str(board_dir))
        expanded = os.path.expandvars(expanded)
        unresolved = bool(re.search(r'\$[({]', expanded))
        target = Path(expanded.replace("\\", "/"))
        if not target.is_absolute():
            target = board_dir / target
        records.append({"reference": original, "resolved": str(target.resolve()),
                        "exists": not unresolved and target.is_file(), "unresolvedVariable": unresolved,
                        "transforms": model[2:]})
    return records


def create_board(footprint, output):
    """Embed one library footprint beside its copied models and add closed Edge.Cuts."""
    text = Path(footprint).read_text(encoding="utf-8-sig").strip()
    node = parse_sexpr(text)
    if node[0] not in ("footprint", "module"):
        raise ValueError("Not a KiCad footprint")
    if len(node) < 2 or not isinstance(node[1], str) or not node[1]:
        raise ValueError("Missing or malformed footprint name")
    if children(node, "at"):
        raise UnsupportedGeometry("Unexpected library footprint root placement; fixture refuses to alter it")
    observations = []
    x1, y1, x2, y2 = bounds(node, observations=observations)
    fixture_text, normalizations = normalize_legacy_arcs(text)
    # New board versions require start/mid/end arcs, even inside a legacy module.
    # The embedded fixture copy receives syntax changes; source bytes and model
    # blocks remain intact for the final preservation check.
    board = f'''(kicad_pcb (version 20240108) (generator "headless_qa")
  (general (thickness 1.6)) (paper "A4")
  (layers (0 "F.Cu" signal) (31 "B.Cu" signal)
    (34 "B.Paste" user) (35 "F.Paste" user) (36 "B.SilkS" user) (37 "F.SilkS" user)
    (38 "B.Mask" user) (39 "F.Mask" user) (44 "Edge.Cuts" user)
    (46 "B.CrtYd" user) (47 "F.CrtYd" user) (48 "B.Fab" user) (49 "F.Fab" user))
  (setup (pad_to_mask_clearance 0))
  {fixture_text}
  (gr_rect (start {x1:.6f} {y1:.6f}) (end {x2:.6f} {y2:.6f})
    (stroke (width 0.05) (type default)) (fill none) (layer "Edge.Cuts"))
)\n'''
    output = Path(output)
    models = model_files(node, output.parent)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(board, encoding="utf-8")
    return {"footprint": str(footprint), "entry": node[1], "board": str(output),
            "outline": [x1, y1, x2, y2], "models": models,
            "footprintEmbeddedVerbatim": text in board, "fixtureNormalizations": normalizations,
            "geometryObservations": observations}
