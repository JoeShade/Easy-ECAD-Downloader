"""CLI discovery, isolated KiCad settings, subprocess evidence and image checks."""
import hashlib
import json
import os
import re
import shutil
import subprocess
from datetime import datetime, timezone
from pathlib import Path
import xml.etree.ElementTree as ET


def now():
    return datetime.now(timezone.utc).isoformat()


def atomic_json(filename, value):
    filename = Path(filename)
    temporary = filename.with_suffix(filename.suffix + ".tmp")
    temporary.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")
    temporary.replace(filename)


def discover_cli(explicit=None):
    if explicit:
        if not Path(explicit).is_file():
            raise FileNotFoundError(f"Explicit KiCad executable does not exist: {explicit}")
        return str(Path(explicit).resolve())
    candidates = [explicit, os.environ.get("KICAD_CLI"), shutil.which("kicad-cli")]
    candidates += sorted(Path(os.environ.get("ProgramFiles", "C:/Program Files"), "KiCad").glob("10.*/bin/kicad-cli.exe"), reverse=True)
    for candidate in candidates:
        if candidate and Path(candidate).is_file():
            return str(Path(candidate).resolve())
    raise FileNotFoundError("KiCad 10 CLI not found; supply --kicad-cli or KICAD_CLI")


class Evidence:
    def __init__(self, output, timeout):
        self.output = Path(output).resolve()
        self.output.mkdir(parents=True, exist_ok=True)
        self.timeout = timeout
        self.data = {"schemaVersion": 1, "startedAt": now(), "execution": "RUNNING", "checks": [], "commands": [], "entries": []}
        self.env = dict(os.environ, KICAD_CONFIG_HOME=str(self.output / "kicad-config"),
                        KICAD_DOCUMENTS_HOME=str(self.output / "kicad-documents"))
        self.save()

    def save(self):
        atomic_json(self.output / "render-result.json", self.data)

    def check(self, outcome, establishes, **details):
        self.data["checks"].append(dict(outcome=outcome, establishes=establishes, timestamp=now(), **details))
        self.save()

    def command(self, args, cwd=None):
        record = {"args": list(map(str, args)), "cwd": str(cwd or self.output), "startedAt": now()}
        try:
            response = subprocess.run(record["args"], cwd=cwd or self.output, env=self.env,
                                      capture_output=True, text=True, errors="replace", timeout=self.timeout,
                                      creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
            record.update(exitCode=response.returncode, stdout=response.stdout[-100000:], stderr=response.stderr[-100000:])
        except (subprocess.TimeoutExpired, OSError) as error:
            record.update(exitCode=None, error=str(error), timedOut=isinstance(error, subprocess.TimeoutExpired))
        record["finishedAt"] = now()
        self.data["commands"].append(record)
        with (self.output / "execution.log").open("a", encoding="utf-8") as stream:
            stream.write(json.dumps(record) + "\n")
        self.save()
        if record.get("exitCode") != 0:
            self.check("FAIL", "Command failed or timed out", category="harness", command=record["args"])
        return record

    def preflight(self, explicit):
        import PIL
        self.data["python"] = __import__("sys").version
        self.data["pillow"] = PIL.__version__
        cli = discover_cli(explicit)
        version = self.command([cli, "version"])
        if version.get("exitCode") != 0 or not re.search(r'^10\.\d+\.\d+', version.get("stdout", "").strip()):
            raise RuntimeError("KiCad 10 is required")
        self.data["kicad"] = {"executable": cli, "version": version["stdout"].strip()}
        required = {"sym": (["sym", "export", "svg"], ["--output", "--symbol"]),
                    "fp": (["fp", "export", "svg"], ["--output", "--layers", "--footprint", "--sketch-pads-on-fab-layers"]),
                    "pcb": (["pcb", "render"], ["--output", "--width", "--height", "--side", "--rotate"])}
        for key, (args, flags) in required.items():
            help_result = self.command([cli, *args, "--help"])
            if help_result.get("exitCode") != 0 or any(flag not in help_result.get("stdout", "") for flag in flags):
                raise RuntimeError(f"Installed KiCad help lacks required {key} flags")
        self.check("PASS", "Installed KiCad 10 CLI help exposes required rendering options")
        return cli

    def image(self, filename):
        from PIL import Image, ImageStat
        filename = Path(filename)
        try:
            if filename.suffix.lower() == ".svg":
                root = ET.parse(filename).getroot()
                if root.tag.split("}")[-1] != "svg":
                    raise ValueError("Not an SVG root")
                self.check("PASS", "SVG parses", evidence=str(filename))
                return
            with Image.open(filename) as image:
                image.load()
                if min(image.size) <= 0:
                    raise ValueError("Zero image dimension")
                extrema = ImageStat.Stat(image.convert("RGB")).extrema
                self.check("PASS", "Image decoded with nonzero dimensions", evidence=str(filename), dimensions=list(image.size))
                if max(high-low for low, high in extrema) < 4:
                    self.check("REVIEW", "Image may be blank; heuristic needs visual inspection", evidence=str(filename))
        except Exception as error:
            self.check("FAIL", "Missing, empty, invalid SVG or unreadable image", evidence=str(filename), error=str(error))


def hashes(directory):
    return {str(file.relative_to(directory)): hashlib.sha256(file.read_bytes()).hexdigest()
            for file in Path(directory).rglob("*") if file.is_file()}
