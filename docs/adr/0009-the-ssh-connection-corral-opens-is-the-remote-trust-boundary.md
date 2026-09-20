# 9. The SSH connection corral opens is the remote trust boundary

## Context

Remote environments (`kind: "remote"`) have been first-class on the board for several releases: corral
polls them, spawns into them, reads their transcripts and statuslines, and attaches a live terminal to
their panes. Every one of those runs over `ssh <sshHost> '<herdr command>'` — corral dialling out.

Nothing ran the other way. A Claude session on a remote environment could not read its own card, log
to it, or hand off, because the MCP server is a stdio child of Claude that talks HTTP to corral on
**corral's** loopback (ADR 0002), and corral is on a different machine. Three properties made every
obvious fix wrong:

- **corral's loopback API is unauthenticated by construction.** Binding to `127.0.0.1` and checking
  `Host` is the whole of the access control, and the surface behind it includes spawn, close, board
  writes, fleet restore, and a live-terminal WebSocket — keystroke access to panes on the corral host.
  Anything that hands a remote host "the API" hands it the corral host.
- **The corral host is usually unreachable from the remote.** It is an operator's PC behind NAT, and
  no remote→corral SSH trust exists. corral→remote is the only direction that works.
- **Identity was allowed to be a hint because every caller was local.** ADR 0002 decision 4 resolves a
  caller from `HERDR_PANE_ID` plus a `HERDR_SOCKET_PATH` hint, both read from the caller's own
  environment and therefore chooseable by the caller. Pane ids (`w1:p1`) collide trivially across
  herdr servers, and a remote socket path is an arbitrary string that can repeat across hosts. A
  remote caller was, before this, resolvable to a **local** session and its card.

The last point was a live defect, not a hypothetical: a request carrying a local pane's id and a
foreign socket path resolved, and returned that local session's card, account and cost.

## Decision

**The SSH connection corral opens to an environment is that environment's trust boundary, and it is
the only thing that may assert which environment a caller is in.** Four consequences, which is why
this is one record and not four:

**1. One shared SSH connection per remote host, defined in one place.** `server/ssh-flags.ts` owns
`ControlMaster=auto`, `ControlPath=<CORRAL_HOME>/ssh/%C`, `ControlPersist` and the keepalives, passed
as `-o` flags on every corral `ssh` argv — one-shot herdr reads and the interactive attach alike.
corral does not inherit the operator's `~/.ssh/config` for these: it must *know* the ControlPath,
because consequence 3 rides `ssh -O forward` on that exact connection and cannot ask ssh_config what
path the operator chose.

**2. The ENVIRONMENT comes from the transport, never from a hint. This amends ADR 0002 decision 4.**
That decision stands unchanged for local callers: within an environment, pane id and
cwd remain hints resolved against the trusted config. What changes is that the socket hint is now a
**gate** rather than a tie-breaker — a hint naming no configured local environment's socket resolves
to nothing, even when exactly one local pane carries the caller's pane id — and that for a remote
caller the environment is not derived from the request at all. It is fixed by **which per-environment
listener the connection arrived on** (consequence 3). A remote caller cannot name its environment,
cannot name another one, and is never a candidate for local resolution.

Be precise about what that does and does not assert. The transport fixes ONE of the three
coordinates. Within the environment, the pane id still comes from the caller's own `HERDR_PANE_ID`,
and cwd from its own process — so anything running as the remote user can present itself as any pane
in that environment, and act as that session. That is the same-user boundary, and it is the one the
socket's `0600` mode already draws: a process that can connect to the socket can already read that
user's files, including the transcripts and config of every session it might impersonate. The
environment is what could not be re-established after the fact, and it is what this fixes. Because
the environment is no longer in question, the socket hint is not read at all on this path — an inert
caller-chosen string is an invitation to wire it back into a decision later.

