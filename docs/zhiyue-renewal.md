# Renewable device authorization with explicit confirmation

## First pairing

1. `/device/authorize` creates a five-minute pairing request with a human code and
   a separate secret device code. The signed-in browser approves the human code.
2. `/device/token` creates a **pending** logical binding with a fixed confirmation
   deadline five minutes after server-side creation. It returns access/refresh
   credentials, account/binding IDs and `confirmation_required: true`.
3. The device reliably stores these credentials and a pending-confirmation flag.
4. It calls `POST /v1/zhiyue/device/confirm` with `{refresh_token}`. Only a successful
   confirmation permits article/media reads and refresh. Confirm is idempotent:
   a repeated request returns 204 even if the access credential later expires.
5. After 204, the client persists the cleared flag before displaying success.

The same secret device code can retry a lost claim response within the fixed window.
Credentials are domain-separated HMAC derivations using a private per-claim random
nonce. Only credential hashes and temporary recovery material are stored; confirmation
erases that nonce so the short-lived device code cannot derive long-lived credentials. A retry returns the same logical device and credentials, never
extends the deadline, and never re-creates a revoked device. A short-lived request
link is kept as a tombstone until expiration. Browser approval is not device confirmation.

At the five-minute boundary, pending grants become unusable immediately. An automatic
worker physically deletes them at startup and every five seconds; authorization and
pairing paths also clean them up. During normal operation physical deletion can lag
by a sweep interval; database/process unavailability delays it until recovery, but
cannot make an expired grant authorize access. Confirmed devices have no such deadline.
The client may stop polling at the original pairing-code deadline, so a lost response
near that boundary can still require pairing again; the unused device is automatically
removed rather than permanently consuming quota.

Confirmation-response loss is recoverable because the device persisted the refresh
credential first. Restart retries confirm. Temporary network/storage errors preserve
recoverable credentials; permanent invalid grants require pairing again. Cancellation
attempts revocation; a failed network revocation must not be reported as completed.

## Renewal and migration

Device access lasts 24 hours. Confirmed logical bindings and refresh credentials have
neither a total lifetime nor an inactivity timeout. Refresh rotates access, not refresh.
Concurrent refreshes may invalidate an earlier access response; retry with the stable
refresh credential obtains a usable one. Browser sessions and MCP credentials are not accepted.

Existing legacy rows are migrated as already confirmed, with no five-minute deadline.
A valid legacy bearer may call `/device/upgrade`. The server generates a private nonce,
derives the refresh credential with HMAC, and stores only credential hashes plus bounded
recovery material. The original bearer can retry for a fixed five-minute recovery window,
even if its original access expiry passed after a successful upgrade. Retrying never
extends that window. First refresh removes the nonce and old-bearer recovery hash.
Never-upgraded expired credentials cannot upgrade. After the recovery window, a device
that never saved the response must pair again; the already-confirmed binding is not
subject to pending-device cleanup and can be revoked in the website.

## Revocation and security

Password changes and account disablement revoke bindings, media tickets and approved
pairing requests in the same database transaction. Ordinary browser logout does not.
Account-before-request/binding locking prevents a concurrent password change from
resurrecting a revoked grant. No endpoint adds draft, edit, administration or TTS access.

Stable refresh credentials deliberately omit rotation/reuse detection to allow idle
and lost-response recovery. Extracted refresh credentials grant device-only reads until
revocation. Application-isolated storage is not claimed to be encrypted or hardware-backed.
Never log credentials, put them in URLs or follow redirects when transmitting them.
The upgrade nonce alone cannot authenticate, and is erased after recovery or first refresh.

## Compatibility and release

- New client + old backend: legacy pairing/reading remains available; no confirmation
  field means the old grant is already confirmed. No indefinite renewal is promised.
- New client + new backend: explicit confirmation and renewal are enforced.
- Old client + new backend: existing confirmed grants can continue until their ordinary
  expiry, but **new pairing cannot finish** because the old client never confirms.
  Do not waive the confirmation gate. Upgrade clients before/coordinately with the backend.
- No deployment, production migration, image publication or real credentials are part
  of this PR. The migration must be reviewed before rollout; rollback deletes pending
  grants rather than accidentally promoting them to authorized legacy bindings.

Local checks cover Node client simulations, isolated PostgreSQL HTTP regression,
legacy migration, concurrency/revocation, expiry cleanup and confirmation-response retry.
GitHub Actions additionally runs the CMS browser test with synthetic data. Target Rokid
storage, phone-lock networking, cross-24-hour wall-clock use and production acceptance
remain separate. A browser check is not a real-device acceptance result.
