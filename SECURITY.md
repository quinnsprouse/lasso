# Security

Supported: the latest published version of this package, and the `main` branch of the template.

Report a vulnerability privately through GitHub's "Report a vulnerability" form on this repository (Security → Advisories). Do not open a public issue for an unpatched vulnerability. Expect an acknowledgement within a week.

Releases are published from `.github/workflows/release.yml` through npm trusted publishing with provenance: the workflow attests and publishes the same tarball and does not use a long-lived npm token. The very first version of a package is published from a maintainer's terminal, because npm cannot register a trusted publisher before the package exists. The published package has zero runtime dependencies (`tsdown` bundles Effect); `npm audit` findings concern the development toolchain only.
