// 新サイト（shoma.dpdns.org/youtube/）へのデータ引っ越し用エクスポート。
// 形式は新サイト側の transfer.ts（parseTransferJson / decodeFromUrl）と一致させること。
import { storage, type HiddenMap, type HistoryMap, type LaterMap, type ResumeMap } from './storage';

export type TransferPayload = {
  app: 'ytv';
  v: 1;
  exportedAt: number;
  ytv_watch_later: LaterMap;
  ytv_hidden: HiddenMap;
  ytv_resume: ResumeMap;
  ytv_history: HistoryMap;
  ytv_channel_filter: string;
};

/** 今の localStorage をそのまま 1 つの JSON にまとめる */
export function buildExport(): TransferPayload {
  return {
    app: 'ytv',
    v: 1,
    exportedAt: Date.now(),
    ytv_watch_later: storage.loadLater(),
    ytv_hidden: storage.loadHidden(),
    ytv_resume: storage.loadResume(),
    ytv_history: storage.loadHistory(),
    ytv_channel_filter: storage.loadChannelFilter(),
  };
}

// --- URL 用の圧縮エンコード（JSON → UTF-8 → deflate-raw → base64url） ---

async function pipeBytes(
  bytes: Uint8Array<ArrayBuffer>,
  stream: { readable: ReadableStream<Uint8Array>; writable: WritableStream<BufferSource> },
): Promise<Uint8Array> {
  const writer = stream.writable.getWriter();
  const writing = writer.write(bytes).then(() => writer.close());
  const reader = stream.readable.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
  }
  await writing;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  // btoa は文字列しか受けないので、大きい配列は小分けにして binary string にする
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function encodeForUrl(payload: TransferPayload): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  const compressed = await pipeBytes(bytes, new CompressionStream('deflate-raw'));
  return bytesToBase64Url(compressed);
}
