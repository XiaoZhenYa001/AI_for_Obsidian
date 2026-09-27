import { randomBytes } from "crypto";
import { Buffer } from "buffer";
import { createServer, IncomingMessage, ServerResponse } from "http";
import type { Socket } from "net";

export interface HtmlPreviewServerOptions {
  filePath: string;
  allowNetwork: boolean;
  readFile: (vaultPath: string) => Promise<{ data: ArrayBuffer | string; mimeType?: string } | undefined>;
  onResource?: (path: string) => void;
}

export interface HtmlPreviewServer {
  url: string;
  origin: string;
  setAllowNetwork(value: boolean): void;
  close(): Promise<void>;
}

export type HtmlPreviewServerFactory = (options: HtmlPreviewServerOptions) => Promise<HtmlPreviewServer>;

const MIME_TYPES: Readonly<Record<string, string>> = {
  html: "text/html; charset=utf-8", htm: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8", js: "text/javascript; charset=utf-8", mjs: "text/javascript; charset=utf-8",
  json: "application/json; charset=utf-8", map: "application/json; charset=utf-8",
  webmanifest: "application/manifest+json; charset=utf-8", wasm: "application/wasm",
  svg: "image/svg+xml", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
  gif: "image/gif", webp: "image/webp", avif: "image/avif", ico: "image/x-icon", bmp: "image/bmp",
  woff: "font/woff", woff2: "font/woff2", ttf: "font/ttf", otf: "font/otf", eot: "application/vnd.ms-fontobject",
  mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", oga: "audio/ogg", opus: "audio/ogg",
  m4a: "audio/mp4", aac: "audio/aac", flac: "audio/flac",
  mp4: "video/mp4", m4v: "video/mp4", webm: "video/webm", ogv: "video/ogg", mov: "video/quicktime",
  pdf: "application/pdf", txt: "text/plain; charset=utf-8", csv: "text/csv; charset=utf-8",
  xml: "application/xml; charset=utf-8", vtt: "text/vtt; charset=utf-8"
};

function contentSecurityPolicy(allowNetwork: boolean): string {
  const web = allowNetwork ? " https: http:" : "";
  return [
    "default-src 'none'",
    `script-src 'self' 'unsafe-inline' 'unsafe-eval' blob: data:${web}`,
    `style-src 'self' 'unsafe-inline' blob: data:${web}`,
    `img-src 'self' blob: data:${web}`,
    `font-src 'self' blob: data:${web}`,
    `media-src 'self' blob: data:${web}`,
    `connect-src 'self' blob: data:${web}${allowNetwork ? " wss: ws:" : ""}`,
    `frame-src 'self' blob: data:${web}`,
    `worker-src 'self' blob:${web}`,
    `manifest-src 'self' blob: data:${web}`,
    "object-src 'none'",
    `base-uri 'self'${web}`,
    `form-action 'self'${web}`
  ].join("; ");
}

function isSafeSegment(segment: string): boolean {
  return Boolean(segment) && !segment.startsWith(".") && !/[\\/\u0000-\u001f\u007f:]/.test(segment);
}

function requestSegments(url: string): string[] | undefined {
  // Decode each segment separately: encoded slashes cannot turn into directory traversal.
  if (!url.startsWith("/") || url.startsWith("//")) return undefined;
  const pathname = url.split("?", 1)[0];
  try {
    const segments = pathname.slice(1).split("/").map(segment => decodeURIComponent(segment));
    return segments.every(isSafeSegment) ? segments : undefined;
  } catch {
    return undefined;
  }
}

