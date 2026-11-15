/**
 * A fake media host for the organic media lock (RK9-852): HEAD answers with
 * Content-Type, Content-Length, ETag and Last-Modified. A test changes a
 * file's headers or status to model a swapped or dropped file.
 */

export interface FakeMediaFile {
  status: number;
  headers: Record<string, string>;
}

export const MEDIA_LAST_MODIFIED = "Sat, 14 Nov 2026 08:00:00 GMT";

function typeOf(url: string): string {
  if (url.endsWith(".mp4")) return "video/mp4";
  if (url.endsWith(".png")) return "image/png";
  return "image/jpeg";
}

export class FakeMedia {
  readonly files = new Map<string, FakeMediaFile>();
  readonly heads: string[] = [];

  constructor(readonly host = "media.ololla.fi") {}

  handles(url: string): boolean {
    try {
      return new URL(url).hostname === this.host;
    } catch {
      return false;
    }
  }

  file(url: string): FakeMediaFile {
    let file = this.files.get(url);
    if (!file) {
      file = {
        status: 200,
        headers: { "content-type": typeOf(url), "content-length": "1048576", etag: '"v1"', "last-modified": MEDIA_LAST_MODIFIED },
      };
      this.files.set(url, file);
    }
    return file;
  }

  readonly fetch = async (url: string, init?: RequestInit): Promise<Response> => {
    if ((init?.method ?? "GET") !== "HEAD") throw new Error(`the fake media host takes HEAD only, got ${init?.method ?? "GET"} ${url}`);
    this.heads.push(url);
    const file = this.file(url);
    return new Response(null, { status: file.status, headers: file.headers });
  };
}
