"""Inventory all 3D files and label derived model fixtures without guessing associations."""
import os
from pathlib import Path

from fixture import children, create_board, model_files, parse_sexpr

MODEL_SUFFIXES = {".step", ".stp", ".wrl"}


def model_inventory(source, file_hashes, verified_paths=None):
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
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=True)
    reference = os.path.relpath(model, directory).replace("\\", "/")
    # An unassociated model uses identity transforms; this is importer evidence,
    # not a replacement for the original footprint's reference or placement.
    model_block = f'(model "{reference}" (offset (xyz 0 0 0)) (scale (xyz 1 1 1)) (rotate (xyz 0 0 0)))' if include_model else ""
    text = f'''(footprint "Derived_Model_Inspection" (version 20240108) (generator "headless_qa") (layer "F.Cu")
      (fp_rect (start -3 -3) (end 3 3) (stroke (width 0.1) (type default)) (fill none) (layer "F.Fab"))
      {model_block})\n'''
    footprint = directory / "derived.kicad_mod"
    footprint.write_text(text, encoding="utf-8")
    record = create_board(footprint, directory / "derived.kicad_pcb")
    return {"kind": "derived-model-inspection", "association": "none inferred", "fixture": record,
            "reference": reference, "transforms": children(parse_sexpr(text), "model")[0][2:] if include_model else [],
            "limitation": "Identity transforms exercise the model importer; original reference and alignment remain unverified"}


def footprint_views(parsed):
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
