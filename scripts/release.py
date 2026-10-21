"""Releases: the version in manifest.json, published by CI once it passes on main.

Versions are MAJOR.MM with no "v": 1.00, 1.01, ... 1.99, then 2.00. To release,
raise "version" in manifest.json (bump does it) and push that to main, or merge
a pull request that does. When CI passes on that commit, the Release workflow
tags it with the version and publishes a GitHub release with notes (the
version's section of CHANGELOG.md, or else the commits since the last release)
and satellite_spotter.zip, which HACS installs. Pushes that leave the version
alone release nothing.

usage:
  python scripts/release.py bump                      # manifest.json to the next version
  python scripts/release.py status                    # would pushing to main release it?
  python scripts/release.py plan                      # CI: released versions on stdin
  python scripts/release.py notes VERSION [PREVIOUS]  # CI: the release notes (Markdown)
  python scripts/release.py package OUT.zip           # CI: what HACS installs

`plan` prints `version=`, `release=` and `previous=` lines for $GITHUB_OUTPUT.
Versions that are already released, or tags in another format, are never
released again; a manifest version lower than the latest release fails.
"""

from __future__ import annotations

import json
from pathlib import Path
import re
import subprocess
import sys
import zipfile

ROOT = Path(__file__).resolve().parents[1]
INTEGRATION = ROOT / "custom_components/satellite_spotter"
MANIFEST = INTEGRATION / "manifest.json"
CHANGELOG = ROOT / "CHANGELOG.md"
REPOSITORY = "kedube/ha-satellite-spotter"
VERSION_RE = re.compile(r"(\d+)\.(\d{2})")
# A release ships the integration's files, not caches left by running it.
LEFT_OUT = re.compile(r"(^|/)(__pycache__|\.DS_Store)(/|$)|\.py[co]$")
# Already compressed: stored as they are rather than deflated again.
STORED = (".br", ".gz", ".jpg", ".png", ".woff2")
# Every entry gets this time, so the same files always make the same zip.
ZIP_TIME = (2026, 1, 1, 0, 0, 0)


def parse(version: str) -> tuple[int, int]:
    """(major, minor) of a version like 1.07; anything else is an error."""
    match = VERSION_RE.fullmatch(version)
    if not match:
        raise ValueError(f"{version!r} is not a MAJOR.MM version such as 1.00")
    return int(match[1]), int(match[2])


def next_version(version: str) -> str:
    """The version after this one: 1.00 -> 1.01, 1.99 -> 2.00."""
    major, minor = parse(version)
    return f"{major + 1}.00" if minor == 99 else f"{major}.{minor + 1:02d}"


def manifest_version(path: Path = MANIFEST) -> str:
    return json.loads(path.read_text())["version"]


def latest(released: list[str]) -> str | None:
    """The highest release in this format; other tags (v0.1.0, say) are left out."""
    versions = [v for v in released if VERSION_RE.fullmatch(v)]
    return max(versions, key=parse, default=None)


def previous(version: str, released: list[str]) -> str | None:
    """The release before this version: the highest one below it."""
    return latest([v for v in released if VERSION_RE.fullmatch(v) and parse(v) < parse(version)])


def plan(version: str, released: list[str]) -> tuple[bool, str]:
    """Whether to release `version`, and why."""
    parse(version)
    newest = latest(released)
    if newest is None:
        return True, f"{version} is the first release"
    if parse(version) > parse(newest):
        return True, f"{version} follows the latest release, {newest}"
    if version == newest:
        return False, (
            f"{version} is already released; raise the version in manifest.json "
            f"(python scripts/release.py bump gives {next_version(version)}) to release again"
        )
    raise ValueError(f"manifest.json says {version}, lower than the latest release, {newest}")


def bump(path: Path = MANIFEST) -> tuple[str, str]:
    """Raise the manifest's version by one step, keeping the file's layout."""
    text = path.read_text()
    old = manifest_version(path)
    new = next_version(old)
    text, count = re.subn(r'("version":\s*")[^"]*(")', rf"\g<1>{new}\g<2>", text)
    if count != 1:
        raise ValueError(f"{path} has no single version field")
    path.write_text(text)
    return old, new


