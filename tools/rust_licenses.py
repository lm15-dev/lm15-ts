"""Collect shipped Rust dependency notices from Cargo's locked wasm dependency graph.

Run where the crate was built (the build server locally, or the GitHub runner).
Only metadata is queried; this command does not compile anything.
"""
import json
from pathlib import Path
import subprocess
import sys

repo = Path(sys.argv[1]).resolve()
metadata = json.loads(subprocess.check_output([
    "cargo", "metadata", "--locked", "--format-version", "1",
    "--filter-platform", "wasm32-unknown-unknown", "--no-default-features", "--features", "wasm",
], cwd=repo))
packages = {package["id"]: package for package in metadata["packages"]}
nodes = {node["id"]: node for node in metadata["resolve"]["nodes"]}
root = metadata["resolve"]["root"]
seen = set()

def visit(package):
    if package in seen:
        return
    seen.add(package)
    for dependency in nodes[package]["deps"]:
        if any(kind["kind"] != "dev" for kind in dependency["dep_kinds"]):
            visit(dependency["pkg"])

visit(root)
print("Rust dependencies used by the LM15 WebAssembly codec\n")
for package_id in sorted(seen, key=lambda item: packages[item]["name"]):
    if package_id == root:
        continue
    package = packages[package_id]
    folder = Path(package["manifest_path"]).parent
    notices = set()
    if package.get("license_file"):
        notices.add(folder / package["license_file"])
    for pattern in ["LICENSE*", "LICENCE*", "COPYING*", "NOTICE*", "license*", "licenses/*"]:
        notices.update(path for path in folder.glob(pattern) if path.is_file())
    if not notices:
        raise RuntimeError(f"No bundled license notice for {package['name']} {package['version']}; review before publishing")
    print("\n" + "=" * 72)
    print(f"{package['name']} {package['version']} — {package.get('license', '')}")
    print(package.get("repository", ""))
    for path in sorted(notices):
        print(f"\n--- {path.relative_to(folder)} ---\n")
        print(path.read_text())
