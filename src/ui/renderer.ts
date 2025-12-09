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
      startStream: (sessionId?: string) => Promise<any>;
      sendStreamChunk: (sessionId: string, arrayBuffer: ArrayBuffer) => Promise<any>;
      endStream: (sessionId?: string) => Promise<any>;
      onTranscription: (cb: (sessionId: string, text: string) => void) => void;
    };
  }
}

const modelId = "Xenova/whisper-small.en"; // default model

const openBtn = document.getElementById("openBtn") as HTMLButtonElement;
const saveBtn = document.getElementById("saveBtn") as HTMLButtonElement;
const recordBtn = document.getElementById('recordBtn') as HTMLButtonElement;
const refreshBtn = document.getElementById('refreshBtn') as HTMLButtonElement | null;
const recStatus = document.getElementById('recStatus') as HTMLElement;
const transcriptEl = document.getElementById("transcript") as HTMLElement;
const canvas = document.getElementById("waveCanvas") as HTMLCanvasElement;
const ctx = canvas.getContext("2d")!;

// Ensure canvas pixel size matches display size for crisp drawing
function adjustCanvasSize() {
  const ratio = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || 600;
  const h = canvas.clientHeight || 150;
  // reset transform to avoid cumulative scaling
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  canvas.width = Math.max(1, Math.floor(w * ratio));
  canvas.height = Math.max(1, Math.floor(h * ratio));
  ctx.scale(ratio, ratio);
}
window.addEventListener('resize', adjustCanvasSize);
adjustCanvasSize();

let currentAudioPath: string | null = null;
let mediaRecorder: MediaRecorder | null = null;
let currentSessionId: string | null = null;

// Live waveform drawing state
let liveChunks: Float32Array[] = [];
let liveSampleRate = 16000; // will be overwritten by decoded chunk sampleRate if available
let drawAnimationId: number | null = null;
const MAX_LIVE_SECONDS = 6; // keep last N seconds for display
let pendingDecodes = 0;
// AudioWorklet capture state (for reliable real-time PCM)
let audioCtxCapture: AudioContext | null = null;
let audioWorkletNode: AudioWorkletNode | null = null;
let mediaStreamSource: MediaStreamAudioSourceNode | null = null;
let captureGainNode: GainNode | null = null;


function sleep(ms: number) {
  return new Promise((res) => setTimeout(res, ms));
}

async function waitForPendingDecodes(timeoutMs = 1000) {
  const start = Date.now();
  while (pendingDecodes > 0 && (Date.now() - start) < timeoutMs) {
    await sleep(30);
  }
}

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
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, Math.floor(canvas.width / dpr));
  const h = Math.max(1, Math.floor(canvas.height / dpr));
  ctx.clearRect(0, 0, canvas.width, canvas.height);
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

// Build a single Float32Array from liveChunks (oldest -> newest), limited to maxSamples
function concatLiveSamples(maxSamples: number): Float32Array {
  if (liveChunks.length === 0) return new Float32Array(0);
  // compute total length
  let total = 0;
  for (const c of liveChunks) total += c.length;
  // if under limit, concat all
  if (total <= maxSamples) {
    const out = new Float32Array(total);
    let off = 0;
    for (const c of liveChunks) {
      out.set(c, off);
      off += c.length;
    }
    return out;
  }
  // need to drop oldest samples to fit
  let toDrop = total - maxSamples;
  let startIndex = 0;
  while (startIndex < liveChunks.length && toDrop > 0) {
    if (liveChunks[startIndex].length <= toDrop) {
      toDrop -= liveChunks[startIndex].length;
      startIndex++;
    } else {
      // partially drop from start of this chunk
      const keep = liveChunks[startIndex].length - toDrop;
      const out = new Float32Array(maxSamples);
      let off = 0;
      // copy partial from this chunk
      out.set(liveChunks[startIndex].subarray(liveChunks[startIndex].length - keep), off);
      off += keep;
      // copy the rest
      for (let i = startIndex + 1; i < liveChunks.length; i++) {
        out.set(liveChunks[i], off);
        off += liveChunks[i].length;
      }
      return out;
    }
  }
  // if we've skipped whole chunks, copy remaining
  const remaining = liveChunks.slice(startIndex);
  const out = new Float32Array(maxSamples);
  let off = 0;
  for (const c of remaining) {
    if (off + c.length > maxSamples) {
      out.set(c.subarray(0, maxSamples - off), off);
      break;
    }
    out.set(c, off);
    off += c.length;
  }
  return out;
}

function drawLiveWaveform() {
  const maxSamples = Math.max(1024, Math.floor(MAX_LIVE_SECONDS * liveSampleRate));
  const samples = concatLiveSamples(maxSamples);
  if (samples.length === 0) {
    // clear canvas using display size
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.floor(canvas.width / dpr));
    const h = Math.max(1, Math.floor(canvas.height / dpr));
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, w, h);
  } else {
    drawWaveform(samples);
  }
}

