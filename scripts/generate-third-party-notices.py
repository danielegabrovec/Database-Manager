#!/usr/bin/env python3
"""Inventory locked app dependencies and preserve their original legal texts.

Requires the existing npm installation and Cargo registry cache. Does not install,
execute dependency code, choose the project's own license, or publish anything.
"""
import argparse
from collections import Counter, deque
from datetime import date
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tarfile
import tomllib
import zipfile

ROOT = Path(__file__).resolve().parents[1]
LEGAL = ROOT / "licenses"
PROJECT_VERSION = json.loads((ROOT / "package.json").read_text(encoding="utf8"))["version"]
RELEASE_TAG = "v" + PROJECT_VERSION
RELEASE_URL = f"https://github.com/danielegabrovec/Database-Manager/releases/tag/{RELEASE_TAG}"
MPL_ASSET_URL = f"https://github.com/danielegabrovec/Database-Manager/releases/download/{RELEASE_TAG}/third-party-mpl-sources.zip"
LEGAL_NAME = re.compile(r"licen[cs]e|copying|copyright|notice|third[-_ ]?party[-_ ]?notices", re.I)

def sha(data): return hashlib.sha256(data).hexdigest()
def slug(text): return re.sub(r"[^A-Za-z0-9._+-]+", "_", text).strip("._")
def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

def legal_files(package_root):
    """Preserve license/notice files, including bundled subcomponent notices."""
    result = []
    for base, directories, files in os.walk(package_root, followlinks=False):
        directories[:] = [d for d in directories if d not in {"node_modules", ".git", "target", "__pycache__"} and not (Path(base) / d).is_symlink()]
        for name in files:
            path = Path(base) / name
            if LEGAL_NAME.search(name) and not path.is_symlink() and path.stat().st_size <= 2 * 1024 * 1024:
                # Names such as license.rs and license.test.js are implementation,
                # not legal text. Real LICENSE/NOTICE text has no such extension.
                if path.suffix.lower() not in {".rs", ".js", ".ts", ".py", ".c", ".h", ".json", ".toml", ".map", ".png", ".svg", ".wasm"}:
                    result.append(path)
    return sorted(result)

def copyright_headers(package_root):
    found = set()
    # This is a bounded attribution recovery for crates whose published archive
    # has a license declaration but no standalone license file (e.g. selectors).
    for path in sorted(package_root.rglob("*.rs"))[:250]:
        for line in path.read_text(encoding="utf8", errors="replace").splitlines()[:20]:
            if "copyright" in line.lower(): found.add(line.strip().lstrip("/* ").rstrip("*/ "))
    return sorted(found)

def copy_legal_files(package_root, destination, checksum_files=None):
    copied = []
    for path in legal_files(package_root):
        relative = path.relative_to(package_root).as_posix()
        data = path.read_bytes()
        expected = (checksum_files or {}).get(relative)
        if expected and sha(data) != expected:
            raise RuntimeError(f"License file differs from Cargo checksum: {package_root.name}/{relative}")
        target = destination / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
        copied.append({"path":target.relative_to(ROOT).as_posix(), "sha256":sha(data), "bytes":len(data), "packageChecksumVerified":bool(expected)})
    return copied

def normal_closure(metadata):
    nodes = {n["id"]:n for n in metadata["resolve"]["nodes"]}
    queue = deque(metadata["workspace_members"]); seen = set()
    while queue:
        identifier = queue.popleft()
        if identifier in seen: continue
        seen.add(identifier)
        for dep in nodes.get(identifier, {}).get("deps", []):
            if any(kind.get("kind") is None for kind in dep.get("dep_kinds", [])): queue.append(dep["pkg"])
    return seen

def metadata_windows():
    result = subprocess.run(["cargo", "metadata", "--manifest-path", str(ROOT / "src-tauri/Cargo.toml"), "--locked", "--offline", "--format-version", "1", "--filter-platform", "x86_64-pc-windows-msvc"], cwd=ROOT, capture_output=True, text=True, encoding="utf8")
    if result.returncode: raise RuntimeError("Cargo metadata offline failed. Populate the existing locked Windows dependency cache before regenerating notices.\n" + result.stderr)
    return json.loads(result.stdout)

