"""Plan and render supplied CAD assets with KiCad while preserving original bytes.

fixture.py owns board construction; model_inspection.py owns model accounting.
Command completion and image decoding leave visual correctness for human review.
"""
import argparse
import json
import math
import shutil
import sys
from pathlib import Path

from fixture import children, create_board, parse_sexpr, UnsupportedGeometry
from render_support import Evidence, hashes, now, verified_download_paths
from model_inspection import (associate_models, derived_model_fixture, final_model_outcomes,
                              footprint_views, image_framing, model_inventory, scene_framing_hint)

HERE = Path(__file__).resolve().parent


def symbol_entries(parsed):
    """Require named, distinct top-level entries before planning library inspections."""
    entries = children(parsed, "symbol")
    if parsed[0] != "kicad_symbol_lib" or not entries:
        raise ValueError("Symbol library has no entries")
    names = [entry[1] if len(entry) > 1 else None for entry in entries]
    if any(not isinstance(name, str) or not name for name in names) or len(set(names)) != len(names):
        raise ValueError("Symbol library has missing or duplicate entry names")
    return names


def svg_images(evidence, directory):
    """Keep SVG originals and record decoded raster copies as separate evidence."""
    files = sorted(directory.rglob("*.svg"))
    if not files:
        evidence.check("FAIL", "KiCad did not produce SVG files", evidence=str(directory))
    pngs = []
    for svg in files:
        evidence.image(svg)
        png = svg.with_suffix(".png")
        record = evidence.command(["node", HERE / "rasterize.js", svg, png])
        if record.get("exitCode") == 0:
            if evidence.image(png):
                pngs.append(str(png))
    return [str(file) for file in files] + pngs


def pcb_view(evidence, cli, board, output, view):
    """Fit a transparent silhouette before rendering the same camera with a background."""
    output.parent.mkdir(parents=True, exist_ok=True)
    angles = ["--rotate", "315,0,45"] if view == "isometric" else []
    side = "right" if view == "side" else "top"
    # KiCad's default camera fits the board outline. Source hints account for
    # elevated or offset models; silhouette probes then establish image margins.
    scene = scene_framing_hint(board)
    attempts, zoom, framing = [], scene["zoom"], {"contained": False}
    common = [cli, "pcb", "render", "--width", "1200", "--height", "900", "--side", side, *angles]
    for attempt in range(7):
        probe = output.with_name(f"{output.stem}.fit-{attempt}.png")
        record = evidence.command([*common, "--output", probe, "--background", "transparent", "--zoom", str(zoom), board], cwd=board.parent)
        detail = {"zoom": zoom, "image": str(probe), "exitCode": record.get("exitCode")}
        attempts.append(detail)
        if record.get("exitCode") != 0:
            record.update(imageDecoded=False, framing={"contained": False, "attempts": attempts})
            return record
        framing = image_framing(probe)
        detail.update(framing)
        if framing["contained"]:
            break
        zoom /= 2
    # At the bounded fallback limit retain the last tested camera. Silhouette
    # containment establishes framing; model appearance remains a visual review.
    zoom = attempts[-1]["zoom"]
    record = evidence.command([*common, "--output", output, "--background", "opaque", "--zoom", str(zoom), board], cwd=board.parent)
    record["framing"] = {**framing, "zoom": zoom, "attempts": attempts, "sceneHint": scene}
    if record.get("exitCode") == 0:
        record["imageDecoded"] = evidence.image(output)
    else:
        record["imageDecoded"] = False
    if record["imageDecoded"] and not framing["contained"]:
        evidence.check("REVIEW", "Camera framing could not establish a clear silhouette margin; full appearance remains outstanding",
                       category="harness", evidence=str(output), framing=record["framing"])
    evidence.save()
    return record


