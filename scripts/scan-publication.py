"""Read-only publication inventory/secret-pattern/PE-string checks.

Writes reports only under artifacts/. Does not stage, commit, publish, execute an
installer, change credentials or shut down the computer. Printed findings never
contain credential values, email addresses or local user names.
"""
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import re
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ROOT_FILES = [
    ".gitignore", ".gitattributes", "README.md", "LICENSE", "LICENSE.md",
    "LEGAL.md", "PRIVACY.md", "AUTHORS.md", "NOTICE", "NOTICE.md",
    "THIRD_PARTY_NOTICES.md", "THIRD-PARTY-NOTICES.md", "SECURITY.md", "CONTRIBUTING.md",
    "CODE_OF_CONDUCT.md", "package.json", "package-lock.json", "tsconfig.json",
    "vite.config.ts", "index.html", "Avvia Database Manager.cmd",
]
PATTERNS = {
    "github_token": re.compile(r"\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{30,})"),
    "api_secret_token": re.compile(r"\bsk-[A-Za-z0-9_-]{20,}"),
    "aws_access_key": re.compile(r"\b(?:AKIA|ASIA)[A-Z0-9]{16}\b"),
    "private_key": re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----"),
    "jwt": re.compile(r"\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}"),
}
USER_HOME = re.compile(r"(?i)(?<![a-z0-9_])[a-z]:[\\/]+Users[\\/]+([^\\/\s\"']+)")
UNIX_HOME = re.compile(r"(?<![a-z0-9_])/(?:Users|home)/([a-zA-Z0-9._-]+)")
PERSONAL_MAIL = re.compile(r"(?i)\b[\w.+-]+@(?:gmail\.com|outlook\.[a-z]+|hotmail\.[a-z]+|icloud\.com)\b")
CREDENTIAL_URI = re.compile(r"\b(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?):\/\/([^\s/@\"']+):([^\s/@\"']+)@")
GENERIC_USERS = {"public", "default", "defaultuser", "allusers", "user", "username", "user_name", "your_username", "your_user", "runner", "build"}
IMAGE_EXTENSIONS = {".png", ".ico", ".jpg", ".jpeg", ".webp", ".svg"}


def relative(path: Path) -> str:
    return path.relative_to(ROOT).as_posix()


def add_tree(files: set[Path], folder: str, extensions: set[str]) -> None:
    base = ROOT / folder
    if not base.is_dir():
        return
    for path in base.rglob("*"):
        if path.is_file() and not path.is_symlink() and path.suffix.lower() in extensions:
            # No generic 'bin' exclusion: src-tauri/src/bin/bridge.rs is own source.
            if any(part in {"node_modules", "target", ".git", "__pycache__"} for part in path.relative_to(base).parts):
                continue
            files.add(path)


