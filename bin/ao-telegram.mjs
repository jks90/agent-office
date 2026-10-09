#!/usr/bin/env node
// Envía un aviso por Telegram (FT-174). Es el RELEASE_NOTIFY_CMD de scripts/release/run-all.sh: el texto llega como
// argumento o, si no hay, por stdin. Usa la config de data/telegram.json; sin ella no hace nada (sale 0).
import * as telegram from '../server/telegram.js';

let text = process.argv.slice(2).join(' ').trim();
if (!text && !process.stdin.isTTY) { let b = ''; for await (const c of process.stdin) b += c; text = b.trim(); }
if (text) await telegram.send(text);
process.exit(0);
