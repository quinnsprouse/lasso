# Security

Supported: the latest published version of this package, and the `main` branch of the template.

Report a vulnerability privately through GitHub's "Report a vulnerability" form on this repository (Security → Advisories). Do not open a public issue for an unpatched vulnerability. Expect an acknowledgement within a week.

Releases use npm trusted publishing from `.github/workflows/release.yml`, without a long-lived npm token. npm generates provenance for public packages published from public repositories. A maintainer publishes the first version from a terminal, then configures the trusted publisher as described in CONTRIBUTING.md. The package declares zero runtime dependencies because tsdown bundles Effect. Audit the bundled libraries as well as the development tools when reviewing dependency vulnerabilities.
