# Privacy notice (DRAFT)

> **DRAFT, needs legal review, not legal advice.** This is a starting point written by the
> engineering team from [DATA-HANDLING.md](../DATA-HANDLING.md). Names, addresses, legal
> bases, jurisdictions and retention commitments must be confirmed by counsel before
> publication. Placeholders are in `[brackets]`.

Last updated: [date]

## Who we are

[Company legal name], [address] ("LXS", "we") operates the LXS hosted honeypot service.
Contact: [privacy@REPLACE-ME.example].

## Two kinds of data

1. **Customer account data**: information about the people who sign up and use LXS. We are
   the controller for it.
2. **Decoy telemetry**: what third parties (typically attackers) do to the decoys our
   customers deploy, including IP addresses and credentials they typed. We process it on
   behalf of our customers, who decide to deploy decoys; for it we act as [processor] and the
   customer as [controller]. [Counsel: confirm roles and whether a DPA is offered.]

## Account data we collect

Email address, username, name, a hash of your password, your organization and role, IP
address and browser user agent on actions recorded in the audit log, and the settings you
configure. We use it to provide the service, secure accounts, send service emails
(verification, password reset, invitations, alerts you configure) and keep an audit trail.
[Legal basis: performance of contract / legitimate interests.]

## Decoy telemetry

Source IP addresses and ports, timestamps, requests, commands, files and credentials sent to
decoys. Passwords outside a public list of common defaults are stored only masked and hashed,
and every captured password is replaced by a one-way hash after [30] days. We use telemetry
only to detect, correlate and report attacks to the customer that owns the decoy.
[Legal basis: legitimate interests in network security, see recital 49 GDPR; counsel to
confirm.]

## Retention

Event data is kept for [30 / 90 / 365] days depending on the customer's plan, the original
sensor record for [7 / 14 / 30] days. Deleted projects are purged after [7] days; backups
age out after [14–35] days. Account data is kept while the account exists.

## Sharing

We do not sell data. Sub-processors: hosting ([AWS]), an LLM provider ([Anthropic / OpenAI /
Google]) when AI summaries are enabled (redacted incident summaries only), an email provider
([Resend]), and [Cloudflare Turnstile] for bot checks. Alerts go where the customer routes
them (Slack, webhooks). [List and locations to be confirmed; international transfer
mechanism to be confirmed.]

## Your choices and rights

Owners can export a project's data and delete projects from Settings → Data. Any user can
delete their account there (password required). You may have rights to access, correct,
delete, restrict or object to processing, and to complain to a supervisory authority.
Contact [privacy@REPLACE-ME.example]. People whose IP appears in decoy telemetry should
contact the customer that deployed the decoy; we will assist that customer.

## Security

Encryption in transit, encrypted alert credentials, hashed passwords and keys, role-based
access and an audit log. Report vulnerabilities per [SECURITY.md](../../SECURITY.md).

## Changes

We will post changes here and notify account owners of material ones by email.
