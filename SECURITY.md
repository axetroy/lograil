# Security Policy

## Supported Versions

Only the latest published `0.x` release line receives security fixes. As the
library approaches `1.0`, the latest minor will be the supported version.

## Reporting a Vulnerability

**Please do not open public GitHub issues for security vulnerabilities.**

Report security issues privately so we can ship a fix before disclosure:

- **GitHub Security Advisories (preferred):** use
  [Report a vulnerability](https://github.com/axetroy/lograil/security/advisories/new)
  on the repository. This opens a private channel with the maintainers.
- **Email:** send details to **security@axetroy.dev** (PGP encouraged; key on
  request). Use the subject prefix `[lograil security]`.

Please include:

- a description of the vulnerability and its impact,
- steps to reproduce (a minimal PoC is ideal),
- affected version(s),
- any suggested mitigation if you have one.

We aim to acknowledge reports within **72 hours** and to provide a remediation
timeline within **7 days**. Once a fix is released we will coordinate public
disclosure with you.

## Security Considerations for Users

`lograil` is designed to be safe by default:

- Internal errors (in plugins, processors, formatters or transports) are caught
  and routed to `onError` / the native `console.error`; they never crash the
  caller. See the [immutability & zero-copy](../guide/immutability.md) guide.
- Sensitive fields (`password`, `token`, `authorization`, `cookie`, `secret`,
  …) are redacted by `createRedactProcessor()` out of the box.
- Cross-process (Electron IPC) entries are serialized once and transferred, not
  structured-cloned repeatedly.
- No outbound network traffic is initiated unless you add `OtlpTransport` or your
  own HTTP transport.

When logging, avoid putting raw secrets into `message`/`args`; prefer structured
`context`/`metadata` so the redactor can scrub them.
