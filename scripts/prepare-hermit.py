#!/usr/bin/env python3
"""Restore Hermit's POSIX launchers when a Windows checkout serialized symlinks."""

import os
import re
from pathlib import Path


def prepare(root: Path) -> int:
    if os.name == "nt":
        raise RuntimeError("Run Hermit preparation on macOS or Linux.")
    directory = root / "bin"
    for name in ("hermit", "activate-hermit", "activate-hermit.fish"):
        launcher = directory / name
        raw = launcher.read_bytes()
        normalized = raw.replace(b"\r\n", b"\n")
        if raw != normalized:
            launcher.write_bytes(normalized)
    (directory / "hermit").chmod(0o755)
    links = []
    for item in directory.iterdir():
        if item.is_symlink() or not item.is_file() or item.stat().st_size > 64:
            continue
        target = item.read_text(encoding="utf-8").strip()
        package = re.fullmatch(r"\.[A-Za-z0-9][A-Za-z0-9._+-]*\.pkg", target)
        if (target == "hermit" and item.name.startswith(".") and item.name.endswith(".pkg")) or (
            package and (directory / target).is_file()
        ):
            links.append((item, target))
    for item, target in links:
        replacement = item.with_name(item.name + ".symlink-prepare")
        # An existing temporary path is never overwritten or deleted.
        replacement.symlink_to(target)
        replacement.replace(item)
    return len(links)


if __name__ == "__main__":
    print(f"Hermit ready: restored {prepare(Path(__file__).resolve().parent.parent)} links")
