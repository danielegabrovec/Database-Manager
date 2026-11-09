# Third-party notices — Database Manager 0.2.1

Database Manager's original application code is attributed to **Daniele Gabrovec**. The project's own terms are in `LICENSE` and `LEGAL.md`. Those terms do not replace the licenses or ownership notices of the third-party components below.

## Preserved licenses and provenance

The `licenses/` directory distributed with the Windows installer and portable package contains:

- `dependency-inventory.json`: exact package names, locked versions, declared license expressions, public source locations, legal-text paths and SHA-256 values;
- `INDEX.md`: a human-readable component index;
- `third-party/`: original LICENSE, NOTICE, COPYRIGHT and ThirdPartyNotices files collected from installed npm packages and the Cargo registry cache;
- `upstream/` and `upstream-supplements.json`: missing standalone notices retrieved from the upstream repositories at the commits identified by the published crates, with their source URLs and hashes.

The inventory covers the locked application npm dependencies and the Windows desktop Cargo graph, including development/build tools. It is intentionally broader than a list of code actually linked into the installer. Platform-optional npm packages not installed for this target are identified separately. Rust procedural macros and other build tools are not presented as application runtime features.

License expressions are preserved as declared upstream. `OR` indicates alternatives; `AND` indicates combined terms. Original copyright, attribution and warranty notices remain in the full texts. This notice grants no rights to third-party trademarks and claims no ownership over third-party code.

## MPL-2.0 covered source

The locked Rust dependency graph includes these MPL-2.0 components:

| Component | Version |
|---|---|
| cssparser | 0.37.0 |
| cssparser-macros | 0.7.1 |
| dtoa-short | 0.3.5 |
| option-ext | 0.2.0 |
| selectors | 0.38.0 |

Unmodified source for these exact versions is provided with the [v0.2.1 release](https://github.com/danielegabrovec/Database-Manager/releases/tag/v0.2.1) in [third-party-mpl-sources.zip](https://github.com/danielegabrovec/Database-Manager/releases/download/v0.2.1/third-party-mpl-sources.zip). Its `SOURCES.json` identifies every package, upstream source URL, original crate checksum and included file hash. The source archives are checked against `Cargo.lock`; existing source headers are preserved. This source-availability notice concerns those covered components, not a change to the license of Database Manager's separate original files. See the [MPL-2.0 text](https://www.mozilla.org/en-US/MPL/2.0/).

## Other component notices

- **DOMPurify 3.4.17** declares `MPL-2.0 OR Apache-2.0`; this distribution uses its **Apache-2.0 option**. Its upstream license texts remain included.
- **Monaco Editor** and its bundled components, including applicable font/icon notices, are covered by its preserved `LICENSE` and complete `ThirdPartyNotices.txt`. **Lucide** retains its ISC/Feather and contributor notices. These assets are not claimed as original artwork by Daniele Gabrovec.
- **ring** retains its combined Apache-2.0/ISC terms and BoringSSL/other bundled notices. **moka** retains its upstream `NOTICE`; components declaring multiple combined licenses retain each collected text.
- **webpki-roots** includes certificate data under CDLA-Permissive-2.0. Unicode components retain their Unicode license and copyright notices.
- **caniuse-lite** declares CC-BY-4.0 and is identified as development/build data. Its source attribution and license are preserved; it is not described as a separately shipped runtime feature.
- **SQLite** is included through the Rust bindings. The SQLite project identifies its deliverable library code as [public-domain software](https://sqlite.org/copyright.html); the Rust bindings have their own preserved license notices.

Database servers, Docker images, language SDKs and generated-project dependencies are separate products acquired or configured by the user. They are not bundled into this application merely because the application can connect to them or generate examples using their APIs. Downloaded QA toolchains, databases, native-server ZIP caches and REA evidence are excluded from the public application distribution. DBeaver and pgAdmin were studied for a documented comparison; their implementation code, branding and binaries are not incorporated into Database Manager.

Microsoft WebView2 and Windows system components remain subject to their own Microsoft terms. The installer/build tooling also retains its applicable upstream terms; app dependency metadata is not a claim of ownership over those components.

## Reproducing the inventory

After restoring the locked npm installation and Windows Cargo dependency cache, run:

```powershell
python scripts/generate-third-party-notices.py
```

The script does not install packages, run dependency code, choose the original project's license or publish a release. See `docs/LICENZE-DIPENDENZE.md` for the audit scope and release packaging details.
