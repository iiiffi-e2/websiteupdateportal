import { PortalError } from "@/domain/errors";

export const EDITABLE_FIELDS = ["headline", "tagline", "phone", "accent"] as const;
export type EditableField = (typeof EDITABLE_FIELDS)[number];

export type FieldEdit = {
  field: EditableField;
  value: string;
};

const NAMED_COLORS: Record<string, string> = {
  teal: "#0e6b66",
  copper: "#b64a28",
  ink: "#1b1915",
  sand: "#c2a27a",
  forest: "#1d7a4a",
};

const FIELD_PATTERNS: readonly { field: EditableField; pattern: RegExp }[] = [
  {
    field: "headline",
    pattern: /^(?:please\s+)?(?:change|update|set)\s+the\s+headline\s+to\s+(.+?)\.?$/i,
  },
  {
    field: "tagline",
    pattern: /^(?:please\s+)?(?:change|update|set)\s+the\s+(?:tagline|subtitle)\s+to\s+(.+?)\.?$/i,
  },
  {
    field: "phone",
    pattern: /^(?:please\s+)?(?:change|update|set)\s+the\s+phone(?:\s+number)?\s+to\s+(.+?)\.?$/i,
  },
  {
    field: "accent",
    pattern: /^(?:please\s+)?(?:change|update|set)\s+the\s+accent\s+color\s+to\s+(.+?)\.?$/i,
  },
];

export function parseFieldEdit(request: string): FieldEdit | null {
  const text = request.trim().replace(/^["“]|["”]$/g, "");
  if (!text || text.includes("\n") || text.length > 400) return null;
  for (const candidate of FIELD_PATTERNS) {
    const match = text.match(candidate.pattern);
    if (!match?.[1]) continue;
    const value = stripQuotes(match[1].trim());
    if (!value || value.includes("\n") || value.length > 180) return null;
    return { field: candidate.field, value };
  }
  return null;
}

function stripQuotes(value: string): string {
  return value.replace(/^["“]|["”]$/g, "").trim();
}

export function applyFieldEdit(
  files: Record<string, string>,
  edit: FieldEdit,
): { files: Record<string, string>; summary: string } {
  if (edit.field === "accent") {
    const css = files["styles.css"];
    if (typeof css !== "string") {
      throw new PortalError("edit_failed", "styles.css is not available to the editor.");
    }
    const color = normalizeColor(edit.value);
    if (!color) {
      throw new PortalError(
        "edit_failed",
        "Accent color must be a #rgb or #rrggbb value, or one of teal, copper, ink, sand, forest.",
      );
    }
    if (!/--accent\s*:/.test(css)) {
      throw new PortalError("edit_failed", "styles.css has no --accent color.");
    }
    const previous = css.match(/--accent\s*:\s*([^;]+)/)?.[1]?.trim() ?? "the previous color";
    const nextCss = css.replace(/(--accent\s*:\s*)([^;]+)/, `$1${color}`);
    return {
      files: { ...files, "styles.css": nextCss },
      summary: `Changed the accent color from ${previous} to ${color} in styles.css.`,
    };
  }

  const html = files["index.html"];
  if (typeof html !== "string") {
    throw new PortalError("edit_failed", "index.html is not available to the editor.");
  }
  const pattern = new RegExp(
    `(<(?<tag>[a-z0-9]+)(?<attrs>[^>]*\\sdata-field="${edit.field}"[^>]*)>)(?<inner>[\\s\\S]*?)(</\\k<tag>>)`,
    "i",
  );
  const match = html.match(pattern);
  if (!match?.groups) {
    throw new PortalError("edit_failed", `The page has no ${edit.field} field.`);
  }
  const previous = decodeHtml(match.groups.inner.trim());
  const safe = escapeHtml(edit.value);
  let attrs = match.groups.attrs;
  if (edit.field === "phone") {
    const digits = edit.value.replace(/[^\d+]/g, "");
    attrs = attrs.includes("href=")
      ? attrs.replace(/href="[^"]*"/, `href="${digits ? `tel:${digits}` : "#"}"`)
      : `${attrs} href="${digits ? `tel:${digits}` : "#"}"`;
  }
  const replacement = `<${match.groups.tag}${attrs}>${safe}</${match.groups.tag}>`;
  const nextHtml = html.replace(match[0], replacement);
  return {
    files: { ...files, "index.html": nextHtml },
    summary: `Changed the ${edit.field} from "${previous}" to "${edit.value}" in index.html.`,
  };
}

export function normalizeColor(input: string): string | null {
  const value = input.trim().toLowerCase();
  if (/^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(value)) return value;
  return NAMED_COLORS[value] ?? null;
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function decodeHtml(value: string): string {
  return value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&amp;", "&");
}
