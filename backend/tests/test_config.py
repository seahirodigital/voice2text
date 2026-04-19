from __future__ import annotations

from pathlib import Path

from app.config import _deep_merge, _expand_path


def test_deep_merge_keeps_nested_defaults():
    merged = _deep_merge(
        {"outer": {"a": 1, "b": 2}, "other": 3},
        {"outer": {"b": 9}},
    )
    assert merged == {"outer": {"a": 1, "b": 9}, "other": 3}


def test_expand_path_resolves_repo_relative_path():
    resolved = _expand_path("frontend/dist")
    assert isinstance(resolved, Path)
    assert str(resolved).endswith(str(Path("frontend") / "dist"))
