# Marker: plan for an AI-edited whiteboard

## Context
This started as a new project in an empty repo, under the name BoardBot; it was renamed Marker on 2026-10-26. The goal is a browser-only virtual whiteboard with a hand-drawn look. Users edit it **first through natural language** (typed or spoken), and an external LLM turns each request into diagram changes. Manual editing stays available. Other requirements:
- Model providers are interchangeable, chosen by a setting plus an API key. The first one is **Azure AI Foundry**.
- A board is fully contained in a text file that compiles to canvas elements and decompiles back.
- A change log drives undo and redo.
- Microphone input, transcribed on-device where the quality is good enough.
- No dedicated backend: a static site.

**Decisions so far (from the Q&A):**
- Canvas: build on **Excalidraw**.
- Images: **place images on the board** and **attach images as context for an LLM request** (no image-to-diagram conversion yet).
- Format: a **text DSL with a compiler and decompiler**.
- Storage: **local only, single user**.
- Voice: **English only**. On-device by default, with a choice of models in settings, and remote transcription through the active provider as an option.
- A **status bar** shows each active request's progress and the queue of actions being prepared or applied.
- **Token usage and estimated cost** are tracked for every remote call.
- AI changes **apply immediately, with no approval step**. Undo is the safety net.
- **Settings export/import** covers everything except API keys.
- **Template components:** a template is a board with params and ports. Templates can nest, and the AI can place instances of them.

---

## Architecture

```
┌──────────────── Browser (static SPA, Vite + React + TS) ───────────────────┐
│                                                                            │
│  Prompt bar ──┐   Mic ─► STT engine (Worker) ─► transcript ──┐             │
│  (+images,    │                                              ▼             │
│   selection)  └──────────────► Edit Orchestrator ◄───────────┘             │
│                                  │  1. context = DSL(board or subset)      │
│                                  │  2. LLMProvider.complete(tools=ops)     │
│                                  │  3. validate ops (zod) → repair loop    │
│                                  │  4. auto-layout unplaced nodes (ELK)    │
│                                  │  5. apply as Transaction (undoable)     │
│                                  ▼                                         │
│  Board Model (semantic doc) ◄── History (op log, undo/redo stacks)         │
│      │   ▲                                                                 │
│  compile  decompile/diff                                                   │
│      ▼   │                                                                 │
│  Excalidraw canvas (manual edits → onChange → diff → Transaction)          │
│                                                                            │
│  Persistence: IndexedDB autosave · File System Access API open/save        │
│  Settings: provider, endpoint, deployment, key (localStorage)              │
└────────────────────────────────────────────────────────────────────────────┘
        │ HTTPS (direct from browser; CORS must allow it — see Spike A)
        ▼
  Azure AI Foundry (chat + optional transcription deployment)
```

**Source of truth:** our **Board Model**, the semantic document behind the DSL. Excalidraw is the renderer and the manual-editing surface. Every change, from the AI or from a manual edit, becomes a **Transaction** of ops on the Board Model. That single path gives one change log, one undo stack, and one serialisation.

### Proposed repo layout
```
src/
  model/        types.ts, ops.ts (op schemas, zod), applyOp.ts, invertOp.ts
  dsl/          grammar.peggy, parse.ts, print.ts (canonical), dsl.test.ts
  compile/      toExcalidraw.ts, fromExcalidraw.ts (diff → ops), layout.ts (elkjs)
  history/      history.ts (transactions, undo/redo, persisted log)
  ai/           orchestrator.ts, prompt.ts, context.ts, providers/{types,azureFoundry,...}.ts
  speech/       types.ts, engines/{moonshine,whisper,webSpeech,providerRemote}.ts, worker.ts, models.ts (catalog)
  jobs/         queue.ts (job store, lifecycle, concurrency), types.ts
  usage/        ledger.ts (IndexedDB), pricing.ts (editable table), aggregate.ts
  settings/     store.ts, schema.ts, exportImport.ts (strips secret fields), migrations.ts
  templates/    library.ts (IndexedDB), expand.ts (instance → elements, params, ports, cycle check),
                saveAsTemplate.ts, versions.ts
  storage/      idb.ts, fileAccess.ts, bundle.ts (.board / .boardz / .boardlib)
  ui/           App.tsx, PromptBar, MicButton, SettingsDialog, HistoryPanel, ChangeHighlight, TemplateLibrary,
                StatusBar, QueuePanel, UsagePanel
```

---

## 1. Board file format (DSL)

There are two goals that pull against each other. Humans and the LLM need it **readable and diffable**. The canvas needs it **lossless enough** that the hand-drawn look stays stable from one load to the next.

**Approach:** line-oriented statements with stable ids. Defaults are omitted. Excalidraw-only details are kept in an optional `~{}` "render hints" block so the LLM can ignore them.

```
board "System overview" v1
style default font=hand roughness=1 stroke=#1e1e1e

node api  "API Gateway"  rect     at(200,100) size(160,60) fill=#e3f2fd ~{seed:1934}
node db   "Postgres"     cylinder below(api,80)
node q    "Job queue"    diamond  right(api,120)
edge e1 api -> db "queries" dashed
edge e2 api -> q
text n1 "TODO: auth" at(420,40) size=20
group g1 "Backend" [api, db, q]
image i1 asset:7f3a… at(600,300) size(240,160)
draw d1 stroke=#c00 width=2 path="M10 10 Q 40 5 60 30 …"   # freehand, SVG-path encoded
```

- **Shapes:** `rect`, `ellipse`, `diamond`, `cylinder` (composite), `sticky`, `line`/`arrow`, `text`, `image`, `draw` (freehand), `frame`, and `group`.
- **Relative placement** (`below(x,gap)`, `right(x,gap)`, or no position at all) is resolved at compile time by **elkjs** auto-layout. This is important because LLMs are poor at absolute coordinates.
- **Canonical printer:** `print(parse(text)) === text` for canonical input. Property tests check `decompile(compile(model)) ≅ model`.
- **Template instances:** the `use` statement, plus embedded `define` blocks. See §1b.
- **Images:** a `.board` file references `asset:<sha256>`. Two save modes:
  - a **single `.board` text file** with a base64 `assets` section at the end (fully self-contained, but bulky);
  - a **`.boardz`** zip containing `board.txt` and `assets/`.
- **Change log in the file:** an optional `history` section with the last N transactions, so undo survives reopening the file.
- **Parser:** a **peggy** grammar. It gives good error messages, which also feed the LLM repair loop.

## 1b. Template components

