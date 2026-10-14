"""Build an inspection board without modifying footprint geometry or model blocks."""
import json
import math
import os
import re
from pathlib import Path


class UnsupportedGeometry(ValueError):
    """A demonstrated fixture capability limit, not a demonstrated component defect."""


def parse_sexpr(text):
    tokens = re.findall(r'"(?:\\.|[^"\\])*"|\(|\)|[^\s()]+', text)
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


def bounds(node, margin=True):
    points = []
    def coordinate(value):
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

    def arc(value):
        start, end = coordinate(field(value, "start")), coordinate(field(value, "end"))
        midpoint = children(value, "mid")
        if midpoint:
            mid = coordinate(field(value, "mid"))
            x1, y1 = start
            x2, y2 = mid
            x3, y3 = end
            determinant = 2 * (x1*(y2-y3) + x2*(y3-y1) + x3*(y1-y2))
            if abs(determinant) < 1e-10:
                raise ValueError("Degenerate arc: coincident or collinear points")
            a, b, c = x1*x1+y1*y1, x2*x2+y2*y2, x3*x3+y3*y3
            center = ((a*(y2-y3)+b*(y3-y1)+c*(y1-y2))/determinant,
                      (a*(x3-x2)+b*(x1-x3)+c*(x2-x1))/determinant)
            angle = lambda p: math.atan2(p[1]-center[1], p[0]-center[0])
            start_angle, mid_angle, end_angle = map(angle, (start, mid, end))
            sweep = (end_angle-start_angle) % math.tau
            if (mid_angle-start_angle) % math.tau > sweep + 1e-9:
                sweep -= math.tau
            radius = math.dist(start, center)
            points.extend((start, mid, end))
        else:
            # Legacy KiCad arcs use start as centre and end as the initial point.
            center, initial = start, end
            sweep = math.radians(float(field(value, "angle")[1]))
            if not math.isfinite(sweep) or not 0 < abs(sweep) <= math.tau + 1e-9:
                raise ValueError("Malformed legacy arc sweep")
            radius = math.dist(initial, center)
            start_angle = math.atan2(initial[1]-center[1], initial[0]-center[0])
            points.extend((initial, (center[0]+radius*math.cos(start_angle+sweep), center[1]+radius*math.sin(start_angle+sweep))))
        if radius <= 1e-10 or not math.isfinite(radius):
            raise ValueError("Degenerate arc radius")
        for extremum in (0, math.pi/2, math.pi, 3*math.pi/2):
            distance = (extremum-start_angle) % math.tau if sweep > 0 else (start_angle-extremum) % math.tau
            if distance <= abs(sweep) + 1e-9:
                points.append((center[0]+radius*math.cos(extremum), center[1]+radius*math.sin(extremum)))

    def visit(value):
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
            points.extend(((x-half_x, y-half_y), (x+half_x, y+half_y)))
        for child in value[1:]:
            visit(child)
    # Model transforms are in 3D units, not footprint millimetres.
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
    records = []
    for model in children(node, "model"):
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
    text = Path(footprint).read_text(encoding="utf-8-sig").strip()
    node = parse_sexpr(text)
    if node[0] not in ("footprint", "module"):
        raise ValueError("Not a KiCad footprint")
    if children(node, "at"):
        raise UnsupportedGeometry("Unexpected library footprint root placement; fixture refuses to alter it")
    x1, y1, x2, y2 = bounds(node)
    # A KiCad 8 board is readable by KiCad 10. The footprint text is embedded verbatim.
    board = f'''(kicad_pcb (version 20240108) (generator "headless_qa")
  (general (thickness 1.6)) (paper "A4")
  (layers (0 "F.Cu" signal) (31 "B.Cu" signal)
    (34 "B.Paste" user) (35 "F.Paste" user) (36 "B.SilkS" user) (37 "F.SilkS" user)
    (38 "B.Mask" user) (39 "F.Mask" user) (44 "Edge.Cuts" user)
    (46 "B.CrtYd" user) (47 "F.CrtYd" user) (48 "B.Fab" user) (49 "F.Fab" user))
  (setup (pad_to_mask_clearance 0))
  {text}
  (gr_rect (start {x1:.6f} {y1:.6f}) (end {x2:.6f} {y2:.6f})
    (stroke (width 0.05) (type default)) (fill none) (layer "Edge.Cuts"))
)\n'''
    output = Path(output)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(board, encoding="utf-8")
    return {"footprint": str(footprint), "entry": node[1], "board": str(output),
            "outline": [x1, y1, x2, y2], "models": model_files(node, output.parent),
            "footprintEmbeddedVerbatim": text in board}
