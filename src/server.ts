import { ollamaBaseURL } from './ollama.js'
import { log } from './log.js'
import { createApp } from './app.js'

const port = Number(process.env.PORT ?? 3000)

function parseDebateMaxConcurrent(raw: string | undefined): {
  value: number
  usedFallback: boolean
} {
  const parsed = Number(raw ?? 1)
  if (!Number.isFinite(parsed) || parsed < 1) {
    return { value: 1, usedFallback: true }
  }

  return { value: Math.floor(parsed), usedFallback: false }
}

const debateMaxConcurrent = parseDebateMaxConcurrent(process.env.DEBATE_MAX_CONCURRENT)
const maxActiveDebates = debateMaxConcurrent.value

const app = createApp(maxActiveDebates)

app.listen(port, () => {
  if (debateMaxConcurrent.usedFallback) {
    log.info('debate_max_concurrent_fallback', {
      configured: process.env.DEBATE_MAX_CONCURRENT ?? null,
      applied: maxActiveDebates,
    })
  }

  log.info('server_started', { port, ollama_base_url: ollamaBaseURL })
})
