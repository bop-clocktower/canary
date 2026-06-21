# canary.spec
# IMPORTANT: Always build with the project venv Python to pick up all dependencies:
#   .venv/bin/python -m PyInstaller canary.spec --clean --noconfirm
#
from PyInstaller.utils.hooks import collect_data_files, collect_submodules, copy_metadata

block_cipher = None

# Bundle frameworks JSON data files
datas = [
    ("agent/frameworks/*.json", "agent/frameworks"),
]
# fastmcp may have data files (e.g. schema stubs)
datas += collect_data_files("fastmcp")
# Bundle canary-test-ai dist-info so --version works in frozen binary
datas += copy_metadata("canary-test-ai")

hiddenimports = (
    collect_submodules("agent")
    + collect_submodules("typer")
    + collect_submodules("rich")
    + collect_submodules("fastmcp")
    + ["openpyxl.cell._writer"]  # openpyxl lazy import that PyInstaller misses
)

a = Analysis(
    ["agent/cli.py"],
    pathex=["."],
    binaries=[],
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=["tests", "docs", "scripts"],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.zipfiles,
    a.datas,
    [],
    name="canary",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,        # UPX causes false-positive AV hits — keep off
    console=True,
    disable_windowed_traceback=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
