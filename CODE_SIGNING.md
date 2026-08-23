# Code signing policy

This policy describes how official CrystalCut release artifacts are built,
reviewed, approved, signed, and published.

## Status

Windows code signing through the SignPath Foundation is being prepared and is
not yet active. Until a release explicitly states that its Windows artifacts
are signed, users should treat those artifacts as unsigned.

After sponsorship is approved, CrystalCut will display the following required
attribution on its project and release pages:

> Free code signing provided by SignPath.io, certificate by SignPath Foundation.

## Official project and downloads

- Source repository: <https://github.com/pkh31337/CrystalCut>
- Official releases: <https://github.com/pkh31337/CrystalCut/releases>
- Project website: <https://pkh31337.com>
- License: [Apache License 2.0](LICENSE), without commercial dual licensing

Only artifacts published from the official GitHub repository are CrystalCut
releases. Files obtained from mirrors, forks, pull-request builds, or third
parties are outside this policy.

## Signing scope

The planned SignPath signing scope is limited to official Windows x64 release
artifacts built from this repository:

- the CrystalCut application executable;
- the NSIS setup executable;
- the MSI installer; and
- project-owned executable components contained in those packages, when
  applicable.

Third-party binaries are not signed using the SignPath Foundation certificate
as if they were authored by CrystalCut. Development builds, pull-request
artifacts, local builds, and macOS packages are outside the SignPath
Authenticode signing scope. macOS uses its own Apple code-signing and
notarization process.

## Build provenance and release process

CrystalCut releases are built from version tags by the public
[GitHub Actions release workflow](.github/workflows/release.yml). The workflow
runs on GitHub-hosted runners and performs version validation before building
the Windows and macOS packages.

Once SignPath sponsorship is active, the Windows release process will:

1. check out the exact tagged revision from this repository;
2. install the dependencies pinned by `package-lock.json` and
   `src-tauri/Cargo.lock`;
3. validate that the tag matches the application manifests;
4. build the unsigned Windows application and installers on a GitHub-hosted
   Windows runner;
5. upload the unsigned package as a GitHub Actions artifact;
6. submit that artifact to SignPath with GitHub origin verification enabled;
7. require explicit approval from the signing approver;
8. retrieve and verify the signed artifact; and
9. publish only the verified artifact to the matching GitHub Release.

An artifact is never modified after signing. Any required change is built and
signed again under a new release version. Production signatures use a trusted
timestamp so that their validity can be checked after certificate renewal.

## Project and signing roles

CrystalCut is currently maintained by one developer. The roles required by the
SignPath Foundation are assigned as follows:

- **Author and committer:**
  [Park Kyungho (`pkh31337`)](https://github.com/pkh31337) maintains the source
  code, dependencies, build scripts, and release workflow.
- **Reviewer:** Park Kyungho reviews every contribution from non-committers
  before it is merged into the repository.
- **Signing approver:** Park Kyungho explicitly reviews and approves every
  production signing request. A tag or CI run alone does not grant signing
  approval.

Multi-factor authentication is required for the maintainer's GitHub and
SignPath accounts. Any future contributor who receives a signing role must
also use multi-factor authentication and be listed in this policy before
exercising that role.

## Release controls

- Release tags use the `vMAJOR.MINOR.PATCH` format.
- The version must match `package.json`, `src-tauri/tauri.conf.json`, and
  `src-tauri/Cargo.toml`.
- Official signing requests originate only from GitHub-hosted workflow jobs.
- SignPath credentials and API tokens are stored only as encrypted repository
  secrets with the minimum permissions required for signing.
- Each production request requires a human approval decision.
- Authenticode signatures and timestamps are verified before publication.
- Product name and version metadata must match the release being signed.

## Privacy and third-party components

CrystalCut processes source images locally and does not submit them to the
build or signing service. See the [CrystalCut privacy policy](PRIVACY.md) for
details about local data and model downloads.

Third-party dependencies and AI model assets retain their own licenses and are
documented in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). AI model weights
are downloaded on demand and are not embedded in the signed installers.

## Reporting concerns

Questions about this policy or the authenticity of a release can be reported
through the [CrystalCut issue tracker](https://github.com/pkh31337/CrystalCut/issues).
Do not include private images, credentials, or sensitive personal information
in a public issue.