def npm_inventory():
    lock = json.loads((ROOT / "package-lock.json").read_text(encoding="utf8"))
    rows = []
    for location, locked in sorted(lock["packages"].items()):
        if not location: continue
        package_root = ROOT / location
        installed = package_root.is_dir()
        package = json.loads((package_root / "package.json").read_text(encoding="utf8")) if installed and (package_root / "package.json").is_file() else {}
        name = package.get("name") or location.split("node_modules/")[-1]
        version = locked.get("version", package.get("version", "unknown"))
        license_value = locked.get("license") or package.get("license") or "UNDECLARED"
        if isinstance(license_value, dict): license_value = license_value.get("type", "UNDECLARED")
        destination = LEGAL / "third-party/npm" / slug(f"{name}-{version}")
        copied = copy_legal_files(package_root, destination) if installed else []
        notice_origin = None
        if installed and not copied:
            family = "esbuild" if name.startswith("@esbuild/") else "rollup" if name.startswith("@rollup/rollup-") else "@tauri-apps/cli" if name.startswith("@tauri-apps/cli-") else None
            if family:
                family_root = ROOT / "node_modules" / family
                family_package = json.loads((family_root / "package.json").read_text(encoding="utf8"))
                if family_package.get("version") == version:
                    copied = copy_legal_files(family_root, destination)
                    notice_origin = f"Same-version upstream package {family}@{version}; platform binary package omits standalone legal text"
        rows.append({"ecosystem":"npm", "name":name, "version":version, "declaredLicense":license_value,
                     "distributionOption":"Apache-2.0" if name=="dompurify" else None,
                     "scope":"development/build" if locked.get("dev") else "frontend dependency",
                     "optional":bool(locked.get("optional")), "installedForAudit":installed,
                     "sourceUrl":f"https://www.npmjs.com/package/{name}/v/{version}",
                     "repository":package.get("repository"), "copyrightHolderMetadata":package.get("author"),
                     "licenseNoticeOrigin":notice_origin,
                     "licenseTexts":copied})
    return rows

def cargo_inventory(metadata):
    normal = normal_closure(metadata)
    own = set(metadata["workspace_members"])
    rows = []; mpl_packages = []
    for package in sorted(metadata["packages"], key=lambda p:(p["name"],p["version"])):
        if package["id"] in own: continue
        package_root = Path(package["manifest_path"]).parent
        checksums = json.loads((package_root / ".cargo-checksum.json").read_text()) if (package_root / ".cargo-checksum.json").is_file() else {}
        destination = LEGAL / "third-party/cargo" / slug(f"{package['name']}-{package['version']}")
        copied = copy_legal_files(package_root, destination, checksums.get("files"))
        supplements_path = LEGAL / "upstream-supplements.json"
        supplements = json.loads(supplements_path.read_text(encoding="utf8")) if supplements_path.is_file() else []
        for supplement in supplements:
            if supplement["name"] == package["name"] and supplement["version"] == package["version"]:
                path = ROOT / supplement["path"]
                if sha(path.read_bytes()) != supplement["sha256"]: raise RuntimeError("Upstream license supplement checksum mismatch")
                copied.append(supplement)
        license_value = package.get("license") or "UNDECLARED"
        # The published selectors archive declares MPL-2.0 through headers and
        # Cargo metadata but does not contain a standalone full license document.
        if not copied:
            headers = copyright_headers(package_root)
            source = f"Package: {package['name']} {package['version']}\nDeclared license: {license_value}\nUpstream authors: {', '.join(package.get('authors',[]))}\nSource: https://crates.io/api/v1/crates/{package['name']}/{package['version']}/download\n\n" + "\n".join(headers) + "\n"
            attribution = destination / "ATTRIBUTION-METADATA.txt"; attribution.parent.mkdir(parents=True,exist_ok=True); attribution.write_text(source,encoding="utf8")
            copied.append({"path":attribution.relative_to(ROOT).as_posix(),"sha256":sha(attribution.read_bytes()),"bytes":attribution.stat().st_size,"packageChecksumVerified":False,"generatedAttributionMetadata":True})
            if license_value=="MPL-2.0":
                canonical = next(Path(p["manifest_path"]).parent / "LICENSE" for p in metadata["packages"] if p["name"]=="cssparser")
                target = destination / "LICENSE-MPL-2.0.txt";target.write_bytes(canonical.read_bytes())
                copied.append({"path":target.relative_to(ROOT).as_posix(),"sha256":sha(target.read_bytes()),"bytes":target.stat().st_size,"standardLicenseSupplement":True})
        proc_macro = any("proc-macro" in target.get("kind",[]) for target in package.get("targets",[]))
        rows.append({"ecosystem":"cargo", "name":package["name"],"version":package["version"],"declaredLicense":license_value,
                     "scope":"macro/build tool" if proc_macro else "normal dependency closure" if package["id"] in normal else "build/development dependency",
                     "sourceUrl":f"https://crates.io/api/v1/crates/{package['name']}/{package['version']}/download",
                     "repository":package.get("repository"),"copyrightHolderMetadata":package.get("authors",[]),
                     "crateChecksum":checksums.get("package"),"licenseTexts":copied})
        if license_value=="MPL-2.0": mpl_packages.append(package)
    return rows, mpl_packages