Where this is implemented matters as much as the rule. The environment-pinned resolver is a separate
function from the local one, and the pinned identity is answered IN PROCESS, not through a
`/api/whoami?env=…` parameter. A query parameter would have ended the property that no request
reaching corral's loopback can name a remote environment — and that property, rather than the
authority the parameter would have granted, is what makes the amendment reviewable.

**3. The remote MCP surface is a per-environment unix socket that corral reverse-forwards, and the
MCP server stays on the corral host.** For each remote environment that configures an `mcpSocket`
path, corral holds `ssh -O forward -R <remote socket>:<per-env local socket>` on the shared
connection. sshd creates the remote socket as the remote user, mode `0600`, so only that account
reaches it; nothing listens on a TCP port and corral's HTTP port is never forwarded. On the remote, a
dependency-free Node shim speaks MCP stdio to Claude and pipes to that socket after one preamble line
carrying its pane hints. The shim holds no protocol knowledge beyond "preamble, then pipe", so there
is no repo checkout on the remote and no version skew between the remote and the corral server.

That listener is **not** the REST API: no live-terminal WebSocket, no fleet restore, no board
deletes, no upload route. What it serves is a reduced tool set, and the reduction is specifically
about the corral HOST, not about the board:

- **Session lifecycle is environment-scoped.** `corral_spawn` starts sessions only on the caller's
  own environment, and `corral_session_close` closes only sessions there — a card can hold sessions
  on several environments, so card membership alone would let a remote session close a pane on the
  operator's machine. `corral_fleet` is absent: a fleet-wide listing of every session, including
  local panes, their working directories and their statuslines, is not a remote session's business.
- **The board store is shared trust, deliberately.** A remote session can read any card on any board
  it knows the ids of, log to one, create one, and rewrite the description of the card it is bound to
  — exactly like a local session, because the board is the shared artefact sessions collaborate
  through and a card's collaborators are already mutually trusted by being on it. The consequence to
  name plainly: a remote session can write text that higher-trust local sessions later read. That is
  a prompt-injection channel, and it is the same one every session already has; it is why corral's
  own MCP instructions say that tool output is untrusted input to be reported, never followed.

So the property is "a remote session cannot reach the corral host", not "a remote session can only
see its own card".

Which listener a connection reaches is decided by the `mcpSocket` path in the trusted config, so that
path is the environment's identity in the same way the listener is. Two environments sharing one —
easily done when both are accounts on the same host — would silently pin every session of one to the
other's cards, which is precisely the misattribution this record claims to make structurally
impossible. corral refuses such a config at load rather than starting with it.

**4. corral may write files on remote hosts, and only under a private temp directory it creates.**
Spawn briefs and uploads stream over the shared connection's stdin into a `0700` directory owned by
the remote user. This is what lets a remote session spawn a neighbour on its own machine, which
consequence 3 would otherwise expose as a tool that always fails.

**Operator setup this requires, and why it is not corral's to do.** corral's key on a remote is
expected to be pinned with `restrict`, which disables forwarding. The key line needs
`port-forwarding` added:

```
restrict,port-forwarding,pty,from="<corral host>" ssh-ed25519 AAAA… corral@<corral host>
```

Verified against a real host before this was built, because the whole design rests on it: with
`restrict` alone the forward is refused; with `port-forwarding` added, a *streamlocal* (unix-socket)
reverse forward is accepted — not merely a TCP one — and the resulting remote socket is `srw-------`
owned by the remote user. No `sshd_config` change is needed:
`AllowStreamLocalForwarding` defaults to `yes`, and the key option was the only block. corral does not
edit `authorized_keys`; relaxing one's own hardening is an operator decision, and a remote that has
not made it simply has no remote MCP.

## Rationale

Moving the **process** rather than the **API** is what makes the reduced surface possible at all. With
the MCP server on the corral host, "what a remote session may do" is a list of registered tools in
corral's own code, reviewed with the rest of it. With the server on the remote, it would be whatever
the remote can reach over the wire, and the reduction would have to be re-implemented as an
authorising proxy — a second, weaker copy of the trust boundary.