def inventory() -> tuple[list[Path], list[dict]]:
    files = {ROOT / name for name in ROOT_FILES if (ROOT / name).is_file()}
    add_tree(files, "src", {".ts", ".tsx", ".css", ".json"})
    add_tree(files, "src-tauri/src", {".rs", ".md", ".sql", ".json"})
    add_tree(files, "src-tauri/tests", {".rs", ".sql", ".json"})
    add_tree(files, "src-tauri/capabilities", {".json", ".toml"})
    add_tree(files, "src-tauri/icons", {".png", ".ico"})
    add_tree(files, "docs", {".md", ".json", ".png", ".jpg", ".webp", ".svg"})
    add_tree(files, "scripts", {".ps1", ".py", ".cmd", ".sh"})
    add_tree(files, ".github", {".yml", ".yaml", ".md", ".json"})
    for name in ["Cargo.toml", "Cargo.lock", "build.rs", "tauri.conf.json"]:
        path = ROOT / "src-tauri" / name
        if path.is_file():
            files.add(path)
    # Only own QA entry points/manifests, never downloaded tools/generated trees.
    qa = ROOT / "tests/codegen"
    if qa.is_dir():
        files.update(path for path in qa.glob("*.py") if path.is_file())
        for name in [".gitignore", "Cargo.toml", "Cargo.lock", "package.json", "package-lock.json"]:
            path = qa / name
            if path.is_file():
                files.add(path)
        add_tree(files, "tests/codegen/src", {".rs"})
    license_issues = []
    manifest = ROOT / "licenses/dependency-inventory.json"
    if manifest.is_file():
        files.add(manifest)
        supplements = ROOT / "licenses/upstream-supplements.json"
        if supplements.is_file():
            files.add(supplements)
        index = ROOT / "licenses/INDEX.md"
        if index.is_file():
            files.add(index)
        data = json.loads(manifest.read_text(encoding="utf-8"))

        def legal_entries(value):
            if isinstance(value, dict):
                if isinstance(value.get("path"), str) and value["path"].startswith("licenses/") and "sha256" in value:
                    yield value
                for item in value.values():
                    yield from legal_entries(item)
            elif isinstance(value, list):
                for item in value:
                    yield from legal_entries(item)

        for entry in legal_entries(data):
            path = ROOT / entry["path"]
            try:
                path.resolve().relative_to((ROOT / "licenses").resolve())
            except ValueError:
                license_issues.append({"path": entry["path"], "issue": "outside licenses/"})
                continue
            if not path.is_file() or path.is_symlink():
                license_issues.append({"path": entry["path"], "issue": "missing or link"})
            elif hashlib.sha256(path.read_bytes()).hexdigest() != entry["sha256"]:
                license_issues.append({"path": entry["path"], "issue": "manifest hash mismatch"})
            else:
                files.add(path)
    return sorted(files), license_issues


def scan_sources(files: list[Path]) -> dict:
    strong, homes, emails, uris, images = [], [], [], [], []
    for path in files:
        name = relative(path)
        legal = name.startswith("licenses/")
        if path.suffix.lower() in IMAGE_EXTENSIONS:
            images.append(name)
            continue
        for number, line in enumerate(path.read_text(encoding="utf-8", errors="replace").splitlines(), 1):
            for kind, pattern in PATTERNS.items():
                if pattern.search(line):
                    strong.append({"path": name, "line": number, "kind": kind, "value": "REDACTED"})
            for pattern in [USER_HOME, UNIX_HOME]:
                match = pattern.search(line)
                if match and match[1].casefold() not in GENERIC_USERS and not match[1].startswith("<"):
                    homes.append({"path": name, "line": number, "kind": "absolute_user_home_path", "thirdPartyLegalText": legal})
            if PERSONAL_MAIL.search(line):
                emails.append({"path": name, "line": number, "kind": "contact_email", "thirdPartyLegalText": legal, "note": "Public license contacts must be preserved; owning-source emails require review."})
            match = CREDENTIAL_URI.search(line)
            if match:
                resolution = "manual review required"
                if "{" in match[0] or "$" in match[0]:
                    resolution = "dynamic variable/format placeholder"
                elif match[1].upper() in {"USER", "USERNAME"} and match[2].upper() in {"PASS", "PASSWORD"}:
                    resolution = "generic sample placeholders"
                uris.append({"path": name, "line": number, "kind": "credential_uri", "resolution": resolution, "value": "REDACTED"})
    return {"strongCredentialPatternFindings": strong, "userHomePathFindings": homes, "contactEmailFindings": emails, "credentialUriFindings": uris, "imagesRequiringVisualReview": images}


def scan_asset(path: Path) -> dict:
    data = path.read_bytes()
    homes = USER_HOME.finditer(data.decode("latin-1"))
    count = sum(match[1].casefold() not in GENERIC_USERS and not match[1].startswith("<") for match in homes)
    wide = len(re.findall(rb"(?i)[a-z]\x00:\x00(?:\\\x00|/\x00)U\x00s\x00e\x00r\x00s\x00(?:\\\x00|/\x00)", data))
    strong = [kind for kind, pattern in PATTERNS.items() if pattern.search(data.decode("latin-1"))]
    return {"file": relative(path), "size": len(data), "sha256": hashlib.sha256(data).hexdigest(), "privateAsciiUserHomeReferences": count, "utf16UserHomePrefixReferences": wide, "strongCredentialPatternKinds": strong, "limitation": "Byte-string scan; compressed installer payload is not independently unpacked. Pair with the scanned portable binary built from the same release."}


