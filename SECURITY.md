# Security policy

## Reporting a vulnerability

Please report security issues privately to **security@REPLACE-ME.example** (placeholder
until the project has a monitored address). Do not open a public issue for a vulnerability.

Include what you found, how to reproduce it, the affected component (API, worker, dashboard,
agent, SDK, decoys) and version or commit, and the impact you expect. Encrypt with
[PGP key placeholder] if the report contains sensitive data.

We aim to acknowledge within 3 business days, give an initial assessment within 10, and
agree a disclosure date with you once a fix is available. We credit reporters who want it.

## Scope

In scope: this repository and the hosted LXS service. Of special interest: cross-tenant
access, ingest-key or session bypass, decoy containment escapes, and exposure of captured
credentials or alert secrets.

Out of scope: the decoys being attacked (that is their job), denial of service by volume,
social engineering, and findings that need a compromised customer host.

## Safe harbour

Good-faith research that respects these rules, avoids privacy violations and service
disruption, and does not touch other customers' data will not be pursued by us.
[Counsel to confirm wording.]

## Data handling

What LXS stores and for how long: [docs/DATA-HANDLING.md](docs/DATA-HANDLING.md).
