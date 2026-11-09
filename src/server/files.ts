import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { PortalError } from "@/domain/errors";

const PREVIEW_EXTENSIONS = new Set([
  ".html",
  ".css",
  ".txt",
  ".svg",
  ".json",
  ".js",
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".gif",
  ".ico",
]);

export async function snapshotTree(source: string, destination: string): Promise<void> {
  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true });
  await copySafe(source, destination);
}

export async function writeAttachment(root: string, id: string, bytes: Buffer): Promise<void> {
  if (bytes.byteLength > 2_000_000) {
    throw new PortalError("attachment_rejected", "Attachments must be 2 MB or smaller.");
  }
  const dir = path.join(root, "attachments");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, id), bytes);
}

export async function readAttachment(root: string, id: string): Promise<Buffer> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) {
    throw new PortalError("not_found", "Not found.");
  }
  return readFile(path.join(root, "attachments", id));
}

export function contentTypeFor(filePath: string): string {
  switch (path.extname(filePath).toLowerCase()) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".json":
      return "application/json";
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    case ".gif":
      return "image/gif";
    case ".ico":
      return "image/x-icon";
    default:
      return "text/plain; charset=utf-8";
  }
}

export function resolveInside(root: string, parts: string[]): string {
  const base = path.resolve(root);
  const target = path.resolve(base, ...parts);
  if (target !== base && !target.startsWith(`${base}${path.sep}`)) {
    throw new PortalError("not_found", "Not found.");
  }
  return target;
}

export function safeFilename(name: string): string {
  const base = name.split(/[/\\]/).pop() ?? "attachment";
  const cleaned = base.replace(/[^A-Za-z0-9._-]/g, "").slice(0, 80);
  return cleaned || "attachment";
}

async function copySafe(source: string, destination: string): Promise<void> {
  const entries = await readdir(source, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === ".git" || entry.name.startsWith(".env")) continue;
    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);
    if (entry.isDirectory()) {
      await mkdir(to, { recursive: true });
      await copySafe(from, to);
      continue;
    }
    if (!entry.isFile()) continue;
    if (!PREVIEW_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
    const info = await stat(from);
    if (info.size > 1_000_000) continue;
    const bytes = await readFile(from);
    await writeFile(to, bytes);
  }
}
