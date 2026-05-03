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
- encrypted AS-DCP handling
- JPEG2000 decoding
- playback scheduling
- color conversion
- FilmProcessor app, Vault, Fileshare, or cloud-processing integrations

## Status

Initial public extraction. Expect API changes before `1.0.0`.

## Security

This package is parser-only and should be treated as untrusted-input handling
code. Avoid running it with elevated privileges, and report malformed-file
crashes or excessive CPU/memory behavior through `SECURITY.md`.

## License

MIT. See `LICENSE`.
