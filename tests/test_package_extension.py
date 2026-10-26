"""Exercise release artifacts against isolated Git repositories and real ZIP decoding."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
import zipfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from package_extension import build_package  # noqa: E402


class PackageTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.output = self.root / "dist"
        self.git("init", "--quiet")
        self.manifest = {
            "manifest_version": 3, "version": "1.1.0",
            "background": {"service_worker": "src/main.js", "scripts": ["src/main.js"]},
            "action": {"default_popup": "src/popup.html", "default_icon": {"16": "icons/16.png"}},
            "icons": {"16": "icons/16.png"},
            "options_ui": {"page": "src/popup.html"},
            "content_scripts": [{"js": ["src/content.js"]}]
        }
        self.write_json("manifest.json", self.manifest)
        self.write_json("package.json", {"name": "easy-ecad-downloader", "version": "1.1.0"})
        self.write_json("package-lock.json", {"version": "1.1.0", "packages": {"": {"version": "1.1.0"}}})
        self.write("LICENSE", "Example license\r\n")
        self.write("CHANGELOG.md", "# Changelog\n\n## 1.1.0\n\n### Added\n\n"
                   "- Current change; [design](systemDesign.md#details).\n"
                   "- [External](https://example.test/reference).\n\n## 1.0.0\n\n- Old change.\n")
        self.write("src/main.js", 'import { value } from "./module.js";\r\nvoid value;\r\n')
        self.write("src/module.js", "export const value = 1;\n")
        self.write("src/content.js", "void 0;\n")
        self.write("src/popup.html", '<link href="popup.css"><script src="main.js"></script>')
        self.write("src/popup.css", 'body { background: url("assets/background.png"); }')
        self.write("src/assets/background.png", b"binary\r\nasset")
        self.write("icons/16.png", b"icon bytes")
        for name in ["README.md", "INSTALL.txt", "tests/example.js", ".env", "node_modules/example.js",
                     "TEST-MATRIX.MD", "qa-run/results.json", "src/debug.log", "src/.local.js"]:
            self.write(name, "local developer data")
        self.git("add", ".")
        self.write("src/untracked.js", "local unpublished source")

    def git(self, *args):
        return subprocess.check_output(["git", *args], cwd=self.root, stderr=subprocess.PIPE).decode().strip()

    def write(self, name, value):
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(value if isinstance(value, bytes) else value.encode())

    def write_json(self, name, value):
        self.write(name, json.dumps(value))

    def build(self, **kwargs):
        return build_package(self.root, self.output, **kwargs)

    def test_archive_contains_only_runtime_files_at_root_and_valid_checksum(self):
        path = self.build(tag="v1.1.0")
        self.assertEqual(path.name, "easy-ecad-downloader-1.1.0.zip")
        with zipfile.ZipFile(path) as archive:
            self.assertEqual(set(archive.namelist()), {
                "manifest.json", "LICENSE", "src/main.js", "src/module.js", "src/content.js",
                "src/popup.html", "src/popup.css", "src/assets/background.png", "icons/16.png"
            })
            self.assertIsNone(archive.testzip())
            self.assertEqual(json.loads(archive.read("manifest.json"))["version"], "1.1.0")
            self.assertEqual(archive.read("src/assets/background.png"), b"binary\r\nasset")
            self.assertNotIn(b"\r\n", archive.read("src/main.js"))
        checksum = path.with_suffix(".zip.sha256").read_text().strip().split()
        self.assertEqual(checksum, [hashlib.sha256(path.read_bytes()).hexdigest(), path.name])

    def test_repeated_packaging_and_checkout_newlines_produce_identical_bytes(self):
        first = self.build().read_bytes()
        self.write("src/main.js", (self.root / "src/main.js").read_bytes().replace(b"\r\n", b"\n"))
        self.assertEqual(self.build().read_bytes(), first)

    def test_notes_use_only_current_version_and_tagged_document_links(self):
        self.build(repository="example/project")
        notes = (self.output / "release-notes.md").read_text()
        self.assertIn("Current change", notes)
        self.assertNotIn("Old change", notes)
        self.assertIn("https://github.com/example/project/blob/v1.1.0/systemDesign.md#details", notes)
        self.assertIn("https://example.test/reference", notes)

    def test_tag_mismatch_leaves_no_output(self):
        with self.assertRaisesRegex(ValueError, "Release tag must be v1.1.0"):
            self.build(tag="v1.2.0")
        self.assertFalse(self.output.exists())

    def test_each_package_version_must_match_manifest(self):
        for name, nested in [("package.json", False), ("package-lock.json", False),
                             ("package-lock.json", True)]:
            with self.subTest(name=name, nested=nested):
                path = self.root / name
                original = path.read_bytes()
                data = json.loads(original)
                target = data["packages"][""] if nested else data
                target["version"] = "1.0.0"
                self.write_json(name, data)
                with self.assertRaisesRegex(ValueError, "versions must match"):
                    self.build()
                path.write_bytes(original)

    def test_missing_manifest_and_transitive_resources_stop_packaging(self):
        for name in ["src/main.js", "src/module.js", "src/popup.css", "src/assets/background.png"]:
            with self.subTest(name=name):
                self.git("rm", "--cached", name)
                with self.assertRaisesRegex(ValueError, "Missing"):
                    self.build()
                self.git("add", name)
        self.assertFalse(self.output.exists())

    def test_missing_or_duplicate_changelog_version_stops_packaging(self):
        for changelog in ["## 1.0.0\nOld only\n", "## 1.1.0\nOne\n## 1.1.0\nTwo\n", "## 1.1.0\n"]:
            with self.subTest(changelog=changelog):
                self.write("CHANGELOG.md", changelog)
                with self.assertRaisesRegex(ValueError, "changelog|CHANGELOG"):
                    self.build()
        self.assertFalse(self.output.exists())

    def test_git_symlink_entries_are_rejected(self):
        blob = self.git("hash-object", "-w", "src/main.js")
        self.git("update-index", "--cacheinfo", f"120000,{blob},src/main.js")
        with self.assertRaisesRegex(ValueError, "regular, resolved Git file"):
            self.build()

    def test_missing_tracked_runtime_file_fails_without_replacing_previous_archive(self):
        path = self.build()
        original = path.read_bytes()
        (self.root / "src/main.js").unlink()
        with self.assertRaises(FileNotFoundError):
            self.build()
        self.assertEqual(path.read_bytes(), original)


if __name__ == "__main__":
    unittest.main()
