export const HTML_PREVIEW_SANDBOX = "allow-scripts";
// Only the trusted wrapper receives same-origin; user content never does.
export const HTML_PREVIEW_WRAPPER_SANDBOX = "allow-scripts allow-same-origin";
export const HTML_FULL_PREVIEW_SANDBOX = "allow-scripts allow-same-origin allow-forms allow-modals allow-downloads";

/** The local HTTP page has its own origin and keeps its original markup. */
export function wrapFullHtmlPreview(url: string): string {
  const origin = new URL(url).origin;
  const escape = (value: string) => value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; frame-src ${escape(origin)}; base-uri 'none'; object-src 'none'"><style>html,body{margin:0;width:100%;height:100%;overflow:hidden}iframe{display:block;border:0;width:100%;height:100%}</style></head><body><iframe title="HTML 页面内容" sandbox="${HTML_FULL_PREVIEW_SANDBOX}" referrerpolicy="no-referrer" src="${escape(url)}"></iframe></body></html>`;
}

export type HtmlDocumentOptions = {
  filePath: string;
  allowNetwork?: boolean;
  readText: (path: string) => Promise<string | undefined>;
  readBinary: (path: string) => Promise<ArrayBuffer | undefined>;
};

export type HtmlPreviewDocument = {
  srcdoc: string;
  dependencies: string[];
  warnings: string[];
};

const RESOURCE_MIME_TYPES: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
  webp: "image/webp", svg: "image/svg+xml", avif: "image/avif", ico: "image/x-icon",
  woff: "font/woff", woff2: "font/woff2", ttf: "font/ttf", otf: "font/otf",
  mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", mp4: "video/mp4", webm: "video/webm"
};
const MAX_RESOURCE_BYTES = 8 * 1024 * 1024;

export function htmlPreviewCsp(allowNetwork = false): string {
  const network = allowNetwork ? " https: http:" : "";
  return [
    "default-src 'none'",
    `script-src 'unsafe-inline' data: blob:${network}`,
    `style-src 'unsafe-inline' data:${network}`,
    `img-src data: blob:${network}`,
    `font-src data:${network}`,
    `media-src data: blob:${network}`,
    allowNetwork ? "connect-src https: http: wss: ws:" : "connect-src 'none'",
    "frame-src 'none'", "object-src 'none'", "base-uri 'none'", "form-action 'none'"
  ].join("; ");
}

/**
 * A parent policy is necessary because a document's own resource CSP does not
 * restrict navigation of its browsing context. Keep user HTML in a second,
 * opaque-origin frame so the trusted parent's frame-src also governs navigation.
 */
export function wrapHtmlPreviewDocument(srcdoc: string, allowNetwork = false): string {
  const escapeAttribute = (value: string): string => value.replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  // srcdoc inherits this policy, so resource permissions must match the child.
  const policy = htmlPreviewCsp(allowNetwork).replace("frame-src 'none'", "frame-src about: data: blob:");
  return `<!DOCTYPE html><html><head><meta http-equiv="Content-Security-Policy" content="${escapeAttribute(policy)}"><meta charset="utf-8"><style>html,body{margin:0;width:100%;height:100%;overflow:hidden}iframe{display:block;border:0;width:100%;height:100%}</style></head><body><iframe title="HTML 页面内容" sandbox="${HTML_PREVIEW_SANDBOX}" referrerpolicy="no-referrer" allow="camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'" srcdoc="${escapeAttribute(srcdoc)}"></iframe></body></html>`;
}

