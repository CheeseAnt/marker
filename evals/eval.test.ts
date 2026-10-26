/**
 * Model evals. By default each case replays its recorded answers (evals/recordings), so the run is
 * deterministic and free; cases without a recording are skipped. To record against a real model:
 *
 *   BOARDBOT_EVAL_LIVE=1 BOARDBOT_AZURE_ENDPOINT=https://<res>.openai.azure.com \
 *   BOARDBOT_AZURE_DEPLOYMENT=<name> BOARDBOT_AZURE_KEY=<key> npm run eval:live
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { runEdit } from '../src/ai/orchestrator'
import { createAzureFoundryProvider } from '../src/ai/providers/azureFoundry'
import type { ChatResult, LLMProvider } from '../src/ai/providers/types'
import { parseBoard } from '../src/dsl/parse'
import { emptyHistory } from '../src/history/history'
import { commit } from '../src/model/apply'
import { CASES } from './cases'

const LIVE = process.env.BOARDBOT_EVAL_LIVE === '1'

interface Recording {
  caseId: string
  model?: string
  recordedAt: string
  responses: ChatResult[]
}

const pathFor = (id: string) => new URL(`./recordings/${id}.json`, import.meta.url)

function replaying(rec: Recording): LLMProvider {
  let i = 0
  return {
    id: 'replay',
    label: 'Replay',
    capabilities: { vision: true, tools: true, streaming: true, transcription: false },
    complete: async () => {
      const next = rec.responses[i++]
      if (!next) throw new Error(`the recording for ${rec.caseId} has no answer number ${i}; record it again`)
      return next
    },
    testConnection: async () => {
      throw new Error('not recorded')
    },
  }
}

function recording(provider: LLMProvider, into: ChatResult[]): LLMProvider {
  return {
    ...provider,
    complete: async (req, opts) => {
      const result = await provider.complete(req, opts)
      into.push(result)
      return result
    },
  }
}

describe('model evals', () => {
  for (const c of CASES) {
    const recorded = existsSync(pathFor(c.id))
    it.skipIf(!LIVE && !recorded)(c.id, async () => {
      const responses: ChatResult[] = []
      const provider = LIVE
        ? recording(
            createAzureFoundryProvider({
              endpoint: process.env.BOARDBOT_AZURE_ENDPOINT ?? '',
              deployment: process.env.BOARDBOT_AZURE_DEPLOYMENT ?? '',
              endpointStyle: 'auto',
              apiVersion: process.env.BOARDBOT_AZURE_API_VERSION ?? '',
              apiKey: process.env.BOARDBOT_AZURE_KEY ?? '',
            }),
            responses,
          )
        : replaying(JSON.parse(readFileSync(pathFor(c.id), 'utf8')) as Recording)

      const result = await runEdit({
        prompt: c.prompt,
        provider,
        getBoard: () => c.board,
        getHistory: () => emptyHistory(),
        selection: c.selection ?? [],
        templates: (c.templates ?? []).map((text) => {
          const board = parseBoard(text)
          return { name: board.template!.name, version: 1, board }
        }),
      })

      if (LIVE) {
        const rec: Recording = { caseId: c.id, model: responses.find((r) => r.model)?.model, recordedAt: new Date().toISOString(), responses }
        writeFileSync(pathFor(c.id), JSON.stringify(rec, null, 2) + '\n')
      }

      expect(result.kind, result.kind === 'reply' ? `replied: ${result.message}` : 'edited the board').toBe(c.expect ?? 'edit')
      const after = result.kind === 'edit' ? commit(c.board, result.ops).board : c.board
      const failures = c.checks.map((check) => check(after, c.board)).filter(Boolean)
      expect(failures).toEqual([])
    })
  }
})
