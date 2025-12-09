#!/usr/bin/env node
import { transcribeFile } from '../services/transcribe.js';
import path from 'path';

async function main() {
  const arg = process.argv[2];
  if (!arg) {
    console.error('Usage: npm run transcribe -- <audio-file>');
    process.exit(2);
  }
  const filePath = path.resolve(process.cwd(), arg);
  try {
    const text = await transcribeFile(filePath);
    console.log('\n=== TRANSCRIPT ===\n');
    console.log(text);
  } catch (err: any) {
    console.error('Transcription failed:', err?.message ?? err);
    process.exitCode = 1;
  }
}

main();
