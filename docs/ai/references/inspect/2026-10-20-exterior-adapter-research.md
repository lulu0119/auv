# Exterior connection contract for AUV Playground

Source inspection date: 2026-10-20.
Evidence level: upstream source inspection and package retrieval.
Live OAuth, daemon, and relay behavior is outside this source evidence.

## Upstream identity and package pins

The [Exterior repository](https://github.com/lulu0119/exterior) supplies the
connection client and contract. The inspected revision is
[`d9b6c35e0ff5b05262b1c5cf71c20f8fde47e6c4`](https://github.com/lulu0119/exterior/commit/d9b6c35e0ff5b05262b1c5cf71c20f8fde47e6c4),
dated 2026-10-19.

The source manifests name `@exterior/client`, `@exterior/contract`, and the
`exterior` CLI. They declare `0.1.0-beta.1`. The client exports its React hook
at `@exterior/client/react` and requires React 19. The CLI requires Node 22 or
later. Sources: [client manifest](https://github.com/lulu0119/exterior/blob/d9b6c35e0ff5b05262b1c5cf71c20f8fde47e6c4/packages/client/package.json),
[contract manifest](https://github.com/lulu0119/exterior/blob/d9b6c35e0ff5b05262b1c5cf71c20f8fde47e6c4/packages/contract/package.json),
[CLI manifest](https://github.com/lulu0119/exterior/blob/d9b6c35e0ff5b05262b1c5cf71c20f8fde47e6c4/packages/gateway/package.json).

The Playground pins client and contract packages to an immutable preview revision.
The official
[preview workflow](https://github.com/lulu0119/exterior/blob/d9b6c35e0ff5b05262b1c5cf71c20f8fde47e6c4/.github/workflows/preview.yml)
publishes all three packages through pkg-pr-new.

Package addresses:

- [Client tarball](https://pkg.pr.new/lulu0119/exterior/@exterior/client@d9b6c35e0ff5b05262b1c5cf71c20f8fde47e6c4)
- [Contract tarball](https://pkg.pr.new/lulu0119/exterior/@exterior/contract@d9b6c35e0ff5b05262b1c5cf71c20f8fde47e6c4)
- [CLI tarball](https://pkg.pr.new/lulu0119/exterior@d9b6c35e0ff5b05262b1c5cf71c20f8fde47e6c4)

The pinned client and contract declare `0.0.0-preview-d9b6c35`.
The client depends on the contract at the same full-SHA address.
Their declarations define the APIs below.

## Browser adapter contract

`Device` contains `id`, `hostname`, `workingDirectory`, `platform`, and `agents`.
Each agent contains `name` and `agentType`. Platform values are `macos`,
`windows`, and `linux`. The client rejects device entries without a working
directory or a recognized platform. Sources: [contract types](https://github.com/lulu0119/exterior/blob/d9b6c35e0ff5b05262b1c5cf71c20f8fde47e6c4/packages/contract/src/index.ts#L35-L90),
[device response parser](https://github.com/lulu0119/exterior/blob/d9b6c35e0ff5b05262b1c5cf71c20f8fde47e6c4/packages/client/src/oauth.ts#L526-L531).

All device fields are required and non-null. Their exact shape is:

```ts
type Device = {
  id: string
  hostname: string
  workingDirectory: string
  agents: readonly { name: string; agentType: string }[]
  platform: 'macos' | 'windows' | 'linux'
}
```

`listDevices` requests `/api/devices` with a bearer token.
`openConnection(relayUrl, accessToken, { deviceId, agentName })` requests
`/api/connections` and returns `{ url, agentType, agentName }`.
Both requests omit browser cookies. Source: [client requests](https://github.com/lulu0119/exterior/blob/d9b6c35e0ff5b05262b1c5cf71c20f8fde47e6c4/packages/client/src/oauth.ts#L230-L264).

`useAccount(relayUrl, init)` returns
`{ account, busy, error, signIn, signOut }`.
Account phases are `checking`, `signed-out`, and `signed-in`.
A signed-in account contains `accessToken`.
The hook accepts `redirectUri`, `returnTo`, `clientId`, `clientName`, and
`logoUri`. The default callback is `/oauth/callback`.
The hook stores tokens in `sessionStorage` and registrations in `localStorage`.
Sources: [React hook](https://github.com/lulu0119/exterior/blob/d9b6c35e0ff5b05262b1c5cf71c20f8fde47e6c4/packages/client/src/react.tsx),
[callback constant](https://github.com/lulu0119/exterior/blob/d9b6c35e0ff5b05262b1c5cf71c20f8fde47e6c4/packages/contract/src/index.ts#L3-L9).

The exact account shape is:

```ts
type AccountSession = {
  account:
    | { phase: 'checking' }
    | { phase: 'signed-out' }
    | { phase: 'signed-in'; accessToken: string }
  busy: boolean
  error: string
  signIn: () => void
  signOut: () => void
}
```

The Playground supplies its callback under the `/playground/` base path.
The hook default uses the page origin and does not include an application base
path. The hook recognizes callbacks by pathname and replaces the address with
`returnTo` after code redemption. Without `clientId`, the client registers the
app with the relay.
Sources: [callback calculation](https://github.com/lulu0119/exterior/blob/d9b6c35e0ff5b05262b1c5cf71c20f8fde47e6c4/packages/client/src/react.tsx#L14-L40),
[browser registration contract](https://github.com/lulu0119/exterior/blob/d9b6c35e0ff5b05262b1c5cf71c20f8fde47e6c4/packages/client/README.md#which-client-id).

The SDK default relay is `http://127.0.0.1:8787`.
The upstream Example deployment separately selects
`https://relay.apps.superpowerlulu.win` through `VITE_EXTERIOR_URL`.
These are source defaults, with no live availability evidence here.
Sources: [SDK default](https://github.com/lulu0119/exterior/blob/d9b6c35e0ff5b05262b1c5cf71c20f8fde47e6c4/packages/contract/src/index.ts#L3),
[Example deployment](https://github.com/lulu0119/exterior/blob/d9b6c35e0ff5b05262b1c5cf71c20f8fde47e6c4/.github/workflows/example-pages.yml#L32-L35).

## ACP handoff and AUV ownership

Exterior returns a one-time WebSocket address. The web app is the ACP
client. Exterior forwards ACP frames and tool permission requests unchanged.
The optional `createAgentConnector` helper shares concurrent opens and obtains
a fresh ticket through `reopen()`. Its recovery contract never resumes sessions.
Sources: [frame contract](https://github.com/lulu0119/exterior/blob/d9b6c35e0ff5b05262b1c5cf71c20f8fde47e6c4/docs/adr/0002-passthrough-acp-frames.md),
[ticket helper](https://github.com/lulu0119/exterior/blob/d9b6c35e0ff5b05262b1c5cf71c20f8fde47e6c4/packages/client/src/connection.ts).

`PayloadSchema` uses
`v.maxLength(1_048_576)` on its string. This schema limit differs from a
byte-based WebSocket limit. For an oversized daemon payload, the relay closes
the daemon socket with code 1008 and reason `message`. For an oversized browser
payload, the daemon ignores the invalid relay message. The gateway also stops
an agent with more than 1,048,576 pending characters before a newline.
Sources: [payload schema](https://github.com/lulu0119/exterior/blob/d9b6c35e0ff5b05262b1c5cf71c20f8fde47e6c4/packages/contract/src/index.ts#L29-L71),
[relay parsing](https://github.com/lulu0119/exterior/blob/d9b6c35e0ff5b05262b1c5cf71c20f8fde47e6c4/apps/relay/src/server/routes/sockets.ts#L38-L45),
[daemon parsing](https://github.com/lulu0119/exterior/blob/d9b6c35e0ff5b05262b1c5cf71c20f8fde47e6c4/packages/gateway/src/daemon.ts#L227-L238),
[pending frame limit](https://github.com/lulu0119/exterior/blob/d9b6c35e0ff5b05262b1c5cf71c20f8fde47e6c4/packages/gateway/src/frames.ts),
[agent stop behavior](https://github.com/lulu0119/exterior/blob/d9b6c35e0ff5b05262b1c5cf71c20f8fde47e6c4/packages/gateway/src/host.ts#L140-L148).

The selected device supplies the default ACP session directory.
Upstream Example passes `device.workingDirectory` to its ACP workspace.
Sources: [connection UI](https://github.com/lulu0119/exterior/blob/d9b6c35e0ff5b05262b1c5cf71c20f8fde47e6c4/apps/example/src/components/app/connect-form.tsx#L48-L53),
[ACP workspace](https://github.com/lulu0119/exterior/blob/d9b6c35e0ff5b05262b1c5cf71c20f8fde47e6c4/apps/example/src/components/app/connection-pane.tsx#L41-L48),
[directory decision](https://github.com/lulu0119/exterior/blob/d9b6c35e0ff5b05262b1c5cf71c20f8fde47e6c4/docs/adr/0016-resolve-commands-and-device-working-directory.md).

The Playground adapter owns relay configuration, authentication, device discovery,
and tickets. It returns `{ url, label, cwd }` to the ACP consumer.
Playground owns its ACP client, agent proxy, codemode protocol, and selected AUV Device.
The local implementation is in
[`exterior.ts`](../../../../apps/repl-playground/src/features/agent/exterior.ts).

## Custom agent configuration

The CLI supports `exterior agent-config create --name <name> --command <command>`.
It parses the command into an executable and arguments, then stores a `custom`
agent. `--env KEY=VALUE` supplies repeatable environment entries.
The configuration lives at `~/.config/exterior/config.json`.
Sources: [create command](https://github.com/lulu0119/exterior/blob/d9b6c35e0ff5b05262b1c5cf71c20f8fde47e6c4/packages/gateway/src/cli/commands/agent-config/create.ts#L7-L65),
[command parser](https://github.com/lulu0119/exterior/blob/d9b6c35e0ff5b05262b1c5cf71c20f8fde47e6c4/packages/gateway/src/agents.ts#L42-L75),
[configuration path](https://github.com/lulu0119/exterior/blob/d9b6c35e0ff5b05262b1c5cf71c20f8fde47e6c4/packages/gateway/src/config.ts#L7-L32).

The AUV proxy command shape is
`node "<absolute-path>/agent/proxy.mjs" -- <acp-command> <acp-arguments>`.
The separator and actual ACP command are required by the
[local proxy entrypoint](../../../../apps/repl-playground/agent/proxy.mjs).
Exterior does not require an AUV-specific upstream agent type.

The daemon uses `exterior login --relay <origin>`, then
`exterior daemon --relay <origin>`. Device approval happens on the relay.
`EXTERIOR_RELAY` also selects the relay. Agent configuration changes reach a
running daemon without a restart. Sources: [manual](https://github.com/lulu0119/exterior/blob/d9b6c35e0ff5b05262b1c5cf71c20f8fde47e6c4/docs/manual.md#sign-in-a-device-with-the-cli),
[relay selection](https://github.com/lulu0119/exterior/blob/d9b6c35e0ff5b05262b1c5cf71c20f8fde47e6c4/packages/gateway/src/cli/relay.ts#L6-L40).

NOTICE: This research provides no live sign-in or agent compatibility claim.
Live acceptance requires an approved account, an online device, and an ACP
agent that supports the Playground proxy requirements.