def changelog_section(version: str, path: Path | None = None) -> str | None:
    """What CHANGELOG.md says under "## <version>", up to the next such heading."""
    path = path or CHANGELOG
    if not path.exists():
        return None
    lines: list[str] = []
    inside = False
    for line in path.read_text().splitlines():
        if line.startswith("## "):
            if inside:
                break
            # "## 1.01", "## [1.01]" and "## 1.01 (2026-11-02)" all name 1.01.
            inside = re.match(rf"\[?{re.escape(version)}\]?(\s|$)", line[3:].strip()) is not None
        elif inside:
            lines.append(line)
    return "\n".join(lines).strip() or None


def commits(since: str | None, ref: str = "HEAD") -> list[str]:
    """The subjects of the commits after `since` up to `ref` (all of them for a first release)."""
    out = subprocess.run(
        ["git", "log", "--no-merges", "--format=%s", f"{since}..{ref}" if since else ref],
        capture_output=True,
        text=True,
        check=True,
        cwd=ROOT,
    ).stdout
    return [subject for subject in out.splitlines() if subject.strip()]


def notes(version: str, since: str | None = None, ref: str = "HEAD") -> str:
    """The release notes: the changelog's section, else the commits since the last release."""
    body = changelog_section(version)
    if body is None:
        body = "\n".join(f"- {subject}" for subject in commits(since, ref)) or "- Maintenance"
    if since:
        compare = f"https://github.com/{REPOSITORY}/compare/{since}...{version}"
        body += f"\n\n**Full changelog**: {compare}"
    return body + "\n"


def package(out: Path, source: Path = INTEGRATION) -> list[str]:
    """Zip the integration's files at the zip's root, as HACS unpacks them; returns their names."""
    names = sorted(
        path.relative_to(source).as_posix()
        for path in source.rglob("*")
        if path.is_file() and not LEFT_OUT.search(path.relative_to(source).as_posix())
    )
    if "manifest.json" not in names:
        raise ValueError(f"{source} has no manifest.json")
    out.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(out, "w") as zf:
        for name in names:
            info = zipfile.ZipInfo(name, ZIP_TIME)
            info.compress_type = (
                zipfile.ZIP_STORED if name.endswith(STORED) else zipfile.ZIP_DEFLATED
            )
            info.external_attr = 0o644 << 16
            zf.writestr(info, (source / name).read_bytes(), compresslevel=9)
    return names


def _remote_tags() -> list[str]:
    out = subprocess.run(
        ["git", "ls-remote", "--tags", "--refs", "origin"],
        capture_output=True,
        text=True,
        check=True,
        cwd=ROOT,
    ).stdout
    return [line.rsplit("refs/tags/", 1)[-1] for line in out.splitlines() if "refs/tags/" in line]


def main(argv: list[str]) -> int:
    command, args = (argv[1], argv[2:]) if len(argv) > 1 else ("", [])
    try:
        if command == "bump" and not args:
            old, new = bump()
            print(f"manifest.json: {old} -> {new}")
        elif command == "status" and not args:
            release, why = plan(manifest_version(), _remote_tags())
            print(f"{why}." + (" CI releases it once the checks pass on main." if release else ""))
        elif command == "plan" and not args:
            version = manifest_version()
            released = sys.stdin.read().split()
            release, why = plan(version, released)
            print(f"::notice title=Release::{why}", file=sys.stderr)
            print(f"version={version}\nrelease={str(release).lower()}")
            print(f"previous={previous(version, released) or ''}")
        elif command == "notes" and len(args) in (1, 2):
            print(notes(args[0], args[1] if len(args) == 2 and args[1] else None), end="")
        elif command == "package" and len(args) == 1:
            names = package(Path(args[0]))
            print(f"{args[0]}: {len(names)} files, version {manifest_version()}")
        else:
            print(__doc__, file=sys.stderr)
            return 2
    except (ValueError, OSError, subprocess.CalledProcessError) as err:
        print(f"::error title=Release::{err}" if command == "plan" else err, file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
