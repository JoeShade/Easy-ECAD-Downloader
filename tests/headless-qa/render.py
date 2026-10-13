"""Render untouched downloaded libraries and all footprints with the KiCad 10 CLI."""
import argparse
import json
import shutil
import sys
from pathlib import Path

from fixture import children, create_board, parse_sexpr
from render_support import Evidence, hashes, now

HERE = Path(__file__).resolve().parent


def svg_images(evidence, directory):
    files = sorted(directory.rglob("*.svg"))
    if not files:
        evidence.check("FAIL", "KiCad did not produce SVG files", evidence=str(directory))
    for svg in files:
        evidence.image(svg)
        png = svg.with_suffix(".png")
        record = evidence.command(["node", HERE / "rasterize.js", svg, png])
        if record.get("exitCode") == 0:
            evidence.image(png)
    return [str(file) for file in files]


def pcb_view(evidence, cli, board, output, view):
    output.parent.mkdir(parents=True, exist_ok=True)
    angles = ["--rotate", "315,0,45"] if view == "isometric" else []
    side = "right" if view == "side" else "top"
    record = evidence.command([cli, "pcb", "render", "--output", output, "--width", "1200", "--height", "900",
                               "--side", side, "--background", "opaque", *angles, board], cwd=board.parent)
    if record.get("exitCode") == 0:
        evidence.image(output)
    return record


def calibrate(evidence, cli, project):
    from PIL import Image
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
    passed = red_pixels > 100 and all(model["exists"] for model in fixture["models"])
    evidence.data["fixtureCalibration"] = dict(passed=passed, redPixels=red_pixels, fixture=fixture)
    evidence.check("PASS" if passed else "BLOCKED",
                   "Known-good relative WRL path rendered the synthetic red model" if passed else
                   "Known-good model did not render; demonstrated fixture/environment problem",
                   category="fixture", evidence=str(image))
    return passed


def render_assets(evidence, cli, source, project):
    if not source.is_dir():
        raise ValueError("Input download directory does not exist")
    if source == project or source in project.parents or source == evidence.output or source in evidence.output.parents:
        raise ValueError("Output/project directories must be outside the input directory")
    if any(file.is_symlink() for file in source.rglob("*")):
        raise ValueError("Input symlinks are not supported")
    original_hashes = hashes(source)
    evidence.data["inputHashes"] = original_hashes
    for relative in original_hashes:
        file = source / relative
        evidence.check("PASS" if file.stat().st_size else "FAIL", "Downloaded file exists and is nonempty", evidence=relative)
    fixture_ok = calibrate(evidence, cli, project)
    copied = project / "assets"
    shutil.copytree(source, copied)
    symbols = sorted(copied.rglob("*.kicad_sym"))
    footprints = sorted(copied.rglob("*.kicad_mod"))
    if not symbols:
        evidence.check("BLOCKED", "No downloaded symbol library to render", category="input")
    if not footprints:
        evidence.check("BLOCKED", "No downloaded footprint to render", category="input")
    for index, library in enumerate(symbols):
        try:
            parsed = parse_sexpr(library.read_text(encoding="utf-8-sig"))
            entries = [node[1] for node in children(parsed, "symbol")]
            if not entries:
                raise ValueError("Symbol library has no entries")
            for entry_index, entry in enumerate(entries):
                directory = evidence.output / "symbols" / f"library-{index}" / f"entry-{entry_index}"
                directory.mkdir(parents=True)
                record = evidence.command([cli, "sym", "export", "svg", "--symbol", entry, "--output", directory, library])
                artifacts = svg_images(evidence, directory) if record.get("exitCode") == 0 else []
                evidence.data["entries"].append(dict(kind="symbol", file=str(library.relative_to(copied)), entry=entry, artifacts=artifacts))
                evidence.save()
        except Exception as error:
            evidence.check("FAIL", "Symbol library could not be rendered", category="exported-asset", file=str(library), error=str(error))
    for index, footprint in enumerate(footprints):
        try:
            entry = parse_sexpr(footprint.read_text(encoding="utf-8-sig"))[1]
            views = {"copper-silk": "F.Cu,F.SilkS", "fabrication": "F.Fab", "courtyard": "F.CrtYd,F.Fab"}
            for view, layers in views.items():
                directory = evidence.output / "footprints" / str(index) / view
                directory.mkdir(parents=True)
                record = evidence.command([cli, "fp", "export", "svg", "--footprint", footprint.stem, "--layers", layers,
                                           "--sketch-pads-on-fab-layers", "--output", directory, footprint.parent])
                if record.get("exitCode") == 0:
                    svg_images(evidence, directory)
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
            for view in ["top", "isometric", "side"]:
                pcb_view(evidence, cli, board, evidence.output / "assemblies" / str(index) / f"{view}.png", view)
        except Exception as error:
            evidence.check("FAIL", "Footprint inspection failed", category="exported-asset", file=str(footprint), error=str(error))
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
    args = parser.parse_args()
    if args.timeout <= 0:
        parser.error("Timeout must be positive")
    if (args.output / "render-result.json").exists():
        parser.error("Output already contains evidence; choose a fresh output directory")
    if not args.preflight and not args.input:
        parser.error("--input is required unless --preflight is supplied")
    evidence = Evidence(args.output, args.timeout)
    try:
        cli = evidence.preflight(args.kicad_cli)
        if not args.preflight:
            project = (args.project or args.output.parent / (args.output.name + "-inspection-project")).resolve()
            project.mkdir(parents=True, exist_ok=True)
            render_assets(evidence, cli, args.input.resolve(), project)
        evidence.data["execution"] = "COMPLETED"
    except Exception as error:
        evidence.data["execution"] = "FAILED"
        evidence.check("BLOCKED", str(error), category="environment" if args.preflight else "harness")
    finally:
        evidence.data["finishedAt"] = now()
        evidence.save()
    outcomes = {check["outcome"] for check in evidence.data["checks"]}
    print(json.dumps({"execution": evidence.data["execution"], "outcomes": sorted(outcomes), "evidence": str(evidence.output)}))
    return 1 if "FAIL" in outcomes else 2 if "BLOCKED" in outcomes else 0


if __name__ == "__main__":
    sys.exit(main())
