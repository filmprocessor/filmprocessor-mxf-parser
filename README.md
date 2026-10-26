# FilmProcessor MXF Parser

Read-only JavaScript helpers for parsing SMPTE MXF files in browser and Node
environments. The package focuses on KLV scanning, BER length decoding,
DCP-oriented picture/sound element detection, frame indexing, and selected
metadata extraction.

This is an extracted utility package. It does not include FilmProcessor's media
player, DCP playback scheduler, rendering pipeline, upload flows, server APIs,
or product UI.

## Install

```bash
npm install @filmprocessor/mxf-parser
```

## Example

```js
import {
  parseMXFMetadata,
  buildMXFFrameIndex,
  probeMXFType,
} from "@filmprocessor/mxf-parser";

const type = await probeMXFType(file);
const metadata = await parseMXFMetadata(file);
const frames = await buildMXFFrameIndex(file);

console.log({ type, metadata, frameCount: frames.length });
```

## Scope

Included:

- BER length decoding
- SMPTE UL matching helpers
- DCP picture and sound KLV detection
- MXF header metadata probing
- frame index construction for DCP-style picture essence
- MCA/channel-label parsing
- read-only PCM audio chunk helpers

Not included:

- MXF writing
- DCP authoring
- encrypted AS-DCP decryption (encrypted input is detected and refused by the frame indexer)
- JPEG2000 decoding
- playback scheduling
- color conversion
- FilmProcessor app, Vault, Fileshare, or cloud-processing integrations

## Status

Source synchronized with FilmProcessor’s 17 October 2026 application release.
Expect API changes before `1.0.0`.

### 0.2.0

- `parseMXFMetadata()` exposes `encrypted`, `stereoscopic` and an exact
  `video.editRate` rational (null when the source rate is unavailable).
- Stereoscopic frame indexes contain one entry per edit unit, with the left
  eye at `offset`/`size` and the second eye at `rightEye`.
- `isEncryptedMXF()` detects cryptographic context metadata; frame indexing
  rejects encrypted input with `error.code === "ENCRYPTED_MXF"`.
- Frame indexing avoids counting the final picture twice when scanning overlaps.
- MCA labels resolve the file’s Primer Pack and preserve carrier channel slots.

Consumers that counted individual eye frames must adapt to edit-unit indexing.

## Security

This package is parser-only and should be treated as untrusted-input handling
code. Avoid running it with elevated privileges, and report malformed-file
crashes or excessive CPU/memory behavior through `SECURITY.md`.

## License

Apache-2.0. See `LICENSE`.

## Licence history

Version 0.3.0 adopts Apache License 2.0 for this project. Earlier published
versions through 0.2.0 retain their MIT licence. Third-party dependencies
retain their own licences. See `LICENSE` and `NOTICE`.
