# Exterior EAP SDK migration

NOTICE: The [HTTP MCP migration](2026-10-25-playground-http-mcp-design.md) supersedes
the package pin and agent-wrapper setup below. The account identity and OAuth diagnosis remain relevant.

Date: 2026-10-23.
Updated: 2026-10-25.
Change classification: bug fix.
Evidence: upstream source inspection, regression tests, relay metadata requests, and owner-confirmed live app registration.
Live account authorization and device connections need separate evidence.

## Cause and dependency

The old adapter omitted `clientId` and used `@exterior/client` at revision `d9b6c35`.
That SDK tried anonymous registration before authorization.
The configured relay returned no registration endpoint.
Sign-in failed with `Exterior does not let apps register themselves.`

Exterior now requires a metadata document address or a client id registered by an account.
Its [accepted decision](https://github.com/lulu0119/exterior/blob/6f20a7fc8684ff21bee2de2976874f431cd9ee92/docs/adr/0028-a-web-app-names-itself.md)
removes anonymous registration.

The Playground now uses `@exterioragentprotocol/sdk`, pinned to
[`2205c5c9267a8e0ece3e8cee31cbc073bccabced`](https://github.com/lulu0119/exterior/commit/2205c5c9267a8e0ece3e8cee31cbc073bccabced).
The SDK replaces both `@exterior/client` and the public use of `@exterior/contract`.
Its dependencies use normal package versions, so the old `blockExoticSubdeps: false` exception is no longer necessary.

## Adapter contract

The adapter imports browser calls from `@exterioragentprotocol/sdk/client` and the account hook from `@exterioragentprotocol/sdk/client/react`.
The SDK discovers the authorization server through `/.well-known/oauth-protected-resource`.
Device requests use `/eap/v1/devices` and `/eap/v1/connections`.
Authorization requests use `eap:client offline_access`.
These contracts come from the [SDK manual](https://github.com/lulu0119/exterior/blob/2205c5c9267a8e0ece3e8cee31cbc073bccabced/packages/sdk/README.md).

The account state contains its phase, without an access token.
The adapter uses `session.listDevices()` and `session.openConnection()`.
These SDK methods obtain live tokens and share concurrent refreshes.
The adapter maps devices to agent targets and connections to the ACP contract.
The form keeps its device selection across refreshes.
It resets when the sign-in phase changes.
The upstream [account hook](https://github.com/lulu0119/exterior/blob/2205c5c9267a8e0ece3e8cee31cbc073bccabced/packages/sdk/src/client/react.tsx)
owns token refresh and sign-out.

## Identity and local development

The owner selected `https://auv.moeru.ai/playground/oauth-client.json` as the production client identity.
The source document is `apps/repl-playground/public/oauth-client.json`.
The existing site build copies it into the Playground deployment.
It lists the production callback and local callbacks for `127.0.0.1` and `localhost`.
The relay accepts different ports on a registered loopback redirect.
This follows the upstream [identity decision](https://github.com/lulu0119/exterior/blob/6f20a7fc8684ff21bee2de2976874f431cd9ee92/docs/adr/0028-a-web-app-names-itself.md).

The development page does not need deployment.
The metadata document does need a public HTTPS address that returns JSON.
On 2026-10-23, the chosen address returned HTTP 200 with `text/html`.
That response is not an OAuth metadata document.

Before publication, local development uses an account-registered public client.
`VITE_EXTERIOR_CLIENT_ID` overrides the default identity with that id.
The client needs the local callback addresses and no secret.
`VITE_EXTERIOR_URL` continues to select the relay.
The [Playground README](../../../../apps/repl-playground/README.md) gives the configuration.

The relay now provides a registration page and public result polling through
[app setup](https://github.com/lulu0119/exterior/blob/2205c5c9267a8e0ece3e8cee31cbc073bccabced/docs/app-setup.md).
The dashboard also provides **Register app**.
The assistant opens a setup link with a random id, app name, and exact callback.
The account owner signs in and confirms registration on the relay.
The assistant polls `/api/clients/setup/<id>` and checks the returned name and callback before saving the public identity.
The result contains no account tokens.
Registration does not grant access to devices.

On 2026-10-25, the owner registered `AUV Playground Dev` on `https://relay.apps.superpowerlulu.win` through this flow.
The confirmed callback is `http://127.0.0.1:5180/playground/oauth/callback`.
The relay and client id are saved in the ignored `.env.development.local` file.
Production builds retain the metadata-document identity.
The production metadata document remains unpublished by this task.

## Verification

The regression test calls the real SDK authorization flow through the adapter's account configuration.
Its discovery fixture omits anonymous registration.
Before the fix, it reproduced the reported error.
After the fix, it checks the explicit client id, callback, and EAP scope.

The browser fixture uses EAP v1 routes.
It rotates the stored access token after discovery and checks the connection request's authorization header.
Other checks cover tab persistence, ACP initialization, codemode, cancellation, images, and recovery.
These checks use synthetic accounts and agents.
They do not prove live OAuth approval or a real device connection.

On 2026-10-25, live app registration succeeded on the selected remote relay.
The owner authorized the app, and the browser completed its local callback.
The account initially had no online device.

The local Windows device then signed in with the Exterior CLI preview at the same pinned revision.
The owner confirmed its device code on the relay.
The CLI daemon connected and advertised the existing `opencode` configuration and the added `auv-playground` configuration.
The agent configuration is in `~/.config/exterior/config.json`.
The new configuration runs this checkout's `agent/proxy.mjs` with the installed OpenCode 2.0.26 executable.
The client retains its normal working directory.
The daemon must stay running for the device to remain online.

The Playground selected `auv-playground` and opened a real agent through the remote relay.
ACP initialization and codemode negotiation succeeded.
The page showed **Code execution connected**.
The agent called the codemode tool with `text(1 + 1)` and returned `2`.
The Playground console separately recorded `2`.
This live check used the mock desktop and delivered no real device input.

The updated adapter passed 88 unit tests, the browser regression, TypeScript checks, ESLint, and the production build.
The production bundle excludes the registered development client id.
