#!/usr/bin/env python3
"""Builds the ready-made firmware a release carries: for every Keychron keyboard the app knows,
Keychron's own keymap ("keychron", else "via", else "default") with the profile switcher module
(scripts/build_module.sh), then writes firmware.json, the list the app reads (firmware/quick.rs).

    QMK_DIR=/path/to/keychron/qmk_firmware python3 scripts/build_prebuilt.py <out dir> <tag> [keyboards...]

Keyboards whose own keymap doesn't build (a bug in Keychron's tree) are left out and listed at the
end: the app then points to the Firmware tab for them. Runs the builds in parallel.
"""
import hashlib
import json
import os
import shutil
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TEMPLATES = ("keychron", "via", "default")


def module_version() -> int:
    for line in (ROOT / "firmware/profile_switcher.c").read_text().splitlines():
        if line.startswith("#define PS_PROTO_VERSION"):
            return int(line.split()[2])
    raise SystemExit("PS_PROTO_VERSION not found")


def template_of(qmk: Path, kb: str) -> str | None:
    """The keymap build_module.sh picks: the first of TEMPLATES found up the keyboard's folders."""
    for name in TEMPLATES:
        d = qmk / "keyboards" / kb
        while d != qmk / "keyboards":
            if (d / "keymaps" / name).is_dir():
                return name
            d = d.parent
    return None


def git_head(qmk: Path) -> tuple[str, str]:
    """Which Keychron branch and commit the firmware was built from, for firmware.json.

    `check=True`: a git that fails here used to give back two empty strings, which the app then
    printed as "Keychron  at " and sliced into. The manifest is what tells a user what they are
    installing, so an unknown answer is a build failure, not a blank.
    """
    def run(*a: str) -> str:
        r = subprocess.run(["git", "-C", str(qmk), *a], capture_output=True, text=True, check=True)
        out = r.stdout.strip()
        if not out:
            raise SystemExit(f"git {' '.join(a)} in {qmk} said nothing: can't label the firmware.")
        return out

    return run("rev-parse", "--abbrev-ref", "HEAD"), run("rev-parse", "HEAD")


def build(qmk: Path, kb: str, out: Path, logs: Path) -> tuple[str, dict | None]:
    log = logs / (kb.replace("/", "_") + ".log")
    with open(log, "w") as f:
        ok = subprocess.run(["sh", str(ROOT / "scripts/build_module.sh"), kb], stdout=f, stderr=subprocess.STDOUT,
                            env={**os.environ, "QMK_DIR": str(qmk)}).returncode == 0
    built = qmk / (kb.replace("/", "_") + "_ps_check.bin")
    if not ok or not built.exists():
        return kb, None
    name = kb.replace("/", "_") + "_companion.bin"
    shutil.copyfile(built, out / name)
    data = (out / name).read_bytes()
    return kb, {"file": name, "sha256": hashlib.sha256(data).hexdigest(), "size": len(data), "keymap": template_of(qmk, kb)}


def main() -> None:
    if len(sys.argv) < 3:
        raise SystemExit(__doc__)
    qmk = Path(os.environ.get("QMK_DIR") or sys.exit("set QMK_DIR"))
    out, tag = Path(sys.argv[1]), sys.argv[2]
    out.mkdir(parents=True, exist_ok=True)
    logs = out / "logs"
    logs.mkdir(exist_ok=True)
    index = json.loads((ROOT / "src/data/boards/index.json").read_text())
    wanted = sys.argv[3:] or sorted({b["firmware"] for b in index if b.get("firmware")})
    wanted = [kb for kb in wanted if template_of(qmk, kb)]
    print(f"building {len(wanted)} keyboards")
    # In parallel against one QMK tree. That is safe only because each build has its own keymap
    # folder (`keyboards/<kb>/keymaps/ps_check`) and its own `.build` output per keyboard, so two
    # builds never write the same file. Anything that starts sharing a path between keyboards has
    # to take a lock, or this quietly produces firmware built from another board's keymap.
    with ThreadPoolExecutor(max_workers=os.cpu_count() or 2) as pool:
        results = dict(pool.map(lambda kb: build(qmk, kb, out, logs), wanted))
    boards = {kb: r for kb, r in sorted(results.items()) if r}
    failed = sorted(kb for kb, r in results.items() if not r)
    manifest = {"tag": tag, "module": module_version(), "keychron": list(git_head(qmk)), "boards": boards}
    (out / "firmware.json").write_text(json.dumps(manifest, indent=1) + "\n", newline="\n")
    print(f"{len(boards)} built, {len(failed)} failed")
    for kb in failed:
        print(f"  FAIL {kb} (see logs/{kb.replace('/', '_')}.log)")


if __name__ == "__main__":
    main()
