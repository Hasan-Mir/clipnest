// CopyQ-style text transformations. Each returns the new text or throws with a readable message.

export interface Transform { id: string; label: string; group: string; run: (s: string) => string }

const words = (s: string) =>
  s.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_\-.]+/g, " ").trim().split(/\s+/).filter(Boolean);

const b64enc = (s: string) => {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  bytes.forEach((b) => (bin += String.fromCharCode(b)));
  return btoa(bin);
};
const b64dec = (s: string) => {
  const bin = atob(s.trim().replace(/-/g, "+").replace(/_/g, "/"));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
};

export const TRANSFORMS: Transform[] = [
  { id: "json-pretty", group: "JSON", label: "Prettify JSON", run: (s) => JSON.stringify(JSON.parse(s), null, 2) },
  { id: "json-min", group: "JSON", label: "Minify JSON", run: (s) => JSON.stringify(JSON.parse(s)) },
  { id: "upper", group: "Case", label: "UPPERCASE", run: (s) => s.toUpperCase() },
  { id: "lower", group: "Case", label: "lowercase", run: (s) => s.toLowerCase() },
  { id: "camel", group: "Case", label: "camelCase", run: (s) => words(s).map((w, i) => (i ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w.toLowerCase())).join("") },
  { id: "pascal", group: "Case", label: "PascalCase", run: (s) => words(s).map((w) => w[0].toUpperCase() + w.slice(1).toLowerCase()).join("") },
  { id: "snake", group: "Case", label: "snake_case", run: (s) => words(s).map((w) => w.toLowerCase()).join("_") },
  { id: "kebab", group: "Case", label: "kebab-case", run: (s) => words(s).map((w) => w.toLowerCase()).join("-") },
  { id: "b64e", group: "Encode", label: "Base64 encode", run: b64enc },
  { id: "b64d", group: "Encode", label: "Base64 decode", run: b64dec },
  { id: "urle", group: "Encode", label: "URL encode", run: encodeURIComponent },
  { id: "urld", group: "Encode", label: "URL decode", run: decodeURIComponent },
  {
    id: "jwt", group: "Encode", label: "Decode JWT",
    run: (s) => {
      const p = s.trim().split(".");
      if (p.length < 2) throw new Error("Not a JWT");
      const pretty = (x: string) => JSON.stringify(JSON.parse(b64dec(x)), null, 2);
      return `// header\n${pretty(p[0])}\n\n// payload\n${pretty(p[1])}`;
    },
  },
  { id: "trim", group: "Whitespace", label: "Trim", run: (s) => s.trim() },
  { id: "collapse", group: "Whitespace", label: "Collapse whitespace", run: (s) => s.replace(/[ \t]+/g, " ").replace(/\s*\n\s*/g, "\n").trim() },
  { id: "noblank", group: "Lines", label: "Remove blank lines", run: (s) => s.split(/\r?\n/).filter((l) => l.trim()).join("\n") },
  { id: "dedupe", group: "Lines", label: "Remove duplicate lines", run: (s) => [...new Set(s.split(/\r?\n/))].join("\n") },
  { id: "sort", group: "Lines", label: "Sort lines A→Z", run: (s) => s.split(/\r?\n/).sort((a, b) => a.localeCompare(b)).join("\n") },
  { id: "sortr", group: "Lines", label: "Sort lines Z→A", run: (s) => s.split(/\r?\n/).sort((a, b) => b.localeCompare(a)).join("\n") },
  { id: "reverse", group: "Lines", label: "Reverse lines", run: (s) => s.split(/\r?\n/).reverse().join("\n") },
  {
    id: "fa", group: "Persian", label: "Normalize Persian (ی ک ۱۲۳)",
    run: (s) => s.replace(/ي/g, "ی").replace(/ك/g, "ک").replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d))).replace(/[۰-۹]/g, (d) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(d))),
  },
  {
    id: "count", group: "Info", label: "Count chars / words / lines",
    run: (s) => `characters: ${[...s].length}\nwords: ${(s.match(/\S+/g) || []).length}\nlines: ${s.split(/\r?\n/).length}`,
  },
];
