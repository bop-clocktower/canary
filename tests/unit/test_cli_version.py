"""Unit tests for `canary version`."""

from typer.testing import CliRunner

from agent.cli import app

runner = CliRunner()


def test_version_reports_installed_package_version():
    """version reflects the installed package metadata, not a hardcoded string."""
    res = runner.invoke(app, ["version"])
    assert res.exit_code == 0
    assert "canary" in res.stdout
    assert "v0.1 (MVP)" not in res.stdout


def test_version_falls_back_when_metadata_missing(monkeypatch):
    """When the package isn't installed, version prints 'unknown' rather than raising."""
    from importlib.metadata import PackageNotFoundError

    def _raise(_name):
        raise PackageNotFoundError

    monkeypatch.setattr("importlib.metadata.version", _raise)
    res = runner.invoke(app, ["version"])
    assert res.exit_code == 0
    assert "vunknown" in res.stdout