def calibrate(evidence, cli, project):
    """Exercise known WRL and STEP geometry to establish fixture/importer prerequisites."""
    from PIL import Image, ImageChops
    root = project / "calibration"
    shutil.copytree(HERE / "fixtures" / "known-good", root)
    board = root / "fixture.pretty" / "calibration.kicad_pcb"
    fixture = create_board(root / "fixture.pretty" / "qa_block.kicad_mod", board)
    image = evidence.output / "calibration" / "top.png"
    record = pcb_view(evidence, cli, board, image, "top")
    red_pixels = 0
    if record.get("exitCode") == 0 and image.is_file():
        with Image.open(image) as rendered:
            red_pixels = sum(1 for r, g, b in rendered.convert("RGB").get_flattened_data()
                             if r > 80 and r > g * 1.4 and r > b * 1.4)
    wrl_passed = red_pixels > 100 and all(model["exists"] for model in fixture["models"])
    evidence.check("PASS" if wrl_passed else "BLOCKED",
                   "Known-good relative WRL path rendered the synthetic red model" if wrl_passed else
                   "Known-good model did not render; demonstrated fixture/environment problem",
                   category="fixture", evidence=str(image))
    step = root / "fixture.3dshapes" / "qa_block.step"
    derived = derived_model_fixture(step, root / "step-model")
    control = derived_model_fixture(step, root / "step-control", include_model=False)
    model_image = evidence.output / "calibration" / "step.png"
    control_image = evidence.output / "calibration" / "step-control.png"
    step_record = pcb_view(evidence, cli, Path(derived["fixture"]["board"]), model_image, "top")
    control_record = pcb_view(evidence, cli, Path(control["fixture"]["board"]), control_image, "top")
    changed_pixels = 0
    if step_record.get("imageDecoded") and control_record.get("imageDecoded"):
        with Image.open(model_image) as model_pixels, Image.open(control_image) as control_pixels:
            difference = ImageChops.difference(model_pixels.convert("RGB"), control_pixels.convert("RGB"))
            changed_pixels = sum(1 for pixel in difference.get_flattened_data() if max(pixel) > 30)
    step_passed = changed_pixels > 100
    passed = wrl_passed and step_passed
    evidence.data["fixtureCalibration"] = dict(passed=passed,
        wrl={"passed": wrl_passed, "redPixels": red_pixels, "fixture": fixture, "image": str(image)},
        step={"passed": step_passed, "changedPixels": changed_pixels, "fixture": derived,
              "image": str(model_image), "controlImage": str(control_image)})
    evidence.check("PASS" if step_passed else "BLOCKED", "Known-good STEP changed the render versus a model-free synthetic control",
                   category="fixture", evidence=str(model_image), controlEvidence=str(control_image), changedPixels=changed_pixels)
    return passed


def inspection(evidence, identifier, kind, **details):
    """Keep one planned record per stable inspection ID across planning and execution."""
    records = evidence.data.setdefault("coverage", {}).setdefault("inspections", [])
    existing = next((record for record in records if record["id"] == identifier), None)
    if existing:
        return existing
    record = dict(id=identifier, kind=kind, expected=True, attempted=False, produced=False, images=[], commands=[], **details)
    records.append(record)
    evidence.save()
    return record


def assembly_views(evidence, cli, board, prefix, output):
    """Record each assembly camera independently so partial failures retain coverage."""
    records, images, commands = [], [], []
    for view in ["top", "isometric", "side"]:
        item = inspection(evidence, f"{prefix}.{view}", "assembly", view=view)
        item["attempted"] = True
        before = len(evidence.data["commands"])
        image = output / f"{view}.png"
        record = pcb_view(evidence, cli, board, image, view)
        item.update(produced=bool(record.get("imageDecoded") and record.get("framing", {}).get("contained")),
                    framing=record.get("framing"), images=[str(image)] if image.is_file() else [],
                    commands=list(range(before, len(evidence.data["commands"]))))
        records.append(record)
        commands.extend(item["commands"])
        images.extend(item["images"])
        evidence.save()
    return {"execution": "COMPLETED" if all(record.get("imageDecoded") for record in records) else "FAILED",
            "commands": commands, "images": images, "importerCommandsAttempted": True,
            "geometryAppearance": "UNVERIFIED"}


def update_coverage(evidence):
    """Summarize produced evidence while keeping visual inspection explicitly pending."""
    coverage = evidence.data.setdefault("coverage", {})
    records = coverage.setdefault("inspections", [])
    coverage.update(expected=len(records), attempted=sum(item["attempted"] for item in records),
                    produced=sum(item["produced"] for item in records),
                    outstanding=[item["id"] for item in records if not item["produced"]], fullyInspected=False,
                    visualInspectionPending=bool(records), assets={"expected": list(evidence.data.get("inputHashes", {})),
                    "models": len(evidence.data.get("models", [])),
                    "modelOutstanding": [item["relativePath"] for item in evidence.data.get("models", []) if item["outcome"] != "PASS"]})
    evidence.save()


