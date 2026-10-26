"""Camera framing regressions; model/importer correctness still needs native visual review."""
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from PIL import Image, ImageDraw

from fixture import create_board
from model_inspection import derived_model_fixture, image_framing, model_framing_hint, scene_framing_hint
from render import assembly_views, pcb_view, update_coverage
from render_support import Evidence, hashes


class ModelFramingTests(unittest.TestCase):
    def test_derived_outline_covers_large_offset_vrml_without_moving_model(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "originals"
            source.mkdir()
            model = source / "offset.wrl"
            model.write_text("#VRML V2.0 utf8\nTransform { translation 100 0 10 scale 2 1 1 "
                             "children [ Shape { geometry Box { size 40 20 10 } } ] }")
            before = hashes(source)
            result = derived_model_fixture(model, root / "inspection")
            self.assertGreater(result["framingHint"]["radiusMm"], 100)
            self.assertEqual(result["framingHint"]["centerMm"], [254, 0, 25.4])
            self.assertLess(result["fixture"]["outline"][0], 140)
            self.assertGreater(result["fixture"]["outline"][2], 360)
            self.assertEqual(result["transforms"], [["offset", ["xyz", "0", "0", "0"]],
                             ["scale", ["xyz", "1", "1", "1"]], ["rotate", ["xyz", "0", "0", "0"]]])
            self.assertEqual(hashes(source), before)
            self.assertEqual(result["association"], "none inferred")

    def test_small_and_large_step_units_produce_useful_separate_framing(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            def step(name, coordinate, unit):
                model = root / name
                model.write_text(f"#1=(LENGTH_UNIT() NAMED_UNIT(*) SI_UNIT({unit},.METRE.));\n"
                                 f"#2=CARTESIAN_POINT('',({coordinate},0.,0.));\n"
                                 f"#3=CARTESIAN_POINT('',(-{coordinate},0.,0.));")
                return model_framing_hint(model)
            small = step("small.step", ".1", ".MILLI.")
            large = step("large.step", "100.", ".MILLI.")
            metres = step("metres.step", ".1", "$")
            self.assertAlmostEqual(small["radiusMm"], .1)
            self.assertAlmostEqual(large["radiusMm"], 100)
            self.assertEqual(large["radiusMm"], metres["radiusMm"])
            self.assertTrue(large["limitations"])

    def test_vrml_coordinate_mesh_uses_kicad_units_and_rejects_unusable_bounds(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            model = root / "mesh.wrl"
            model.write_text("Coordinate { point [ -1 -2 -2, 1 2 2 ] }")
            self.assertAlmostEqual(model_framing_hint(model)["radiusMm"], 3 * 2.54)
            model.write_text("Shape { geometry UnknownPrimitive { } }")
            self.assertIsNone(model_framing_hint(model)["radiusMm"])
            step = root / "unknown.step"
            step.write_text("CARTESIAN_POINT('',(100.,0.,0.));")
            self.assertIsNone(model_framing_hint(step)["radiusMm"])

    def test_alpha_framing_detects_clipped_contained_and_missing_silhouettes(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "image.png"
            image = Image.new("RGBA", (200, 100))
            ImageDraw.Draw(image).rectangle((0, 10, 150, 90), fill=(50, 50, 50, 255))
            image.save(path)
            self.assertFalse(image_framing(path)["contained"])
            image = Image.new("RGBA", (200, 100))
            ImageDraw.Draw(image).rectangle((20, 10, 180, 90), fill=(50, 50, 50, 255))
            image.save(path)
            self.assertTrue(image_framing(path)["contained"])
            image = Image.new("RGBA", (200, 100))
            image.save(path)
            self.assertFalse(image_framing(path)["contained"])
            Image.new("RGB", (200, 100)).save(path)
            self.assertFalse(image_framing(path)["contained"])

    def test_scene_hint_accounts_for_wholly_offscreen_model_before_silhouette_check(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            model = root / "elevated.wrl"
            model.write_text("#VRML V2.0 utf8\nTransform { translation 0 0 100 "
                             "children [ Shape { geometry Box { size 1 1 1 } } ] }")
            footprint = root / "original.kicad_mod"
            footprint.write_text('(footprint "original" (layer "F.Cu") '
                                 '(fp_rect (start -1 -1) (end 1 1) (layer "F.Fab")) '
                                 '(model "elevated.wrl" (offset (xyz 0 0 50)) '
                                 '(scale (xyz 2 1 1)) (rotate (xyz 0 0 0))))')
            board = root / "original.kicad_pcb"
            create_board(footprint, board)
            before = hashes(root)
            hint = scene_framing_hint(board)
            self.assertLess(hint["zoom"], .01)
            self.assertEqual(hint["models"][0]["centerMm"][2], 254)
            self.assertTrue(hint["limitations"])
            self.assertEqual(hashes(root), before)
            # A board-only alpha image can already be contained. Source geometry
            # therefore informs the first camera as well as silhouette fitting.
            with patch('render.scene_framing_hint', return_value=hint):
                evidence = Evidence(root / "renders", 1)
                with patch.object(evidence, "command", side_effect=self.render_stub(.01)) as command:
                    result = pcb_view(evidence, "fake-cli", board, evidence.output / "side.png", "side")
            first = command.call_args_list[0].args[0]
            self.assertLess(float(first[first.index("--zoom") + 1]), .01)
            self.assertTrue(result["framing"]["contained"])

    def test_legacy_inches_and_modern_mm_offsets_use_equivalent_cameras(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "block.wrl").write_text("Shape { geometry Box { size 1 1 1 } }")
            cameras = []
            for name, offset in (("legacy", "(at (xyz 1 2 3))"), ("modern", "(offset (xyz 25.4 50.8 76.2))")):
                footprint = root / f"{name}.kicad_mod"
                footprint.write_text('(footprint "original" (layer "F.Cu") '
                                     '(fp_rect (start -1 -1) (end 1 1) (layer "F.Fab")) '
                                     f'(model "block.wrl" {offset} (scale (xyz 1 1 1)) (rotate (xyz 0 0 0))))')
                board = root / f"{name}.kicad_pcb"
                create_board(footprint, board)
                cameras.append(scene_framing_hint(board)["zoom"])
            self.assertAlmostEqual(*cameras)

    def render_stub(self, contained_at=None):
        """Write clipped/contained silhouettes according to the requested camera zoom."""
        def command(args, cwd=None):
            output = Path(args[args.index("--output") + 1])
            zoom = float(args[args.index("--zoom") + 1])
            transparent = args[args.index("--background") + 1] == "transparent"
            image = Image.new("RGBA" if transparent else "RGB", (200, 100))
            fits = contained_at is not None and zoom <= contained_at
            ImageDraw.Draw(image).rectangle((20 if fits else 0, 10, 180, 90), fill=(80, 80, 80, 255) if transparent else (80, 80, 80))
            image.save(output)
            return {"exitCode": 0, "args": list(map(str, args))}
        return command

    def test_camera_retries_clip_and_uses_tested_zoom_without_changing_board(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            board = root / "original.kicad_pcb"
            board.write_text('(model "original.wrl" (offset (xyz 1 2 3)) (scale (xyz 2 1 1)))')
            original = board.read_bytes()
            evidence = Evidence(root / "renders", 1)
            with patch.object(evidence, "command", side_effect=self.render_stub(.25)) as command:
                record = pcb_view(evidence, "fake-cli", board, evidence.output / "isometric.png", "isometric")
            self.assertEqual(record["framing"]["zoom"], .25)
            self.assertTrue(record["framing"]["contained"])
            self.assertTrue(record["imageDecoded"])
            self.assertEqual(command.call_count, 4)
            self.assertEqual(board.read_bytes(), original)
            self.assertIn("315,0,45", command.call_args.args[0])

    def test_camera_exhaustion_is_explicit_harness_review_and_not_coverage_completion(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            board = root / "board.kicad_pcb"
            board.write_text("unchanged fixture")
            evidence = Evidence(root / "renders", 1)
            with patch.object(evidence, "command", side_effect=self.render_stub()):
                result = assembly_views(evidence, "fake-cli", board, "assembly-0", evidence.output / "assembly")
            update_coverage(evidence)
            self.assertEqual(result["geometryAppearance"], "UNVERIFIED")
            self.assertEqual(len(evidence.data["coverage"]["outstanding"]), 3)
            self.assertTrue(all(not item["produced"] for item in evidence.data["coverage"]["inspections"]))
            reviews = [item for item in evidence.data["checks"] if item["outcome"] == "REVIEW"]
            self.assertEqual(len(reviews), 3)
            self.assertTrue(all(item["category"] == "harness" for item in reviews))
            self.assertEqual(board.read_text(), "unchanged fixture")


if __name__ == "__main__":
    unittest.main()
