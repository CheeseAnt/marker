# BoardBot: plan for an AI-edited whiteboard

## Context
This is a new project in an empty repo (`/Users/anton/Documents/git/boardbot`). The goal is a browser-only virtual whiteboard with a hand-drawn look. Users edit it **first through natural language** (typed or spoken), and an external LLM turns each request into diagram changes. Manual editing stays available. Other requirements:
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

- **Export:** a `boardbot-settings.json` file `{schema: 'boardbot-settings', version: 1, exportedAt, settings}`. It contains:
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
| 7. Voice | Capture worklet, on-device model catalog and worker (Moonshine, Whisper .en), Web Speech, provider-remote engine, voice settings, mic UI | 1–1.5 wks |
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

## Questions still open (can be answered after the spikes)
- File extension and name (`.board` / `.boardz`?), and whether the history section is saved by default.
- Hosting target (this affects COOP/COEP headers and whether an optional proxy is easy to add).
- Default prices to ship for your Azure region and deployment type.
