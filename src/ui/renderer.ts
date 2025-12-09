/* Renderer for Electron transcription UI
   - Opens local audio via preload API
   - Decodes audio with WebAudio API to Float32Array
   - Resamples to 16k if needed
   - Draws waveform on canvas
   - Runs Xenova whisper pipeline and shows transcript
   - Saves transcript back to disk
*/

declare global {
  interface Window {
    electronAPI: {
      openAudioFile: () => Promise<string | null>;
      saveTranscript: (filePath: string, text: string) => Promise<boolean>;
      transcribeFile: (filePath: string) => Promise<{ok: boolean; text?: string; error?: string}>;
    };
  }
}

const modelId = "Xenova/whisper-small.en"; // default model

const openBtn = document.getElementById("openBtn") as HTMLButtonElement;
const saveBtn = document.getElementById("saveBtn") as HTMLButtonElement;
const transcriptEl = document.getElementById("transcript") as HTMLElement;
const canvas = document.getElementById("waveCanvas") as HTMLCanvasElement;
const ctx = canvas.getContext("2d")!;

let currentAudioPath: string | null = null;

// If the preload bridge didn't expose `electronAPI`, surface a helpful error immediately.
if (!window.electronAPI) {
  const msg = 'electronAPI is not present on window — preload failed to run. Check that Electron is launching with the correct `preload` script and that preload has no runtime errors.';
  console.error('renderer:', msg, { location: window.location.href });
  const el = document.getElementById('transcript');
  if (el) el.textContent = msg;
}

function pathToFileUrl(path: string) {
  // Convert Windows backslashes and produce file:///C:/... style URL
  let p = path.replace(/\\/g, "/");
  if (/^[A-Za-z]:\//.test(p)) {
    // Windows absolute path
    return "file:///" + p;
  }
  if (!p.startsWith("/")) p = "/" + p;
  return "file://" + p;
}

async function fetchArrayBufferFromPath(path: string): Promise<ArrayBuffer> {
  const url = pathToFileUrl(path);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to load file: ${res.status}`);
  return await res.arrayBuffer();
}

async function decodeArrayBufferToFloat32(arrayBuffer: ArrayBuffer): Promise<{samples: Float32Array, sampleRate:number}> {
  const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
  const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer.slice(0));
  const sampleRate = audioBuffer.sampleRate;
  // take first channel (mixdown if necessary)
  let channelData: Float32Array;
  if (audioBuffer.numberOfChannels === 1) {
    channelData = audioBuffer.getChannelData(0) ?? new Float32Array(audioBuffer.length);
  } else {
    channelData = mixdown(audioBuffer);
  }
  // copy to new Float32Array
  const samples = new Float32Array(channelData.length);
  samples.set(channelData);
  return { samples, sampleRate };
}

function mixdown(audioBuffer: AudioBuffer): Float32Array {
  const ch = audioBuffer.numberOfChannels;
  const len = audioBuffer.length;
  if (ch === 0 || len === 0) return new Float32Array(0);
  const out = new Float32Array(len);
  for (let c = 0; c < ch; c++) {
    const data = audioBuffer.getChannelData(c);
    if (!data) continue;
    const d = data as Float32Array;
    for (let i = 0; i < len; i++) out[i] = (out[i] ?? 0) + (d[i] ?? 0);
  }
  const channels = ch || 1;
  for (let i = 0; i < len; i++) out[i] = (out[i] ?? 0) / channels;
  return out;
}

async function resampleFloat32Array(input: Float32Array, srcRate: number, dstRate: number): Promise<Float32Array> {
  if (srcRate === dstRate) return input;
  const length = Math.ceil(input.length * dstRate / srcRate);
  const offlineCtx = new (window.OfflineAudioContext || (window as any).webkitOfflineAudioContext)(1, length, dstRate);
  const buffer = offlineCtx.createBuffer(1, input.length, srcRate);
  // Ensure a concrete ArrayBuffer-backed Float32Array (avoids SharedArrayBuffer typing issues)
  buffer.copyToChannel(new Float32Array(input), 0);
  const src = offlineCtx.createBufferSource();
  src.buffer = buffer;
  src.connect(offlineCtx.destination);
  src.start(0);
  const rendered = await offlineCtx.startRendering();
  return rendered.getChannelData(0) as Float32Array;
}

function drawWaveform(samples: Float32Array) {
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0,0,w,h);
  ctx.fillStyle = "#fff";
  ctx.fillRect(0,0,w,h);
  ctx.strokeStyle = "#007acc";
  ctx.lineWidth = 1;
  ctx.beginPath();
  const step = Math.max(1, Math.floor(samples.length / w));
  for (let i = 0; i < w; i++) {
    const start = i * step;
    let min = 1, max = -1;
    for (let j = 0; j < step && (start + j) < samples.length; j++) {
      const v = samples[start + j] ?? 0;
      if (v < min) min = v;
      if (v > max) max = v;
    }
    const y1 = (1 - (min + 1) / 2) * h;
    const y2 = (1 - (max + 1) / 2) * h;
    ctx.moveTo(i, y1);
    ctx.lineTo(i, y2);
  }
  ctx.stroke();
}

async function transcribeFile(path: string) {
  transcriptEl.textContent = "Loading audio...";
  const ab = await fetchArrayBufferFromPath(path);
  transcriptEl.textContent = "Decoding...";
  const { samples, sampleRate } = await decodeArrayBufferToFloat32(ab);
  const targetRate = 16000;
  let float32 = samples;
  if (sampleRate !== targetRate) {
    transcriptEl.textContent = `Resampling ${sampleRate} → ${targetRate}...`;
    float32 = await resampleFloat32Array(samples, sampleRate, targetRate);
  }
  drawWaveform(float32);

  transcriptEl.textContent = "Transcribing (running Node service)...";
  const resp = await window.electronAPI.transcribeFile(path);
  if (!resp || !resp.ok) {
    transcriptEl.textContent = `Error: ${resp?.error ?? 'unknown'}`;
    return '';
  }
  transcriptEl.textContent = resp.text ?? '';
  return resp.text ?? '';
}

openBtn.addEventListener('click', async () => {
  console.debug('renderer: openBtn clicked');
  try {
    const path = await window.electronAPI.openAudioFile();
    console.debug('renderer: openAudioFile returned', path);
    if (!path) {
      transcriptEl.textContent = 'Open cancelled';
      return;
    }
    currentAudioPath = path;
    try {
      await transcribeFile(path);
    } catch (err: any) {
      console.error('renderer: transcribeFile error', err);
      transcriptEl.textContent = `Error: ${err.message ?? err}`;
    }
  } catch (err: any) {
    console.error('renderer: openAudioFile invocation failed', err);
    transcriptEl.textContent = `Error opening file: ${err?.message ?? err}`;
    alert(`Open failed: ${err?.message ?? err}`);
  }
});

saveBtn.addEventListener('click', async () => {
  if (!currentAudioPath) {
    alert('Open a file first');
    return;
  }
  const text = transcriptEl.textContent || '';
  const txtPath = currentAudioPath.replace(/\.[^/.]+$/, '') + '.txt';
  await window.electronAPI.saveTranscript(txtPath, text);
  alert('Saved: ' + txtPath);
});

export {};
