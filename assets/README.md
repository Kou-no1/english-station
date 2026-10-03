# UI Assets

`guide.webp` is an original illustration generated with the built-in image generation tool and optimized locally for the app. It is cached for offline use.

Prompt:

> Compact friendly robot guide for a Japanese elementary-school English app: a small white and turquoise communications robot with a charcoal face screen, expressive eyes, a coral antenna, and a golden star held in its hands. Polished matte clay 3D style, full subject centered on a transparent background, clear silhouette at small sizes. No text, logos, watermark, scenery, or background particles.

Interface SVG icons are bundled from Lucide 0.468.0, licensed under ISC. See `lucide-LICENSE`. No network or Lucide runtime is required to display them.

`tools/prepare-ui-assets.mjs` prepares the illustration and embeds the selected official Lucide icon paths. It needs Sharp only when preparing assets, not when running the app.
