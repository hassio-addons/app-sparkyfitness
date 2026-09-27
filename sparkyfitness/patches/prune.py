#!/usr/bin/env python3
"""Leave only what the SparkyFitness server runs on in its deployment.

The server is deployed with its development dependencies, since it is
compiled from TypeScript in place, with the esbuild one of them brings along.
Once that is done, none of them are needed: type checkers, linters, test
runners, and the compiler itself. On top of that, pnpm links in the optional
peers of several packages, because the workspace happens to have them: the
Expo and React Native packages of the mobile app among them, which make up
most of what is deployed. The server never loads any of it.

pnpm lays a deployment out as a graph of links: every package sits in a
directory of its own below node_modules/.pnpm, next to links to exactly the
packages it depends on. So what the server can reach is found by following
those links, starting from the dependencies it declares. Whatever is not
reached is deleted.

Before that, links to optional peers are cut, but only to peers the server
never imports. trace-imports.mjs lists what it does import, following every
import from its entry point. Optional peers are by definition something a
package copes without, and these ones are not even asked for.

Nothing is installed here, only removed, so every package kept is the version
the lockfile says.
"""

from __future__ import annotations

import json
import platform
import re
import shutil
import sys
from pathlib import Path

# What npm compares a package's "os", "cpu" and "libc" fields against.
CURRENT = {
    "os": "linux",
    "cpu": {"x86_64": "x64", "aarch64": "arm64", "armv7l": "arm"}.get(
        platform.machine(), platform.machine()
    ),
    "libc": "musl",
}


class PruneError(Exception):
    """The deployment does not look the way this was written against."""


def size(path: Path) -> int:
    """Bytes taken by the files below a directory, not following links."""
    return sum(
        f.stat(follow_symlinks=False).st_size
        for f in path.rglob("*")
        if f.is_file() and not f.is_symlink()
    )


def entries(node_modules: Path) -> list[Path]:
    """The packages in a node_modules directory, scoped ones included."""
    if not node_modules.is_dir():
        return []
    found = []
    for entry in sorted(node_modules.iterdir()):
        if entry.name.startswith("."):
            continue
        if entry.name.startswith("@") and entry.is_dir() and not entry.is_symlink():
            found.extend(sorted(entry.iterdir()))
        else:
            found.append(entry)
    return found


def store_entry(package: Path, store: Path) -> Path | None:
    """The directory below .pnpm a package lives in, if it lives in one."""
    try:
        relative = package.resolve().relative_to(store)
    except ValueError:
        return None
    return store / relative.parts[0]


def packages_in(entry: Path) -> list[Path]:
    """The package a directory below .pnpm holds, and the links next to it."""
    return entries(entry / "node_modules")


def runs_here(manifest: dict) -> bool:
    """Whether a package is meant for this platform, the way npm decides."""
    for field, current in CURRENT.items():
        values = manifest.get(field)
        if not values:
            continue
        if isinstance(values, str):
            values = [values]
        allowed = [v for v in values if not v.startswith("!")]
        if f"!{current}" in values or (allowed and current not in allowed):
            return False
    return True


def cut_unused_optional_peers(store: Path, used: set[str]) -> int:
    """Unlink optional peers the server never imports, wherever linked."""
    cut = 0
    for entry in store.iterdir():
        if entry.name.startswith(".") or entry.name == "node_modules":
            continue
        for package in packages_in(entry):
            if package.is_symlink() or not (package / "package.json").is_file():
                continue
            manifest = json.loads(
                (package / "package.json").read_text(encoding="utf-8")
            )
            optional = [
                peer
                for peer, meta in manifest.get("peerDependenciesMeta", {}).items()
                if meta.get("optional")
            ]
            for peer in optional:
                link = entry / "node_modules" / peer
                if not link.is_symlink():
                    continue
                target = store_entry(link, store)
                if target is not None and target.name not in used:
                    link.unlink()
                    cut += 1
    return cut


