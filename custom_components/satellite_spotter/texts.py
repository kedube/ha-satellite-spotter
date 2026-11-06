"""The words the integration writes itself, in Home Assistant's language."""

from __future__ import annotations

from collections.abc import Collection
import json
from pathlib import Path

_TRANSLATIONS = Path(__file__).parent / "translations"
_DEFAULT_LANGUAGE = "en"


def resolve_language(language: str, available: Collection[str]) -> str:
    """Return an exact match, else the first with the same base language, else English."""
    language = language.replace("_", "-")
    if language in available:
        return language
    base = language.partition("-")[0].lower()
    for candidate in sorted(available):
        if candidate.partition("-")[0].lower() == base:
            return candidate
    return _DEFAULT_LANGUAGE


def load_common(language: str) -> dict[str, str]:
    """Return a language's common strings (reads a file: not in the event loop)."""
    available = [path.stem for path in _TRANSLATIONS.glob("*.json")]
    path = _TRANSLATIONS / f"{resolve_language(language, available)}.json"
    common: dict[str, str] = json.loads(path.read_text(encoding="utf-8"))["common"]
    return common
