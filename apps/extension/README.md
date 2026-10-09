# Plip Study Buddy — Chrome extension (MV3)

A side-panel study buddy for students. It helps you reason through your own
work; it cannot type into a page, fill a field, press a key or submit anything.

No build step and no dependencies: this directory is the extension.

```bash
# chrome://extensions -> Developer mode -> Load unpacked -> this folder
npm test            # 94 unit tests (node --test, no install)
npm run pack        # -> dist/plip-study-buddy-<version>.zip, publishes nothing
npm run proxy       # tools/dev_proxy.py, a reference model proxy for development
npm run icons       # regenerate icons/ from assets/plip-icon-256.png
```

Everything else — loading it, the permission model, the pages it refuses, the
capability matrix against Plip on macOS, the opt-in learning-event contract,
and what has **not** been verified — is in
[../../docs/EXTENSION.md](../../docs/EXTENSION.md).

MIT, like the rest of Plip. Preview quality: not published to the Chrome Web
Store, not verified on Chromebook hardware, synthetic demo data only.
