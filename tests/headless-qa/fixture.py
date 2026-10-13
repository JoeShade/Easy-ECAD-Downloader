"""Build an inspection board without modifying footprint geometry or model blocks."""
import json
import math
import os
import re
from pathlib import Path


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


def bounds(node):
    points = []
    def visit(value):
        if not isinstance(value, list) or not value:
            return
        if value[0] in ("start", "end", "center", "xy", "at") and len(value) >= 3:
            try:
                x, y = float(value[1]), float(value[2])
                if not math.isfinite(x) or not math.isfinite(y):
                    raise ValueError("Nonfinite footprint coordinate")
                points.append((x, y))
            except (TypeError, ValueError):
                raise ValueError("Invalid footprint coordinate")
        if value[0] == "pad":
            at, size = children(value, "at"), children(value, "size")
            if at and size:
                x, y = map(float, at[0][1:3])
                # Diagonal bounds cover rotated pads without changing their rotation.
                radius = math.hypot(*map(float, size[0][1:3])) / 2
                points.extend(((x-radius, y-radius), (x+radius, y+radius)))
        for child in value[1:]:
            visit(child)
    # Model transforms are in 3D units, not footprint millimetres.
    for child in node[1:]:
        if isinstance(child, list) and child[0] != "model":
            visit(child)
    if not points:
        raise ValueError("No footprint coordinates found")
    xs, ys = zip(*points)
    margin = max(2, max(max(xs)-min(xs), max(ys)-min(ys)) * .15)
    return [min(xs)-margin, min(ys)-margin, max(xs)+margin, max(ys)+margin]


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
        raise ValueError("Unexpected library footprint root placement; fixture refuses to alter it")
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
