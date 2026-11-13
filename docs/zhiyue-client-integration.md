# Paired client / backend HTTP regression

The device authorization workflow checks out `zcorw/zhiyue` at
`ee5d319f2183998780e1e53108fdca952bb4f4f2` and executes its actual
`aiui/lib/zhisheng.js` client against the backend and an isolated PostgreSQL database.
The pin is deliberate: update it explicitly after reviewing a client release.
No client source is copied into the backend or used by production code.

## Run locally

Build the API first. Set `ZHIYUE_TEST_DATABASE_URL` to a loopback PostgreSQL database
named exactly `zhiyue_integration_test`. Use disposable synthetic data only; the
suite migrates that database and cleans up its generated accounts.
Set `ZHIYUE_CLIENT_SOURCE` to the absolute path of the pinned client module.
From `apps/api` run:

```sh
node --experimental-vm-modules --test --test-concurrency=1 test/zhiyue-device.test.mjs test/zhiyue-client.test.mjs
```

The new test skips without both variables; CI supplies both. Missing/unreadable
client source with the variables configured fails rather than silently skipping.

## Coverage and limits

- Actual client JSON parsing, persistence state, approval and confirmation requests.
- Confirmation response lost **after** the server commits, followed by idempotent retry.
- Three renewal cycles with concurrent article reads sharing each renewal.
- Browser logout preserves device access; a synthetic password-hash change revokes
  the binding and the client clears its invalid credentials.
- Existing backend regressions separately cover migration, expiry, legacy upgrade,
  account isolation and revocation races.

Only transport origins are adapted from a logical HTTPS origin to loopback HTTP;
response URL metadata is restored to that logical origin. Payloads and statuses are
not mocked. This does **not** test TLS/proxies/redirects, real Rokid storage/network,
article/audio rendering, elapsed 24-hour use or production deployment. The VM uses
in-memory storage; durable target-device storage acceptance remains outstanding.
No deployment, production migration, or real credential is performed by this test.