def mpl_source_archive(packages, output):
    lock = tomllib.loads((ROOT / "src-tauri/Cargo.lock").read_text(encoding="utf8"))
    checksums = {(p["name"],p["version"]):p.get("checksum") for p in lock["package"]}
    cargo_home = Path(os.environ.get("CARGO_HOME", Path.home() / ".cargo"))
    entries = []; payload = []
    for package in sorted(packages,key=lambda p:p["name"]):
        name,version=package["name"],package["version"]
        matches=list((cargo_home / "registry/cache").glob(f"*/{name}-{version}.crate"))
        if not matches: raise RuntimeError(f"Original cached source archive missing for {name} {version}")
        archive=matches[0]; data=archive.read_bytes(); expected=checksums[(name,version)]
        if sha(data)!=expected: raise RuntimeError(f"Original archive checksum mismatch for {name} {version}")
        files=[]
        with tarfile.open(archive,"r:gz") as source:
            for member in sorted(source.getmembers(),key=lambda p:p.name):
                if not member.isfile():
                    if member.isdir():continue
                    raise RuntimeError(f"Unsupported source archive entry: {name}/{member.name}")
                path=Path(member.name)
                if path.is_absolute() or ".." in path.parts:raise RuntimeError("Unsafe upstream source archive path")
                content=source.extractfile(member).read();payload.append((member.name,content));files.append({"path":member.name,"sha256":sha(content),"bytes":len(content)})
        entries.append({"name":name,"version":version,"license":"MPL-2.0","modified":False,"originalCrateSha256":expected,"sourceUrl":f"https://static.crates.io/crates/{name}/{name}-{version}.crate","files":files})
    output.mkdir(parents=True,exist_ok=True)
    source_manifest={"schemaVersion":1,"releaseTag":RELEASE_TAG,"scope":f"Unmodified published source of {len(entries)} MPL-2.0 crates; excludes Database Manager original source and any server binary/toolchain.","packages":entries}
    payload.append(("SOURCES.json",(json.dumps(source_manifest,ensure_ascii=False,indent=2)+"\n").encode()))
    payload.append(("README.txt",b"MPL-2.0 third-party source availability\n\nThese are the unmodified regular files from the original five crates.io source archives, verified against Cargo.lock SHA-256. No runtime binaries or private build paths are included. SOURCES.json identifies versions, upstream source URLs, archive checksums and every included file. Package-specific source headers remain intact. Database Manager original code and its separate project license are not relicensed by this archive.\n"))
    archive_path=output / "third-party-mpl-sources.zip"
    with zipfile.ZipFile(archive_path,"w",zipfile.ZIP_DEFLATED,compresslevel=9) as archive:
        for name,content in sorted(payload):
            info=zipfile.ZipInfo(name,(2026,11,9,0,0,0));info.compress_type=zipfile.ZIP_DEFLATED;info.external_attr=0o100644<<16;archive.writestr(info,content)
    public={"asset":"third-party-mpl-sources.zip","releaseTag":RELEASE_TAG,"releaseUrl":RELEASE_URL,"assetUrl":MPL_ASSET_URL,"sha256":sha(archive_path.read_bytes()),"bytes":archive_path.stat().st_size,"packages":[{k:v for k,v in p.items() if k!="files"} for p in entries]}
    write_json(output / "third-party-mpl-sources-manifest.json",public)
    return public

def nsis_notices():
    roots=[]
    for parent in [Path(os.environ.get("LOCALAPPDATA","."))/"tauri",Path(os.environ.get("LOCALAPPDATA","."))/"tauri-bundler"]:
        if parent.is_dir():roots.extend(p for p in parent.glob("*") if p.is_dir() and "nsis" in p.name.lower())
    copied=[]
    for root in roots:
        copied.extend(copy_legal_files(root,LEGAL / "build-tools/nsis"))
    return copied

