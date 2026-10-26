"""Build and verify the unpacked-extension ZIP, checksum and versioned release notes."""
from __future__ import annotations

import argparse
import hashlib
from html.parser import HTMLParser
import io
import json
from pathlib import Path, PurePosixPath
import posixpath
import re
import subprocess
import tempfile
from urllib.parse import urlsplit
import zipfile


ROOT = Path(__file__).resolve().parents[1]
PACKAGE_NAME = "easy-ecad-downloader"
REPOSITORY = "JoeShade/Easy-ECAD-Downloader"
TEXT_SUFFIXES = {".js", ".html", ".css", ".json"}


def release_version(root: Path, tag: str | None) -> str:
    manifest = json.loads((root / "manifest.json").read_text(encoding="utf-8"))
    package = json.loads((root / "package.json").read_text(encoding="utf-8"))
    lock = json.loads((root / "package-lock.json").read_text(encoding="utf-8"))
    version = manifest.get("version", "")
    if not re.fullmatch(r"(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)", version):
        raise ValueError("The manifest version must use major.minor.patch.")
    if any(int(part) > 65535 for part in version.split(".")) or version == "0.0.0":
        raise ValueError("The manifest version is outside browser extension limits.")
    if manifest.get("manifest_version") != 3 or package.get("name") != PACKAGE_NAME:
        raise ValueError("Expected the Easy ECAD Manifest V3 package.")
    versions = [package.get("version"), lock.get("version"),
                lock.get("packages", {}).get("", {}).get("version")]
    if any(value != version for value in versions):
        raise ValueError("Manifest, package and lockfile versions must match.")
    if tag is not None and tag != f"v{version}":
        raise ValueError(f"Release tag must be v{version}; got {tag}.")
    return version


def allowed_file(name: str) -> bool:
    parts = PurePosixPath(name).parts
    if not parts or any(part.startswith(".") for part in parts):
        return False
    if name in {"manifest.json", "LICENSE"}:
        return True
    suffix = PurePosixPath(name).suffix
    return (parts[0] == "src" and suffix in {".js", ".html", ".css", ".png"}) or (
        parts[0] == "icons" and suffix == ".png")


def runtime_files(root: Path) -> dict[str, bytes]:
    # Git's index supplies the candidate names; untracked local files never ship.
    # Read working-tree bytes so local packaging includes edits to tracked source.
    entries = subprocess.check_output(
        ["git", "ls-files", "--stage", "-z"], cwd=root
    ).decode("utf-8").split("\0")
    files = {}
    for entry in filter(None, entries):
        metadata, name = entry.split("\t", 1)
        if not allowed_file(name):
            continue
        mode, _, stage = metadata.split()
        if mode not in {"100644", "100755"} or stage != "0":
            raise ValueError(f"Runtime path must be a regular, resolved Git file: {name}")
        source = root / name
        if source.is_symlink() or not source.resolve().is_relative_to(root.resolve()):
            raise ValueError(f"Runtime path escapes the checkout or is a symlink: {name}")
        content = source.read_bytes()
        # Fixed metadata and LF text make the archive independent of checkout
        # timestamps and Windows Git newline conversion; binary assets stay intact.
        if name == "LICENSE" or source.suffix in TEXT_SUFFIXES:
            content = content.replace(b"\r\n", b"\n")
        files[name] = content
    if not {"manifest.json", "LICENSE"}.issubset(files):
        raise ValueError("Tracked manifest.json and LICENSE are required.")
    return dict(sorted(files.items()))


class HtmlReferences(HTMLParser):
    def __init__(self):
        super().__init__()
        self.references = []

    def handle_starttag(self, tag, attrs):
        self.references.extend(value for key, value in attrs
                               if key in {"src", "href"} and value)


def check_reference(files: dict[str, bytes], owner: str, reference: str) -> None:
    parsed = urlsplit(reference)
    if parsed.scheme or parsed.netloc or not parsed.path:
        return
    target = posixpath.normpath(posixpath.join(posixpath.dirname(owner), parsed.path))
    if "\\" in reference or target not in files:
        raise ValueError(f"Missing packaged reference: {owner} -> {reference}")