**Principle: a template is just a board.** Any board, or a selection saved as a board, can be marked as a template. Templates can contain base nodes and other template instances, so nesting works. On top of a normal board, a template declares two things:
- **params:** text or style slots, such as `{name}`;
- **ports:** named attachment points, so external edges can connect to an instance.

```
# in a template board (library: server@3)
board "Server" v3 template params(name, ip="10.0.0.1", color=#e3f2fd) ports(in=box.left, out=box.right)
node box "{name}" rect size(160,80) fill={color}
text ip "{ip}" below(box,4) size=14
use disk1 disk at(10,90)           # nested template

# in a user board
use web1 server@3 name="Web 1" at(100,100)
use web2 server@3 name="Web 2" right(web1,60) color=#fde2e2
edge e3 web1.out -> web2.in
define server@3 { …embedded copy of the template's DSL… }   # keeps the file self-contained
```

- **Library:** templates live in an IndexedDB library, shown as a palette panel with thumbnails. A user can:
  - **save the selection as a template**, which prompts for name, params (pick text fields to turn into params) and ports (pick nodes or edges);
  - open a template as its own board to edit it;
  - import or export templates as `.board` files, or as a `.boardlib` bundle.
- **Self-contained files:** a board embeds every template version it uses in `define` blocks, including transitive ones. It opens identically on a machine without that library. When the library has a newer version, the instance shows an "update available" badge, and updating is an undoable transaction.
- **Compilation:**
  - instances are expanded recursively into Excalidraw elements with namespaced ids (`web1/box`);
  - each instance is grouped as one movable, scalable unit;
  - params are substituted and ports resolve to edge bindings;
  - a cycle check rejects a template that contains itself.
- **Manual edits inside an instance:**
  - text and style changes become **per-instance overrides**, stored as `use … override(box.fill=#fff)`;
  - geometry or structural edits prompt **"Detach instance?"**, which inlines its base nodes as a single undoable transaction.
- **AI integration:**
  - the context includes a compact template catalog (name, version, description, params, ports);
  - new ops are `addInstance`, `updateInstance` (params, overrides), `detachInstance` and `swapTemplate`;
  - so a prompt like "add three web servers behind the load balancer" uses the user's own components;
  - a later option is "create a template from this selection", called a "componentize" op.
- **Undo/history:**
  - instance ops are ordinary transactions in the board's history;
  - edits to a template are recorded in the template's own history;
  - **linked instances re-render from the template version they're pinned to**, so editing a template never silently changes other boards — they get the "update available" badge instead.
## 2. Change log, undo and redo

- **Op set** (the same set the LLM emits): `addNode`, `updateNode` (partial props), `removeNode`, `addEdge`, `updateEdge`, `removeEdge`, `addText`, `addImage`, `addDrawing`, `move`, `resize`, `restyle`, `group`/`ungroup`, `reorder`.
- **Transaction** = `{id, ts, source: 'manual'|'ai'|'voice', prompt?, ops[], inverseOps[]}`. Inverses are computed when the transaction is applied, using a snapshot of the affected ids.
- **Undo/redo:** a stack over transactions. An AI request undoes as **one step**. A manual drag is coalesced into one transaction (debounced on pointer-up).
- **Manual edits:** in Excalidraw `onChange`, diff elements by `id` and `version` against the last compiled scene, then convert the diff into ops.
- **Excalidraw's built-in history must be bypassed** so there aren't two undo stacks. Push our own updates with `updateScene({captureUpdate: NEVER})` and intercept Ctrl+Z / the toolbar buttons. → **Spike B**.
- **History panel:** a list of transactions with source, prompt and time. Clicking an entry jumps there (undo or redo up to that point).

## 3. Natural-language edit pipeline (the core)

1. **Context builder:** includes the DSL of the board, without render hints. Large boards are trimmed to the selection, the viewport and their 1-hop neighbours, plus a summary list of the other ids. The current selection ids are always included.
2. **Request:** a system prompt (op semantics and DSL cheat-sheet), the user text or transcript, and any attached images (sent as multimodal content). The model **returns ops through tool calls or a JSON-schema structured output**, not a rewritten file. That keeps changes small, cheap to validate, and makes untouched elements impossible to corrupt.
3. **Validate** with zod and check that ids exist. On failure, send the errors back to the model (max 2 repair rounds).
4. **Layout:** new nodes with no position get placed by ELK relative to their neighbours.
5. **Apply immediately. There is no approval step.** A valid op set is applied straight away as one transaction, and undo is the safety net. Two lightweight cues help:
   - the changed elements get a brief highlight flash (about 1.5 s);
   - a toast reads "Applied 4 changes · **Undo**".
   The history panel keeps the prompt alongside each transaction, so any AI change can be found and undone later.
6. **Concurrency:** record the board version at request time. If the user edited the board in between, ops for ids that still exist are applied, and conflicts are shown.
7. **Arbitrary drawings:** the model can emit `addDrawing` with an SVG path. That path is converted to Excalidraw `freedraw` or `line` elements. Quality will be modest. Expect simple icons and doodles, not illustrations.

## 4. Provider abstraction

```ts
interface LLMProvider {
  id: string; label: string;
  settingsSchema: ZodSchema;              // drives the settings form
  complete(req: { system: string; messages: Msg[] /* text+image parts */;
                  tools: ToolDef[]; responseFormat?: JsonSchema },
           signal: AbortSignal, onProgress?: (p: {outputTokens: number}) => void)
           : Promise<{ toolCalls: ToolCall[]; text?: string; usage: Usage }>;
  transcribe?(audio: Blob, signal: AbortSignal): Promise<{ text: string; usage: Usage }>; // optional
  capabilities: { vision: boolean; tools: boolean; structuredOutput: boolean; streaming: boolean; transcription: boolean };
}
```

- **Azure AI Foundry (first):** settings are endpoint, deployment/model, API version and key. It supports both endpoint styles:
  - the OpenAI-compatible `…/openai/v1/chat/completions` or `…/openai/deployments/{dep}/chat/completions`;
  - the Foundry models endpoint `https://<res>.services.ai.azure.com/models/chat/completions` (with the `model` field).
  Use plain `fetch`, with no SDK, to keep the bundle small and the CORS behaviour visible.
- **Later providers** fit behind the same interface: OpenAI, Anthropic (allows direct browser calls with an opt-in header), Gemini, and a local Ollama or LM Studio.
- **Settings UI:** a provider dropdown plus a form generated from that provider's schema, a "Test connection" button, and a token/cost readout per request.