/** Resolve only vault paths; URLs and traversal outside the vault are rejected. */
export function resolveVaultResourcePath(documentPath: string, reference: string): string | undefined {
  let value: string;
  try {
    value = decodeURIComponent(reference.trim().split(/[?#]/, 1)[0]).replace(/\\/g, "/");
  } catch {
    return undefined;
  }
  if (!value || value.startsWith("//") || /^[a-z][a-z0-9+.-]*:/i.test(value) || /[\u0000-\u001f]/.test(value)) {
    return undefined;
  }
  const segments = value.startsWith("/") ? [] : documentPath.split("/").slice(0, -1);
  for (const segment of value.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (segments.length === 0) return undefined;
      segments.pop();
    } else {
      segments.push(segment);
    }
  }
  if (segments.some((segment) => segment.startsWith("."))) return undefined;
  return segments.join("/") || undefined;
}

export async function rewriteCssResources(
  css: string,
  replaceResource: (reference: string) => Promise<string>
): Promise<string> {
  // Both @import "theme.css" and url(...) can refer to vault resources.
  const pattern = /@import\s+(["'])([^"']+)\1|url\(\s*(?:"([^"\r\n]*)"|'([^'\r\n]*)'|([^\s)'";]+))\s*\)/gi;
  const matches = Array.from(css.matchAll(pattern));
  const replacements = await Promise.all(matches.map(async (match) => {
    const reference = match[2] ?? match[3] ?? match[4] ?? match[5];
    const replacement = await replaceResource(reference);
    const quoted = JSON.stringify(replacement);
    return match[2] === undefined ? `url(${quoted})` : `@import ${quoted}`;
  }));
  let output = css;
  for (let index = matches.length - 1; index >= 0; index -= 1) {
    const match = matches[index];
    output = output.slice(0, match.index) + replacements[index] + output.slice(match.index! + match[0].length);
  }
  return output;
}

export async function buildHtmlPreviewDocument(source: string, options: HtmlDocumentOptions): Promise<HtmlPreviewDocument> {
  const dependencies = new Set<string>([options.filePath]);
  const warnings = new Set<string>();
  const binaryCache = new Map<string, Promise<string>>();
  let loadedBytes = 0;
  const warn = (message: string) => { warnings.add(message); };
  const acceptSize = (size: number, path: string): boolean => {
    loadedBytes += size;
    if (size > MAX_RESOURCE_BYTES || loadedBytes > 32 * 1024 * 1024) {
      warn(`资源过大，已跳过：${path}`);
      return false;
    }
    return true;
  };
  const dataUrl = (mime: string, bytes: ArrayBuffer): string => {
    let binary = "";
    for (const value of new Uint8Array(bytes)) binary += String.fromCharCode(value);
    return `data:${mime};base64,${btoa(binary)}`;
  };
  const externalReference = (reference: string): string | undefined => {
    if (/^(?:data:|#)/i.test(reference)) return reference;
    if (/^(?:https?:)?\/\//i.test(reference)) {
      if (options.allowNetwork) return reference.startsWith("//") ? `https:${reference}` : reference;
      warn("部分在线资源已阻止；可通过顶部开关允许加载。");
      return "data:,";
    }
    return undefined;
  };
  const loadAsset = async (reference: string, parentPath: string): Promise<string> => {
    const external = externalReference(reference);
    if (external !== undefined) return external;
    const path = resolveVaultResourcePath(parentPath, reference);
    if (!path) return "data:,";
    const mime = RESOURCE_MIME_TYPES[path.split(".").pop()!.toLowerCase()];
    if (!mime) {
      warn(`不支持的资源类型：${path}`);
      return "data:,";
    }
    dependencies.add(path);
    if (!binaryCache.has(path)) {
      binaryCache.set(path, (async () => {
        const bytes = await options.readBinary(path);
        if (!bytes) { warn(`找不到资源：${path}`); return "data:,"; }
        return acceptSize(bytes.byteLength, path) ? dataUrl(mime, bytes) : "data:,";
      })());
    }
    const result = await binaryCache.get(path)!;
    const fragment = reference.includes("#") ? reference.slice(reference.indexOf("#")) : "";
    return result + fragment;
  };
  const loadCss = async (reference: string, parentPath: string, ancestors = new Set<string>()): Promise<string> => {
    const external = externalReference(reference);
    if (external !== undefined) return external;
    const path = resolveVaultResourcePath(parentPath, reference);
    if (!path || !/\.css$/i.test(path)) return loadAsset(reference, parentPath);
    if (ancestors.has(path) || ancestors.size >= 12) { warn(`已跳过循环 CSS 引用：${path}`); return "data:,"; }
    dependencies.add(path);
    const css = await options.readText(path);
    if (css === undefined) { warn(`找不到样式：${path}`); return "data:,"; }
    if (!acceptSize(css.length * 2, path)) return "data:,";
    const nextAncestors = new Set([...ancestors, path]);
    const rewritten = await rewriteCssResources(css, (value) => loadCss(value, path, nextAncestors));
    return `data:text/css;charset=utf-8,${encodeURIComponent(rewritten)}`;
  };

  // Place the policy before the input, including while parsing this inert document.
  const csp = htmlPreviewCsp(Boolean(options.allowNetwork));
  const doc = new DOMParser().parseFromString(`<meta http-equiv="Content-Security-Policy" content="${csp}">${source}`, "text/html");
  doc.querySelectorAll("base, meta[http-equiv], iframe, frame, object, embed").forEach((element) => element.remove());
  const policy = doc.createElement("meta");
  policy.httpEquiv = "Content-Security-Policy";
  policy.content = csp;
  doc.head.prepend(policy);
  const charset = doc.createElement("meta");
  charset.setAttribute("charset", "utf-8");
  doc.head.insertBefore(charset, policy.nextSibling);

  for (const script of Array.from(doc.querySelectorAll<HTMLScriptElement>("script[src]"))) {
    const reference = script.getAttribute("src") || "";
    const external = externalReference(reference);
    if (external !== undefined) { script.src = external; continue; }
    const path = resolveVaultResourcePath(options.filePath, reference);
    if (!path || !/\.(?:js|mjs)$/i.test(path)) { script.remove(); continue; }
    dependencies.add(path);
    const js = await options.readText(path);
    if (js === undefined || !acceptSize(js.length * 2, path)) { warn(`无法加载脚本：${path}`); script.remove(); continue; }
    if (script.type === "module" && /\b(?:import|export)\s/.test(js)) warn("模块脚本的相对 import 依赖暂不支持；请使用打包后的脚本。");
    script.src = `data:text/javascript;charset=utf-8,${encodeURIComponent(js)}`;
    script.removeAttribute("integrity");
  }
  for (const link of Array.from(doc.querySelectorAll<HTMLLinkElement>("link[href]"))) {
    if (link.rel.toLowerCase() === "stylesheet") link.href = await loadCss(link.getAttribute("href") || "", options.filePath);
    else link.remove();
    link.removeAttribute("integrity");
  }
  for (const style of Array.from(doc.querySelectorAll("style"))) {
    style.textContent = await rewriteCssResources(style.textContent || "", (value) => loadCss(value, options.filePath));
  }
  for (const element of Array.from(doc.querySelectorAll<HTMLElement>("[style]"))) {
    element.setAttribute("style", await rewriteCssResources(element.getAttribute("style") || "", (value) => loadCss(value, options.filePath)));
  }
  for (const element of Array.from(doc.querySelectorAll("img[src], input[type=image][src], audio[src], video[src], source[src], video[poster]"))) {
    for (const attribute of ["src", "poster"]) {
      const reference = element.getAttribute(attribute);
      if (reference) element.setAttribute(attribute, await loadAsset(reference, options.filePath));
    }
  }
  // A srcset may mix URLs and data URLs; the safe fallback is the rewritten src.
  doc.querySelectorAll("[srcset]").forEach((element) => element.removeAttribute("srcset"));
  doc.querySelectorAll("a[href], area[href]").forEach((element) => {
    const href = element.getAttribute("href") || "";
    if (!href.startsWith("#")) {
      element.removeAttribute("href");
      element.setAttribute("title", "预览中不打开外部链接");
    }
    element.removeAttribute("ping");
  });
  return { srcdoc: `<!DOCTYPE html>\n${doc.documentElement.outerHTML}`, dependencies: Array.from(dependencies), warnings: Array.from(warnings) };
}
