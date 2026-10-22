"""Exercise matrix parsing, guarded writes and recovery with local temporary files."""
from __future__ import annotations

import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

from matrix import HEADERS, CHECKS, FINDINGS, Matrix, baseline, digest, initialise, summary, update


class MatrixTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.path = self.root / "cases.md"
        self.campaign = self.root / "campaign"
        self.path.write_bytes(self.document())
        initialise(Matrix.read(self.path), self.campaign)

    def tearDown(self):
        self.temporary.cleanup()

    @staticmethod
    def document(ending="\n", bom=False):
        rows = []
        for identifier in ("P001", "P002", "P033"):
            fixed = [identifier, "Mouser", "SamacSys/Mouser", "Example", f"{identifier}-ABC/TR",
                     "0805", "[Open](https://example.test/product)", "Product seed"]
            rows.append("| " + " | ".join(fixed + ["—"] * 9 + ["NOT RUN", "—"]) + " |")
        text = ending.join(["# Existing user matrix", "", "Do not alter this note.", "",
                            "| " + " | ".join(HEADERS) + " |",
                            "| " + " | ".join(["---"] * len(HEADERS)) + " |", *rows,
                            "", "Original trailing notes.", ""])
        return (("\ufeff" if bom else "") + text).encode("utf-8")

    def apply(self, patch, identifier="P001"):
        return update(self.path, self.campaign, identifier, digest(self.path.read_bytes()), patch)

    def test_initialise_keeps_exact_original_and_definitions(self):
        self.assertEqual((self.campaign / "original-matrix.md").read_bytes(), self.path.read_bytes())
        matrix = Matrix.read(self.path)
        self.assertEqual(baseline(matrix, self.campaign)["definition_sha256"], matrix.definition_hash())
        self.assertEqual(summary(matrix)["incomplete_ids"], ["P001", "P002", "P033"])

    def test_updates_one_row_preserving_other_lines(self):
        before = self.path.read_bytes().splitlines(keepends=True)
        result = self.apply({"set": {"Symbol preview": "PASS", "Case status": "PARTIAL"}})
        after = self.path.read_bytes().splitlines(keepends=True)
        changed = [i for i, pair in enumerate(zip(before, after)) if pair[0] != pair[1]]
        self.assertEqual(changed, [Matrix.read(self.path).rows["P001"][0]])
        self.assertEqual(result["row"]["Symbol preview"], "PASS")
        self.assertEqual(len(list((self.campaign / "revisions").glob("*.md"))), 1)

    def test_fixed_fields_cannot_be_patched(self):
        before = self.path.read_bytes()
        with self.assertRaisesRegex(ValueError, "result columns"):
            self.apply({"set": {"Fixed MPN": "SUBSTITUTE"}})
        self.assertEqual(self.path.read_bytes(), before)

    def test_findings_are_append_only_and_pipe_safe(self):
        self.apply({"set": {"Symbol preview": "REVIEW", "Case status": "PARTIAL"},
                    "append_finding": "P001-F01 | Actual: clipped\nManual review required."})
        result = self.apply({"append_finding": "P001-F01 retest: still clipped. [image](evidence/a.png)"})
        cell = result["row"][FINDINGS]
        self.assertIn(r"P001-F01 \| Actual: clipped<br>", cell)
        self.assertIn("<br><br>P001-F01 retest", cell)
        with self.assertRaisesRegex(ValueError, "append-only"):
            self.apply({"set": {FINDINGS: "erase history"}})

    def test_backslash_at_cell_end_does_not_break_table(self):
        self.apply({"append_finding": "Observed path ends with a slash \\"})
        self.assertEqual(len(Matrix.read(self.path).rows), 3)

    def test_stale_hash_is_rejected(self):
        stale = digest(self.path.read_bytes())
        self.apply({"set": {"Case status": "PARTIAL"}})
        before = self.path.read_bytes()
        with self.assertRaisesRegex(ValueError, "Stale"):
            update(self.path, self.campaign, "P001", stale, {"set": {"Download": "PASS"}})
        self.assertEqual(self.path.read_bytes(), before)

    def test_changed_fixed_selection_is_rejected(self):
        self.path.write_bytes(self.path.read_bytes().replace(b"P001-ABC/TR", b"P001-OTHER/TR"))
        with self.assertRaisesRegex(ValueError, "Fixed case"):
            baseline(Matrix.read(self.path), self.campaign)

    def test_changed_row_order_is_rejected(self):
        matrix = Matrix.read(self.path)
        first, second = matrix.rows["P001"][0], matrix.rows["P002"][0]
        matrix.lines[first], matrix.lines[second] = matrix.lines[second], matrix.lines[first]
        self.path.write_text("".join(matrix.lines), encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "Fixed case"):
            baseline(Matrix.read(self.path), self.campaign)

    def test_deleted_row_is_rejected(self):
        matrix = Matrix.read(self.path)
        del matrix.lines[matrix.rows["P002"][0]]
        self.path.write_text("".join(matrix.lines), encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "Fixed case"):
            baseline(Matrix.read(self.path), self.campaign)

    def test_duplicate_id_is_rejected(self):
        self.path.write_bytes(self.path.read_bytes().replace(b"| P002 |", b"| P001 |"))
        with self.assertRaisesRegex(ValueError, "duplicate"):
            Matrix.read(self.path)

    def test_incompatible_header_is_rejected(self):
        self.path.write_bytes(self.path.read_bytes().replace(b"Fixed MPN", b"Product choice"))
        with self.assertRaisesRegex(ValueError, "19-column"):
            Matrix.read(self.path)

    def test_final_status_requires_accounted_checks(self):
        with self.assertRaisesRegex(ValueError, "PARTIAL"):
            self.apply({"set": {"Case status": "PASS", "Download": "PASS"}})
        with self.assertRaisesRegex(ValueError, "PARTIAL"):
            self.apply({"set": {"Case status": "FAIL", "Download": "FAIL"}, "append_finding": "Observed export failure"})

    def test_fail_and_blocked_are_not_fully_inspected(self):
        values = {key: "PASS" for key in CHECKS}
        values.update({"Download": "FAIL", "KiCad 3D": "BLOCKED", "Case status": "FAIL"})
        result = self.apply({"set": values, "append_finding": "Observed partial export; model unavailable for inspection."})
        self.assertEqual(result["closed_rows"], 1)
        self.assertEqual(result["fully_inspected_rows"], 0)
        self.assertEqual(result["cases_with_failures"], ["P001"])
        self.assertEqual(result["cases_with_blockers"], ["P001"])

    def test_final_status_precedence(self):
        values = {key: "PASS" for key in CHECKS}
        values.update({"Symbol preview": "FAIL", "KiCad 3D": "REVIEW", "Case status": "REVIEW"})
        with self.assertRaisesRegex(ValueError, "must be FAIL"):
            self.apply({"set": values, "append_finding": "Two observed findings"})

    def test_unavailable_checks_need_reason(self):
        values = {key: "PASS" for key in CHECKS}
        values.update({"KiCad 3D": "N/A", "Case status": "PASS"})
        with self.assertRaisesRegex(ValueError, "explicit reason"):
            self.apply({"set": values})
        result = self.apply({"set": values, "append_finding": "Source explicitly lists no 3D asset."})
        self.assertEqual(result["fully_inspected_rows"], 1)

    def test_legacy_fail_with_blanks_remains_incomplete(self):
        self.path.write_bytes(self.path.read_bytes().replace(b"| NOT RUN |", b"| FAIL |", 1))
        counts = summary(Matrix.read(self.path))
        self.assertIn("P001", counts["incomplete_ids"])
        self.assertEqual(counts["closed_rows"], 0)

    def test_preexisting_lock_is_not_removed_or_overridden(self):
        lock = self.campaign / ".matrix.lock"
        lock.write_text("other writer", encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "locked"):
            self.apply({"set": {"Case status": "PARTIAL"}})
        self.assertEqual(lock.read_text(), "other writer")

    def test_cannot_reset_campaign(self):
        with self.assertRaises(FileExistsError):
            initialise(Matrix.read(self.path), self.campaign)

    def test_tampered_backup_is_rejected(self):
        (self.campaign / "original-matrix.md").write_text("changed", encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "backup"):
            baseline(Matrix.read(self.path), self.campaign)

    def test_bom_and_crlf_are_preserved(self):
        path = self.root / "crlf.md"
        path.write_bytes(self.document("\r\n", bom=True))
        campaign = self.root / "crlf-campaign"
        initialise(Matrix.read(path), campaign)
        before = path.read_bytes().splitlines(keepends=True)
        update(path, campaign, "P001", digest(path.read_bytes()), {"set": {"Case status": "PARTIAL"}})
        after = path.read_bytes().splitlines(keepends=True)
        self.assertTrue(path.read_bytes().startswith(b"\xef\xbb\xbf"))
        self.assertTrue(all(line.endswith(b"\r\n") for line in after))
        index = Matrix.read(path).rows["P001"][0]
        self.assertEqual(before[:index], after[:index])
        self.assertEqual(before[index + 1:], after[index + 1:])

    def test_checkpoint_cli(self):
        command = [sys.executable, str(Path(__file__).with_name("matrix.py")), "checkpoint",
                   "--matrix", str(self.path), "--campaign", str(self.campaign),
                   "--state", "PAUSED", "--id", "P033", "--step", "inspect footprint",
                   "--run-id", "P033-a1-example"]
        completed = subprocess.run(command, capture_output=True, text=True, timeout=10, check=True)
        checkpoint = json.loads(completed.stdout)
        self.assertEqual(checkpoint["state"], "PAUSED")
        self.assertEqual(checkpoint["case_id"], "P033")
        self.assertEqual(json.loads((self.campaign / "checkpoint.json").read_text()), checkpoint)


if __name__ == "__main__":
    unittest.main()