## 5. Images
- **Place:** paste, drag-drop or file picker. The file is hashed (sha256) into the asset store (IndexedDB) and becomes an Excalidraw image element. Large images are downscaled on import (max edge around 2048px).
- **As LLM context:** a paperclip in the prompt bar. Selected image elements on the board can also be attached automatically. This needs the provider capability `vision: true`; without it, the paperclip is disabled with a tooltip.

## 6. Voice input (English only)

**Verdict: in-browser transcription is good enough for this use case.** Edit commands are short, push-to-talk utterances, so batch transcription after the button is released works well. Streaming isn't needed. Restricting to English lets us use the smaller and faster English-only models.

**Settings → Voice:**
- **Mode:** `On-device` (default) · `Remote (via provider)` · `Browser (Web Speech)` · `Off`
- **On-device model** (picker shows download size, a speed/accuracy hint, and a "downloaded ✓" state with a delete button to free the cache):

| Option | Size (q4/q8, approx.) | Notes |
|---|---|---|
| **Moonshine base** (default) | ~60–120 MB | Fastest for its accuracy, built for short English commands. MIT-licensed. |
| Moonshine tiny | ~30–60 MB | For low-end devices and machines without WebGPU. |
| Whisper base.en | ~80–150 MB | Well-proven option. Accepts the board's node labels as a vocabulary prompt. |
| Whisper small.en | ~250–500 MB | Most accurate on-device option. Needs WebGPU to be fast. |

  Runtime is transformers.js in a Web Worker, using WebGPU with a WASM fallback. Models download once and are cached by the browser. Exact sizes get measured in Spike C.
- **Remote:** uses the **active model provider** through an optional `transcribe()` capability. For Azure Foundry that's a `gpt-4o-transcribe` or `gpt-4o-mini-transcribe` (or `whisper`) deployment on the same resource and key, configured as a "transcription deployment" field in the provider settings. Providers without a transcription capability show the option disabled.
- **Web Speech API:** zero-download fallback for Chrome/Edge. The settings make clear that audio goes to the browser vendor unless `processLocally=true` is available.
- If the selected on-device model fails (no WebGPU and too slow, or the download fails), the app suggests switching to Moonshine tiny or remote, without silently changing modes.

**Engine plumbing:**
- **`SpeechEngine` interface:** `{ id, kind: 'local'|'remote'|'browser', prepare(onProgress), transcribe(audio: Float32Array16k, hints, signal) → {text, usage?} }`. Audio is captured with `getUserMedia` and an AudioWorklet, then resampled to 16 kHz mono.
- Remote transcription reports usage (audio seconds and/or tokens) to the usage ledger (§9).
- **Transcript lands in the prompt bar** so the user can edit it. A setting allows "auto-send after speaking".
- **Hosting gotcha:** multi-threaded WASM needs cross-origin isolation (COOP/COEP). Pick a host that can set headers (Cloudflare Pages, Netlify, Azure Static Web Apps), or use `coi-serviceworker` on GitHub Pages.

## 6b. Keyboard shortcuts for prompting

- **Focus the prompt bar: `/`.** Ignored while typing in a field. Escape returns focus to the canvas. Shipped in phase 4.
- **Microphone: hold Ctrl+Shift+Space to talk, release to stop.**
  - A tap shorter than about 300 ms toggles recording on, and a second tap stops it.
  - It works while focus is in the prompt bar, and the transcript lands there.
  - The mic button and the status bar show "recording" while it's held.
  - Shipped with voice in phase 7.
- **Why these keys:** they avoid Excalidraw's bindings (letters and digits for tools, Space to pan, `?` for help, Cmd/Ctrl+/ for the command palette) and common browser and OS shortcuts (Cmd+Space, Ctrl+Space input switching, Cmd+Shift+M).
- **Remappable:** both are listed in Settings → Shortcuts, with conflict detection against Excalidraw's shortcuts. They're stored in settings, so they're included in settings export.

## 7. Job queue and status bar

Every voice or text request becomes a **Job** in a central queue (`src/jobs/queue.ts`, zustand store). The status bar renders that queue.

**Job lifecycle** (each stage reports progress):
```
recording → transcribing → queued → building context → calling model → validating (repair n/2)
          → laying out → applying → applied | failed | cancelled
```
- **Concurrency:** preparation stages (transcription, model calls) can run in parallel, up to a configurable limit (default 2). **Applying to the board is serialized**, in submission order. Before applying, each job checks the board version it was built against and goes through the conflict handling in §3.6.
- **Every job is cancellable** through its `AbortSignal`, which aborts the fetch or the worker task.
- **Progress sources:**
  - model download: bytes loaded / total;
  - transcription: stage indicator plus elapsed time;
  - model call: **streaming** (`stream: true` with usage included in the stream), showing output tokens received and elapsed time live;
  - repair rounds: "repair 1/2".

**Status bar layout (bottom of the screen):**
```
[● Mic: Moonshine base · ready] [Provider: Azure gpt-4.1 ✓]   ⟳ 2 active · 1 queued  ▾   Session: 12.4k tok · $0.031
```
- **Left:** voice engine state (not loaded / downloading 43% / ready / recording ●) and provider health (last test OK or error).
- **Middle:** an active job pill. Click it to expand the **queue panel**: each job shows its prompt snippet, current stage with a progress bar, elapsed time, token count so far, and cancel or retry buttons. Finished jobs stay in a "recent" section (last 20), linked to their history transaction.
- **Right:** running usage and cost for the session. Click it to open the usage panel (§9).
- Errors show as a red pill with the message and a retry action. Failures are never only a console log.

## 8. Settings export and import

- **Export:** a `marker-settings.json` file `{schema: 'marker-settings', version: 1, exportedAt, settings}`. It contains:
  - provider configs (endpoint, deployments, API version, active provider);
  - voice mode and on-device model choice;
  - job concurrency;
  - the pricing table and budget limits;
  - UI preferences such as auto-send voice and theme.
- **API keys are never exported.** Secret fields are tagged `secret: true` in each provider's `settingsSchema`, and the exporter strips every tagged field. A unit test asserts that no secret field survives export.
- **Import:** pick a file, validate it with zod, show a summary of what will change, then **replace** or **merge**. Keys already stored for a matching provider are kept. Providers without a key show "API key needed" in settings and in the status bar's provider pill.
- **Migrations:** settings carry a `version` field, and a `migrateSettings(v → v+1)` chain lets older exports keep importing.
- **Out of scope:** the usage ledger (it has its own CSV export) and boards (saved as files).

## 9. Token usage and cost tracking

