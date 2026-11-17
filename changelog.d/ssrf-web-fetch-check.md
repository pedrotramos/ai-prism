### Security

- **web_fetch: regression tests for the mapped-IPv6 SSRF bypass**: `server/web.test.js` now covers
  every form a customer report used to reach loopback or cloud metadata. These are mapped IPv4 in
  dotted and hex form (`[::ffff:127.0.0.1]` → `[::ffff:7f00:1]`, `[::ffff:a9fe:a9fe]`),
  IPv4-compatible, NAT64, decimal/octal/hex IPv4 hosts, `localhost`, DNS answers that resolve to a
  mapped address, and a redirect from a public host to a private one. Each case asserts the request
  is refused before any socket opens. Since PR #53, main sends `web_fetch` through
  `blockedAddressReason` (a2aGuard.js), which blocks all of them. Releases v1.2.0–v1.4.0 still have
  the old dotted-only check, so the fix ships with the next release.
