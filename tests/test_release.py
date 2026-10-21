"""The release tool CI runs: the versions, the decision, the notes and the zip HACS installs."""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path
import subprocess
import zipfile

import pytest

_SPEC = importlib.util.spec_from_file_location(
    "release_tool", Path(__file__).parents[1] / "scripts/release.py"
)
release = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(release)


def test_manifest_version_is_in_the_release_format() -> None:
    release.parse(release.manifest_version())


@pytest.mark.parametrize(
    ("current", "following"),
    [("1.00", "1.01"), ("1.09", "1.10"), ("1.98", "1.99"), ("1.99", "2.00"), ("9.99", "10.00")],
)
def test_next_version(current: str, following: str) -> None:
    assert release.next_version(current) == following


@pytest.mark.parametrize("bad", ["1.0", "1.000", "v1.00", "1.0.0", "1.1a", ""])
def test_other_formats_are_refused(bad: str) -> None:
    with pytest.raises(ValueError):
        release.parse(bad)


def test_release_only_a_higher_version() -> None:
    assert release.plan("1.00", [])[0] is True
    assert release.plan("1.01", ["1.00"])[0] is True
    assert release.plan("2.00", ["1.99", "1.10", "1.09"])[0] is True
    # Unchanged: wait for the version to go up.
    released, why = release.plan("1.10", ["1.09", "1.10"])
    assert released is False
    assert "1.11" in why
    # 1.10 is newer than 1.9x only by number, not by text.
    assert release.latest(["1.09", "1.10", "1.02"]) == "1.10"
    # Tags in another format are not releases of this scheme.
    assert release.plan("1.00", ["v0.1.0", "0.1.0"])[0] is True
    with pytest.raises(ValueError, match="lower than the latest release"):
        release.plan("1.05", ["1.06"])


def test_the_previous_release_is_the_highest_below() -> None:
    assert release.previous("1.11", ["1.09", "1.10", "v2.0.0"]) == "1.10"
    assert release.previous("1.10", ["1.09", "1.10"]) == "1.09"
    assert release.previous("1.00", []) is None


def test_bump_changes_only_the_version(tmp_path: Path) -> None:
    manifest = tmp_path / "manifest.json"
    original = release.MANIFEST.read_text()
    manifest.write_text(original.replace(release.manifest_version(), "1.99"))
    assert release.bump(manifest) == ("1.99", "2.00")
    assert manifest.read_text() == original.replace(release.manifest_version(), "2.00")


def test_plan_tells_the_workflow_what_to_do(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    version = release.manifest_version()
    major, minor = release.parse(version)
    older = f"{major - 1}.{minor:02d}" if major > 1 else None
    monkeypatch.setattr("sys.stdin", __import__("io").StringIO(f"v0.9.0\n{older or ''}\n"))
    assert release.main(["release.py", "plan"]) == 0
    out = capsys.readouterr()
    assert out.out.splitlines() == [f"version={version}", "release=true", f"previous={older or ''}"]
    assert out.err.startswith("::notice title=Release::")
    # Already released: nothing to do.
    monkeypatch.setattr("sys.stdin", __import__("io").StringIO(f"{version}\n"))
    assert release.main(["release.py", "plan"]) == 0
    assert "release=false" in capsys.readouterr().out


def test_the_notes_come_from_the_changelog(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    changelog = tmp_path / "CHANGELOG.md"
    changelog.write_text(
        "# Changelog\n\n## [1.02] (2026-12-01)\n\n- Later.\n\n"
        "## 1.01\n\nSome text.\n\n- A fix.\n\n## 1.00\n\n- First.\n"
    )
    monkeypatch.setattr(release, "CHANGELOG", changelog)
    assert release.changelog_section("1.01", changelog) == "Some text.\n\n- A fix."
    assert release.changelog_section("1.02", changelog) == "- Later."
    assert release.changelog_section("1.03", changelog) is None
    assert release.notes("1.01", "1.00") == (
        "Some text.\n\n- A fix.\n\n**Full changelog**: "
        "https://github.com/kedube/ha-satellite-spotter/compare/1.00...1.01\n"
    )
    assert release.notes("1.00") == "- First.\n"


def test_without_a_changelog_section_the_notes_list_the_commits(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    repo = tmp_path / "repo"
    repo.mkdir()

    def git(*args: str) -> None:
        subprocess.run(["git", *args], cwd=repo, check=True, capture_output=True)

    git("init", "-q", "-b", "main")
    git("config", "user.email", "test@example.com")
    git("config", "user.name", "Test")
    for subject in ("First", "Second", "Third"):
        (repo / "file.txt").write_text(subject)
        git("add", "file.txt")
        git("commit", "-q", "-m", subject)
        if subject == "First":
            git("tag", "1.00")
    monkeypatch.setattr(release, "ROOT", repo)
    monkeypatch.setattr(release, "CHANGELOG", repo / "CHANGELOG.md")
    assert release.notes("1.01", "1.00").startswith("- Third\n- Second\n\n**Full changelog**")
    assert release.notes("1.00") == "- Third\n- Second\n- First\n"


def test_the_package_is_what_hacs_installs(tmp_path: Path) -> None:
    out = tmp_path / "dist/satellite_spotter.zip"
    names = release.package(out)
    with zipfile.ZipFile(out) as zf:
        assert zf.namelist() == names
        # The integration's files at the zip's root, as HACS unpacks them into
        # custom_components/satellite_spotter/.
        manifest = json.loads(zf.read("manifest.json"))
        assert manifest["domain"] == "satellite_spotter"
        assert manifest["version"] == release.manifest_version()
        needed = ("__init__.py", "brand/icon.png", "frontend/sat-card.js", "translations/en.json")
        assert set(needed) <= set(names)
        assert not [n for n in names if "__pycache__" in n or n.endswith(".pyc")]
        # Already compressed files are stored, the rest deflated.
        infos = {info.filename: info for info in zf.infolist()}
        assert infos["brand/icon.png"].compress_type == zipfile.ZIP_STORED
        assert infos["__init__.py"].compress_type == zipfile.ZIP_DEFLATED
    # The same files make the same zip, whenever it is built.
    again = tmp_path / "again.zip"
    release.package(again)
    assert again.read_bytes() == out.read_bytes()


def test_a_folder_without_a_manifest_is_not_packaged(tmp_path: Path) -> None:
    (tmp_path / "src").mkdir()
    (tmp_path / "src/__init__.py").write_text("")
    with pytest.raises(ValueError, match=r"no manifest\.json"):
        release.package(tmp_path / "out.zip", tmp_path / "src")
