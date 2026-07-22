#!/usr/bin/env python3
"""alarm -- fire only when a deletion removes the last coverage of a hot symbol.

The premise that keeps this skill from becoming nag fatigue: most test deletions
are legitimate, so katana is silent by default and records everything. It alarms
in exactly one situation -- the deleted test was the *last* test covering a
symbol that ``critical-areas.json`` marks as high-risk. When that file is
missing or malformed the alarm degrades to recording-only and says so out loud;
a gate that manufactures failures on missing data is one people mute, and a
muted gate is worse than no gate.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from enum import Enum
from pathlib import Path

import diffscan

DEGRADED_NOTICE = "critical-area data unavailable, recording only, not alarming"

# risk_score at or above this makes a name-matched last-coverage loss CRITICAL;
# below it the loss is still real but ranked HIGH.
_CRITICAL_RISK = 0.7

# Directory names too generic to imply a coverage relationship on their own.
_GENERIC_DIRS = {
    "src", "lib", "app", "apps", "packages", "pkg",
    "tests", "test", "__tests__", "e2e", "spec", "dist", "build",
}

_CODE_SUFFIXES = (".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py")


class Fidelity(Enum):
    NAME_MATCHED = "name-matched"
    HEURISTIC = "heuristic"

    @property
    def rank(self) -> int:
        return 0 if self is Fidelity.NAME_MATCHED else 1


class Severity(Enum):
    CRITICAL = "critical"
    HIGH = "high"
    MEDIUM = "medium"

    @property
    def sort_key(self) -> int:
        return {"critical": 0, "high": 1, "medium": 2}[self.value]


@dataclass
class CriticalAreas:
    available: bool
    areas: list
    reason: str


@dataclass
class Finding:
    kind: str
    test: str
    file: str
    area: str
    fidelity: Fidelity
    severity: Severity
    evidence: str

    def to_dict(self) -> dict:
        return {
            "kind": self.kind,
            "test": self.test,
            "file": self.file,
            "area": self.area,
            "fidelity": self.fidelity.value,
            "severity": self.severity.value,
            "evidence": self.evidence,
        }


def load_critical_areas(path) -> CriticalAreas:
    """Load ``critical-areas.json``; unavailable (not raising) on any problem."""
    if path is None:
        return CriticalAreas(False, [], "critical-area file not provided")
    path = Path(path)
    if not path.exists():
        return CriticalAreas(False, [], f"critical-area file not found: {path}")
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError) as exc:
        return CriticalAreas(False, [], f"critical-area file malformed: {exc}")
    areas = data.get("areas", []) if isinstance(data, dict) else []
    return CriticalAreas(True, list(areas), "")


def _norm(text: str) -> str:
    return re.sub(r"[^a-z0-9]", "", text.lower())


def area_symbols(area_path: str) -> set:
    """Symbols an area path exposes: its basename minus code suffix, and parts.

    ``src/loyalty/points.service.ts`` -> {"points.service", "points", "service"}.
    """
    base = area_path.replace("\\", "/").split("/")[-1]
    for suffix in _CODE_SUFFIXES:
        if base.endswith(suffix):
            base = base[: -len(suffix)]
            break
    symbols = {base}
    symbols.update(part for part in base.split(".") if part)
    return symbols


def _area_norm_symbols(area_path: str) -> set:
    return {s for s in (_norm(x) for x in area_symbols(area_path)) if len(s) >= 4}


def _dirs(path: str) -> list:
    parts = [p for p in path.replace("\\", "/").split("/") if p]
    return parts[:-1]


def _significant_dirs(path: str) -> set:
    return {d for d in _dirs(path) if d not in _GENERIC_DIRS}


def _name_covers(test_name: str, norm_symbols: set) -> bool:
    normalized = _norm(test_name)
    return any(sym in normalized for sym in norm_symbols)


def _repo_test_files(repo: Path):
    for path in sorted(repo.rglob("*")):
        if not path.is_file():
            continue
        rel = path.relative_to(repo).as_posix()
        if diffscan.is_test_file(rel):
            yield rel, path


_PY_TEST_DEF = re.compile(r"^\s*(?:async\s+)?def\s+(test\w*)\s*\(", re.MULTILINE)
_JS_TEST_CALL = re.compile(
    r"\b(?:describe|context|it|test)(?:\.\w+)?\s*\(\s*(['\"`])(.*?)\1"
)


def _test_names(text: str) -> list:
    names = [m.group(1) for m in _PY_TEST_DEF.finditer(text)]
    names += [m.group(2) for m in _JS_TEST_CALL.finditer(text)]
    return names


def _name_coverage_remains(repo: Path, norm_symbols: set) -> bool:
    for _rel, path in _repo_test_files(repo):
        try:
            text = path.read_text(encoding="utf-8")
        except OSError:
            continue
        if any(_name_covers(name, norm_symbols) for name in _test_names(text)):
            return True
    return False


def _dir_coverage_remains(repo: Path, area_dirs: set) -> bool:
    for rel, path in _repo_test_files(repo):
        if not (set(_dirs(rel)) & area_dirs):
            continue
        try:
            text = path.read_text(encoding="utf-8")
        except OSError:
            continue
        if _test_names(text):
            return True
    return False


def build_findings(deletions, areas: CriticalAreas, repo) -> list:
    """Return last-coverage-removed findings; empty when data is unavailable."""
    if not areas.available:
        return []  # silent by default: never alarm on degraded data
    repo = Path(repo)
    findings: list[Finding] = []

    for deletion in deletions:
        best: Finding = None
        for area in areas.areas:
            area_path = area.get("path", "")
            risk = float(area.get("risk_score", 0.0) or 0.0)
            norm_symbols = _area_norm_symbols(area_path)

            if norm_symbols and _name_covers(deletion.name, norm_symbols):
                if _name_coverage_remains(repo, norm_symbols):
                    continue
                fidelity = Fidelity.NAME_MATCHED
                severity = (
                    Severity.CRITICAL if risk >= _CRITICAL_RISK else Severity.HIGH
                )
            else:
                area_dirs = _significant_dirs(area_path)
                if not (area_dirs & set(_dirs(deletion.file))):
                    continue
                if _dir_coverage_remains(repo, area_dirs):
                    continue
                fidelity = Fidelity.HEURISTIC
                severity = Severity.MEDIUM

            candidate = Finding(
                kind="last-coverage-removed",
                test=deletion.name,
                file=deletion.file,
                area=area_path,
                fidelity=fidelity,
                severity=severity,
                evidence=(
                    f"{deletion.name} was the last test covering {area_path}"
                ),
            )
            if best is None or (fidelity.rank, severity.sort_key) < (
                best.fidelity.rank,
                best.severity.sort_key,
            ):
                best = candidate

        if best is not None:
            findings.append(best)

    findings.sort(key=lambda f: (f.severity.sort_key, f.file, f.test))
    return findings
