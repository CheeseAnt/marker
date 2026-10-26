# BoardBot

A browser-only whiteboard with a hand-drawn look, edited mainly through natural language (typed or spoken) and interchangeable LLM providers, starting with Azure AI Foundry. The full plan is in [docs/PLAN.md](docs/PLAN.md).

## Development

```sh
npm install
npm run dev     # http://localhost:5173
npm test
npm run build
```

The dev and preview servers send COOP/COEP headers (needed later for multi-threaded on-device speech models). Excalidraw's fonts are copied into `public/fonts/` before dev and build, so they load under those headers and work offline.
