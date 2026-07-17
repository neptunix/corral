# Security policy

corral's threat model: the server binds 127.0.0.1 and trusts whoever can reach the loopback
interface — the local operator on a single-user machine, but any local user or process on a
shared box. The highest-privilege surface is the WebSocket attach endpoint (hardening
described in the README). There is no auth layer.

**Reporting:** please use GitHub's private vulnerability reporting on this
repository (Security → Report a vulnerability) rather than a public issue.
Reports are acknowledged on a best-effort basis — this is a maintainer-run
open-source project, not a vendor with an SLA.