function startLiveDrawing() {
  if (drawAnimationId) return;
  function loop() {
    drawLiveWaveform();
    drawAnimationId = requestAnimationFrame(loop);
  }
  drawAnimationId = requestAnimationFrame(loop);
}

function stopLiveDrawing() {
  if (drawAnimationId) {
    cancelAnimationFrame(drawAnimationId);
    drawAnimationId = null;
  }
  // keep the last drawn frame so users can see the final waveform after stopping
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
 
// AudioWorklet helper: start capturing PCM frames from the microphone stream.
async function startAudioCaptureIfNeeded() {
  if (audioCtxCapture) return;
  try {
    audioCtxCapture = new (window.AudioContext || (window as any).webkitAudioContext)();
    // create a tiny worklet that posts input channel data to the main thread
    const workletCode = `class PCMProcessor extends AudioWorkletProcessor {\n  process(inputs) {\n    try {\n      const input = inputs[0];\n      if (input && input[0]) {\n        // copy to transferable Float32Array
        const buffer = new Float32Array(input[0]);\n        this.port.postMessage(buffer, [buffer.buffer]);\n      }\n    } catch (e) {\n      // ignore\n    }\n    return true;\n  }\n}\nregisterProcessor('pcm-processor', PCMProcessor);`;
    const blob = new Blob([workletCode], { type: 'application/javascript' });
    const url = URL.createObjectURL(blob);
    await audioCtxCapture.audioWorklet.addModule(url);
    audioWorkletNode = new AudioWorkletNode(audioCtxCapture, 'pcm-processor');
    audioWorkletNode.port.onmessage = (ev: MessageEvent) => {
      try {
        const data = ev.data as Float32Array;
        // ensure a concrete copy
        const samples = new Float32Array(data.length);
        samples.set(data);
        liveSampleRate = audioCtxCapture?.sampleRate || liveSampleRate;
        liveChunks.push(samples);
        // trim
        const maxSamples = MAX_LIVE_SECONDS * liveSampleRate;
        let total = 0;
        for (let i = liveChunks.length - 1; i >= 0; i--) {
          total += liveChunks[i].length;
          if (total > maxSamples) {
            while (liveChunks.length && total > maxSamples) {
              total -= liveChunks[0].length;
              liveChunks.shift();
            }
            break;
          }
        }
        if (!drawAnimationId) startLiveDrawing();
      } catch (err) {
        console.warn('worklet onmessage error', err);
      }
    };
    // create a silent gain node to connect output so processor runs reliably
    captureGainNode = audioCtxCapture.createGain();
    captureGainNode.gain.value = 0;
    captureGainNode.connect(audioCtxCapture.destination);
    // To hook the stream source we need a media stream; try to reuse existing MediaRecorder's stream
    // If MediaRecorder exists and has a stream, use it; otherwise, request a new stream
    let streamForCapture: MediaStream | null = null;
    if (mediaRecorder && (mediaRecorder as any).stream) {
      streamForCapture = (mediaRecorder as any).stream as MediaStream;
    }
    if (!streamForCapture) {
      try {
        streamForCapture = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch (err) {
        console.warn('startAudioCapture: getUserMedia failed', err);
        return;
      }
    }
    mediaStreamSource = audioCtxCapture.createMediaStreamSource(streamForCapture);
    mediaStreamSource.connect(audioWorkletNode);
    audioWorkletNode.connect(captureGainNode);
  } catch (err) {
    console.warn('startAudioCapture failed', err);
    // cleanup on failure
    try { audioCtxCapture?.close(); } catch (e) {}
    audioCtxCapture = null;
    audioWorkletNode = null;
    mediaStreamSource = null;
    captureGainNode = null;
  }
}

function stopAudioCaptureIfNeeded() {
  try {
    if (mediaStreamSource) {
      try { mediaStreamSource.disconnect(); } catch (e) {}
      mediaStreamSource = null;
    }
    if (audioWorkletNode) {
      try { audioWorkletNode.port.close(); } catch (e) {}
      try { audioWorkletNode.disconnect(); } catch (e) {}
      audioWorkletNode = null;
    }
    if (captureGainNode) {
      try { captureGainNode.disconnect(); } catch (e) {}
      captureGainNode = null;
    }
    if (audioCtxCapture) {
      try { audioCtxCapture.close(); } catch (e) {}
      audioCtxCapture = null;
    }
  } catch (err) {
    console.warn('stopAudioCaptureIfNeeded error', err);
  }
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

// Recording controls
recordBtn.addEventListener('click', async () => {
  if (!recordBtn) return;
  try {
    if (!mediaRecorder || mediaRecorder.state === 'inactive') {
      // start
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaRecorder = new MediaRecorder(stream);
      currentSessionId = `s_${Date.now()}`;
      // notify main
      await window.electronAPI.startStream(currentSessionId);
      mediaRecorder.ondataavailable = async (e: BlobEvent) => {
        if (!e.data || e.data.size === 0) return;
        const ab = await e.data.arrayBuffer();
        try {
          await window.electronAPI.sendStreamChunk(currentSessionId!, ab);
        } catch (err) {
          console.error('sendStreamChunk error', err);
        }
        // If we have an AudioWorklet capturing PCM, it will feed `liveChunks` directly.
        // Skip decoding the recorded Blob to avoid format/codec decode errors in some engines.
        if (audioWorkletNode) {
          return;
        }
        // Also decode locally and add to live buffer for waveform visualization
        pendingDecodes++;
        try {
          const { samples, sampleRate } = await decodeArrayBufferToFloat32(ab);
          liveSampleRate = sampleRate || liveSampleRate;
          liveChunks.push(samples);
          // trim to MAX_LIVE_SECONDS
          const maxSamples = MAX_LIVE_SECONDS * liveSampleRate;
          let total = 0;
          for (let i = liveChunks.length - 1; i >= 0; i--) {
            total += liveChunks[i].length;
            if (total > maxSamples) {
              // drop oldest until under limit
              while (liveChunks.length && total > maxSamples) {
                total -= liveChunks[0].length;
                liveChunks.shift();
              }
              break;
            }
          }
          // ensure animation running
          if (!drawAnimationId) startLiveDrawing();
        } catch (err) {
          console.warn('live decode error', err);
        } finally {
          pendingDecodes = Math.max(0, pendingDecodes - 1);
        }
      };
      mediaRecorder.onstart = () => {
        if (recStatus) recStatus.textContent = 'Recording...';
        recordBtn.textContent = 'Stop';
        // reset live buffer and start drawing
        liveChunks = [];
        drawAnimationId = null;
        startLiveDrawing();
        // also start AudioWorklet capture for reliable PCM frames
        // startAudioCapture is async but we don't need to await here
        startAudioCaptureIfNeeded();
      };
      mediaRecorder.onstop = async () => {
        if (recStatus) recStatus.textContent = 'Finalizing...';
        recordBtn.textContent = 'Record';
        try {
          const resp = await window.electronAPI.endStream(currentSessionId!);
          if (!resp || !resp.ok) {
            transcriptEl.textContent = `Error: ${resp?.error ?? 'unknown'}`;
          }
        } catch (err) {
          console.error('endStream error', err);
          transcriptEl.textContent = `Error: ${err?.message ?? err}`;
        } finally {
          // Give the browser a short moment to deliver the final `dataavailable` event
          // (some engines emit it after `stop` fires). Then wait for pending decodes.
          await sleep(300);
          await waitForPendingDecodes(1200);
          // Force a few final draws to ensure the canvas paints the last frame.
          try {
            drawLiveWaveform();
            await sleep(30);
            drawLiveWaveform();
            await sleep(30);
            drawLiveWaveform();
          } catch (err) {
            console.warn('draw final waveform failed', err);
          }
          if (recStatus) recStatus.textContent = 'Idle';
          currentSessionId = null;
          stopAudioCaptureIfNeeded();
          stopLiveDrawing();
        }
      };
      mediaRecorder.start(250); // emit blobs every 250ms
    } else if (mediaRecorder.state === 'recording') {
      mediaRecorder.stop();
    }
  } catch (err: any) {
    console.error('recordBtn handler error', err);
    alert('Recording failed: ' + (err?.message ?? err));
  }
});

// receive transcription results
window.electronAPI.onTranscription((sid, text) => {
  // If this is the current session or no session specified, show text
  transcriptEl.textContent = text ?? '';
  if (recStatus) recStatus.textContent = 'Idle';
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

// Manual refresh button: redraw the live waveform or re-render the opened file
if (refreshBtn) {
  refreshBtn.addEventListener('click', async () => {
    try {
      if (recStatus) recStatus.textContent = 'Refreshing...';
      adjustCanvasSize();
      if (liveChunks.length > 0) {
        // draw current live buffer
        drawLiveWaveform();
      } else if (currentAudioPath) {
        // re-decode and draw the opened file (this also updates transcript text)
        try {
          await transcribeFile(currentAudioPath);
        } catch (err: any) {
          console.error('refresh: transcribeFile failed', err);
        }
      } else {
        // nothing to draw: clear to white
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        const dpr = window.devicePixelRatio || 1;
        const w = Math.max(1, Math.floor(canvas.width / dpr));
        const h = Math.max(1, Math.floor(canvas.height / dpr));
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, w, h);
      }
    } finally {
      if (recStatus) recStatus.textContent = 'Idle';
    }
  });
}

export {};