- **Ledger:** an IndexedDB store with one record per remote call:
  `{ts, jobId, boardId, provider, deployment/model, kind: 'chat'|'transcribe', inputTokens, cachedInputTokens?, outputTokens, audioSeconds?, costEstimate?, priceVersion}`.
  - Chat token counts come from the response `usage` object (the final chunk when streaming).
  - Repair rounds are separate records under the same job.
  - Transcription records audio seconds and any tokens the API reports.
  - On-device work is recorded as zero cost, so the queue view stays complete.
- **Pricing table:** Azure prices vary by region, deployment type (global, data zone, provisioned) and agreement, and there's no reliable keyless way to fetch them from a browser. So prices live in a **user-editable table** per deployment: $/1M input, cached input and output tokens, and $/minute of audio. It ships with defaults for common models and records "last updated" in the settings. Costs are estimates computed when the call happens, and the price version is stored with each record.
- **Views:**
  - per-job cost in the queue panel;
  - session total in the status bar;
  - a usage panel showing today, this month and per board, split by model and by kind, with a simple daily bar chart;
  - CSV export.
- **Optional budget guard:** a monthly soft limit that warns, and an optional hard limit that blocks new remote jobs until the user confirms.

---

## Gaps and risks

| # | Gap / risk | Mitigation |
|---|---|---|
| A | ~~Unclear whether Azure Foundry endpoints send CORS headers for browser calls.~~ **Resolved 2026-10-26:** a preflight to `<res>.services.ai.azure.com/models/chat/completions` returned `access-control-allow-origin: *` and allowed `api-key,content-type` for POST. The `openai.azure.com/openai/deployments/{dep}/chat/completions` style passed the same check. | Direct browser calls work with both endpoint styles. |
| B | Excalidraw has its own undo history, so there could be two undo stacks. | **Spike B:** confirm `captureUpdate` control and keyboard interception in the current Excalidraw version. |
| C | The API key sits in the browser (localStorage), so any XSS leaks it. | Strict CSP, no third-party scripts, optional passphrase-encrypted key storage (WebCrypto), and docs advising a scoped or rate-limited key. |
| D | LLMs are poor at spatial layout. | Relative-placement ops plus ELK auto-layout. The model never has to produce pixel-perfect coordinates. |
| E | Large boards exceed the context window and cost. | Selection/viewport scoping plus an id summary. Show the token count before sending. |
| F | Lossless round-trip of every Excalidraw property through the DSL. | Unknown properties go in `~{}` render hints. Round-trip property tests with fast-check. |
| G | Freehand drawings in a text file are bulky, and the LLM can only move, restyle or delete them. | Encode points as an SVG path with reduced precision. Document the limitation. |
| H | Models differ in tool-call / structured-output support. | Capability flags, plus a fallback of a fenced JSON block parsed leniently. |
| I | Microphone needs HTTPS and a permission prompt; first STT use downloads a large model. | Explicit "Enable on-device voice" step with a progress bar. Web Speech or remote as the instant fallback. |
| J | Embedded images bloat the text file. | `.boardz` bundle option, and downscaling on import. |
| K | Template changes vs instance overrides: a param is renamed or the node an override targets is removed. | Pin each instance to a version. On update, show a migration report listing dropped overrides; the update stays undoable. |
| L | Deep nesting or large templates blow up the LLM context. | The catalog lists only each template's interface (params, ports). Instances appear in the DSL as one `use` line and are never expanded for the model. |

---

## Phases and rough effort (one developer, MVP quality)

| Phase | Scope | Est. |
|---|---|---|
| 0. Spikes | A: Azure CORS ✅ passed. B: Excalidraw history control ✅ looks feasible (`CaptureUpdateAction`, hideable `.undo-redo-buttons`). C: Whisper-base WebGPU latency/size on target devices | 2–4 days |
| 1. Shell | Vite/React/TS, Excalidraw embedded, IndexedDB autosave, settings store, static deploy pipeline | ~1 wk |
| 2. Model + DSL | Types, ops, peggy grammar, canonical printer, compile to Excalidraw, decompile/diff from Excalidraw, ELK layout, tests | 2–3 wks |
| 3. History | Transactions, inverses, undo/redo, coalescing, history panel, persisted log | ~1 wk |
| 4. Providers | Interface, Azure Foundry (both endpoint styles), settings form, test-connection button | ~1 wk |
| 5. NL editing | Prompt and tool schemas, context builder, validation/repair loop, apply + highlight + undo toast, conflict handling | 2–3 wks |
| 5b. Templates | Template board flag, params and ports, `use`/`define` in the DSL, recursive expansion, overrides and detach, library panel, save selection as template, version pinning and updates, AI catalog and ops | 2–2.5 wks |
| 6. Images | Asset store, place/paste, `.boardz`, images as LLM context | ~1 wk |
| 7. Voice | Push-to-talk hotkey (§6b), capture worklet, on-device model catalog and worker (Moonshine, Whisper .en), Web Speech, provider-remote engine, voice settings, mic UI | 1–1.5 wks |
| 8. Jobs + status bar | Job queue and lifecycle, cancellation, streaming progress, status bar, queue panel. The basic queue lands with phase 5; this phase is the full UI | ~1 wk |
| 9. Usage + cost | Ledger, editable pricing table, usage panel and chart, CSV export, budget guard | ~1 wk |
| 9b. Settings export/import | Schema versioning, secret stripping, import diff summary, merge or replace | 2–3 days |
| 10. Polish | File open/save (File System Access API with download fallback), SVG/PNG export, PWA offline, CSP, error states | 1–2 wks |
| **Total** | | **~15–20 weeks** |

**Suggested first milestone (about 3 weeks):** Phases 0 and 1, plus a thin slice of phases 2, 4 and 5. The slice covers nodes, edges and text only: type "add a database below the API and connect them", it appears, and Ctrl+Z removes it.

---

## Implementation notes

**Phase 2 (done, 2026-10-26)**
- **Parser:** hand-written instead of peggy. The format is line-based, so a small tokenizer and parser are enough and avoid a codegen step. Errors carry `line:col`.
- **Core ops:** the core set is `add`, `update` (with style and hints merged; `null` removes), `remove` (cascades to edges, groups and relative dependents), `reorder` (`after`), `replace` (kind change under the same id) and `board` (title and default style). The named ops the LLM will use in phase 5 (`move`, `restyle` and so on) will be thin wrappers over these. `commit()` applies a list atomically, checks integrity, and returns inverse ops.
- **Relative placement is live:** `below(api,80)` follows `api` when it moves. Dragging or resizing a dependent pins it to `at(x,y)`.
- **Compiler and decompiler:**
  - `compileBoard` is our own deterministic compiler: stable ids, seeds from an id hash, labels as `<id>~label`, our own arrow routing.
  - `diffScene` compares the live Excalidraw scene against `compileBoard(board)`, so an untouched scene produces no ops.
  - Hand-drawn elements keep Excalidraw's id, unless it isn't a valid identifier; then it gets an `x` prefix.
