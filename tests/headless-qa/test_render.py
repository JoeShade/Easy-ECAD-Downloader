"""Check fixture geometry, immutable downloads and renderer failure accounting.

Native rendering is mocked so these regressions run with Python alone.
"""
import tempfile
import unittest
from pathlib import Path

from fixture import bounds, children, create_board, model_files, normalize_legacy_arcs, parse_sexpr
from render_support import Evidence, atomic_json, discover_cli, hashes, redact, verified_download_paths
from model_inspection import associate_models, derived_model_fixture, footprint_views, model_inventory

HERE = Path(__file__).resolve().parent
SAMPLE = HERE / "fixtures" / "known-good" / "fixture.pretty" / "qa_block.kicad_mod"


class FixtureTests(unittest.TestCase):
    def test_inventory_rechecks_current_bytes_before_authorizing_browser_assets(self):
        import copy
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            asset = root / 'part.kicad_mod'
            asset.write_bytes(b'original')
            report = {'schemaVersion': 2, 'stages': {'downloads': {'assets': [
                {'relativePath': asset.name, 'verified': True, 'size': asset.stat().st_size,
                 'sha256': hashes(root)[asset.name]},
                {'relativePath': None, 'verified': False}
            ]}}}
            self.assertEqual(verified_download_paths(report, root), {asset.name})
            asset.write_bytes(b'modified')
            with self.assertRaisesRegex(ValueError, 'size or SHA-256'):
                verified_download_paths(report, root)
            asset.write_bytes(b'original')
            for change in ({'relativePath': '../part.kicad_mod'}, {'relativePath': 'C:/part.kicad_mod'},
                           {'relativePath': 'nested/../part.kicad_mod'}, {'size': True},
                           {'verified': 'true'}, {'sha256': 'invalid'}):
                malformed = copy.deepcopy(report)
                malformed['stages']['downloads']['assets'][0].update(change)
                with self.subTest(change=change), self.assertRaises(ValueError):
                    verified_download_paths(malformed, root)
            report['schemaVersion'] = 1
            with self.assertRaisesRegex(ValueError, 'schema 2'):
                verified_download_paths(report, root)

    def test_malformed_symbol_entry_retains_other_planned_library_inspections(self):
        from render import plan_inspections
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / 'downloads'
            source.mkdir()
            (source / 'a.kicad_sym').write_text('(kicad_symbol_lib (symbol))')
            (source / 'b.kicad_sym').write_text('(kicad_symbol_lib (symbol "valid"))')
            evidence = Evidence(root / 'renders', 1)
            plan_inspections(evidence, source)
            self.assertEqual([item['id'] for item in evidence.data['coverage']['inspections']],
                             ['symbol-0.unparsed', 'symbol-1.0'])

    def test_malformed_model_reference_retains_coverage_and_cannot_write_fixture(self):
        from render import plan_inspections
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / 'downloads'
            source.mkdir()
            malformed = source / 'bad.kicad_mod'
            malformed.write_text('(footprint "bad" (fp_rect (start 0 0) (end 1 1)) (model))')
            evidence = Evidence(root / 'renders', 1)
            plan_inspections(evidence, source)
            self.assertEqual(evidence.data['coverage']['expected'], 6)
            board = root / 'bad.kicad_pcb'
            with self.assertRaisesRegex(ValueError, 'model reference'):
                create_board(malformed, board)
            self.assertFalse(board.exists())

    def test_unnamed_footprint_cannot_write_fixture(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source, board = root / 'unnamed.kicad_mod', root / 'unnamed.kicad_pcb'
            for name in ('', '""'):
                source.write_text(f'(footprint {name} (fp_rect (start 0 0) (end 1 1)))')
                with self.subTest(name=name), self.assertRaisesRegex(ValueError, 'footprint name'):
                    create_board(source, board)
                self.assertFalse(board.exists())

    def test_render_preserves_preflight_original_hash_baseline(self):
        from unittest.mock import patch
        from render import render_assets
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / 'downloads'
            source.mkdir()
            original = source / 'part.kicad_mod'
            original.write_text('(footprint "before")')
            evidence = Evidence(root / 'renders', 1)
            before = hashes(source)
            evidence.data['inputHashes'] = before
            original.write_text('(footprint "changed")')
            with patch('render.calibrate') as calibration, self.assertRaisesRegex(ValueError, 'changed before rendering'):
                render_assets(evidence, 'fake-cli', source, root / 'inspection')
            calibration.assert_not_called()
            self.assertEqual(evidence.data['inputHashes'], before)
            self.assertFalse((root / 'inspection/assets').exists())

    def test_nonfinite_timeouts_are_rejected_before_creating_evidence(self):
        from unittest.mock import patch
        from render import main
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary) / 'renders'
            for timeout in ('nan', 'inf', '-inf'):
                with self.subTest(timeout=timeout), patch('sys.argv', [
                        'render.py', '--preflight', '--output', str(output), '--timeout=' + timeout]), \
                        patch('sys.stderr'), self.assertRaises(SystemExit) as result:
                    main()
                self.assertEqual(result.exception.code, 2)
                self.assertFalse(output.exists())

    def test_circle_bounds_include_full_radius(self):
        result = bounds(parse_sexpr('(footprint "circle" (fp_circle (center 0 0) (end 10 0)))'), margin=False)
        self.assertLessEqual(result[0], -10)
        self.assertLessEqual(result[1], -10)
        self.assertGreaterEqual(result[2], 10)
        self.assertGreaterEqual(result[3], 10)

    def test_arc_bounds_include_midpoint_and_sweep(self):
        result = bounds(parse_sexpr('(footprint "arc" (fp_arc (start 10 0) (mid 0 10) (end -10 0)))'))
        self.assertLessEqual(result[0], -10)
        self.assertGreaterEqual(result[2], 10)
        self.assertGreaterEqual(result[3], 10)

    def test_translated_circle_and_arc_axis_extrema(self):
        result = bounds(parse_sexpr('(footprint "circle" (fp_circle (center 20 30) (end 30 30)))'), margin=False)
        self.assertEqual(result, [10, 20, 30, 40])
        result = bounds(parse_sexpr('(footprint "arc" (fp_arc (start 6 8) (mid 10 0) (end 6 -8)))'), margin=False)
        self.assertAlmostEqual(result[2], 10)
        self.assertAlmostEqual(result[1], -8)
        self.assertAlmostEqual(result[3], 8)

    def test_legacy_arc_normalization_preserves_both_directions_and_major_sweeps(self):
        import math
        for degrees in (90, -90, 270, -270):
            with self.subTest(degrees=degrees):
                source = f'(module "arc" (fp_arc (start 10 20) (end 12 20) (angle {degrees}) (layer F.SilkS) (width 0.12)))'
                normalized, changes = normalize_legacy_arcs(source)
                arc = children(parse_sexpr(normalized), 'fp_arc')[0]
                self.assertEqual(children(arc, 'angle'), [])
                self.assertEqual(children(arc, 'layer'), [['layer', 'F.SilkS']])
                self.assertEqual(children(arc, 'width'), [['width', '0.12']])
                for field, fraction in (('start', 0), ('mid', .5), ('end', 1)):
                    angle = math.radians(degrees)*fraction
                    expected = (10+2*math.cos(angle), 20+2*math.sin(angle))
                    actual = tuple(map(float, children(arc, field)[0][1:]))
                    for result, target in zip(actual, expected):
                        self.assertAlmostEqual(result, target, places=9)
                for original_bound, fixture_bound in zip(bounds(parse_sexpr(source), margin=False),
                                                          bounds(parse_sexpr(normalized), margin=False)):
                    self.assertAlmostEqual(original_bound, fixture_bound, places=8)
                self.assertEqual(changes[0]['kind'], 'legacy-arc-syntax')
                self.assertFalse(changes[0]['geometryRepaired'])

    def test_legacy_and_modern_full_circle_arcs_have_the_same_bounds(self):
        for degrees in (360, -360):
            source = f'(module "full" (fp_arc (start 20 30) (end 30 30) (angle {degrees}) (layer F.SilkS) (width 0.1)))'
            normalized, changes = normalize_legacy_arcs(source)
            self.assertEqual(len(children(parse_sexpr(normalized), 'fp_arc')), 1)
            self.assertEqual(bounds(parse_sexpr(source), margin=False), [10, 20, 30, 40])
            self.assertEqual(bounds(parse_sexpr(normalized), margin=False), [10, 20, 30, 40])
            self.assertEqual(len(changes), 1)

    def test_zero_radius_arcs_remain_visible_in_fixture_metadata_and_are_not_repaired(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / 'point.kicad_mod'
            original = '(module "point" (fp_arc (start 2.95 3.92) (end 2.95 3.92) (angle -359) (layer F.SilkS) (width 0.25)))'
            source.write_text(original)
            record = create_board(source, root / 'fixture.kicad_pcb')
            self.assertEqual(source.read_text(), original)
            self.assertFalse(record['footprintEmbeddedVerbatim'])
            self.assertTrue(record['fixtureNormalizations'][0]['zeroRadius'])
            self.assertEqual(record['geometryObservations'], [
                {'kind': 'zero-radius-arc', 'point': [2.95, 3.92], 'geometryRepaired': False}])
            footprint = children(parse_sexpr((root / 'fixture.kicad_pcb').read_text()), 'module')[0]
            arc = children(footprint, 'fp_arc')[0]
            self.assertEqual(len(children(footprint, 'fp_arc')), 1)
            self.assertEqual(bounds(footprint, margin=False), [2.95, 3.92, 2.95, 3.92])
            self.assertEqual([children(arc, key)[0][1:] for key in ('start', 'mid', 'end')],
                             [['2.9500000000', '3.9200000000']]*3)
            modern = '(footprint "point" (version 20240108) (layer F.Cu) (fp_arc (start 2.95 3.92) (mid 2.95 3.92) (end 2.95 3.92) (layer F.SilkS) (width 0.25)))'
            source.write_text(modern)
            modern_record = create_board(source, root / 'modern.kicad_pcb')
            self.assertTrue(modern_record['footprintEmbeddedVerbatim'])
            self.assertEqual(modern_record['fixtureNormalizations'], [])
            self.assertEqual(modern_record['geometryObservations'], record['geometryObservations'])

    def test_normalization_does_not_repair_legacy_arcs_in_invalid_modern_sources(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source, board = root / 'bad.kicad_mod', root / 'fixture.kicad_pcb'
            original = '(footprint "bad" (version 20240108) (fp_arc (start 0 0) (end 1 0) (angle 90)))'
            source.write_text(original)
            with self.assertRaisesRegex(ValueError, 'conflicts with modern'):
                create_board(source, board)
            self.assertFalse(board.exists())
            self.assertEqual(source.read_text(), original)

    def test_arc_normalization_changes_only_legacy_arc_geometry_tokens(self):
        model = '(model "../models/(fp_arc literal).wrl" (offset (xyz 1.2 -3.4 5.6)) (scale (xyz 2 3 4)) (rotate (xyz 10 20 30)))'
        modern = '(fp_arc (start 1 0) (mid 0 1) (end -1 0) (stroke (width 0.2) (type solid)) (layer "F.Fab"))'
        source = f'(module "mixed" (fp_text user "(fp_arc is just text)" (at 0 0) (layer F.Fab)) {modern} (fp_arc (start 0 0) (end 1 0) (angle -90) (layer F.SilkS) (width 0.1)) {model})'
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            footprint, board = root / 'mixed.kicad_mod', root / 'fixture.kicad_pcb'
            footprint.write_text(source)
            record = create_board(footprint, board)
            output = board.read_text()
            self.assertIn(model, output)
            self.assertIn(modern, output)
            self.assertIn('(fp_text user "(fp_arc is just text)"', output)
            self.assertEqual(footprint.read_text(), source)
            self.assertEqual(len(record['fixtureNormalizations']), 1)
            self.assertEqual(record['models'][0]['transforms'], children(parse_sexpr(source), 'model')[0][2:])
        self.assertEqual(normalize_legacy_arcs(f'(footprint "modern" {modern} {model})'),
                         (f'(footprint "modern" {modern} {model})', []))

    def test_rotated_pad_extents_are_translated(self):
        result = bounds(parse_sexpr('(footprint "pad" (pad "1" smd rect (at 10 20 90) (size 8 2) (layers "F.Cu")))'), margin=False)
        for actual, expected in zip(result, [9, 16, 11, 24]):
            self.assertAlmostEqual(actual, expected)

    def test_geometry_rejects_degenerate_nonfinite_and_unsupported_primitives(self):
        for shape in ['(fp_circle (center 0 0) (end 0 0))',
                      '(fp_arc (start 0 0) (mid 1 0) (end 2 0))',
                      '(fp_arc (start 0 0) (end 2 0))',
                      '(fp_circle (center nan 0) (end 10 0))',
                      '(pad "1" smd rect (at 0 0) (size inf 2))',
                      '(fp_unsupported (start 0 0) (end 1 1))']:
            with self.subTest(shape=shape), self.assertRaisesRegex(ValueError, 'Degenerate|Malformed|Missing|Unsupported'):
                bounds(parse_sexpr(f'(footprint "bad" {shape})'))

    def test_backside_layers_and_curved_fixture_outline_are_recorded(self):
        back = HERE / 'fixtures/known-good/fixture.pretty/qa_back.kicad_mod'
        views = footprint_views(parse_sexpr(back.read_text()))
        self.assertEqual(views['back-copper-silk'], 'B.Cu,B.SilkS')
        self.assertEqual(views['back-fabrication'], 'B.Fab')
        self.assertEqual(views['back-courtyard'], 'B.CrtYd,B.Fab')
        with tempfile.TemporaryDirectory() as temporary:
            curved = HERE / 'fixtures/known-good/fixture.pretty/qa_curved.kicad_mod'
            board = Path(temporary) / 'curved.kicad_pcb'
            record = create_board(curved, board)
            self.assertTrue(record['footprintEmbeddedVerbatim'])
            self.assertLessEqual(record['outline'][0], -10)
            self.assertGreaterEqual(record['outline'][2], 30)
            self.assertGreaterEqual(record['outline'][3], 40)
            self.assertEqual(len(children(parse_sexpr(board.read_text()), 'gr_rect')), 1)

    def test_inventory_accounts_for_step_wrl_multiple_footprints_and_missing_reference(self):
        import shutil
        with tempfile.TemporaryDirectory() as temporary:
            source = Path(temporary) / 'downloads'
            shutil.copytree(SAMPLE.parent.parent, source)
            orphan = source / 'fixture.3dshapes/orphan.wrl'
            orphan.write_text('#VRML V2.0 utf8\nShape { geometry Box { size 1 1 1 } }')
            missing = source / 'fixture.pretty/missing.kicad_mod'
            missing.write_text(SAMPLE.read_text().replace('qa_block.wrl', 'missing.wrl'))
            inventory = model_inventory(source, hashes(source))
            missing_refs = associate_models(inventory, sorted(source.rglob('*.kicad_mod')), source)
            self.assertEqual({record['relativePath'] for record in inventory}, {
                'fixture.3dshapes/qa_block.step', 'fixture.3dshapes/qa_block.wrl', 'fixture.3dshapes/orphan.wrl'})
            by_name = {Path(record['relativePath']).name: record for record in inventory}
            self.assertEqual(len(by_name['qa_block.wrl']['references']), 2)
            self.assertEqual(by_name['qa_block.step']['references'], [])
            self.assertEqual(by_name['orphan.wrl']['references'], [])
            self.assertEqual(missing_refs[0]['reference'], '../fixture.3dshapes/missing.wrl')
            before = hashes(source)
            derived = derived_model_fixture(source / 'fixture.3dshapes/qa_block.step', Path(temporary) / 'derived')
            self.assertEqual(derived['association'], 'none inferred')
            self.assertEqual(derived['transforms'], [['offset', ['xyz', '0', '0', '0']], ['scale', ['xyz', '1', '1', '1']], ['rotate', ['xyz', '0', '0', '0']]])
            self.assertEqual(before, hashes(source))

    def test_absolute_original_model_reference_is_associated_without_rewriting(self):
        import shutil
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source, copied = root / 'downloads', root / 'copied'
            shutil.copytree(SAMPLE.parent.parent, source)
            absolute = (source / 'fixture.3dshapes/qa_block.wrl').as_posix()
            footprint = source / 'fixture.pretty/qa_block.kicad_mod'
            text = footprint.read_text().replace('../fixture.3dshapes/qa_block.wrl', absolute)
            footprint.write_text(text)
            shutil.copytree(source, copied)
            inventory = model_inventory(source, hashes(source))
            associate_models(inventory, [copied / 'fixture.pretty/qa_block.kicad_mod'], copied, original=source)
            record = next(model for model in inventory if model['format'] == 'wrl')
            self.assertEqual(record['references'][0]['reference'], absolute)
            self.assertEqual(footprint.read_text(), text)

    def test_renderer_does_not_drop_unreferenced_models_when_commands_fail(self):
        import shutil
        from unittest.mock import patch
        from render import render_assets
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / 'downloads'
            shutil.copytree(SAMPLE.parent.parent, source)
            evidence = Evidence(root / 'renders', 1)
            with patch('render.calibrate', return_value=True), patch.object(evidence, 'command', return_value={'exitCode': 1}), \
                 patch('render.pcb_view', return_value={'exitCode': 1, 'imageDecoded': False}):
                render_assets(evidence, 'fake-kicad-cli', source, root / 'inspection')
            self.assertEqual(len(evidence.data['models']), 2)
            records = {Path(record['relativePath']).suffix: record for record in evidence.data['models']}
            self.assertEqual(records['.wrl']['exercisedBy'][0]['kind'], 'original-assembly')
            self.assertEqual(records['.step']['exercisedBy'][0]['kind'], 'derived-model-inspection')
            self.assertTrue(all(record['outcome'] == 'FAIL' for record in records.values()))
            self.assertTrue(all(record['geometryAppearance'] == 'UNVERIFIED' for record in records.values()))
            self.assertGreater(len(evidence.data['coverage']['outstanding']), 0)
            self.assertFalse(evidence.data['coverage']['fullyInspected'])

    def test_malformed_geometry_has_a_recorded_failure_and_closed_board_is_not_written(self):
        from unittest.mock import patch
        from render import render_assets
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / 'downloads'
            source.mkdir()
            footprint = source / 'bad.kicad_mod'
            footprint.write_text('(footprint "bad" (fp_circle (center 0 0) (end 0 0)))')
            evidence = Evidence(root / 'renders', 1)
            with patch('render.calibrate', return_value=True), patch.object(evidence, 'command', return_value={'exitCode': 1}):
                render_assets(evidence, 'fake-kicad-cli', source, root / 'inspection')
            failure = next(check for check in evidence.data['checks'] if check['establishes'] == 'Footprint inspection failed')
            self.assertEqual(failure['outcome'], 'FAIL')
            self.assertIn('Degenerate circle', failure['error'])
            self.assertFalse((root / 'inspection/assets/qa-inspection-0.kicad_pcb').exists())

    def test_blocked_cli_retains_planned_symbols_footprints_and_models(self):
        import shutil
        from render import plan_inspections, update_coverage
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / 'downloads'
            shutil.copytree(SAMPLE.parent.parent, source)
            evidence = Evidence(root / 'renders', 1)
            evidence.data['inputHashes'] = hashes(source)
            evidence.data['models'] = model_inventory(source, evidence.data['inputHashes'])
            plan_inspections(evidence, source)
            evidence.check('BLOCKED', 'Synthetic missing CLI', category='environment')
            update_coverage(evidence)
            coverage = evidence.data['coverage']
            self.assertGreater(coverage['expected'], 20)
            self.assertEqual(coverage['attempted'], 0)
            self.assertEqual(coverage['produced'], 0)
            self.assertEqual(len(coverage['outstanding']), coverage['expected'])
            self.assertEqual(len(evidence.data['models']), 2)
            self.assertTrue(all(model['outcome'] == 'NOT_RUN' for model in evidence.data['models']))

    def test_unsupported_fixture_geometry_is_a_harness_blocker(self):
        from unittest.mock import patch
        from render import render_assets
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / 'downloads'
            source.mkdir()
            (source / 'future.kicad_mod').write_text('(footprint "future" (fp_unsupported (start 0 0) (end 1 1)))')
            evidence = Evidence(root / 'renders', 1)
            with patch('render.calibrate', return_value=True), patch.object(evidence, 'command', return_value={'exitCode': 1}):
                render_assets(evidence, 'fake-kicad-cli', source, root / 'inspection')
            failure = next(check for check in evidence.data['checks'] if check['establishes'] == 'Footprint inspection failed')
            self.assertEqual(failure['outcome'], 'BLOCKED')
            self.assertEqual(failure['category'], 'harness')

    def test_python_evidence_redaction_is_structural(self):
        import json
        original = {'url': 'https://example.test/?token=covered-secret&PHPSESSID=covered-session',
                    'malformedUrl': 'https://[broken?token=covered-malformed',
                    'email': 'covered-user@example.test',
                    'message': 'Cookie: PHPSESSID=covered-cookie', 'nested': [None, 3, {'password': 'covered-pass', 'mpn': 'ABC/TR'}]}
        before = json.dumps(original)
        self.assertNotIn('covered-', json.dumps(redact(original)))
        self.assertEqual(json.dumps(original), before)
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
            del del_after[board.relative_to(root / "assets").as_posix()]
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
            self.assertEqual([check["outcome"] for check in evidence.data["checks"]], ["FAIL", "FAIL", "BLOCKED"])
            import sys
            result = evidence.command([sys.executable, "-c", "import time; time.sleep(2)"])
            self.assertTrue(result["timedOut"])
            self.assertEqual(evidence.data['checks'][-1]['category'], 'harness')
            evidence.command([sys.executable, '-c', 'raise SystemExit(1)'])
            self.assertEqual(evidence.data['checks'][-1]['cause'], 'unknown')
            atomic_json(Path(temporary) / "sample.json", {"saved": True})
            self.assertFalse((Path(temporary) / "sample.json.tmp").exists())


if __name__ == "__main__":
    unittest.main()
