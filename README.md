# Marker

A browser-only whiteboard with a hand-drawn look (built on Excalidraw), edited mainly by describing changes, typed or spoken, to a model you configure (Azure AI Foundry first). There is no Marker server: the app talks to your model straight from the browser. The design and decisions are in [docs/PLAN.md](docs/PLAN.md).

## Using it

- **Describe a change** in the prompt bar (`/` jumps there) and press Enter, or hold **Ctrl+Shift+Space** to say it. Attach images with the paperclip, or paste or drop them.
- **Undo** anything with Ctrl/Cmd+Z; every change, including the model's, is one step in **History**.
- **Templates:** select shapes and save them as a template, then add copies that each have their own text.
- **Files:** Open, Save and Save as in the main menu (Ctrl/Cmd+O, +S, +Shift+S). A `.board` file is readable board text with its images and undo history; `.boardz` is the same zipped.
- **Settings:** model endpoint, deployment and key (kept only in your browser), voice, shortcuts, prices and a monthly budget. Settings export and import without the key.

## Development

```sh
npm install
npm run dev            # http://localhost:5173
npm test               # unit tests
npx playwright test    # browser tests against the dev server
npm run e2e:preview    # build, then check the production build (security policy, speech, offline)
npm run eval           # replay recorded model answers for the eval cases
npm run eval:live      # record answers from Azure (see evals/eval.test.ts for the env vars)
npm run build
```

Opt-in tests: `MARKER_SPEECH_E2E=1` runs real on-device speech recognition (downloads a 28 MB model), and `MARKER_AZURE_ENDPOINT`, `_DEPLOYMENT` and `_KEY` run `e2e/live.spec.ts` against your deployment.

## Hosting

`npm run build` produces a static site in `dist/`. On-device speech recognition needs cross-origin isolation: hosts that can set headers should send `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp`. On hosts that can't (for example GitHub Pages), the service worker adds them, after one reload on the first visit. After one visit the app works offline; speech models are kept by the browser once downloaded.