- **Layout:** `placeUnplaced` (ELK, layered) writes absolute positions for new unplaced nodes. Phase 5 calls it after AI ops.
- **Canvas sync:**
  - Board changes are pushed into Excalidraw with `captureUpdate: NEVER`.
  - Edits made on the canvas are diffed after each gesture ends, and are ignored when they're our own render (tracked with `hashElementsVersion`).
  - The board is passed as `initialData`, and the first scene Excalidraw reports becomes the baseline (otherwise its async init reads as "delete everything").
- **Persistence:** the board is autosaved as DSL text in IndexedDB. The phase 1 raw-scene autosave is migrated once through the decompiler.
- **Not yet:** `cylinder` and `frame` shapes, template ports (parsed, not used), image file bytes (phase 6).

**Phase 3 (done, 2026-10-26)**
- **History module:** `src/history/` is pure (`record` / `undo` / `redo` / `jumpTo`). Each transaction stores the applied ops (with cascades) and their inverse, plus its source, title and optional prompt. Titles describe what was asked for, before cascades ("Moved “API Gateway”", "Deleted 2 elements").
- **Undo and redo:** Ctrl/Cmd+Z undoes; Ctrl/Cmd+Shift+Z or Ctrl+Y redoes. Text fields, including Excalidraw's own text editor, keep native undo. Canvas edits still waiting on the debounce are flushed before any history move, so they can't be lost.
- **Where it shows:** undo and redo buttons sit in Excalidraw's footer, beside zoom. The History drawer lists changes newest first, marks the current state, strikes through undone steps, and jumps on click.
- **Persistence:** history (capped at 300) is saved to IndexedDB in the same write as the board text, tagged with a hash of that text. It's only restored when the hash matches.
- **Deferred to phase 10:** the optional `history` section inside saved `.board` files lands with real file open and save.

**Phase 4 (done, 2026-10-26)**
- **Provider interface (`src/ai/providers/types.ts`):** streaming `complete()` with tool calls, image parts and usage, plus `testConnection()`, which forces a tool call so it also confirms the deployment can edit boards. Failures are `ProviderError`s with a kind (auth, not-found, rate-limit with retry-after, network, config, and so on) and a message written for the user.
- **Azure AI Foundry (`azureFoundry.ts`):**
  - plain `fetch` with SSE parsing, `api-key` header, `max_completion_tokens`, and `stream_options.include_usage` (except on the models endpoint);
  - three endpoint types (deployments, v1, models), detected from the URL;
  - a pasted portal URL fills in the deployment and API version;
  - an empty API version means the default for the endpoint type.
- **Settings dialog:** a native `<dialog>`. Edits are staged until Save; the test uses the staged values. The API key is stored separately from settings, and the E2E test checks that it never appears in the settings record. The provider name in the status strip opens the dialog. With no model configured, Draw opens Settings.
- **Shortcuts:** `/` focuses the prompt bar and Escape returns to the canvas. Both are in the settings schema (`shortcuts`); the remapping UI comes with phase 7.
- **Live check still needed:** tests use a mocked Azure. The first real "Test connection" against `gpt-5.6-luna` should be done by hand.

**Phase 5 (done, 2026-10-26)**
- **Model tools:** `edit_board({summary, ops})` and `reply({message})`, sent with `toolChoice: 'required'`. Their JSON Schemas come from the zod schemas in `src/ai/llmOps.ts`.
  - Model ops: `add_node`, `add_text`, `add_edge` (id optional), `add_drawing`, `update`, `remove`, `group`, `ungroup`, `reorder`.
  - Placement is relative (`{rel, of, gap}`), absolute, or left out for automatic layout.
  - They translate to core ops, and mistakes the model can fix come back as readable issues.
- **Orchestrator (`runEdit`):**
  - context is the board text without render hints, the selection captured when the request was sent, and the request;
  - zod validation, then translation, then a test `commit`, with failures returned as a tool result, for up to 2 repairs;
  - then `placeUnplaced`;
  - result is one transaction titled with the model's summary, with the prompt stored on it.
  - Boards over 24k characters send only the selection and its neighbours in full, plus a capped id summary.
