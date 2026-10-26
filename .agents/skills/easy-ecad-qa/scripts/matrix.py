"""Guarded updates for the existing 19-column Easy ECAD Markdown matrix.

This module records caller-supplied results while preserving fixed component
selections. The QA harness owns test execution and reviewers own verdicts.
Requires Python 3.10+ and the standard library.
"""
from __future__ import annotations

import argparse
from collections import Counter
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import sys
import tempfile
from typing import Any, Iterator

HEADERS = (
    "ID", "Site", "Backend/route", "Manufacturer", "Fixed MPN",
    "Target package / geometry (verify)", "Starting URL", "Entry",
    "Resolved product URL", "Source # detection", "Manufacturer/MPN detection",
    "Symbol preview", "Footprint preview", "Download", "KiCad symbol",
    "KiCad footprint", "KiCad 3D", "Case status", "Findings / reproduction / evidence",
)
CHECKS = HEADERS[9:17]
FIXED = HEADERS[:8]
UNRUN = {"", "—", "-", "NOT RUN", "NOT_RUN"}
OUTCOMES = {"PASS", "FAIL", "REVIEW", "BLOCKED", "N/A"}
STATES = {"NOT RUN", "PARTIAL", "PASS", "FAIL", "REVIEW", "BLOCKED"}
FINDINGS = HEADERS[-1]


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def split_cells(line: str) -> list[str] | None:
    """Split a table row at pipes preceded by an even number of backslashes.

    An odd backslash count escapes the pipe as cell text; paired backslashes
    leave the pipe available as a column boundary.
    """
    text = line.strip()
    if not text.startswith("|") or not text.endswith("|"):
        return None
    cells, current, slashes = [], [], 0
    for character in text[1:-1]:
        if character == "|" and slashes % 2 == 0:
            cells.append("".join(current).strip())
            current = []
        else:
            current.append(character)
        slashes = slashes + 1 if character == "\\" else 0
    cells.append("".join(current).strip())
    return cells


def safe_cell(value: str) -> str:
    """Keep the patch on one table line and escape unescaped pipe delimiters."""
    value = value.replace("\r\n", "\n").replace("\r", "\n").replace("\n", "<br>").strip()
    result, slashes = [], 0
    for character in value:
        if character == "|" and slashes % 2 == 0:
            result.append("\\")
        result.append(character)
        slashes = slashes + 1 if character == "\\" else 0
    # An odd terminal backslash would escape the following table delimiter.
    if slashes % 2:
        result.append("\\")
    return "".join(result)


@dataclass
class Matrix:
    path: Path
    raw: bytes
    lines: list[str]
    rows: dict[str, tuple[int, dict[str, str]]]

    @classmethod
    def read(cls, path: Path, raw: bytes | None = None) -> "Matrix":
        """Locate the fixed table schema and retain original lines for patching.

        Candidate bytes support validation before publication. Invalid column
        counts, separators or repeated case IDs raise ValueError.
        """
        path = path.resolve()
        raw = path.read_bytes() if raw is None else raw
        lines = raw.decode("utf-8").splitlines(keepends=True)
        starts = [index for index, line in enumerate(lines)
                  if split_cells(line.lstrip("\ufeff")) == list(HEADERS)]
        if len(starts) != 1:
            raise ValueError("Expected exactly one existing 19-column Easy ECAD table; schema unchanged")
        start = starts[0]
        separator = split_cells(lines[start + 1]) if start + 1 < len(lines) else None
        if not separator or len(separator) != len(HEADERS) or not all(
                re.fullmatch(r":?-{3,}:?", cell) for cell in separator):
            raise ValueError("Invalid Markdown table separator")
        rows: dict[str, tuple[int, dict[str, str]]] = {}
        for index in range(start + 2, len(lines)):
            if not lines[index].lstrip().startswith("|"):
                break
            cells = split_cells(lines[index])
            if cells is None or len(cells) != len(HEADERS):
                raise ValueError(f"Wrong cell count on line {index + 1}")
            identifier = cells[0]
            if not re.fullmatch(r"P\d{3,}", identifier) or identifier in rows:
                raise ValueError(f"Invalid or duplicate case ID: {identifier!r}")
            rows[identifier] = (index, dict(zip(HEADERS, cells)))
        if not rows:
            raise ValueError("The test table has no cases")
        return cls(path, raw, lines, rows)

    def definitions(self) -> list[list[str]]:
        return [[row[key] for key in FIXED] for _, row in self.rows.values()]

    def definition_hash(self) -> str:
        """Hash fixed columns in row order using stable, compact JSON encoding."""
        return digest(json.dumps(self.definitions(), ensure_ascii=False,
                                 separators=(",", ":")).encode("utf-8"))

    def row(self, identifier: str) -> dict[str, str]:
        if identifier not in self.rows:
            raise ValueError(f"Case does not exist: {identifier}")
        return self.rows[identifier][1]


