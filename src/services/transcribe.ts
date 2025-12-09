import fs from 'fs/promises';
import { pipeline } from '@xenova/transformers';
import wavDecoder from 'wav-decoder';
import { spawn } from 'child_process';
import path from 'path';
import os from 'os';

/**
 * Transcription service
 * - Exports transcribeFile(filePath, modelId?) which returns transcript string
 * - Uses ffmpeg (system or ffmpeg-static) to create a 16k mono WAV, decodes and runs Xenova pipeline
 */

async function runFfmpegTo16kMono(inputPath: string): Promise<string> {
  const tmp = path.join(os.tmpdir(), `vtp_tmp_${Date.now()}.wav`);
  let ffmpegExec = 'ffmpeg';
  try {
    const ffmpegStatic = await import('ffmpeg-static');
    ffmpegExec = (ffmpegStatic && (ffmpegStatic.default || ffmpegStatic)) as unknown as string;
  } catch (e) {
    // fallback to system ffmpeg
  }

  await new Promise<void>((resolve, reject) => {
    const ff = spawn(ffmpegExec, ['-y', '-i', inputPath, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', tmp], { stdio: 'inherit' });
    ff.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`ffmpeg exit ${code}`)));
    ff.on('error', reject);
  });
  return tmp;
}

function mixdownChannels(channelData: Float32Array[] | undefined): Float32Array {
  // If no channel data, return empty samples
  if (!channelData || channelData.length === 0) return new Float32Array(0);
  if (channelData.length === 1) return channelData[0] ?? new Float32Array(0);
  const len = channelData[0]!.length;
  const out = new Float32Array(len);
  for (let c = 0; c < channelData.length; c++) {
    const ch = channelData[c];
    if (!ch) continue;
    const chArr = ch as Float32Array;
    for (let i = 0; i < len; i++) out[i] = (out[i] ?? 0) + (chArr[i] ?? 0);
  }
  // Avoid division by zero — count only non-empty channels
  const channels = channelData.filter((c) => !!c).length || 1;
  for (let i = 0; i < len; i++) out[i] = (out[i] ?? 0) / channels;
  return out;
}

async function decodeWavToFloat32(filePath: string): Promise<{ samples: Float32Array; sampleRate: number; }> {
  const buf = await fs.readFile(filePath);
  const audioData = await wavDecoder.decode(Buffer.from(buf));
  const sampleRate = audioData.sampleRate;
  // Normalize channelData shape: wav-decoder typings may include undefined channels
  const rawChannels = (audioData as any).channelData as (Float32Array | undefined)[] | undefined;
  const normalized = (rawChannels ?? []).map((c) => c ?? new Float32Array(0));
  const samples = mixdownChannels(normalized.length ? normalized : undefined);
  return { samples, sampleRate };
}

export async function transcribeFile(filePath: string, modelId = 'Xenova/whisper-small.en') {
  console.log('Preparing audio (resample to 16k mono if needed)...');
  const tmpPath = await runFfmpegTo16kMono(filePath);

  try {
    console.log('Decoding WAV...');
    const { samples } = await decodeWavToFloat32(tmpPath);

    console.log('Loading model and transcribing (may take a while)...');
    const asr = await pipeline('automatic-speech-recognition', modelId);
    const result = await asr(samples);
    let text: string;
    if (typeof result === 'string') {
      text = result;
    } else if (Array.isArray(result)) {
      // Join multiple segments/outputs
      text = result.map((r: any) => (r?.text ?? JSON.stringify(r))).join('\n');
    } else {
      text = (result?.text ?? JSON.stringify(result));
    }
    return text;
  } finally {
    await fs.unlink(tmpPath).catch(() => { /* ignore */ });
  }
}

export default { transcribeFile };