- **Job queue (basic):** one request at a time, so each edit is validated against the board the previous one left. Stages are thinking, correcting and placing; jobs can be cancelled, show live token counts, and track session token usage. The full queue panel is phase 8.
- **Feedback:**
  - the status strip shows the active request with elapsed time and tokens, plus Cancel;
  - a blue marker stroke sweeps along the ledge while busy;
  - a toast says what changed, with Undo (which only undoes if it's still the latest change);
  - replies and errors show in the toast with Try again;
  - changed shapes get a fading marker ring instead of being selected, because selecting opens Excalidraw's style panel over the board.
- **Testing:** unit tests use a scripted provider, and E2E tests use a mocked Azure (edit and undo, reply, repair, cancel). `e2e/live.spec.ts` runs one real request when the `MARKER_AZURE_*` env vars are set.
- **Still to do:** the ~30-prompt eval set. It needs live runs to record responses first.
- **Recent context and follow-ups (done):** `src/ai/recent.ts` adds two sections to each request:
  - "Recent conversation": up to 4 finished requests from the last 30 minutes, each with the reply text, the change made, the error or the cancellation. This makes "yes, do that" work.
  - "Recent changes": the 5 newest history entries with source, request and touched ids.

  `edit_board` takes `undo_first: n` (0–5):
  - the orchestrator validates the new ops against the board after undoing on a copy;
  - the queue checks that those are still the newest changes, really undoes them, then applies the new ops as one step, so undoing it goes back to before the rejected change;
  - `undo_first` with no ops is a plain undo.

**Fonts (done, 2026-10-26)**
- **Seven presets (`src/model/fonts.ts`),** each mapped to a typeface Excalidraw ships and we host ourselves: `hand` (Excalifont, default), `virgil` (Classic sketch), `normal` (Rounded / Nunito), `sans` (Plain / Liberation Sans), `display` (Headline / Lilita One), `code` (Comic Shanns), `mono` (Cascadia).
- **Board font:** `style default font=…`, set from Excalidraw's main menu ("Board font", each option shown in its own face). It's one undoable step, and Excalidraw's font for new text follows it.
- **Per element:** `font=` on any node, edge label or text. Picking a font in Excalidraw's style panel is recorded on that element (deprecated faces are enabled so Virgil and Cascadia can be picked). A face outside the presets is kept as a `fontFamily` hint.
- **The model** can set per-element fonts through `style.font`, and the board font with `set_board_font`.
- **Text measurement** estimates width per font. All preset faces are loaded on startup, then the scene is re-measured so text drawn before a face arrived isn't clipped. The text panel's code face is named "Marker Code" so it doesn't clash with Excalidraw's "Cascadia".

**Phase 5b: templates (done, 2026-10-26)**
- **Model:**
  - `Board.template` (name, description, params with defaults, ports with target and side);
  - `Board.definitions` (flat `name@version` → template board, embedded so files stand alone);
  - an `instance` element with template key, params, placement, scale, and per-part overrides (`{text, style}`, nested parts as `disk1/box`).
  - New ops `define`/`undefine`. Definitions no instance uses (directly or through other templates) are pruned at the end of each commit, inside the transaction, so undo restores them.
  - Checks cover unknown templates, params, ports and override targets, plus definition cycles.
- **DSL:** a template board has `template <name> "<description>"`, `param <name> "<default>"` and `port <name> <target> <side>` lines. Copies are `use <id> <name>@<v> [placement] [scale(n)] [with(p="v")] [override(part.text="…", part.fill=#…)]`, and definitions are `define <name>@<v> { … }` blocks at the end. Params fill `{name}` placeholders in text only (style variation is done with overrides).
- **Compile:**
  - copies expand recursively (depth ≤ 8) into namespaced Excalidraw ids (`web1/box`), scaled and translated from the content bounds, grouped under the copy id, with per-copy seeds;
  - edges bind to port targets;
  - a missing template shows a dashed placeholder.
- **Canvas edits on copies:**
  - moving or scaling the whole copy updates `at`/`scale`;
  - text, style and font changes on parts become overrides;
  - deleting all parts removes the copy;
  - ungrouping detaches it;
  - moving or deleting single parts is rejected and reverted, with a Detach action.
- **Library:** in IndexedDB as DSL text per version. The Templates drawer tab shows previews with defaults filled in, Add to board, Update copies to the latest version (reporting params and overrides that no longer fit), Delete, and "Used on this board, not in your library → Save to library" (keeping the board's version number). "Save selection as template" offers a name, description, fill-in texts, connection points with sides, and the option to replace the selection with a copy (outside edges move to its ports).
- **Model:** each request gets a catalog of templates (description, fill-ins with defaults, ports, parts), and board text is sent without `define` blocks. New ops `add_copy` (library latest, or the board's version), `update_copy` (params, place, scale, `part_text`, `part_style`) and `detach`; edges accept `copy.port`.
- **Later (all since done or decided):** `.boardlib` import/export came with phase 10, and the canvas update badge and colour fill-ins with the deferred work below. Editing a template in place was decided against: edit a template by detaching a copy, changing it, and saving it again under the same name, which creates the next version.

**Phase 6: images (done, 2026-10-26)**
- **Asset store (`src/assets/`):** IndexedDB `marker.asset.<sha1>` holding the data URL, mime type and natural size. The id is the SHA-1 of the bytes, which matches Excalidraw's file ids, so a pasted or dropped image's `fileId` is the board's `asset:<id>`.
- **Canvas:** new files are stored when the scene is read; files the board needs are loaded into Excalidraw (`addFiles`) on startup and after every render. Crop and flip made in Excalidraw round-trip as `crop` and `flip` hints.
- **Attachments:**
  - paperclip, paste or drop onto the ledge, up to 4 images;
  - images are downscaled to 1568px on the long side (photos as JPEG, everything else PNG) and saved as assets;
  - selected board images are attached automatically.
  - They're sent as image parts after the text, and the context lists them by label, asset id and size. Providers without vision refuse with a clear message.
- **Model:** `add_image {id, asset, place?, size?}` places an attached image. Without a size it fits within 320px keeping proportions; without a place it goes right of the selection, or of the last element.
- **Later:**
  - embedding asset bytes in saved `.board` / `.boardz` files comes with file save in phase 10 (for now assets live beside the board in IndexedDB);
  - unused assets are never cleaned up yet.

**Phase 7: voice (done, 2026-10-26)**
- **Engines (`src/speech/`):** one `VoiceEngine` interface, `begin()` returning a session whose `end()` resolves with the text.
  - **On-device** (default): transformers.js 4.3.1 in a module Web Worker. Choice of Moonshine base (default), Moonshine tiny, Whisper base.en and Whisper small.en. WebGPU uses an fp32 encoder with a q4 decoder; the WASM fallback uses q8. ONNX Runtime is self-hosted from `/ort/`. Models are cached by the browser, with Download now and Delete in Settings.
  - **Remote:** the provider's `transcribe()` — Azure `…/audio/transcriptions` (api-version 2025-03-01-preview, or v1) on a transcription deployment, with the same key. Its usage counts toward session tokens.
  - **Browser:** the Web Speech API (Chrome and Edge).
- **Capture:** `getUserMedia`, an AudioWorklet, then an OfflineAudioContext resample to 16 kHz mono, capped at 60 s, with a smoothed level for the mic ring.
- **Interaction:** hold Ctrl+Shift+Space (or the mic button) to talk and release to finish; a tap under 300 ms toggles recording on until the next press. The transcript is appended to the prompt bar, or sent straight away with auto-send, and voice requests are recorded with source `voice`.
  - The status strip shows the engine, model download progress, and recording time.
  - Settings → Shortcuts records new key combinations and warns about clashes with Excalidraw, browser and OS shortcuts.
- **Spike C result:** Moonshine tiny on WASM (headless Chromium, no WebGPU) downloaded and loaded in about 3.1 s and transcribed a 2.7 s spoken request in **185 ms**, accurately. On-device is the right default.
- **Testing:** Chrome's fake microphone plays `e2e/fixtures/speech.wav` (made with macOS `say`). The remote and tap/hold flows are tested with a mocked Azure; the real on-device run is opt-in with `MARKER_SPEECH_E2E=1`, because it downloads the model.
- **Later:** Whisper's vocabulary prompt from board labels, and Chrome's on-device `processLocally` for browser speech. Vite also emits its own unused 27 MB copy of the ORT WASM file in `dist/`, to trim in phase 10.

**Phase 8: job queue (done, 2026-10-26)**
- **Concurrency:** up to `settings.jobConcurrency` (default 2) requests are worked out at once. Applying is synchronous, so changes land one at a time, in the order they finish.
- **Changes in between:** if the board changes while a request is being worked out, the orchestrator checks against the latest board and sends any problems back as a normal correction round. If another change lands between that check and the apply (during layout), or `undo_first` no longer matches the newest changes, the queue redoes the request once against the new board (`ConflictError`, marked "redoing on the changed board").
- **Queue panel:** opened from the strip's request summary ("Working out “…” 4 s, 120 tokens, 2 more"). It lists working requests (with a sweeping marker progress stroke), waiting ones and finished ones (title, reply or error; time, duration, tokens; Spoken), with Cancel, Try again and Clear finished.
- **Placement fix (requested):** requests carry the visible area. Unconnected new elements are centred in the view, at the nearest free spot (ring search), instead of right of the board or at (0,0). Images without a place or selection are centred too, and the model is told the visible bounds and centre.

**Phase 9: usage and cost (done, 2026-10-26)**
- **Ledger:** IndexedDB store `marker-usage/records`, one record per remote call: chat (each correction round separately), connection tests, and remote transcription. Each holds the deployment, the reported model, job id, input / cached input / output tokens, audio seconds, and the cost in USD worked out when the call was made. `meterProvider()` wraps any provider; a cancelled call records estimated tokens (request size / 4, plus what had streamed), flagged `estimated`.
- **Prices:**
  - `settings.pricing[deployment]` stores $/1M input, cached input and output, plus $/minute of audio;
  - defaults cover known families (gpt-4o, 4o-mini, 4.1, 4.1-mini, 4.1-nano, 5, 5-mini, 5-nano, o4-mini, the transcribe models, whisper), matched by exact family or `family-<suffix>`. `gpt-5.6-luna` deliberately matches nothing, so it isn't costed at another model's price.
  - Cached input is billed at its own rate; audio priced per minute is billed by length.
- **Budget:** `settings.budget.warnAt` (a once-a-month warning) and `limit` (new requests fail with a "Send anyway" action that re-submits with `overBudgetOk`).
- **UI:**
  - the status strip shows "This session: N tokens, $X" ("at least" when some calls are unpriced) and opens the Usage tab;
  - the Usage tab has tiles (session, today, month), the budget bar, a 30-day column chart (cost, or tokens when unpriced; single series in marker blue, validated with the dataviz palette checker; hover tooltip; table view), a this-month table by deployment, CSV export and Clear;
  - Settings → Costs edits prices per deployment (the chat and transcription deployments, plus anything in the ledger) and the budget;
  - the queue panel shows each request's cost.

**Phase 9b: settings export and import (done, 2026-10-26)**
- **Export:** `marker-settings.json`, shaped `{schema: 'marker-settings', version: 1, exportedAt, settings}`, from the dialog's current form. Keys are stored apart from settings, so they can't be included; as a second safeguard the exporter refuses if any key-like field name, or the stored key's value, would appear in the file.
- **Import:**
  - parse the file and check its schema and version, refusing newer formats;
  - run the `MIGRATIONS[n]` chain, which upgrades a file one version at a time;
  - refuse key-like fields, then validate with zod; every error is a plain sentence.
  - The review lists each change ("Voice: on-device → remote", "Prices for …"), with **Replace all** (the file's settings, plus defaults) or **Only change what the file sets** (a deep merge; prices for other deployments are kept).
  - "Use these settings" fills the form, and Save keeps it. The stored key is never touched, and a fresh app shows "needs an API key".
- **Not included:** the usage ledger (it has CSV export), template library and boards (files in phase 10).

**Phase 10: polish (done, 2026-10-26)**
- **Board files (`src/storage/boardFile.ts`, `src/state/file.ts`):**
  - `.board` is the board text plus images (`#@asset <id> <mime> <WxH> <base64>`) and history (`#@history <hash> <json>`) as comment lines, so the whole file is still valid board text. History only returns if the hash matches, so a hand-edited file loses it.
  - `.boardz` is a zip (fflate) of `board.board`, `assets/<id>`, `assets.json` and `history.json`.
  - Open, Save, Save as and New in the main menu and on Ctrl/Cmd+O, +S and +Shift+S, using the File System Access API with a download and file-input fallback. The handle is kept in IndexedDB.
  - Unsaved changes are judged by text hash (so undoing back to the saved state counts as saved), shown in the status strip, with a save-first prompt before New or Open.
- **Template library files:** `.boardlib` (JSON of every template and version as board text). Import skips versions already present and adds a conflicting version as the next number.
- **Production content security policy:** injected into built pages only. Allows this site, Azure, Hugging Face, WASM compilation and `blob:` workers; blocks plugins, form submissions and other base URLs. To meet it:
  - Excalidraw's font path is set by `public/asset-path.js`, a classic script that runs before its module registers fonts;
  - its esm.sh font fallback is rewritten to this site at build time;
  - the recorder worklet is imported `?url&no-inline`, so it isn't an inlined `data:` script.
- **Speech runtime, served once:** in development the `/ort/` files are served raw from `node_modules` by a dev-server plugin; builds import the same files through `virtual:ort-paths`, so the copy Vite emits is the only one (dist from about 93 MB to 52 MB).
- **Offline:**
  - a Workbox service worker (vite-plugin-pwa, injectManifest, classic `/sw.js`) precaches the app shell and board fonts (173 entries, about 10.5 MB), and caches the CJK font and speech runtime on first use;
  - every page is served from the precache with COOP/COEP added, which gives cross-origin isolation on header-less hosts (one reload on the first visit);
  - `clientsClaim()` makes the first visit work offline;
  - updates are offered as a Reload toast;
  - there's a manifest, and icons rendered from `public/icons/icon.svg` by `scripts/make-icons.mjs`.
- **Evals (`evals/`):** 31 cases with tolerant structural checks. `npm run eval` replays `evals/recordings/*.json` (cases without one are skipped; one hand-written example is included), and `npm run eval:live` records against Azure from the `MARKER_AZURE_*` env vars.
- **Production checks:** `npm run e2e:preview` builds and runs `e2e/preview/` against `vite preview`, covering the policy (no violations), on-device speech under the policy, and opening offline.

**Rename and deferred work (done, 2026-10-26)**
- **Renamed to Marker:** every name, env var (`MARKER_*`), dev hook (`window.__marker`), cache and storage key. `src/storage/migrateName.ts` moves data saved under `boardbot.*`:
  - localStorage (settings, keys) synchronously, imported first by `main.tsx`, before any store reads it;
  - IndexedDB (board, history, file handle, templates, images, and the usage database) before the app renders, copying before deleting so an interrupted move repeats.

  Files exported with the old `boardbot-settings` / `boardbot-library` tags still import, and the service worker drops the old cache. File extensions are unchanged.
- **Prompt box:** written in Comic Shanns (the "Code" preset), with `autocomplete="off"` so the browser doesn't offer earlier requests.
- **Room for arrow labels:** ELK gets each edge label's size; a group placed below its anchor moves further down for a labelled arrow; a model placement with no gap widens to the label's width (or height) plus 40px.
- **`undo_first` tied to send time:** each request keeps the newest changes from when it was sent and builds "Recent changes" from them. `undo_first` undoes those, only while they're still the newest; otherwise the request fails, pointing to History.
- **Follow links:** relative placement stays live (the open question is settled). While something is dragged, a dashed link runs to each element that will follow it. They're drawn by `CanvasOverlay`, which tracks Excalidraw's scroll and zoom.
- **Cylinders:** `cylinder` compiles to an invisible rectangle carrying the id, bindings and label, plus a closed outline (`~body`) and a rim (`~rim`), grouped under the node. The label's container is the band between the rims, and the outline goes beneath it, since Excalidraw keeps a label just above its container. Moves, resizes and recolours are read from the outline.
- **Frames:** `frame <id> "<name>" [members] [at(x,y) size(w,h)]` compiles to an Excalidraw frame. Without a box it wraps its members plus 40px padding. Membership is read back from `frameId`, frames drawn by hand are adopted, and the model has a `frame` op.
- **Short ids:** two seconds after the canvas goes quiet, elements drawn by hand are renamed (`rect1`, `arrow2`, …) with a new core `rename` op, folded into the user's newest canvas edit so it undoes with it.
- **Dark theme:** a `theme` setting (system, light, dark) in the main menu and Settings. Interface colours are tokens with a dark palette (all text pairs pass WCAG AA), and Excalidraw gets the same theme. `public/theme.js` applies it before the first paint. The usage chart's dark bars were checked with the dataviz validator.
- **Labels:** text is measured again once pending font loads finish, and the Latin range of every face is preloaded, so labels are no longer clipped. Labels in rectangles, sticky notes and cylinders wrap to the shape's width; what was typed stays in `originalText`, which is what decompiling reads.
- **Templates:**
  - an "Update to vN" pill on each outdated copy updates just that copy;
  - `fill={param}` and `stroke={param}` take colours per copy, with overrides still winning;
  - "Save selection as template" can make a shape's fill or outline a fill-in;
  - the model's catalog says which fill-ins are colours.

## Verification
- **Unit (vitest):** DSL parse/print round-trip, compile/decompile round-trip (fast-check property tests), `applyOp`/`invertOp` identity (`apply(inv(apply(op)))` restores the state), Excalidraw-diff-to-ops cases.
- **LLM eval set:** about 30 golden prompts with starting boards. Recorded provider responses are used for deterministic CI. A manual `npm run eval:live` runs against the real Azure deployment and scores op validity and expected structural outcomes.
- **E2E (Playwright):** mocked provider. Prompt → changes applied and highlighted → toast Undo → redo → save → reopen gives an identical board. Settings export → clear storage → import restores everything except keys, and the "API key needed" state appears. Image paste. Voice, using an injected audio file through a fake media stream. Templates: save a selection as a template, place two instances, connect them port to port, edit a param, detach one, then open the file in a clean profile (library empty) — it renders identically from the embedded `define` blocks.
- **Template unit tests:** recursive expansion with params and ports, cycle rejection, override survival and reporting across version updates, detach giving the same visual result.
- **Jobs and usage (unit + E2E):**
  - queue ordering under concurrency (parallel prep, serialized apply);
  - cancel mid-stream aborts the fetch and records partial usage;
  - ledger aggregation matches a fixture;
  - cost recalculates when the price table changes (new jobs only);
  - status bar shows download %, stage changes and token counts with a slow mocked streaming provider.
- **Manual:** the real Azure Foundry key in the deployed static site (confirms CORS end-to-end, and that usage arrives on the final stream chunk), mic on Chrome, Edge and Safari, each on-device model on a WebGPU machine and on a machine without WebGPU.

## Deferred work and open questions

Everything still put off, in one place. Each item says where it came from and roughly what it involves.

### Model quality
- **Record and run the evals** (phase 5, 10). `npm run eval:live` against `gpt-5.6-luna` records answers for the 31 cases in `evals/cases.ts`; only one hand-written example is recorded so far. The failures should drive changes to the system prompt and op descriptions.

### Board model and canvas
- **Labels in ellipses and diamonds** don't wrap. Their default sizes leave less room inside than the label's width, so wrapping them would change existing drawings; it needs new default sizes first.
- **Old long ids.** Only elements drawn since the canvas loaded get short ids; boards saved before keep Excalidraw's long ones.

### Images and files
- **Cleaning up unused images** (phase 6). Image assets in IndexedDB are never deleted. They could be garbage-collected when no board, history entry or template refers to them.
- **Choosing `.boardz` without the file picker** (phase 10). In browsers without the File System Access API, Save as always downloads `.board`.

### Voice
- **Vocabulary hints for Whisper** (phase 7). Pass the board's labels as an initial prompt so names on the board are transcribed correctly.
- **Private browser speech** (phase 7). Use Chrome's on-device `processLocally` for the "browser" voice mode where available.

### Performance and platform
- **Precache size** (phase 10). The service worker precaches about 10.5 MB, mostly Excalidraw's diagram-import chunks (Mermaid and similar). They could be cached on first use instead.
- **Browsers other than Chromium.** All automated tests run in Chromium. Safari and Firefox (microphone, file pickers, service worker, cross-origin isolation) haven't been checked.
- **More providers** (§4). OpenAI, Anthropic, Gemini and local models fit behind the provider interface; only Azure AI Foundry is built.

### Decided
- **Live relative placement:** kept live, with follow links while dragging.
- **Editing a template in place:** not needed; detach a copy, change it, and save it under the same name.

### Answered or still open from the original plan
- **File extension and history (answered):** `.board` (text) and `.boardz` (zip); undo history is saved in files by default.
- **Hosting (open):** any static host works. The service worker supplies the isolation headers where the host can't, so the choice only affects how the first visit loads.
- **Default prices (open):** the defaults are list prices for known model families. `gpt-5.6-luna` has none, so its price has to be entered in Settings → Costs.