/** Serves unchanged web files from the selected HTML file's folder on a private loopback origin. */
export async function startHtmlPreviewServer(options: HtmlPreviewServerOptions): Promise<HtmlPreviewServer> {
  const sourceSegments = options.filePath.split("/");
  if (!sourceSegments.every(isSafeSegment) || !/\.html?$/i.test(options.filePath)) {
    throw new Error("HTML 预览文件路径无效。");
  }
  const sourceName = sourceSegments.pop()!;
  const root = sourceSegments.length ? `${sourceSegments.join("/")}/` : "";
  const hostname = `${randomBytes(16).toString("hex")}.localhost`;
  let expectedHost = "";
  let allowNetwork = options.allowNetwork;
  let closing = false;
  let closePromise: Promise<void> | undefined;
  const connections = new Set<Socket>();

  const serve = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    response.setHeader("Content-Security-Policy", contentSecurityPolicy(allowNetwork));
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Cache-Control", "no-store");
    const fail = (status: number, message: string): void => {
      response.statusCode = status;
      response.setHeader("Content-Type", "text/plain; charset=utf-8");
      response.end(request.method === "HEAD" ? undefined : message);
    };
    if (closing || request.headers.host?.toLowerCase() !== expectedHost) return fail(403, "Forbidden");
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.setHeader("Allow", "GET, HEAD");
      return fail(405, "Method not allowed");
    }
    // A previously installed worker could survive a switch back to offline mode.
    if (request.headers["service-worker"] !== undefined) return fail(403, "Service workers are unavailable");
    const segments = requestSegments(request.url || "");
    if (!segments) return fail(403, "Forbidden");
    const extension = segments[segments.length - 1].split(".").pop()!.toLowerCase();
    const mimeType = MIME_TYPES[extension];
    if (!mimeType) return fail(403, "Unsupported resource type");
    const vaultPath = `${root}${segments.join("/")}`;
    const resource = await options.readFile(vaultPath);
    if (closing || response.destroyed) return;
    if (!resource) return fail(404, "Not found");
    const bytes = typeof resource.data === "string" ? Buffer.from(resource.data, "utf8") : Buffer.from(resource.data);
    options.onResource?.(vaultPath);
    // Use a known MIME for each allowed extension; vault metadata cannot turn a data file into executable HTML.
    response.setHeader("Content-Type", mimeType);
    response.setHeader("Accept-Ranges", "bytes");
    let start = 0;
    let end = bytes.length - 1;
    if (request.headers.range && request.method === "GET") {
      const match = /^bytes=(\d*)-(\d*)$/.exec(request.headers.range);
      if (match && (match[1] || match[2])) {
        start = match[1] ? Number(match[1]) : Math.max(0, bytes.length - Number(match[2]));
        end = match[1] && match[2] ? Math.min(Number(match[2]), end) : end;
      }
      if (!match || (!match[1] && !match[2]) || start > end || start >= bytes.length || !Number.isSafeInteger(start) || !Number.isSafeInteger(end)) {
        response.setHeader("Content-Range", `bytes */${bytes.length}`);
        return fail(416, "Range not satisfiable");
      }
      response.statusCode = 206;
      response.setHeader("Content-Range", `bytes ${start}-${end}/${bytes.length}`);
    }
    response.setHeader("Content-Length", Math.max(0, end - start + 1));
    response.end(request.method === "HEAD" ? undefined : bytes.subarray(start, end + 1));
  };
  const server = createServer((request, response) => {
    void serve(request, response).catch(() => {
      if (response.destroyed) return;
      if (!response.headersSent) {
        response.statusCode = 500;
        response.setHeader("Content-Type", "text/plain; charset=utf-8");
      }
      response.end(request.method === "HEAD" ? undefined : "Unable to read preview resource");
    });
  });
  server.on("connection", socket => {
    connections.add(socket);
    socket.once("close", () => connections.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("无法启动 HTML 本地预览服务。");
  }
  expectedHost = `${hostname}:${address.port}`;
  const origin = `http://${expectedHost}`;
  return {
    origin,
    url: `${origin}/${encodeURIComponent(sourceName)}`,
    setAllowNetwork(value) { allowNetwork = value; },
    close() {
      if (!closePromise) {
        closing = true;
        closePromise = new Promise<void>((resolve, reject) => {
          server.close(error => error ? reject(error) : resolve());
          // Stop keep-alive connections and in-flight requests as well as new connections.
          for (const connection of connections) connection.destroy();
        });
      }
      return closePromise;
    }
  };
}