def main(argv: list[str]) -> int:
    if len(argv) != 3:
        print(f"usage: {argv[0]} <deployed package> <traced packages>", file=sys.stderr)
        return 2

    root = Path(argv[1]).resolve()
    node_modules = root / "node_modules"
    store = node_modules / ".pnpm"
    if not store.is_dir():
        print(f"{root} does not look like a pnpm deployment", file=sys.stderr)
        return 2

    used = set(Path(argv[2]).read_text(encoding="utf-8").split())
    before = size(node_modules)

    manifest = json.loads((root / "package.json").read_text(encoding="utf-8"))
    roots = set(manifest.get("dependencies", {}))

    try:
        missing = sorted(used - {e.name for e in store.iterdir()})
        if missing:
            raise PruneError(f"traced, but not deployed: {', '.join(missing)}")

        top_level = {str(p.relative_to(node_modules)): p for p in entries(node_modules)}
        missing = sorted(roots - set(top_level))
        if missing:
            raise PruneError(f"not deployed: {', '.join(missing)}")

        # Development dependencies go first, so nothing is reached through them.
        for name, link in top_level.items():
            if name not in roots:
                if link.is_symlink():
                    link.unlink()
                else:
                    shutil.rmtree(link)

        cut = cut_unused_optional_peers(store, used)

        # Everything that can be reached by following links from what is kept.
        reached: set[Path] = set()
        pending = [store_entry(top_level[name], store) for name in roots]
        while pending:
            entry = pending.pop()
            if entry is None or entry in reached:
                continue
            reached.add(entry)
            pending.extend(
                store_entry(dependency, store)
                for dependency in packages_in(entry)
                if dependency.exists()
            )

        # Packages built for another platform, like the esbuild binary for the
        # other architecture, which pnpm deploys for every one there is. The
        # package that picks between them only ever loads the one that fits.
        foreign = 0
        for entry in sorted(reached):
            for package in packages_in(entry):
                if package.is_symlink() or not (package / "package.json").is_file():
                    continue
                manifest = json.loads(
                    (package / "package.json").read_text(encoding="utf-8")
                )
                if not runs_here(manifest):
                    reached.discard(entry)
                    foreign += 1

        lost = sorted(used - {entry.name for entry in reached})
        if lost:
            raise PruneError(f"imported, but not reached: {', '.join(lost)}")

        removed = 0
        for entry in store.iterdir():
            if entry.name.startswith(".") or entry.name == "node_modules":
                continue
            if entry.is_dir() and entry not in reached:
                shutil.rmtree(entry)
                removed += 1

        # pnpm also links every package into .pnpm/node_modules, as a fallback
        # for packages that import something they did not declare, and gives
        # every binary a script in .bin. Those pointing at nothing now go too.
        dangling = 0
        for entry in [store, *reached]:
            for link in entries(entry / "node_modules"):
                if link.is_symlink() and not link.exists():
                    link.unlink()
                    dangling += 1
        for script in (node_modules / ".bin").iterdir():
            text = script.read_text(encoding="utf-8", errors="ignore")
            targets = re.findall(r'exec [^\n]*"\$basedir/\.\./([^"]+)"', text)
            if any(not (node_modules / target).exists() for target in targets):
                script.unlink()
                dangling += 1

        for name in roots:
            if not (node_modules / name / "package.json").is_file():
                raise PruneError(f"{name} did not survive pruning")
    except PruneError as err:
        print(f"Pruning the SparkyFitness server failed: {err}", file=sys.stderr)
        return 1

    after = size(node_modules)
    print(f"Pruned the SparkyFitness server in {root}")
    print(f"  kept {len(reached)} packages, removed {removed}")
    print(f"  {foreign} of those removed are for another platform")
    print(f"  cut {cut} unused optional peer link(s), {dangling} dangling link(s)")
    print(f"  {before / 2**20:.0f} MiB -> {after / 2**20:.0f} MiB")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