def verify_runtime(files: dict[str, bytes]) -> None:
    manifest = json.loads(files["manifest.json"])
    background = manifest.get("background", {})
    action = manifest.get("action", {})
    references = [background.get("service_worker"), action.get("default_popup"),
                  manifest.get("options_ui", {}).get("page")]
    references.extend(background.get("scripts", []))
    for icons in [manifest.get("icons", {}), action.get("default_icon", {})]:
        references.extend(icons.values() if isinstance(icons, dict) else [icons])
    for script in manifest.get("content_scripts", []):
        references.extend(script.get("js", []) + script.get("css", []))
    for reference in filter(None, references):
        if reference not in files:
            raise ValueError(f"Missing manifest entrypoint or asset: {reference}")
    # These cover the extension's static ES modules, HTML and CSS resources.
    # Remote provider data and generated data/blob URLs are runtime concerns.
    for name, content in files.items():
        suffix = PurePosixPath(name).suffix
        if suffix not in {".js", ".html", ".css"}:
            continue
        text = content.decode("utf-8")
        if suffix == ".js":
            references = re.findall(r'''(?:\bfrom\s+|\bimport\s*\(\s*|\bimport\s+)["']([^"']+)["']''', text)
        elif suffix == ".html":
            parser = HtmlReferences()
            parser.feed(text)
            references = parser.references
        else:
            references = [value.strip(" \t\r\n\"'") for value in re.findall(r"url\(([^)]+)\)", text)]
        for reference in references:
            check_reference(files, name, reference)


def release_notes(root: Path, version: str, repository: str) -> str:
    if not re.fullmatch(r"[A-Za-z0-9_-]+/[A-Za-z0-9_.-]+", repository):
        raise ValueError("Repository must use owner/name syntax.")
    changelog = (root / "CHANGELOG.md").read_text(encoding="utf-8")
    headings = list(re.finditer(r"^## (.+)$", changelog, re.MULTILINE))
    matches = [i for i, heading in enumerate(headings) if heading[1].strip() == version]
    if len(matches) != 1:
        raise ValueError(f"Expected exactly one CHANGELOG.md section for {version}.")
    index = matches[0]
    end = headings[index + 1].start() if index + 1 < len(headings) else len(changelog)
    notes = changelog[headings[index].end():end].strip()
    if not notes:
        raise ValueError(f"The changelog section for {version} is empty.")

    def tag_link(match):
        target = match[1]
        if urlsplit(target).scheme or target.startswith(("#", "//")):
            return match[0]
        return f"](https://github.com/{repository}/blob/v{version}/{target})"

    return re.sub(r"\]\(([^\s)]+)\)", tag_link, notes) + "\n"


def write_output(path: Path, content: bytes) -> None:
    # Publish each completed file atomically so an interrupted local write cannot
    # replace an earlier valid archive with partial bytes.
    with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as temporary:
        temporary.write(content)
        temporary_path = Path(temporary.name)
    try:
        temporary_path.replace(path)
    finally:
        temporary_path.unlink(missing_ok=True)


def build_package(root: Path, output: Path, tag: str | None = None,
                  repository: str = REPOSITORY) -> Path:
    version = release_version(root, tag)
    notes = release_notes(root, version, repository)
    files = runtime_files(root)
    verify_runtime(files)
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for name, content in files.items():
            entry = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
            entry.create_system = 3
            entry.external_attr = 0o100644 << 16
            archive.writestr(entry, content, compress_type=zipfile.ZIP_DEFLATED, compresslevel=9)
    archive_bytes = buffer.getvalue()
    with zipfile.ZipFile(io.BytesIO(archive_bytes)) as archive:
        if archive.namelist() != list(files) or archive.testzip() is not None:
            raise ValueError("Archive integrity or file inventory verification failed.")
        for name, content in files.items():
            if archive.read(name) != content:
                raise ValueError(f"Archive content verification failed: {name}")
    output.mkdir(parents=True, exist_ok=True)
    path = output / f"{PACKAGE_NAME}-{version}.zip"
    checksum = hashlib.sha256(archive_bytes).hexdigest()
    write_output(path, archive_bytes)
    write_output(path.with_suffix(".zip.sha256"), f"{checksum}  {path.name}\n".encode())
    write_output(output / "release-notes.md", notes.encode("utf-8"))
    return path


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tag", help="Require an exact v<manifest version> tag.")
    parser.add_argument("--output", type=Path, default=ROOT / "dist")
    parser.add_argument("--repository", default=REPOSITORY)
    args = parser.parse_args()
    try:
        path = build_package(ROOT, args.output, args.tag, args.repository)
    except (ValueError, OSError, subprocess.CalledProcessError) as error:
        parser.exit(1, f"Packaging failed: {error}\n")
    print(f"Verified package: {path}")
    print(f"SHA-256: {path.with_suffix('.zip.sha256')}")


if __name__ == "__main__":
    main()