def atomic_bytes(path: Path, data: bytes) -> None:
    """Flush a sibling temporary file, then atomically replace the destination.

    The same-directory temporary keeps replacement on one filesystem. Existing
    permission bits survive replacement, and failed writes clean up the temporary.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        if path.exists():
            shutil.copymode(path, temporary)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def atomic_json(path: Path, data: Any) -> None:
    atomic_bytes(path, (json.dumps(data, ensure_ascii=False, indent=2) + "\n").encode("utf-8"))


def baseline(matrix: Matrix, campaign: Path) -> dict[str, Any]:
    """Verify campaign identity, immutable case definitions and original backup.

    Every update depends on these checks so a campaign remains tied to the same
    matrix path and original component choices throughout its lifetime.
    """
    data = json.loads((campaign / "baseline.json").read_text(encoding="utf-8"))
    if data.get("schema_version") != 1 or data.get("headers") != list(HEADERS):
        raise ValueError("Unsupported campaign baseline")
    if Path(data["matrix_path"]).resolve() != matrix.path:
        raise ValueError("Matrix path differs from this campaign; do not silently change the baseline")
    if data.get("definitions") != matrix.definitions() or data.get("definition_sha256") != matrix.definition_hash():
        raise ValueError("Fixed case definitions, IDs, order or count changed")
    backup = campaign / "original-matrix.md"
    if digest(backup.read_bytes()) != data["original_matrix_sha256"]:
        raise ValueError("Original matrix backup no longer matches the baseline")
    return data


@contextmanager
def campaign_lock(campaign: Path) -> Iterator[None]:
    """Serialize cooperating writers with exclusive lock-file creation.

    An existing lock requires operator investigation. Normal exit and handled
    errors release this process's lock; abrupt termination leaves recovery evidence.
    """
    lock = campaign / ".matrix.lock"
    try:
        descriptor = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    except FileExistsError as error:
        raise ValueError("Campaign is locked; verify the existing writer before any recovery") from error
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            stream.write(json.dumps({"pid": os.getpid(), "time": now()}))
        yield
    finally:
        lock.unlink(missing_ok=True)


def summary(matrix: Matrix) -> dict[str, Any]:
    """Count recorded outcomes, retaining incomplete and overlapping result groups.

    Reviewers supply inspection evidence; these totals describe recorded cells.
    """
    rows = [row for _, row in matrix.rows.values()]
    incomplete = [row["ID"] for row in rows if row["Case status"] in {"NOT RUN", "PARTIAL"}
                  or any(row[key] in UNRUN for key in CHECKS)]
    return {
        "case_count": len(rows), "case_status_counts": dict(Counter(row["Case status"] for row in rows)),
        "incomplete_ids": incomplete,
        "closed_rows": len(rows) - len(incomplete),
        "cases_with_failures": [row["ID"] for row in rows if any(row[key] == "FAIL" for key in CHECKS)],
        "cases_with_blockers": [row["ID"] for row in rows if any(row[key] == "BLOCKED" for key in CHECKS)],
        "cases_awaiting_review": [row["ID"] for row in rows if any(row[key] == "REVIEW" for key in CHECKS)],
        "fully_inspected_rows": sum(row["ID"] not in incomplete and all(
            row[key] in {"PASS", "FAIL", "N/A"} for key in CHECKS) for row in rows),
        "note": "Mechanical counts of recorded cells; not independent proof of inspection. Failure/blocker/review sets overlap.",
    }


def validate_outcomes(row: dict[str, str]) -> None:
    """Require complete check accounting before a final case verdict.

    Failure outranks review, then blocking, then pass. A reason accompanies each
    unsuccessful or unavailable check so the recorded status stays interpretable.
    """
    for key in CHECKS:
        if row[key] not in OUTCOMES | UNRUN:
            raise ValueError(f"Invalid check outcome in {key}: {row[key]!r}")
    state = row["Case status"]
    if state not in STATES:
        raise ValueError("Invalid Case status")
    checks = [row[key] for key in CHECKS]
    if state == "NOT RUN" and any(value not in UNRUN for value in checks):
        raise ValueError("An observed case cannot be NOT RUN")
    if state not in {"PARTIAL", "NOT RUN"}:
        if any(value in UNRUN for value in checks):
            raise ValueError("Unaccounted checks require PARTIAL, even when a failure is known")
        expected = next((value for value in ("FAIL", "REVIEW", "BLOCKED") if value in checks), "PASS")
        if state != expected:
            raise ValueError(f"Completed case status must be {expected} for its recorded checks")
    if any(value in {"FAIL", "REVIEW", "BLOCKED", "N/A"} for value in checks) and row[FINDINGS] in UNRUN:
        raise ValueError("Non-passing/unavailable checks need a finding or explicit reason")


def initialise(matrix: Matrix, campaign: Path) -> dict[str, Any]:
    """Create a fresh campaign directory with original bytes and baseline hashes."""
    campaign = campaign.resolve()
    campaign.parent.mkdir(parents=True, exist_ok=True)
    campaign.mkdir()  # Exclusive creation preserves an existing campaign.
    (campaign / "original-matrix.md").write_bytes(matrix.raw)
    data = {"schema_version": 1, "created_at": now(), "matrix_path": str(matrix.path),
            "headers": list(HEADERS), "definitions": matrix.definitions(),
            "definition_sha256": matrix.definition_hash(), "original_matrix_sha256": digest(matrix.raw)}
    atomic_json(campaign / "baseline.json", data)
    atomic_json(campaign / "checkpoint.json", {"state": "READY", "updated_at": now(),
        "matrix_sha256": digest(matrix.raw), "case_id": None, "step": "preflight", "run_id": None})
    return {"campaign": str(campaign), "matrix_sha256": digest(matrix.raw), **summary(matrix)}


def update(path: Path, campaign: Path, identifier: str, expected_sha: str,
           patch: dict[str, Any]) -> dict[str, Any]:
    """Publish a validated row patch while preserving definitions and prior bytes.

    The caller supplies the SHA-256 of its read snapshot. The lock coordinates
    this tool's writers; byte checks also detect unrelated edits before/after
    publication. A revision backup precedes replacement and a journal entry follows.
    """
    if not isinstance(patch, dict) or set(patch) - {"set", "append_finding"}:
        raise ValueError("Patch supports only set and append_finding")
    values, addition = patch.get("set", {}), patch.get("append_finding", "")
    if not isinstance(values, dict) or not isinstance(addition, str):
        raise ValueError("set must be an object and append_finding must be a string")
    if not values and not addition.strip():
        raise ValueError("Empty update")
    allowed = set(HEADERS[8:-1])
    if set(values) - allowed or any(not isinstance(value, str) for value in values.values()):
        raise ValueError("Only string values in result columns may be set; findings are append-only")
    with campaign_lock(campaign):
        matrix = Matrix.read(path)
        baseline(matrix, campaign)
        if digest(matrix.raw) != expected_sha:
            raise ValueError("Stale matrix SHA-256: reread before editing")
        row = dict(matrix.row(identifier))
        for key, value in values.items():
            row[key] = safe_cell(value)
        if addition.strip():
            row[FINDINGS] = ((row[FINDINGS] + "<br><br>") if row[FINDINGS] not in UNRUN else "") + safe_cell(addition)
        validate_outcomes(row)
        index = matrix.rows[identifier][0]
        old_line = matrix.lines[index]
        ending = "\r\n" if old_line.endswith("\r\n") else "\n" if old_line.endswith("\n") else ""
        lines = list(matrix.lines)
        lines[index] = "| " + " | ".join(row[key] for key in HEADERS) + " |" + ending
        candidate = "".join(lines).encode("utf-8")
        # Parse the serialized row again to catch accidental delimiter changes
        # before replacing the user's matrix.
        parsed = Matrix.read(path, candidate)
        baseline(parsed, campaign)
        if parsed.row(identifier) != row:
            raise ValueError("Updated table did not round-trip; no write performed")
        revision = campaign / "revisions" / f"{expected_sha}.md"
        revision.parent.mkdir(exist_ok=True)
        if revision.exists():
            if revision.read_bytes() != matrix.raw:
                raise ValueError("Revision backup conflict")
        else:
            with revision.open("xb") as stream:
                stream.write(matrix.raw)
        if path.read_bytes() != matrix.raw:
            raise ValueError("Matrix changed during update; no replacement performed")
        atomic_bytes(path, candidate)
        if path.read_bytes() != candidate:
            raise ValueError("Matrix changed after replacement; stop and reconcile")
        event = {"time": now(), "case_id": identifier, "before_sha256": expected_sha,
                 "after_sha256": digest(candidate), "changed_columns": list(values),
                 "finding_appended": bool(addition.strip())}
        with (campaign / "updates.jsonl").open("a", encoding="utf-8") as stream:
            stream.write(json.dumps(event) + "\n")
        return {"matrix_sha256": digest(candidate), "row": row, **summary(parsed)}


def main() -> int:
    """Dispatch matrix bookkeeping commands and emit JSON results or exit code 2.

    Checkpoints reuse the campaign lock and snapshot checks used for row updates.
    """
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    for name in ("init", "inspect", "update", "checkpoint"):
        child = commands.add_parser(name)
        child.add_argument("--matrix", type=Path, required=True)
        child.add_argument("--campaign", type=Path, required=True)
        if name != "init":
            child.add_argument("--id", required=name == "update")
        if name == "update":
            child.add_argument("--patch", type=Path, required=True)
            child.add_argument("--expected-sha", required=True)
        if name == "checkpoint":
            child.add_argument("--state", choices=("RUNNING", "PAUSED", "BLOCKED", "COMPLETE"), required=True)
            child.add_argument("--step", required=True)
            child.add_argument("--run-id")
    args = parser.parse_args()
    try:
        args.matrix, args.campaign = args.matrix.resolve(), args.campaign.resolve()
        if args.command == "update":
            result = update(args.matrix, args.campaign, args.id, args.expected_sha,
                            json.loads(args.patch.read_text(encoding="utf-8-sig")))
        else:
            matrix = Matrix.read(args.matrix)
            if args.command == "init":
                result = initialise(matrix, args.campaign)
            else:
                baseline(matrix, args.campaign)
                row = matrix.row(args.id) if args.id else None
                if args.command == "inspect":
                    result = {"matrix_sha256": digest(matrix.raw), "definition_sha256": matrix.definition_hash(),
                              "row": row, **summary(matrix)}
                else:
                    with campaign_lock(args.campaign):
                        if args.matrix.read_bytes() != matrix.raw:
                            raise ValueError("Matrix changed while checkpointing; reread")
                        result = {"state": args.state, "case_id": args.id, "step": args.step,
                                  "run_id": args.run_id, "updated_at": now(),
                                  "matrix_sha256": digest(matrix.raw)}
                        atomic_json(args.campaign / "checkpoint.json", result)
        print(json.dumps(result, ensure_ascii=True, indent=2))
        return 0
    except (OSError, ValueError, KeyError, TypeError) as error:
        print(f"matrix: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
