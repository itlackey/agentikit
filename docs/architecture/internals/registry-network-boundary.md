# Registry network boundary

All HTTP(S) traffic used to discover or install registry content passes through
`src/registry/network.ts`. The boundary applies URL policy before every request,
resolves and checks every A/AAAA answer, uses manual redirects, and repeats the
same checks for every redirect hop. Cross-origin redirects drop
`Authorization`, `Cookie`, and `Proxy-Authorization` headers.

## Request inventory

| Caller | Remote input | Policy |
| --- | --- | --- |
| `src/registry/providers/static-index.ts` | Configured static index | Public HTTP(S) only |
| `src/registry/providers/skills-sh.ts` | Configured API base plus `/api/search` | Public HTTP(S) only |
| `src/setup/registry-stash-loader.ts` | Setup registry index | Public HTTP(S) only |
| `src/registry/resolve.ts` | npm package metadata | Public npm registry, or the explicit `AKM_NPM_REGISTRY` mirror policy below |
| `src/registry/resolve.ts` | GitHub commit, release, repository, and default-branch metadata | Fixed `https://api.github.com`; redirects rejected |
| `src/sources/providers/provider-utils.ts` via `npm.ts` | npm tarball selected by registry metadata | Exact metadata origin plus the npm network policy; redirects revalidated |

There are no other direct `fetch`, `fetchWithRetry`, raw HTTP(S), Undici, or
socket request calls under `src/registry/**`. The only raw transports are
`src/registry/pinned-transport.ts` and its self-contained one-request helper,
`src/registry/pinned-request-helper.ts`. A compact architecture contract pins
the exact boundary consumers and raw-transport owner. Behavioral integration
tests cover address validation, redirects, credential stripping, DNS pinning,
helper isolation, streaming, timeouts, and cancellation at that boundary.

Git and GitHub bundle materialization uses the `git` executable rather than the
HTTP boundary. GitHub shorthand is converted to the fixed `github.com`
service; operator-supplied `git+...` locators are validated for allowed
transport schemes. A static registry is not trusted to nominate a raw `git`
locator: registry-derived `source: git` entries are rejected before an install
ref can reach `git ls-remote` or clone. Direct operator git installation remains
available and is outside this registry-originated request chain. Setup follows
the same provenance rule: it persists only typed npm refs or fixed-host GitHub
refs from registry data and never converts a registry `homepage` or raw Git ref
into a source. A default-selected official ID is also bound to its fixed GitHub
target, so a configured registry cannot preselect a different package under the
same display ID.

## Destination policy

Normal registry discovery rejects loopback, RFC 1918/ULA private, link-local,
cloud-metadata, documentation, benchmark, multicast, reserved, and
unparseable addresses. A hostname is rejected if any resolved A or AAAA answer
is non-public. URL userinfo is rejected on the initial request and on every
redirect target.

The fixed GitHub policy only permits `https://api.github.com` and rejects all
redirects. This prevents a GitHub token from moving to another origin.

`AKM_NPM_REGISTRY` is the sole private-network mirror exception. Setting
it explicitly permits private or loopback answers only for that configured npm
mirror's exact origin. Registry metadata must begin artifact download at that
same scheme, host, and port; a same-host downgrade or alternate port is not a
new trusted origin. It never permits link-local, metadata, or reserved
destinations. Redirects to another private origin are
rejected; redirects to a public CDN are allowed after DNS validation, with
sensitive headers removed when the origin changes. The default npm registry
does not receive this exception.

Static-index, skills.sh, and setup registry URLs have no private-network opt-out
in 0.9.2. Existing local or intranet registry deployments must move the index
or API to a publicly routable HTTPS endpoint. Alternatively, install a known
bundle directly through an explicit filesystem, git, GitHub, or npm source;
registry discovery is not required for direct installation.

Credential-bearing URLs are rejected on the first URL and every redirect URL;
they are never translated into headers. This preserves the issue #811 policy
inside the redirect boundary.

## Exact DNS and connection guarantee

AKM resolves the original hostname before every attempt, rejects the request if
any A or AAAA answer is non-public, selects one validated numeric answer, and
passes that exact address to the transport. The transport's request-level
lookup returns only that address while retaining the original hostname for the
HTTP `Host` header, TLS SNI, and certificate identity verification. It does not
perform another hostname lookup when it opens the socket. Retries and redirects
return to the outer boundary, repeat resolution and validation, select a fresh
address, and create a fresh non-pooled connection. Automatic redirects are
disabled. DNS resolution and response-header wait share the caller's
per-attempt timeout budget; a resolver that finishes after the deadline cannot
start a transport. Server-controlled `Retry-After` waits are capped at 30
seconds.

Node executes that request directly with the built-in `node:http` and
`node:https` clients. Bun's native TLS client cannot currently retain SNI when
the connection is pinned to a numeric address, so Bun starts one fresh Node >=
24 helper per attempt. The parent sends the credential-bearing request and
validated numeric address over private stdin, never argv or environment, and
receives bounded status/header frames plus a backpressured streaming body over
stdout. The helper is materialized from an embedded self-contained function in
a mode-0700 temporary directory with mode-0600 files, inherits no proxy or
authorization environment, accepts one request, and is killed on abort,
timeout, or body cancellation. Request and response framing is bounded, raw
compressed bodies are decoded in the parent, and temporary artifacts are
removed after the child exits. Registry consumers cancel terminal non-success
response bodies before returning or throwing so an unbounded error body cannot
leave a helper or socket alive. Request bodies are capped at 16 MiB. JSON and
archive consumers apply their own total byte and body-time limits while
retaining streaming backpressure.

The npm package already requires Node >= 24, so both its Bun launcher and Node
fallback can provide the pinned transport. A runtime-free compiled standalone
can also use a Node >= 24 executable found on `PATH`. If none exists, registry
networking fails closed with an actionable `REGISTRY_PINNED_TRANSPORT` error;
it never falls back to an independently resolved Bun connection. Local-only
commands in the standalone remain runtime-free.
