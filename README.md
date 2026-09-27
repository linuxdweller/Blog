# i18n Blog

## Dev

For first timec cloning:

```sh
npm ci
npm run build
npm run dev -- --host
```

## Diagrams

`.mmd` sources live in `diagrams/`, rendered to `public/` via `mmdc` (`mermaid.config.json` / `mermaid.mobile.config.json`).

```sh
npm run diagram -- -i diagrams/envoy-ai-gateway-flow.mmd -o public/envoy-ai-gateway-flow.svg
npm run diagram:mobile -- -i diagrams/envoy-ai-gateway-flow-mobile.mmd -o public/envoy-ai-gateway-flow-mobile.svg
```

## SEO

1. OpenGraph
2. LD JSON

## i18n Requirements

1. A way to show multilangual text based on selected locale (a javascript function for showing the locale's text
   given values for each locale).
2. Directional CSS.
3. Routing.

Examples:

1. https://github.com/psephopaiktes/astro-i18n-starter

## Design

Page content:

1. Header
2. Footer

Examples:

1. https://lexingtonthemes.com/viewports/phanatik/
2. https://dante-astro-theme.netlify.app/blog/
3. https://bookworm-light-astro.vercel.app/

TODO: Create wireframe to see where everything is and what components there are.