def git_author_metadata() -> dict:
    result = subprocess.run(["git", "config", "--get", "user.email"], cwd=ROOT, capture_output=True, text=True)
    email = result.stdout.strip()
    return {"configured": bool(email), "scope": "effective configuration, including repository-local override", "usesGitHubNoReply": email.endswith("@users.noreply.github.com"), "value": "NOT RECORDED", "note": "Prefer repository-local GitHub no-reply author metadata if a private contact address should not enter public history."}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", default="artifacts/publication-20261109")
    parser.add_argument("--assets", nargs="*", default=[])
    args = parser.parse_args()
    output = (ROOT / args.output).resolve()
    output.relative_to((ROOT / "artifacts").resolve())
    output.mkdir(parents=True, exist_ok=True)
    files, legal_issues = inventory()
    scan = scan_sources(files)
    assets = []
    for value in args.assets:
        path = (ROOT / value).resolve()
        path.relative_to(ROOT.resolve())
        assets.append(scan_asset(path))
    report = {"createdAt": dt.datetime.now(dt.timezone.utc).isoformat(), "candidateFiles": len(files), "candidateBytes": sum(path.stat().st_size for path in files), "scope": "Exact owned-source allowlist plus only legal texts referenced by the license inventory; no caches, generated programs, runtimes, local databases or raw REA evidence.", "allowlistCandidate": [relative(path) for path in files], "scan": scan, "licenseManifestIssues": legal_issues, "gitAuthorMetadata": git_author_metadata(), "assets": assets, "assetScanRequested": bool(args.assets)}
    report["sourceReadyForReview"] = not (scan["strongCredentialPatternFindings"] or [item for item in scan["userHomePathFindings"] if not item["thirdPartyLegalText"]] or legal_issues or [item for item in scan["credentialUriFindings"] if item["resolution"] == "manual review required"])
    report["assetByteScanPass"] = bool(assets) and all(not (item["privateAsciiUserHomeReferences"] or item["utf16UserHomePrefixReferences"] or item["strongCredentialPatternKinds"]) for item in assets)
    (output / "initial-commit-allowlist.txt").write_text("\n".join(report["allowlistCandidate"]) + "\n", encoding="utf-8")
    (output / "source-sha256.json").write_text(json.dumps({relative(path): hashlib.sha256(path.read_bytes()).hexdigest() for path in files}, indent=2), encoding="utf-8")
    (output / "source-scan.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    if assets:
        (output / "release-byte-scan.json").write_text(json.dumps(assets, ensure_ascii=False, indent=2), encoding="utf-8")
    summary = {"candidateFiles": len(files), "candidateBytes": report["candidateBytes"], "sourceReadyForReview": report["sourceReadyForReview"], "strongCredentialFindings": len(scan["strongCredentialPatternFindings"]), "ownUserHomeFindings": len([item for item in scan["userHomePathFindings"] if not item["thirdPartyLegalText"]]), "ownContactEmailFindings": len([item for item in scan["contactEmailFindings"] if not item["thirdPartyLegalText"]]), "thirdPartyLegalContacts": len([item for item in scan["contactEmailFindings"] if item["thirdPartyLegalText"]]), "licenseManifestIssues": len(legal_issues), "assetByteScanPass": report["assetByteScanPass"] if assets else "not requested", "allowlist": str(output / "initial-commit-allowlist.txt"), "report": str(output / "source-scan.json"), "gitAuthorUsesNoReply": report["gitAuthorMetadata"]["usesGitHubNoReply"]}
    (output / "publication-audit.md").write_text("# Publication inventory review\n\n```json\n" + json.dumps(summary, ensure_ascii=False, indent=2) + "\n```\n\nThe allowlist is an explicit path list, not permission to stage whole directories. Re-run after source/legal changes. No staging, publication, installer execution or shutdown was performed. Pattern scans do not constitute a comprehensive security audit. Third-party public copyright/contact notices are distinct from private application data. Images require visual review; compressed installer payloads are not independently unpacked by this script.\n", encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 0 if report["sourceReadyForReview"] and (not assets or report["assetByteScanPass"]) else 1


if __name__ == "__main__":
    raise SystemExit(main())
