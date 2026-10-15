# ADR: Creative media enters by HTTPS URL, never by file system or bytes

Status: accepted (RK9-513, epic RK9-505 decisions G4 and G11)

## Context

A brand repo (for example `rk9-ai/bk` for Ololla) makes finished ad media and
must hand it to this plugin. The plugin runs as a Paperclip worker process.
Four transports look possible:

1. `ctx.localFolders`: the plugin reads files from a folder the operator
   configures.
2. A plugin API route (`apiRoutes`) that receives the file.
3. `ctx.http.fetch`: the plugin downloads the file and checks its hash.
4. A public HTTPS URL that Meta fetches itself.

## Decision

Media travels as a public HTTPS URL in a versioned creative manifest
(`schemas/creative-manifest.v1.schema.json`). The plugin never reads the bytes:

- a video goes to Meta with `POST act_<id>/advideos` and `file_url`;
- an image goes to Meta by URL (`link_data.picture`) when the publish step
  builds the ad creative.

`sha256` in the manifest is a dedupe key. The plugin does not verify it,
because it never downloads the file. One HEAD request through the host fetch
checks that the URL answers 200 with the right content type and an acceptable
size.

## Why not the other transports

- **No raw file system access.** Plugin workers are separate Node processes,
  not `vm` sandboxes. Code that calls `fs` directly reads anything the host
  user can read, and no capability check sees it. The capability model holds
  only while the plugin uses `ctx` clients.
- **`localFolders` carries text only.** The host's local folder API reads and
  writes UTF-8 text. Binary media would be corrupted. The plugin's frozen
  capability set (G11) also has no `local.folders`, so the optional
  `creative-inbox` folder from the first spec is not built. Manifests arrive
  through the tool or the route instead.
- **`apiRoutes` carry JSON only.** The host accepts `application/json` and
  limits the body to 1 MB, so a 20 MB reel cannot pass, and base64 in JSON
  would only move the limit.
- **`ctx.http.fetch` corrupts binary.** The host decodes every response body
  as UTF-8 and the worker rebuilds the `Response` from that string, so the
  bytes of a PNG or MP4 change and a sha256 over them never matches. The
  request side turns any non-string body into `String(body)`, so a multipart
  upload cannot pass either. Changing this would mean changing core code,
  which the epic rules out (G1).

## Consequences

- The brand repo must host media at a public HTTPS URL that stays reachable
  until Meta has fetched it (signed URLs must outlive the video processing).
- URL checks at ingress: https only, no credentials, default port, no IP
  literal, no private-only host name (`localhost`, `.local`, `.internal` and
  similar). The HEAD goes through the host fetch, whose guard resolves DNS and
  refuses private addresses. Redirects are not followed.
- The plugin cannot prove that the media behind the URL matches `sha256`.
  Dedupe on `(company, brand, sha256)` trusts the brand repo's hash.
- Tests use a binary fixture that is not valid UTF-8 as every media response
  body and assert that the ingress never reads it.
