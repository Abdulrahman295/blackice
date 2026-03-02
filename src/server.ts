import { ollamaBaseURL } from './ollama.js';
import { log } from './log.js';
import { createApp } from './app.js';

const port = Number(process.env.PORT ?? 3000);
const maxActiveDebates = Number(process.env.DEBATE_MAX_CONCURRENT ?? 1);

const app = createApp(maxActiveDebates);

app.listen(port, () => {
  log.info('server_started', { port, ollama_base_url: ollamaBaseURL });
});
