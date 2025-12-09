import fs from 'fs/promises';
import path from 'path';
import os from 'os';

type Session = { chunks: Buffer[] };

const sessions = new Map<string, Session>();

export function startSession(sessionId = 'default') {
  sessions.set(sessionId, { chunks: [] });
}

export function pushChunk(sessionId = 'default', arrayBuffer: ArrayBuffer) {
  const s = sessions.get(sessionId);
  if (!s) throw new Error('session not started');
  s.chunks.push(Buffer.from(arrayBuffer));
}

export async function endSession(sessionId = 'default'): Promise<string> {
  const s = sessions.get(sessionId);
  if (!s) throw new Error('session not started');
  const outDir = os.tmpdir();
  const outPath = path.join(outDir, `vtp_recording_${sessionId}_${Date.now()}.webm`);
  const buf = Buffer.concat(s.chunks);
  await fs.writeFile(outPath, buf);
  // cleanup session
  sessions.delete(sessionId);

  // call transcribe service (dynamic import)
  // We expect the compiled JS to exist at src/services/transcribe.js after building
  const svcPath = path.join(process.cwd(), 'src', 'services', 'transcribe.js');
  try {
    // Convert to file:// URL for dynamic import in ESM contexts
    const fileUrl = pathToFileURL(svcPath);
    const mod = await import(fileUrl.href);
    if (!mod || !mod.transcribeFile) throw new Error('transcribe service not found');
    const text = await mod.transcribeFile(outPath);
    return text;
  } catch (err) {
    // Propagate the error to caller
    throw err;
  }
}

function pathToFileURL(p: string) {
  let resolved = path.resolve(p);
  // Node's file URL on Windows needs a leading slash
  if (process.platform === 'win32') resolved = '/' + resolved.replace(/\\/g, '/');
  return new URL('file://' + resolved);
}

export default { startSession, pushChunk, endSession };