def plan_inspections(evidence, source, verified_paths=None):
    """Plan eligible assets before preflight, retaining malformed files as outstanding."""
    def eligible(file):
        return verified_paths is None or file.relative_to(source).as_posix() in verified_paths
    for index, library in enumerate(sorted(file for file in source.rglob("*.kicad_sym") if eligible(file))):
        try:
            parsed = parse_sexpr(library.read_text(encoding="utf-8-sig"))
            entries = symbol_entries(parsed)
            for entry_index, entry in enumerate(entries):
                inspection(evidence, f"symbol-{index}.{entry_index}", "symbol", entry=entry)
        except (ValueError, OSError):
            inspection(evidence, f"symbol-{index}.unparsed", "symbol", file=library.relative_to(source).as_posix())
    footprints = sorted(file for file in source.rglob("*.kicad_mod") if eligible(file))
    associate_models(evidence.data["models"], footprints, source)
    for index, footprint in enumerate(footprints):
        try:
            parsed = parse_sexpr(footprint.read_text(encoding="utf-8-sig"))
            for view, layers in footprint_views(parsed).items():
                inspection(evidence, f"footprint-{index}.{view}", "footprint", file=footprint.relative_to(source).as_posix(), layers=layers.split(","))
            for view in ["top", "isometric", "side"]:
                inspection(evidence, f"assembly-{index}.{view}", "assembly", view=view)
        except (ValueError, OSError):
            inspection(evidence, f"footprint-{index}.unparsed", "footprint")
    for index, model in enumerate(evidence.data["models"]):
        if not model["references"]:
            for view in ["top", "isometric", "side"]:
                inspection(evidence, f"derived-model-{index}.{view}", "model", model=model["relativePath"])
    update_coverage(evidence)


