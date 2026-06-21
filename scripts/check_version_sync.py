#!/usr/bin/env python3
"""Fail CI if pyproject.toml and npm/package.json versions diverge."""
import json
import sys
from pathlib import Path

try:
    import tomllib
except ImportError:
    try:
        import tomli as tomllib
    except ImportError:
        import subprocess
        subprocess.run([sys.executable, "-m", "pip", "install", "tomli"], check=True)
        import tomli as tomllib

root = Path(__file__).parent.parent

pyproject_version = tomllib.loads((root / "pyproject.toml").read_text())["project"]["version"]
npm_version = json.loads((root / "npm" / "package.json").read_text())["version"]

if pyproject_version != npm_version:
    print(f"ERROR: version mismatch!")
    print(f"  pyproject.toml : {pyproject_version}")
    print(f"  npm/package.json: {npm_version}")
    print("Update both files to the same version before merging.")
    sys.exit(1)

print(f"OK: versions match ({pyproject_version})")