def verify_inventory(output):
    inventory=json.loads((LEGAL/"dependency-inventory.json").read_text(encoding="utf8"))
    current=json.loads((ROOT/"package.json").read_text(encoding="utf8"))
    if inventory["project"]["version"]!=current["version"]:raise RuntimeError("Inventory version does not match package.json")
    for name,expected in inventory["lockSha256"].items():
        if sha((ROOT/name).read_bytes())!=expected:raise RuntimeError(f"Locked dependencies changed: {name}; regenerate notices")
    count=0
    for package in inventory["packages"]:
        if package.get("installedForAudit",True) and not package["licenseTexts"]:raise RuntimeError("Installed package without legal text")
        for item in package["licenseTexts"]:
            path=ROOT/item["path"]
            if not path.resolve().is_relative_to(ROOT.resolve()) or not path.is_file():raise RuntimeError("Missing or external legal file")
            if sha(path.read_bytes())!=item["sha256"]:raise RuntimeError(f"Legal text changed: {item['path']}")
            count+=1
    asset=output/inventory["mplSourceAsset"]["asset"]
    if sha(asset.read_bytes())!=inventory["mplSourceAsset"]["sha256"]:raise RuntimeError("MPL source ZIP checksum mismatch")
    with zipfile.ZipFile(asset) as archive:
        sources=json.loads(archive.read("SOURCES.json"))
        if sources.get("releaseTag")!=RELEASE_TAG or inventory["mplSourceAsset"].get("releaseTag")!=RELEASE_TAG:raise RuntimeError("MPL source asset release tag differs from package.json")
        for package in sources["packages"]:
            for item in package["files"]:
                if sha(archive.read(item["path"]))!=item["sha256"]:raise RuntimeError("MPL source file mismatch")
    text=(LEGAL/"dependency-inventory.json").read_text(encoding="utf8")
    if re.search(r"[A-Za-z]:\\\\(?:Users|Program Files)|file:///",text):raise RuntimeError("Local/private path in public inventory")
    print(json.dumps({"verified":True,"packages":len(inventory["packages"]),"legalTextsChecked":count,"mplPackages":len(sources["packages"]),"sourceZipSha256":inventory["mplSourceAsset"]["sha256"],"privateBuildPathsInInventory":False},indent=2))

def main():
    parser=argparse.ArgumentParser();parser.add_argument("--mpl-source-output",type=Path,default=ROOT / "artifacts/release-v050");parser.add_argument("--verify",action="store_true");args=parser.parse_args()
    if args.verify:return verify_inventory(args.mpl_source_output)
    LEGAL.mkdir(parents=True,exist_ok=True)
    metadata=metadata_windows();npm=npm_inventory();cargo,mpl=cargo_inventory(metadata)
    extra=nsis_notices();source_asset=mpl_source_archive(mpl,args.mpl_source_output)
    project=json.loads((ROOT / "package.json").read_text(encoding="utf8"))
    own=next(p for p in metadata["packages"] if p["id"] in metadata["workspace_members"])
    rows=npm+cargo
    missing=[{"ecosystem":p["ecosystem"],"name":p["name"],"version":p["version"],"scope":p["scope"]} for p in rows if not p["licenseTexts"] and p.get("installedForAudit",True)]
    inventory={"schemaVersion":1,"generatedOn":date.today().isoformat(),"project":{"name":project["name"],"version":project["version"],"authors":own.get("authors",[])},"target":"x86_64-pc-windows-msvc; default desktop features","scopeNote":"Locked application dependency inventory including build/dev tools. Does not assert that every listed package is linked or bundled into the installer.","lockSha256":{"package-lock.json":sha((ROOT/"package-lock.json").read_bytes()),"src-tauri/Cargo.lock":sha((ROOT/"src-tauri/Cargo.lock").read_bytes())},"packages":rows,"additionalBuildToolNotices":extra,"missingInstalledLicenseTexts":missing,"mplSourceAsset":source_asset}
    serialized=json.dumps(inventory,ensure_ascii=False,indent=2)
    # Never publish developer-machine paths present in cargo metadata.
    if re.search(r"[A-Za-z]:\\\\(?:Users|Program Files)|file:///",serialized):raise RuntimeError("Private/local path leaked into inventory")
    write_json(LEGAL / "dependency-inventory.json",inventory)
    lines=["# Third-party license index","","Generated from package-lock.json and the locked Windows desktop Cargo graph. Full legal texts are preserved in third-party/. Build/development and platform-optional packages are identified in dependency-inventory.json; this is not a binary-link map.","","| Ecosystem | Component | Declared license | Scope | Legal texts |","|---|---|---|---|---|"]
    for p in rows:
        links="; ".join(f"[{Path(f['path']).name}]({Path(f['path']).relative_to('licenses').as_posix()})" for f in p["licenseTexts"]) or "Not installed for this platform" if not p.get("installedForAudit",True) else "; ".join(f"[{Path(f['path']).name}]({Path(f['path']).relative_to('licenses').as_posix()})" for f in p["licenseTexts"]) or "See metadata"
        lines.append(f"| {p['ecosystem']} | {p['name']} {p['version']} | {str(p['declaredLicense']).replace('|','/')} | {p['scope']} | {links} |")
    (LEGAL / "INDEX.md").write_text("\n".join(lines)+"\n",encoding="utf8")
    summary={"npmPackages":len(npm),"cargoPackages":len(cargo),"fullLegalTextFiles":sum(len(p["licenseTexts"]) for p in rows)+len(extra),"licenseCounts":dict(Counter(str(p["declaredLicense"]) for p in rows)),"missingInstalledLicenseTexts":missing,"mplSourceAsset":source_asset}
    print(json.dumps(summary,ensure_ascii=False,indent=2))
    if missing:raise SystemExit("Some installed packages have no harvested legal text; inspect before release")

if __name__=="__main__":main()
