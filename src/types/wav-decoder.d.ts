declare module 'wav-decoder' {
  export interface AudioData {
    sampleRate: number;
    channelData: Float32Array[];
    length?: number;
  }

  export function decode(buffer: ArrayBuffer | Buffer): Promise<AudioData>;

  const _default: {
    decode: typeof decode;
  };

  export default _default;
}
