/**
 * A fake `ctx.http.fetch` for creative ingress tests: answers HEAD for media
 * URLs from a table and Graph requests from a handler, and records every call.
 */

export interface RecordedRequest {
  url: string;
  method: string;
  /** Form fields of a Graph write, decoded. */
  fields: Record<string, string>;
}

export interface MediaHead {
  /** Makes the fetch throw this message, like a connection or TLS failure. */
  throws?: string;
  status?: number;
  headers?: Record<string, string>;
}

/** Bytes that are not valid UTF-8: a lossy text transport would change them. */
export const NON_UTF8_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xfe, 0xc3, 0x28, 0x80, 0x00]);

/** graph.facebook.com and its upload hosts such as graph-video.facebook.com. */
export function isGraphHost(url: string): boolean {
  return /^graph(-[a-z]+)?\.facebook\.com$/.test(new URL(url).hostname);
}

export class FakeMediaAndGraph {
  readonly calls: RecordedRequest[] = [];
  readonly responses: Response[] = [];
  /** HEAD answers by exact URL. Unknown URLs get 404. */
  readonly heads = new Map<string, MediaHead>();
  videoCounter = 0;
  /** Set to make the next advideos POSTs fail with this Graph error body. */
  failUploads = 0;

  head(url: string, head: MediaHead): this {
    this.heads.set(url, head);
    return this;
  }

  get graphWrites(): RecordedRequest[] {
    return this.calls.filter((call) => isGraphHost(call.url) && call.method !== "GET");
  }

  get mediaCalls(): RecordedRequest[] {
    return this.calls.filter((call) => !isGraphHost(call.url));
  }

  fetch = async (url: string, init?: RequestInit): Promise<Response> => {
    const method = init?.method ?? "GET";
    const fields: Record<string, string> = {};
    if (typeof init?.body === "string") {
      for (const [key, value] of new URLSearchParams(init.body)) fields[key] = value;
    }
    this.calls.push({ url, method, fields });
    const response = this.answer(url, method);
    this.responses.push(response);
    return response;
  };

  private answer(url: string, method: string): Response {
    const parsed = new URL(url);
    if (!isGraphHost(url)) {
      const head = this.heads.get(url);
      if (head?.throws) throw new Error(head.throws);
      // A body that is not valid UTF-8: the ingress must never read it.
      return new Response(NON_UTF8_BYTES, { status: head ? (head.status ?? 200) : 404, headers: head?.headers ?? {} });
    }
    const json = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (method === "POST" && /\/act_\d+\/advideos$/.test(parsed.pathname)) {
      if (this.failUploads > 0) {
        this.failUploads -= 1;
        return json(400, { error: { message: "Invalid parameter", type: "OAuthException", code: 100, error_subcode: 1363019 } });
      }
      this.videoCounter += 1;
      return json(200, { id: `90000000000000${this.videoCounter}` });
    }
    if (method === "GET") return json(200, { data: [] });
    return json(200, { success: true, id: "1" });
  }
}