A unix socket, not a TCP port, because the boundary has to survive the remote host having other
accounts on it. A loopback TCP port on the remote is reachable by **every** local account there; a
unix socket created by sshd is `0600` and owned by the one user. This is the difference between "the
remote user gets corral's tools" and "anyone with a shell on that box does".

Identity from the listener rather than from a credential the remote holds, because a credential on
the remote can be read by anything that can read the remote user's files — which is the same set of
principals the socket already admits, so the credential would add a second thing to leak without
narrowing anything. The listener cannot be chosen by the caller at all.

`-O forward` on the shared connection rather than a dedicated `ssh -N -R` process per environment,
because the shared master already exists, already carries keepalives, and is already the thing whose
liveness corral reasons about. One connection per host stays one connection per host.

**A cancelled forward leaves its socket file behind, and a stale file blocks the next forward.**
`ssh -O cancel` unlinks nothing on the remote, the client-side `StreamLocalBindUnlink` is not honoured
for *remote* forwards, and the server-side option of that name defaults to `no`. corral therefore
`rm -f`s the remote socket path over the same connection before every forward request. The
alternative — asking operators to set `StreamLocalBindUnlink=yes` in `sshd_config` — is a host-global
change affecting every account on the machine, to fix a problem corral can fix for itself in one
command.

The forward is re-established by a periodic check that PROBES before it acts — it asks whether the
remote socket is there, and only clears and re-forwards when it is not. The naive loop, clearing and
re-forwarding every tick, would unlink a socket that was working and break every shim connected
through it. One further precondition: `ssh -O forward` speaks to an existing connection and never
establishes one, so a `ControlPersist` of 0 leaves it with no master to attach to and remote MCP
cannot work at all. corral says so at startup rather than letting it present as silence.

Network robustness beyond this is deliberately out of scope. The assumed network is stable broadband;
detecting a dead master (`ssh -O check` loops, reconnect backoff, a push cache on the remote) is
YAGNI. Note what that costs, stated honestly: unlike a one-shot corral ssh call, the tunnel has no
command behind it and no timeout, so a master that has died without the socket going away is not
noticed until the next probe. The shim reports the outcome the remote session actually sees — corral
is not connected — and the session has no corral tools until the next tick repairs it.

## Rejected alternatives

**Sharing corral's `:8787` with the remote** (a firewall allowlist, or an SSH tunnel of the HTTP
port). Rejected because it shares the *whole* unauthenticated API: fleet restore, board deletes, spawn
anywhere, and the live-terminal WebSocket into local panes. "MCP for remote sessions" would become
remote code execution on the operator's own machine. No scoping is possible after the fact, because
the port is the surface.

**A reverse TCP tunnel to a token-authenticated listener, with the MCP server on the remote.** The
fallback if streamlocal forwarding had proved unavailable. Rejected on two counts: the loopback port is
reachable by every account on the remote, leaving a token file as the only barrier; and it puts a full
MCP implementation on each remote, restoring the version-skew problem that moving the process solves.

**A forced-command SSH login from the remote back to the corral host.** The key pins the environment
cleanly, which is attractive. Rejected because the direction does not exist: the corral host is a
laptop behind NAT, and establishing inbound trust to it is a larger security change than the feature
justifies.

**Letting a remote socket hint resolve a remote environment.** The smallest possible change, and the
reason it is listed here: it is exactly what ADR 0002 decision 4 forbids once callers are no longer
all local. The hint is chosen by the caller, so it authenticates nothing — it would make every remote
environment's cards writable by anything that can reach the API with the right string.

**One ADR per feature.** The shared connection, remote file writes, the identity rule and the remote
tool surface shipped as four changes, and each was individually defensible only because of the same
boundary: what SSH already reaches. Four records would have restated that boundary four times, and
none of them would have owned it.
