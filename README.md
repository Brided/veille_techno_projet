# Veille Techno Projet

This project contains audio decoding and transcription tools plus an Electron UI.

Quick commands

- Build and run the Electron UI:

```cmd
npm run build:ui
npm run electron
```

- Transcribe a local file from the CLI (uses Xenova Whisper locally):

```cmd
npm run transcribe -- path\\to\\audio.wav
```

Notes

- The transcription service resamples audio to 16 kHz and decodes WAV before running the model.
- The project attempts to use `ffmpeg-static` when available; otherwise it falls back to system `ffmpeg` on PATH.
- For faster startup use `Xenova/whisper-tiny.en` by changing the default model in `src/services/transcribe.ts` or `src/ui/renderer.ts`.