def render_assets(evidence, cli, source, project, verified_paths=None):
    """Inspect project copies and account for every model while preserving source hashes."""
    if not source.is_dir():
        raise ValueError("Input download directory does not exist")
    if source == project or source in project.parents or source == evidence.output or source in evidence.output.parents:
        raise ValueError("Output/project directories must be outside the input directory")
    if any(file.is_symlink() for file in source.rglob("*")):
        raise ValueError("Input symlinks are not supported")
    original_hashes = hashes(source)
    if "inputHashes" in evidence.data and evidence.data["inputHashes"] != original_hashes:
        raise ValueError("Downloaded originals changed before rendering")
    evidence.data["inputHashes"] = original_hashes
    evidence.data["models"] = model_inventory(source, original_hashes, verified_paths)
    inventory = evidence.data["models"]
    update_coverage(evidence)
    for relative in original_hashes:
        file = source / relative
        evidence.check("PASS" if file.stat().st_size else "FAIL", "Downloaded file exists and is nonempty", evidence=relative)
    copied = project / "assets"
    shutil.copytree(source, copied)
    def eligible(file):
        return verified_paths is None or file.relative_to(copied).as_posix() in verified_paths
    symbols = sorted(file for file in copied.rglob("*.kicad_sym") if eligible(file))
    footprints = sorted(file for file in copied.rglob("*.kicad_mod") if eligible(file))
    evidence.data["missingModelReferences"] = associate_models(inventory, footprints, copied, original=source)
    for missing in evidence.data["missingModelReferences"]:
        evidence.check("REVIEW", "Original footprint reference does not resolve to an inventoried model", **{key: value for key, value in missing.items() if key != "outcome"})
    for index, footprint in enumerate(footprints):
        try:
            parsed = parse_sexpr(footprint.read_text(encoding="utf-8-sig"))
            for view, layers in footprint_views(parsed).items():
                inspection(evidence, f"footprint-{index}.{view}", "footprint", file=footprint.relative_to(copied).as_posix(), layers=layers.split(","))
            for view in ["top", "isometric", "side"]:
                inspection(evidence, f"assembly-{index}.{view}", "assembly", view=view)
        except (ValueError, OSError):
            inspection(evidence, f"footprint-{index}.unparsed", "footprint")
    fixture_ok = calibrate(evidence, cli, project)
    if not symbols:
        evidence.check("BLOCKED", "No downloaded symbol library to render", category="input")
    if not footprints:
        evidence.check("BLOCKED", "No downloaded footprint to render", category="input")
    for index, library in enumerate(symbols):
        try:
            parsed = parse_sexpr(library.read_text(encoding="utf-8-sig"))
            entries = symbol_entries(parsed)
            for entry_index, entry in enumerate(entries):
                item = inspection(evidence, f"symbol-{index}.{entry_index}", "symbol", entry=entry)
                item["attempted"] = True
                before = len(evidence.data["commands"])
                directory = evidence.output / "symbols" / f"library-{index}" / f"entry-{entry_index}"
                directory.mkdir(parents=True)
                record = evidence.command([cli, "sym", "export", "svg", "--symbol", entry, "--output", directory, library])
                artifacts = svg_images(evidence, directory) if record.get("exitCode") == 0 else []
                item.update(produced=any(file.endswith(".png") for file in artifacts), images=artifacts,
                            commands=list(range(before, len(evidence.data["commands"]))))
                evidence.data["entries"].append(dict(kind="symbol", file=str(library.relative_to(copied)), entry=entry, artifacts=artifacts))
                evidence.save()
        except Exception as error:
            item = inspection(evidence, f"symbol-{index}.unparsed", "symbol", file=str(library))
            item["attempted"] = True
            evidence.check("FAIL", "Symbol library could not be rendered", category="exported-asset", file=str(library), error=str(error))
    for index, footprint in enumerate(footprints):
        try:
            parsed = parse_sexpr(footprint.read_text(encoding="utf-8-sig"))
            entry = parsed[1]
            views = footprint_views(parsed)
            for view, layers in views.items():
                item = inspection(evidence, f"footprint-{index}.{view}", "footprint", layers=layers.split(","))
                item["attempted"] = True
                before = len(evidence.data["commands"])
                directory = evidence.output / "footprints" / str(index) / view
                directory.mkdir(parents=True)
                record = evidence.command([cli, "fp", "export", "svg", "--footprint", footprint.stem, "--layers", layers,
                                           "--sketch-pads-on-fab-layers", "--output", directory, footprint.parent])
                if record.get("exitCode") == 0:
                    item["images"] = svg_images(evidence, directory)
                    item["produced"] = any(file.endswith(".png") for file in item["images"])
                item["commands"] = list(range(before, len(evidence.data["commands"])))
                update_coverage(evidence)
            board = footprint.parent / f"qa-inspection-{index}.kicad_pcb"
            fixture = create_board(footprint, board)
            evidence.data["entries"].append(dict(kind="footprint", file=str(footprint.relative_to(copied)), entry=entry, fixture=fixture))
            evidence.save()
            if not fixture["models"]:
                evidence.check("REVIEW", "Exported footprint has no model reference; assembly renders footprint and board only", file=str(footprint))
            for model in fixture["models"]:
                evidence.check("PASS" if model["exists"] and fixture_ok else "REVIEW" if fixture_ok else "BLOCKED",
                               "Referenced model file exists in preserved directory context" if model["exists"] else
                               "Unresolved exported model reference; fixture calibration passed" if fixture_ok else
                               "Model resolution cannot be assessed because fixture calibration failed",
                               category="exported-asset" if fixture_ok else "fixture", **model)
            referenced = [model for model in inventory if any(reference["footprint"] == footprint.relative_to(copied).as_posix() for reference in model["references"])]
            if any(not model["downloadVerified"] for model in referenced):
                evidence.check("BLOCKED", "Primary assembly references a final model asset that was not verified", category="input", file=str(footprint))
                continue
            # Browser evidence authorizes the recorded downloaded models. Require
            # every original reference to resolve to one of those verified paths
            # before KiCad can include its geometry in the assembly images.
            verified_references = {reference["resolved"] for model in referenced if model["downloadVerified"]
                                   for reference in model["references"]}
            if verified_paths is not None and any(model["resolved"] not in verified_references for model in fixture["models"]):
                evidence.check("BLOCKED", "Primary assembly reference is outside the verified model inventory", category="input", file=str(footprint))
                continue
            exercise = assembly_views(evidence, cli, board, f"assembly-{index}", evidence.output / "assemblies" / str(index))
            for model in inventory:
                references = [reference for reference in model["references"] if reference["footprint"] == footprint.relative_to(copied).as_posix()]
                if references:
                    model["exercisedBy"].append({"kind": "original-assembly", "references": references, **exercise})
            update_coverage(evidence)
        except Exception as error:
            unsupported = isinstance(error, UnsupportedGeometry)
            evidence.check("BLOCKED" if unsupported else "FAIL", "Footprint inspection failed",
                           category="harness" if unsupported else "inspection-observation",
                           cause="unsupported fixture geometry" if unsupported else "unknown", file=str(footprint), error=str(error))
    for index, model in enumerate(inventory):
        if model["exercisedBy"] or not model["downloadVerified"]:
            continue
        try:
            derived = derived_model_fixture(copied / model["relativePath"], project / "derived-models" / str(index))
            exercise = assembly_views(evidence, cli, Path(derived["fixture"]["board"]), f"derived-model-{index}", evidence.output / "derived-models" / str(index))
            model["exercisedBy"].append({**derived, **exercise})
        except Exception as error:
            model["limitations"].append(str(error))
            evidence.check("FAIL", "Derived model fixture failed", model=model["relativePath"], error=str(error))
    final_model_outcomes(inventory)
    for model in inventory:
        evidence.check(model["outcome"], "Downloaded model inventory and importer inspection; geometry appearance requires review",
                       model=model["relativePath"], sha256=model["sha256"], evidence=[image for exercise in model["exercisedBy"] for image in exercise.get("images", [])])
    update_coverage(evidence)
    evidence.check("PASS" if hashes(source) == original_hashes else "FAIL", "Downloaded originals unchanged (SHA-256 comparison)")
    evidence.check("REVIEW", "Rendered images require visual component and model-placement inspection")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--project", type=Path)
    parser.add_argument("--kicad-cli")
    parser.add_argument("--timeout", type=float, default=180)
    parser.add_argument("--preflight", action="store_true")
    parser.add_argument("--inventory", type=Path, help="Schema 2 run result; render only verified final assets")
    args = parser.parse_args()
    if not math.isfinite(args.timeout) or args.timeout <= 0:
        parser.error("Timeout must be finite and positive")
    if (args.output / "render-result.json").exists():
        parser.error("Output already contains evidence; choose a fresh output directory")
    if not args.preflight and not args.input:
        parser.error("--input is required unless --preflight is supplied")
    if args.inventory and not args.input:
        parser.error("--input is required with --inventory")
    if args.input:
        original = args.input.resolve()
        targets = [args.output.resolve(), (args.project or args.output.parent / (args.output.name + "-inspection-project")).resolve()]
        if any(target == original or original in target.parents for target in targets):
            parser.error("Output/project directories must be outside the original input directory")
    evidence = Evidence(args.output, args.timeout)
    evidence.data["kind"] = "browser-run-render" if args.inventory else "standalone-render"
    evidence.data["inputDirectory"] = str(args.input.resolve()) if args.input else None
    try:
        verified_paths = None
        if args.inventory:
            report = json.loads(args.inventory.read_text(encoding="utf-8-sig"))
            verified_paths = verified_download_paths(report, args.input)
        if args.input and args.input.is_dir():
            evidence.data["inputHashes"] = hashes(args.input.resolve())
            evidence.data["models"] = model_inventory(args.input.resolve(), evidence.data["inputHashes"], verified_paths)
            plan_inspections(evidence, args.input.resolve(), verified_paths)
        cli = evidence.preflight(args.kicad_cli)
        if not args.preflight:
            project = (args.project or args.output.parent / (args.output.name + "-inspection-project")).resolve()
            project.mkdir(parents=True, exist_ok=True)
            render_assets(evidence, cli, args.input.resolve(), project, verified_paths)
        evidence.data["execution"] = "COMPLETED"
    except Exception as error:
        evidence.data["execution"] = "FAILED"
        evidence.check("BLOCKED", str(error), category="environment" if args.preflight or isinstance(error, (OSError, ModuleNotFoundError)) else "harness")
    finally:
        if args.input and args.input.is_dir() and evidence.data.get("inputHashes") is not None:
            evidence.check("PASS" if hashes(args.input.resolve()) == evidence.data["inputHashes"] else "FAIL",
                           "Downloaded originals unchanged after renderer exit (SHA-256 comparison)")
        evidence.data["finishedAt"] = now()
        update_coverage(evidence)
        evidence.save()
    outcomes = {check["outcome"] for check in evidence.data["checks"]}
    print(json.dumps({"execution": evidence.data["execution"], "outcomes": sorted(outcomes), "evidence": str(evidence.output)}))
    return 1 if "FAIL" in outcomes else 2 if "BLOCKED" in outcomes else 0


if __name__ == "__main__":
    sys.exit(main())
