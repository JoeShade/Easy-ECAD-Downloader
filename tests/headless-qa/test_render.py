"""Offline fixture and rendering failure checks; no KiCad installation required."""
import tempfile
import unittest
from pathlib import Path

from fixture import children, create_board, model_files, parse_sexpr
from render_support import Evidence, atomic_json, discover_cli, hashes

HERE = Path(__file__).resolve().parent
SAMPLE = HERE / "fixtures" / "known-good" / "fixture.pretty" / "qa_block.kicad_mod"


class FixtureTests(unittest.TestCase):
    def test_preserves_geometry_and_transforms_and_closed_outline(self):
        import shutil
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            shutil.copytree(SAMPLE.parent.parent, root / "assets")
            original = root / "assets" / "fixture.pretty" / SAMPLE.name
            before = hashes(root / "assets")
            board = original.parent / "inspection.kicad_pcb"
            record = create_board(original, board)
            text = board.read_text()
            self.assertIn(original.read_text().strip(), text)
            node = parse_sexpr(text)
            self.assertEqual(children(node, "footprint")[0], parse_sexpr(original.read_text()))
            rectangle = children(node, "gr_rect")
            self.assertEqual(len(rectangle), 1)
            self.assertEqual(children(rectangle[0], "layer")[0][1], "Edge.Cuts")
            x1, y1, x2, y2 = record["outline"]
            self.assertLess(x1, -3.5)
            self.assertGreater(x2, 3.5)
            self.assertLess(y1, -4)
            self.assertGreater(y2, 4)
            self.assertTrue(record["models"][0]["exists"])
            self.assertEqual(record["models"][0]["reference"], "../fixture.3dshapes/qa_block.wrl")
            del_after = hashes(root / "assets")
            del del_after[str(board.relative_to(root / "assets"))]
            self.assertEqual(before, del_after)

    def test_handles_all_symbol_entries(self):
        node = parse_sexpr('(kicad_symbol_lib (symbol "one") (symbol "two"))')
        self.assertEqual([value[1] for value in children(node, "symbol")], ["one", "two"])

    def test_reports_missing_models_without_rewriting(self):
        with tempfile.TemporaryDirectory() as temporary:
            node = parse_sexpr(SAMPLE.read_text())
            record = model_files(node, Path(temporary))[0]
            self.assertFalse(record["exists"])
            self.assertEqual(record["transforms"], children(node, "model")[0][2:])
            variable = parse_sexpr('(footprint "x" (model "${KIPRJMOD}/missing.step"))')
            self.assertEqual(model_files(variable, Path(temporary))[0]["resolved"], str((Path(temporary)/"missing.step").resolve()))

    def test_preserves_nonidentity_transforms_and_legacy_module(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            text = SAMPLE.read_text().replace('(footprint ', '(module ', 1)
            text = text.replace('(offset (xyz 0 0 0))', '(offset (xyz 1 2 3))')
            text = text.replace('(scale (xyz 1 1 1))', '(scale (xyz 2 3 4))')
            text = text.replace('(rotate (xyz 0 0 0))', '(rotate (xyz 10 20 30))')
            source, board = root / 'legacy.kicad_mod', root / 'inspection.kicad_pcb'
            source.write_text(text)
            record = create_board(source, board)
            self.assertIn(text.strip(), board.read_text())
            self.assertEqual(record['models'][0]['transforms'], children(parse_sexpr(text), 'model')[0][2:])

    def test_explicit_missing_cli_does_not_silently_fall_back(self):
        with self.assertRaises(FileNotFoundError):
            discover_cli('nonexistent-headless-qa-kicad-cli.exe')

    def test_rejects_malformed_footprints(self):
        for text in ('(footprint "x"', ')', '(x) (y)', 'atom'):
            with self.assertRaises(ValueError):
                parse_sexpr(text)

    def test_image_and_command_failures_are_saved(self):
        with tempfile.TemporaryDirectory() as temporary:
            evidence = Evidence(temporary, .1)
            svg = Path(temporary) / "invalid.svg"
            svg.write_text("<svg>")
            evidence.image(svg)
            evidence.image(Path(temporary) / "missing.png")
            record = evidence.command(["nonexistent-headless-qa-command"])
            self.assertIsNone(record["exitCode"])
            self.assertEqual([check["outcome"] for check in evidence.data["checks"]], ["FAIL"] * 3)
            import sys
            result = evidence.command([sys.executable, "-c", "import time; time.sleep(2)"])
            self.assertTrue(result["timedOut"])
            atomic_json(Path(temporary) / "sample.json", {"saved": True})
            self.assertFalse((Path(temporary) / "sample.json.tmp").exists())


if __name__ == "__main__":
    unittest.main()
