#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const repoRoot = process.cwd();
const scanRoots = ["src/app", "src/components", "src/contexts"];
const sourceExtensions = new Set([".css", ".ts", ".tsx", ".js", ".jsx"]);
const generatedCssPath = path.join(repoRoot, "src/app/light-theme.generated.css");
const reportJsonPath = path.join(repoRoot, "docs/theme-color-inventory.json");
const reportMdPath = path.join(repoRoot, "docs/theme-color-inventory.md");
const reportMapPath = path.join(repoRoot, "docs/theme-color-map.md");

const command = process.argv[2] ?? "audit";

const utilityPrefixes = [
  "accent",
  "bg",
  "border",
  "caret",
  "decoration",
  "divide",
  "fill",
  "from",
  "outline",
  "placeholder",
  "ring",
  "selection",
  "shadow",
  "stroke",
  "text",
  "to",
  "via",
];

const neutralPalette = new Set(["slate", "gray", "zinc", "neutral", "stone"]);
const stateVariants = new Map([
  ["active", ":active"],
  ["checked", ":checked"],
  ["disabled", ":disabled"],
  ["focus", ":focus"],
  ["focus-visible", ":focus-visible"],
  ["focus-within", ":focus-within"],
  ["hover", ":hover"],
  ["open", "[data-state=\"open\"]"],
]);
const groupVariants = new Map([
  ["group-active", ".group:active"],
  ["group-focus", ".group:focus"],
  ["group-focus-visible", ".group:focus-visible"],
  ["group-focus-within", ".group:focus-within"],
  ["group-hover", ".group:hover"],
]);
const peerVariants = new Map([
  ["peer-checked", ".peer:checked ~"],
  ["peer-disabled", ".peer:disabled ~"],
  ["peer-focus", ".peer:focus ~"],
  ["peer-hover", ".peer:hover ~"],
]);
const mediaVariants = new Map([
  ["sm", "@media (min-width: 640px)"],
  ["md", "@media (min-width: 768px)"],
  ["lg", "@media (min-width: 1024px)"],
  ["xl", "@media (min-width: 1280px)"],
  ["2xl", "@media (min-width: 1536px)"],
]);

const namedColors = new Map([
  ["white", { r: 255, g: 255, b: 255 }],
  ["black", { r: 0, g: 0, b: 0 }],
]);

const statusColors = {
  amber: "#b45309",
  blue: "#2563eb",
  cyan: "#0891b2",
  emerald: "#047857",
  fuchsia: "#a21caf",
  green: "#15803d",
  indigo: "#4f46e5",
  lime: "#4d7c0f",
  orange: "#c2410c",
  pink: "#be185d",
  purple: "#7e22ce",
  red: "#dc2626",
  rose: "#be123c",
  sky: "#0369a1",
  teal: "#0f766e",
  violet: "#6d28d9",
  yellow: "#a16207",
};

const lightTokens = {
  page: "#FAFAF8",
  shell: "#FFFFFF",
  surface: "#FFFFFF",
  surfaceWarm: "#F3F2EF",
  surfacePressed: "#E8E6E2",
  border: "rgba(31, 31, 29, 0.14)",
  borderStrong: "rgba(31, 31, 29, 0.24)",
  text: "#1F1F1D",
  textSoft: "#34332F",
  muted: "#77736C",
  faint: "#A6A29A",
  accent: "#516B8A",
  accentSoft: "rgba(81, 107, 138, 0.12)",
  overlay: "rgba(31, 31, 29, 0.08)",
  overlayStrong: "rgba(31, 31, 29, 0.16)",
  backdrop: "rgba(31, 31, 29, 0.26)",
};

function walk(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const relative = normalizePath(full);
    if (relative === "src/app/api" || relative.startsWith("src/app/api/")) continue;
    if (entry.isDirectory()) {
      if (["node_modules", ".next", ".git"].includes(entry.name)) continue;
      out.push(...walk(full));
    } else if (sourceExtensions.has(path.extname(entry.name))) {
      if (path.resolve(full) === path.resolve(generatedCssPath)) continue;
      out.push(full);
    }
  }
  return out;
}

function normalizePath(file) {
  return path.relative(repoRoot, file).replaceAll(path.sep, "/");
}

function getLineStarts(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10) starts.push(i + 1);
  }
  return starts;
}

function locationForIndex(lineStarts, index) {
  let low = 0;
  let high = lineStarts.length - 1;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    if (lineStarts[mid] <= index) low = mid + 1;
    else high = mid - 1;
  }
  const line = Math.max(0, high) + 1;
  const column = index - lineStarts[line - 1] + 1;
  return { line, column };
}

function isClassToken(value) {
  const segments = value.split(":");
  const base = segments[segments.length - 1];
  return utilityPrefixes.some((prefix) => base === prefix || base.startsWith(`${prefix}-`));
}

function parseClassToken(value) {
  const segments = value.split(":");
  const base = segments[segments.length - 1];
  const variants = segments.slice(0, -1);
  const prefix = utilityPrefixes.find((candidate) => base === candidate || base.startsWith(`${candidate}-`));
  if (!prefix) return null;
  const body = base === prefix ? "" : base.slice(prefix.length + 1);
  return { base, body, prefix, variants };
}

function isColorClassToken(value) {
  const parsed = parseClassToken(value);
  if (!parsed || !parsed.body) return false;
  if (parseBodyColor(parsed.body)) return true;
  return /^\[.*(?:#[0-9a-fA-F]{3,8}|\b(?:rgb|rgba|hsl|hsla)\(|\b(?:white|black)\b).*]$/.test(parsed.body);
}

function extractColors(text, file) {
  const entries = [];
  const lineStarts = getLineStarts(text);
  const seenAt = new Set();

  const push = (kind, token, index, extra = {}) => {
    const key = `${kind}:${token}:${index}`;
    if (seenAt.has(key)) return;
    seenAt.add(key);
    const loc = locationForIndex(lineStarts, index);
    entries.push({
      kind,
      token,
      file: normalizePath(file),
      line: loc.line,
      column: loc.column,
      ...extra,
    });
  };

  const hexPattern = /#[0-9a-fA-F]{3,8}\b/g;
  for (const match of text.matchAll(hexPattern)) {
    push("literal", match[0], match.index);
  }

  const functionColorPattern = /\b(?:rgb|rgba|hsl|hsla)\([^)]*\)/g;
  for (const match of text.matchAll(functionColorPattern)) {
    push("literal", match[0].replace(/\s+/g, " "), match.index);
  }

  const classTokenPattern = /(?:^|[\s"'`])([A-Za-z0-9_:/.[\]#%(),-]+(?:\[[^\]\s"'`]+\])?(?:\/\[[^\]\s"'`]+\]|\/[0-9]{1,3})?)(?=$|[\s"'`])/g;
  for (const match of text.matchAll(classTokenPattern)) {
    const token = match[1];
    if (!isClassToken(token) || !isColorClassToken(token)) continue;
    const parsed = parseClassToken(token);
    push("class", token, (match.index ?? 0) + match[0].indexOf(token), {
      prefix: parsed.prefix,
      variants: parsed.variants,
    });
  }

  return entries;
}

function buildInventory() {
  const files = scanRoots.flatMap((root) => walk(path.join(repoRoot, root)));
  const all = files.flatMap((file) => extractColors(fs.readFileSync(file, "utf8"), file));
  const grouped = new Map();

  for (const entry of all) {
    const key = `${entry.kind}:${entry.token}`;
    const group = grouped.get(key) ?? {
      kind: entry.kind,
      token: entry.token,
      count: 0,
      prefixes: new Set(),
      variants: new Set(),
      locations: [],
    };
    group.count += 1;
    if (entry.prefix) group.prefixes.add(entry.prefix);
    if (entry.variants) entry.variants.forEach((variant) => group.variants.add(variant));
    group.locations.push({
      file: entry.file,
      line: entry.line,
      column: entry.column,
    });
    grouped.set(key, group);
  }

  return {
    generatedAt: new Date().toISOString(),
    scanRoots,
    totalOccurrences: all.length,
    totalUniqueTokens: grouped.size,
    groups: [...grouped.values()]
      .map((group) => ({
        ...group,
        prefixes: [...group.prefixes].sort(),
        variants: [...group.variants].sort(),
        locations: group.locations.sort((a, b) => `${a.file}:${a.line}`.localeCompare(`${b.file}:${b.line}`)),
      }))
      .sort((a, b) => b.count - a.count || a.token.localeCompare(b.token)),
  };
}

function ensureDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function writeReports(inventory) {
  ensureDir(reportJsonPath);
  fs.writeFileSync(reportJsonPath, `${JSON.stringify(inventory, null, 2)}\n`);

  const lines = [
    "# Theme Color Inventory",
    "",
    `Generated: ${inventory.generatedAt}`,
    `Scan roots: ${inventory.scanRoots.join(", ")}`,
    `Total occurrences: ${inventory.totalOccurrences}`,
    `Unique tokens: ${inventory.totalUniqueTokens}`,
    "",
    "The JSON report next to this file contains every file, line, and column. This Markdown report keeps the top locations readable.",
    "",
    "| Token | Kind | Count | Prefixes | First locations |",
    "| --- | --- | ---: | --- | --- |",
  ];

  for (const group of inventory.groups) {
    const locations = group.locations
      .slice(0, 5)
      .map((loc) => `${loc.file}:${loc.line}`)
      .join("<br>");
    lines.push(
      `| \`${escapeMarkdown(group.token)}\` | ${group.kind} | ${group.count} | ${group.prefixes.join(", ") || "-"} | ${locations} |`,
    );
  }

  fs.writeFileSync(reportMdPath, `${lines.join("\n")}\n`);
}

function writeMapReport(mappedEntries) {
  const grouped = new Map();
  for (const entry of mappedEntries) {
    const key = `${entry.token}|${entry.declaration}`;
    const group = grouped.get(key) ?? { ...entry, count: 0, locations: [] };
    group.count += entry.count;
    group.locations.push(...entry.locations);
    grouped.set(key, group);
  }

  const lines = [
    "# Light Theme Color Map",
    "",
    "Generated from `scripts/theme-colors.mjs`. This is the review table for the automatic dark-to-light replacements.",
    "",
    "| Source token | Count | Light rule | First locations |",
    "| --- | ---: | --- | --- |",
  ];

  for (const group of [...grouped.values()].sort((a, b) => b.count - a.count || a.token.localeCompare(b.token))) {
    const locations = group.locations
      .slice(0, 4)
      .map((loc) => `${loc.file}:${loc.line}`)
      .join("<br>");
    lines.push(`| \`${escapeMarkdown(group.token)}\` | ${group.count} | \`${escapeMarkdown(group.declaration)}\` | ${locations} |`);
  }

  fs.writeFileSync(reportMapPath, `${lines.join("\n")}\n`);
}

function escapeMarkdown(value) {
  return value.replaceAll("|", "\\|").replaceAll("`", "\\`");
}

function hexToRgb(hex) {
  let normalized = hex.replace("#", "");
  if (normalized.length === 3 || normalized.length === 4) {
    normalized = normalized
      .split("")
      .map((char) => char + char)
      .join("");
  }
  const r = Number.parseInt(normalized.slice(0, 2), 16);
  const g = Number.parseInt(normalized.slice(2, 4), 16);
  const b = Number.parseInt(normalized.slice(4, 6), 16);
  const a = normalized.length >= 8 ? Number.parseInt(normalized.slice(6, 8), 16) / 255 : 1;
  return { r, g, b, a };
}

function luminance({ r, g, b }) {
  const toLinear = (channel) => {
    const value = channel / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

function alphaToNumber(raw, fallback = 1) {
  if (!raw) return fallback;
  const cleaned = raw.replace(/^\//, "").replace(/^\[/, "").replace(/\]$/, "");
  if (cleaned.endsWith("%")) return Number.parseFloat(cleaned) / 100;
  const numeric = Number.parseFloat(cleaned);
  if (Number.isNaN(numeric)) return fallback;
  return numeric > 1 ? numeric / 100 : numeric;
}

function rgba(hexOrRgb, alpha = 1) {
  const rgb = typeof hexOrRgb === "string" ? hexToRgb(hexOrRgb) : hexOrRgb;
  const rounded = Math.max(0, Math.min(1, alpha));
  return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${Number(rounded.toFixed(3))})`;
}

function mix(a, b, amount) {
  const rgbA = typeof a === "string" ? hexToRgb(a) : a;
  const rgbB = typeof b === "string" ? hexToRgb(b) : b;
  return {
    r: Math.round(rgbA.r + (rgbB.r - rgbA.r) * amount),
    g: Math.round(rgbA.g + (rgbB.g - rgbA.g) * amount),
    b: Math.round(rgbA.b + (rgbB.b - rgbA.b) * amount),
  };
}

function rgbToHex({ r, g, b }) {
  return `#${[r, g, b].map((value) => value.toString(16).padStart(2, "0")).join("")}`;
}

function parseBodyColor(body) {
  const opacityMatch = body.match(/^(.*?)(\/(?:\[[^\]]+\]|\d{1,3}))$/);
  const rawColor = opacityMatch ? opacityMatch[1] : body;
  const opacity = opacityMatch ? alphaToNumber(opacityMatch[2], 1) : 1;

  const arbitraryHex = rawColor.match(/^\[(#[0-9a-fA-F]{3,8})\]$/);
  if (arbitraryHex) return { type: "hex", value: arbitraryHex[1], opacity };

  const arbitraryRgb = rawColor.match(/^\[((?:rgb|rgba)\([^\]]+\))\]$/);
  if (arbitraryRgb) return { type: "raw", value: arbitraryRgb[1], opacity };

  const arbitraryCss = rawColor.match(/^\[(.+)\]$/);
  if (arbitraryCss && /(?:#[0-9a-fA-F]{3,8}|\b(?:rgb|rgba|hsl|hsla)\(|\b(?:black|white)\b)/.test(arbitraryCss[1])) {
    return { type: "arbitrary", value: decodeTailwindArbitrary(arbitraryCss[1]), opacity };
  }

  if (namedColors.has(rawColor)) return { type: "named", name: rawColor, rgb: namedColors.get(rawColor), opacity };

  const palette = rawColor.match(/^([a-z]+)-(\d{2,3})$/);
  if (palette) {
    return {
      type: "palette",
      family: palette[1],
      shade: Number.parseInt(palette[2], 10),
      opacity,
    };
  }

  return null;
}

function decodeTailwindArbitrary(value) {
  return value
    .replace(/(?<!\\)_/g, " ")
    .replace(/\\_/g, "_");
}

function mapColor(parsed, prefix) {
  if (!parsed) return null;

  if (parsed.type === "raw") {
    return prefix === "bg" ? lightTokens.surface : lightTokens.text;
  }

  if (parsed.type === "arbitrary") {
    return mapArbitraryCssValue(parsed.value, parsed.opacity, prefix);
  }

  if (parsed.type === "named") {
    if (parsed.name === "white") {
      if (prefix === "bg") {
        return parsed.opacity === 1 ? lightTokens.surface : rgba("#1F1F1D", Math.max(0.03, parsed.opacity * 0.82));
      }
      if (["from", "via", "to"].includes(prefix)) {
        return parsed.opacity === 1 ? lightTokens.surface : rgba(lightTokens.surface, parsed.opacity);
      }
      if (["border", "divide", "ring", "outline"].includes(prefix)) {
        return parsed.opacity === 1 ? lightTokens.border : rgba("#1F1F1D", Math.max(0.055, parsed.opacity * 0.9));
      }
      return parsed.opacity === 1 ? lightTokens.text : rgba(lightTokens.text, parsed.opacity);
    }
    if (parsed.name === "black") {
      if (["bg", "from", "via", "to"].includes(prefix)) {
        return parsed.opacity === 1 ? lightTokens.text : rgba(lightTokens.text, Math.max(0.06, parsed.opacity * 0.42));
      }
      return parsed.opacity === 1 ? lightTokens.text : rgba(lightTokens.text, parsed.opacity);
    }
  }

  if (parsed.type === "palette") {
    if (neutralPalette.has(parsed.family)) return mapNeutralPalette(parsed, prefix);
    const status = statusColors[parsed.family];
    if (status) {
      const alpha = parsed.opacity === 1 ? 1 : parsed.opacity;
      if (["bg", "from", "via", "to"].includes(prefix)) {
        return parsed.opacity === 1 ? rgbToHex(mix(status, "#FFFFFF", parsed.shade <= 300 ? 0.82 : 0.72)) : rgba(status, alpha);
      }
      return parsed.opacity === 1 ? status : rgba(status, alpha);
    }
    return null;
  }

  if (parsed.type === "hex") {
    return mapHex(parsed.value, parsed.opacity, prefix);
  }

  return null;
}

function mapNeutralPalette(parsed, prefix) {
  const alpha = parsed.opacity === 1 ? 1 : parsed.opacity;
  if (["bg", "from", "via", "to"].includes(prefix)) {
    if (parsed.shade >= 800) return parsed.opacity === 1 ? lightTokens.surfaceWarm : rgba("#1F1F1D", Math.max(0.05, alpha * 0.9));
    if (parsed.shade >= 500) return parsed.opacity === 1 ? lightTokens.surfacePressed : rgba("#1F1F1D", Math.max(0.06, alpha * 0.85));
    return parsed.opacity === 1 ? lightTokens.surface : rgba("#FFFFFF", alpha);
  }
  if (["border", "divide", "ring", "outline"].includes(prefix)) {
    return parsed.opacity === 1 ? lightTokens.border : rgba("#1F1F1D", Math.max(0.08, alpha));
  }
  if (prefix === "text" || prefix === "placeholder") {
    if (parsed.shade <= 300) return parsed.opacity === 1 ? lightTokens.textSoft : rgba(lightTokens.textSoft, alpha);
    if (parsed.shade <= 600) return parsed.opacity === 1 ? lightTokens.muted : rgba(lightTokens.muted, alpha);
    return parsed.opacity === 1 ? lightTokens.text : rgba(lightTokens.text, alpha);
  }
  return parsed.opacity === 1 ? lightTokens.text : rgba(lightTokens.text, alpha);
}

function mapArbitraryCssValue(value, opacity, prefix) {
  let mapped = value;
  mapped = mapped.replace(/#[0-9a-fA-F]{3,8}\b/g, (hex) => mapHex(hex, 1, prefix));
  mapped = mapped.replace(/\brgba?\(([^)]*)\)/g, (match, args) => mapRgbFunction(match, args, prefix));
  mapped = mapped.replace(/\bwhite\b/g, prefix === "bg" || prefix === "shadow" ? "rgba(31, 31, 29, 0.08)" : lightTokens.text);
  mapped = mapped.replace(/\bblack\b/g, prefix === "bg" ? lightTokens.surfacePressed : lightTokens.text);
  if (opacity !== 1 && !/gradient\(/.test(mapped)) {
    return rgba(mapped, opacity);
  }
  return mapped;
}

function parseRgbArgs(args) {
  const parts = args
    .replace(/\s*\/\s*/g, ",")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length < 3) return null;
  const channels = parts.slice(0, 3).map((part) => {
    if (part.endsWith("%")) return Math.round((Number.parseFloat(part) / 100) * 255);
    return Number.parseFloat(part);
  });
  if (channels.some((channel) => Number.isNaN(channel))) return null;
  const alpha = parts[3] ? alphaToNumber(parts[3], 1) : 1;
  return { r: channels[0], g: channels[1], b: channels[2], a: alpha };
}

function mapRgbFunction(match, args, prefix) {
  const parsed = parseRgbArgs(args);
  if (!parsed) return match;
  const lum = luminance(parsed);
  const alpha = parsed.a ?? 1;

  if (prefix === "shadow") {
    if (lum < 0.32) return rgba("#1F1F1D", Math.min(0.18, alpha * 0.35));
    if (lum > 0.72) return rgba("#FFFFFF", Math.min(0.85, alpha));
    return rgba("#1F1F1D", Math.min(0.16, alpha * 0.35));
  }

  if (["bg", "from", "via", "to"].includes(prefix)) {
    if (lum < 0.08) {
      return alpha > 0.38 ? rgba(lightTokens.surface, alpha) : rgba("#1F1F1D", Math.max(0.03, alpha * 0.45));
    }
    if (lum < 0.24) {
      return alpha > 0.38 ? rgba(lightTokens.surfaceWarm, alpha) : rgba("#1F1F1D", Math.max(0.035, alpha * 0.5));
    }
    if (lum > 0.72) {
      return rgba("#1F1F1D", Math.max(0.025, alpha * 0.72));
    }
    return rgba(rgbToHex(mix(parsed, "#FFFFFF", 0.72)), alpha);
  }

  if (["border", "divide", "ring", "outline"].includes(prefix)) {
    return rgba("#1F1F1D", Math.max(0.08, Math.min(0.3, alpha)));
  }

  if (lum > 0.55 || lum < 0.16) return rgba(lightTokens.text, alpha);
  return rgba(lightTokens.muted, alpha);
}

function mapHex(hex, opacity, prefix) {
  const lower = hex.toLowerCase();
  const direct = new Map([
    ["#007aff", prefix === "bg" ? "#2563eb" : "#1d4ed8"],
    ["#0284c7", prefix === "bg" ? "#0284c7" : "#0369a1"],
    ["#050505", lightTokens.shell],
    ["#060606", lightTokens.shell],
    ["#070707", lightTokens.shell],
    ["#070708", lightTokens.shell],
    ["#07070a", lightTokens.shell],
    ["#080808", lightTokens.shell],
    ["#090909", lightTokens.shell],
    ["#0a0a0a", lightTokens.shell],
    ["#0a0a0b", lightTokens.shell],
    ["#0a0a0c", lightTokens.shell],
    ["#0b0b0b", lightTokens.shell],
    ["#0b0b0c", lightTokens.shell],
    ["#0c0c0c", lightTokens.shell],
    ["#0d0d10", lightTokens.shell],
    ["#0e0e0e", lightTokens.shell],
    ["#0f0f0f", lightTokens.page],
    ["#0f1012", lightTokens.shell],
    ["#101010", lightTokens.surface],
    ["#101012", lightTokens.surface],
    ["#111111", lightTokens.surface],
    ["#111", lightTokens.surface],
    ["#111115", lightTokens.surface],
    ["#121212", lightTokens.surface],
    ["#141414", lightTokens.surface],
    ["#151515", lightTokens.surface],
    ["#161616", lightTokens.surface],
    ["#171717", lightTokens.surface],
    ["#18181b", lightTokens.surface],
    ["#1a1a1a", lightTokens.surfaceWarm],
    ["#1c1b1a", lightTokens.surfaceWarm],
    ["#1d1d1d", lightTokens.surfaceWarm],
    ["#1e1e1e", lightTokens.surfaceWarm],
    ["#1f1f1f", lightTokens.surfaceWarm],
    ["#202020", lightTokens.surfaceWarm],
    ["#222", lightTokens.surfacePressed],
    ["#222222", lightTokens.surfacePressed],
    ["#242424", lightTokens.surface],
    ["#252525", lightTokens.surfacePressed],
    ["#272727", lightTokens.surfacePressed],
    ["#2a2a2a", "#E8E6E2"],
    ["#2c2c2c", "#E8E6E2"],
    ["#303030", "#D9D6CE"],
    ["#32312f", "#D9D6CE"],
    ["#333", lightTokens.faint],
    ["#333333", lightTokens.faint],
    ["#444", lightTokens.muted],
    ["#444444", lightTokens.muted],
    ["#555", lightTokens.muted],
    ["#555350", lightTokens.muted],
    ["#666", lightTokens.muted],
    ["#666666", lightTokens.muted],
    ["#777", lightTokens.muted],
    ["#777777", lightTokens.muted],
    ["#8a8a8a", lightTokens.muted],
    ["#8c8a88", lightTokens.muted],
    ["#a3a19e", lightTokens.textSoft],
    ["#a7a39e", lightTokens.textSoft],
    ["#b8b4ac", lightTokens.muted],
    ["#d4d1cb", lightTokens.text],
    ["#dad7d1", lightTokens.text],
    ["#dc2626", prefix === "bg" ? "#dc2626" : "#b91c1c"],
    ["#e3e3e3", lightTokens.text],
    ["#e8e5df", lightTokens.text],
    ["#e8e6e3", lightTokens.text],
    ["#ef4444", prefix === "bg" ? "#dc2626" : "#b91c1c"],
    ["#f2f0ec", lightTokens.text],
    ["#f4f4f4", lightTokens.text],
    ["#ffffff", prefix === "bg" ? lightTokens.surface : lightTokens.text],
    ["#000000", lightTokens.text],
    ["#e2765a", lightTokens.accent],
  ]);
  const mapped = direct.get(lower);
  if (mapped) return opacity === 1 ? mapped : rgba(mapped, opacity);

  const rgb = hexToRgb(hex);
  const lum = luminance(rgb);

  if (["bg", "from", "via", "to"].includes(prefix)) {
    if (lum < 0.08) return opacity === 1 ? lightTokens.surface : opacity > 0.5 ? rgba(lightTokens.surface, opacity) : rgba("#1F1F1D", Math.max(0.04, opacity * 0.65));
    if (lum < 0.24) return opacity === 1 ? lightTokens.surfaceWarm : opacity > 0.5 ? rgba(lightTokens.surfaceWarm, opacity) : rgba("#1F1F1D", Math.max(0.05, opacity * 0.72));
    if (lum > 0.72) return opacity === 1 ? lightTokens.surface : rgba(lightTokens.surface, opacity);
    return opacity === 1 ? rgbToHex(mix(rgb, "#FFFFFF", 0.72)) : rgba(rgbToHex(mix(rgb, "#FFFFFF", 0.72)), opacity);
  }

  if (["border", "divide", "ring", "outline"].includes(prefix)) {
    if (lum > 0.62 || lum < 0.2) return opacity === 1 ? lightTokens.border : rgba("#1F1F1D", Math.max(0.08, opacity));
    return opacity === 1 ? rgbToHex(mix(rgb, lightTokens.text, 0.2)) : rgba(rgbToHex(mix(rgb, lightTokens.text, 0.2)), opacity);
  }

  if (lum > 0.5 || lum < 0.16) return opacity === 1 ? lightTokens.text : rgba(lightTokens.text, opacity);
  return opacity === 1 ? lightTokens.muted : rgba(lightTokens.muted, opacity);
}

function declarationFor(prefix, color) {
  switch (prefix) {
    case "accent":
      return `accent-color: ${color};`;
    case "bg":
      return `background-color: ${color};`;
    case "border":
      return `border-color: ${color};`;
    case "caret":
      return `caret-color: ${color};`;
    case "decoration":
      return `text-decoration-color: ${color};`;
    case "divide":
      return `border-color: ${color};`;
    case "fill":
      return `fill: ${color};`;
    case "from":
      return `--tw-gradient-from: ${color} var(--tw-gradient-from-position); --tw-gradient-to: rgba(255, 255, 255, 0) var(--tw-gradient-to-position); --tw-gradient-stops: var(--tw-gradient-from), var(--tw-gradient-to);`;
    case "outline":
      return `outline-color: ${color};`;
    case "placeholder":
      return `color: ${color};`;
    case "ring":
      return `--tw-ring-color: ${color};`;
    case "selection":
      return `background-color: ${color};`;
    case "shadow":
      return `--tw-shadow-color: ${color}; --tw-shadow: var(--tw-shadow-colored);`;
    case "stroke":
      return `stroke: ${color};`;
    case "text":
      return `color: ${color};`;
    case "to":
      return `--tw-gradient-to: ${color} var(--tw-gradient-to-position);`;
    case "via":
      return `--tw-gradient-to: rgba(255, 255, 255, 0) var(--tw-gradient-to-position); --tw-gradient-stops: var(--tw-gradient-from), ${color} var(--tw-gradient-via-position), var(--tw-gradient-to);`;
    default:
      return null;
  }
}

function selectorForToken(token, parsed) {
  const baseSelector = `[data-theme="light"] [class~="${token.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"]`;
  const media = [];
  let prefixSelector = "";
  let suffixSelector = "";
  let pseudoElement = "";

  for (const variant of parsed.variants) {
    if (mediaVariants.has(variant)) {
      media.push(mediaVariants.get(variant));
    } else if (groupVariants.has(variant)) {
      prefixSelector = `${groupVariants.get(variant)} ${prefixSelector}`;
    } else if (peerVariants.has(variant)) {
      prefixSelector = `${peerVariants.get(variant)} ${prefixSelector}`;
    } else if (stateVariants.has(variant)) {
      suffixSelector += stateVariants.get(variant);
    } else if (variant === "first") {
      suffixSelector += ":first-child";
    } else if (variant === "last") {
      suffixSelector += ":last-child";
    } else if (variant === "odd") {
      suffixSelector += ":nth-child(odd)";
    } else if (variant === "even") {
      suffixSelector += ":nth-child(even)";
    }
  }

  if (parsed.prefix === "placeholder" || parsed.variants.includes("placeholder")) pseudoElement = "::placeholder";
  if (parsed.prefix === "selection" || parsed.variants.includes("selection")) pseudoElement = "::selection";

  const themedSelector = prefixSelector
    ? `[data-theme="light"] ${prefixSelector}[class~="${token.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"]`
    : baseSelector;

  return {
    media,
    selector: `${themedSelector}${suffixSelector}${pseudoElement}`,
  };
}

function generateLightCss(inventory) {
  const rules = [];
  const skipped = [];
  const mappedEntries = [];

  for (const group of inventory.groups) {
    if (group.kind !== "class") continue;
    const parsed = parseClassToken(group.token);
    if (!parsed) continue;
    const parsedColor = parseBodyColor(parsed.body);
    const color = mapColor(parsedColor, parsed.prefix);
    const declaration = color ? declarationFor(parsed.prefix, color) : null;
    if (!declaration) {
      skipped.push(group.token);
      continue;
    }
    mappedEntries.push({
      token: group.token,
      count: group.count,
      declaration,
      locations: group.locations,
    });
    const { media, selector } = selectorForToken(group.token, parsed);
    const rule = `${selector} { ${declaration} }`;
    if (media.length) rules.push(`${media.join(" ")} { ${rule} }`);
    else rules.push(rule);
  }

  const css = [
    "/* This file is generated by scripts/theme-colors.mjs. Do not edit by hand. */",
    "/* Light is the first-run default. These rules apply whenever <html data-theme=\"light\"> is active. */",
    "",
    ":root[data-theme=\"light\"] {",
    `  --background: ${lightTokens.page};`,
    `  --foreground: ${lightTokens.text};`,
    `  --muted: ${lightTokens.surfaceWarm};`,
    `  --muted-foreground: ${lightTokens.muted};`,
    `  --border: ${lightTokens.border};`,
    `  --primary: ${lightTokens.text};`,
    "  --primary-foreground: #FFFFFF;",
    `  --secondary: ${lightTokens.surfacePressed};`,
    `  --secondary-foreground: ${lightTokens.text};`,
    `  --accent: ${lightTokens.accent};`,
    "  --accent-foreground: #FFFFFF;",
    `  --input-bg: ${lightTokens.surface};`,
    `  --sidebar-bg: ${lightTokens.shell};`,
    "  --success: #047857;",
    "  --destructive: #dc2626;",
    "  --info: #2563eb;",
    "  --sb-thumb: rgba(31, 31, 29, 0.20);",
    "  --sb-thumb-hover: rgba(31, 31, 29, 0.32);",
    "  --sb-thumb-active: rgba(31, 31, 29, 0.46);",
    "  color-scheme: light;",
    "}",
    "",
    ":root[data-theme=\"light\"] body {",
    `  background-color: ${lightTokens.page};`,
    `  color: ${lightTokens.text};`,
    "  color-scheme: light;",
    "}",
    "",
    ":root[data-theme=\"light\"] .eterx-home-vignette {",
    "  opacity: 0.42;",
    "  filter: invert(1) saturate(0.45);",
    "}",
    "",
    ":root[data-theme=\"light\"] .eterx-home-field {",
    "  opacity: 0.58;",
    "}",
    "",
    ":root[data-theme=\"light\"] .eterx-app-loader {",
    `  background: ${lightTokens.page};`,
    "}",
    "",
    ...[...new Set(rules)].sort(),
    "",
    ...semanticAppCss(),
    "",
    `/* Skipped ${skipped.length} non-color or complex color utility tokens. They remain listed in docs/theme-color-inventory.json. */`,
    "",
  ].join("\n");

  ensureDir(generatedCssPath);
  fs.writeFileSync(generatedCssPath, css);
  writeMapReport(mappedEntries);
  return { rules: new Set(rules).size, skipped: skipped.length };
}

function semanticAppCss() {
  return [
    "/* Semantic app-level light theme polish. These rules handle gradients, images, and major shells that utility token mapping cannot infer. */",
    ":root[data-theme=\"light\"] {",
    "  --eterx-light-page: #FAFAF8;",
    "  --eterx-light-shell: #FFFFFF;",
    "  --eterx-light-panel: #F7F6F3;",
    "  --eterx-light-panel-strong: #F0EFEB;",
    "  --eterx-light-border: rgba(31, 31, 29, 0.14);",
    "  --eterx-light-border-strong: rgba(31, 31, 29, 0.22);",
    "  --eterx-light-text: #1F1F1D;",
    "  --eterx-light-muted: #77736C;",
    "  --eterx-light-faint: #A6A29A;",
    "  --eterx-light-accent: #516B8A;",
    "  --eterx-light-user: #F2F1EE;",
    "  --eterx-light-sidebar: #F7F6F3;",
    "  --eterx-light-sidebar-strong: #FFFFFF;",
    "  --eterx-light-sidebar-hover: #F0EFEB;",
    "  --eterx-light-code: #FFFFFF;",
    "  --eterx-light-code-border: rgba(31, 31, 29, 0.12);",
    "}",
    "",
    ":root[data-theme=\"light\"] .eterx-tooltip-card {",
    "  background: #FFFFFF !important;",
    "  color: #1F1F1D !important;",
    "  border-color: rgba(31, 31, 29, 0.14) !important;",
    "  box-shadow: 0 14px 32px rgba(31, 31, 29, 0.14), inset 0 1px 0 rgba(255, 255, 255, 0.96) !important;",
    "}",
    "",
    ":root[data-theme=\"light\"] .eterx-tooltip-arrow {",
    "  background: #FFFFFF !important;",
    "  border-color: rgba(31, 31, 29, 0.14) !important;",
    "}",
    "",
    ":root[data-theme=\"light\"] img[src*=\"/icons/agent-ui/\"] {",
    "  filter: brightness(0) saturate(0) opacity(0.82) !important;",
    "}",
    "",
    ":root[data-theme=\"light\"] img[src*=\"/icons/agent-ui/\"]:hover,",
    ":root[data-theme=\"light\"] .group:hover img[src*=\"/icons/agent-ui/\"] {",
    "  filter: brightness(0) saturate(0) opacity(0.95) !important;",
    "}",
    "",
    ":root[data-theme=\"light\"] [class~=\"bg-[linear-gradient(180deg,#181818_0%,#111111_46%,#0A0A0A_100%)]\"] {",
    "  background-image: linear-gradient(180deg, #FFFFFF 0%, #F7F6F3 54%, #F0EFEB 100%) !important;",
    "}",
    "",
    ":root[data-theme=\"light\"] [class~=\"bg-[linear-gradient(90deg,rgba(255,255,255,0.026),transparent_18%,transparent_100%)]\"] {",
    "  background-image: linear-gradient(90deg, rgba(31, 31, 29, 0.045), transparent 28%, transparent 100%) !important;",
    "}",
    "",
    ":root[data-theme=\"light\"] .eterx-sidebar-shell {",
    "  background: #ECEBE9 !important;",
    "  border-right-color: rgba(31, 31, 29, 0.075) !important;",
    "  box-shadow: inset -1px 0 0 rgba(31, 31, 29, 0.045), 8px 0 22px rgba(31, 31, 29, 0.055) !important;",
    "}",
    "",
    ":root[data-theme=\"light\"] .eterx-sidebar-sheen {",
    "  background: transparent !important;",
    "}",
    "",
    ":root[data-theme=\"light\"] .eterx-sidebar-brand span {",
    "  color: #343230 !important;",
    "}",
    "",
    ":root[data-theme=\"light\"] .eterx-sidebar-toggle,",
    ":root[data-theme=\"light\"] .eterx-sidebar-nav-item {",
    "  color: #4D4A45 !important;",
    "  border-color: transparent !important;",
    "}",
    "",
    ":root[data-theme=\"light\"] .eterx-sidebar-toggle:hover,",
    ":root[data-theme=\"light\"] .eterx-sidebar-nav-item:hover {",
    "  background: #E1DFDC !important;",
    "  color: #343230 !important;",
    "  border-color: rgba(31, 31, 29, 0.055) !important;",
    "}",
    "",
    ":root[data-theme=\"light\"] .eterx-sidebar-nav-active {",
    "  background: #DCDAD6 !important;",
    "  color: #343230 !important;",
    "  border-color: rgba(31, 31, 29, 0.055) !important;",
    "  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.36) !important;",
    "}",
    "",
    ":root[data-theme=\"light\"] .eterx-sidebar-toggle svg,",
    ":root[data-theme=\"light\"] .eterx-sidebar-nav-item svg {",
    "  color: #56534E !important;",
    "  opacity: 0.92 !important;",
    "}",
    "",
    ":root[data-theme=\"light\"] .eterx-sidebar-shell svg [stroke] {",
    "  stroke: currentColor !important;",
    "  stroke-width: 1.78 !important;",
    "}",
    "",
    ":root[data-theme=\"light\"] .eterx-sidebar-nav-active svg,",
    ":root[data-theme=\"light\"] .eterx-sidebar-nav-item:hover svg {",
    "  color: #343230 !important;",
    "  opacity: 1 !important;",
    "}",
    "",
    ":root[data-theme=\"light\"] .eterx-sidebar-recents {",
    "  background: #F6F5F2 !important;",
    "  border-color: rgba(31, 31, 29, 0.075) !important;",
    "  box-shadow: 0 10px 24px rgba(31, 31, 29, 0.035), inset 0 1px 0 rgba(255, 255, 255, 0.78) !important;",
    "}",
    "",
    ":root[data-theme=\"light\"] .eterx-sidebar-recents [class*=\"text-[#8E918F]\"],",
    ":root[data-theme=\"light\"] .eterx-sidebar-recents [class*=\"text-[#555350]\"] {",
    "  color: #807C75 !important;",
    "}",
    "",
    ":root[data-theme=\"light\"] .eterx-sidebar-chat-row {",
    "  color: #4D4A45 !important;",
    "  border-color: transparent !important;",
    "}",
    "",
    ":root[data-theme=\"light\"] .eterx-sidebar-chat-row:hover {",
    "  background: #E1DFDC !important;",
    "  color: #343230 !important;",
    "  border-color: transparent !important;",
    "}",
    "",
    ":root[data-theme=\"light\"] .eterx-sidebar-chat-active,",
    ":root[data-theme=\"light\"] .eterx-sidebar-chat-working {",
    "  background: #DCDAD6 !important;",
    "  color: #343230 !important;",
    "  border-color: transparent !important;",
    "  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.34) !important;",
    "}",
    "",
    ":root[data-theme=\"light\"] .eterx-sidebar-working-fade {",
    "  background: linear-gradient(270deg, #DCDAD6 0%, rgba(220, 218, 214, 0.90) 42%, transparent 100%) !important;",
    "}",
    "",
    ":root[data-theme=\"light\"] .eterx-sidebar-profile {",
    "  background: #E4E3E0 !important;",
    "  border-top-color: rgba(31, 31, 29, 0.075) !important;",
    "}",
    "",
    ":root[data-theme=\"light\"] .eterx-sidebar-profile-card:hover {",
    "  background: #DCDAD6 !important;",
    "  border-color: transparent !important;",
    "}",
    "",
    ":root[data-theme=\"light\"] .eterx-sidebar-avatar {",
    "  background: linear-gradient(135deg, #F8F7F5, #DCDAD6) !important;",
    "  color: #343230 !important;",
    "  border-color: rgba(31, 31, 29, 0.09) !important;",
    "  box-shadow: 0 4px 12px rgba(31, 31, 29, 0.08), inset 0 1px 0 rgba(255, 255, 255, 0.70) !important;",
    "}",
    "",
    ":root[data-theme=\"light\"] .eterx-sidebar-menu {",
    "  background: rgba(255, 255, 255, 0.96) !important;",
    "  color: #1F1F1D !important;",
    "  border-color: rgba(31, 31, 29, 0.12) !important;",
    "  box-shadow: 0 18px 48px rgba(31, 31, 29, 0.14), inset 0 1px 0 rgba(255, 255, 255, 0.96) !important;",
    "}",
    "",
    ":root[data-theme=\"light\"] .eterx-sidebar-menu button {",
    "  color: #34332F !important;",
    "}",
    "",
    ":root[data-theme=\"light\"] .eterx-sidebar-menu button:hover {",
    "  background: #F3F2EF !important;",
    "  color: #1F1F1D !important;",
    "}",
    "",
    ":root[data-theme=\"light\"] .eterx-sidebar-menu svg {",
    "  color: #77736C !important;",
    "  opacity: 0.92 !important;",
    "}",
    "",
    ":root[data-theme=\"light\"] .eterx-sidebar-menu button:hover svg {",
    "  color: #34332F !important;",
    "  opacity: 1 !important;",
    "}",
    "",
    ":root[data-theme=\"light\"] .eterx-agents-view {",
    "  color: #1F1F1D !important;",
    "}",
    "",
    ":root[data-theme=\"light\"] .eterx-agents-view h1,",
    ":root[data-theme=\"light\"] .eterx-agents-view h2,",
    ":root[data-theme=\"light\"] .eterx-agents-view h3 {",
    "  color: #1F1F1D !important;",
    "}",
    "",
    ":root[data-theme=\"light\"] .eterx-agents-view p,",
    ":root[data-theme=\"light\"] .eterx-agents-view span {",
    "  color: inherit;",
    "}",
    "",
    ":root[data-theme=\"light\"] .eterx-agents-library-panel {",
    "  background: rgba(255, 255, 255, 0.58) !important;",
    "  border-color: rgba(31, 31, 29, 0.08) !important;",
    "  box-shadow: 0 22px 62px rgba(31, 31, 29, 0.07), inset 0 1px 0 rgba(255, 255, 255, 0.72) !important;",
    "}",
    "",
    ":root[data-theme=\"light\"] .eterx-agent-card {",
    "  background: #FFFFFF !important;",
    "  border-color: rgba(31, 31, 29, 0.10) !important;",
    "  color: #1F1F1D !important;",
    "  box-shadow: 0 8px 22px rgba(31, 31, 29, 0.055), inset 0 1px 0 rgba(255, 255, 255, 0.96) !important;",
    "}",
    "",
    ":root[data-theme=\"light\"] .eterx-agent-card:hover {",
    "  background: #FDFCFB !important;",
    "  border-color: rgba(31, 31, 29, 0.16) !important;",
    "  box-shadow: 0 12px 28px rgba(31, 31, 29, 0.075), inset 0 1px 0 rgba(255, 255, 255, 0.96) !important;",
    "}",
    "",
    ":root[data-theme=\"light\"] .eterx-agents-primary-button,",
    ":root[data-theme=\"light\"] .eterx-agent-open-button {",
    "  background: #FFFFFF !important;",
    "  color: #1F1F1D !important;",
    "  border: 1px solid rgba(31, 31, 29, 0.14) !important;",
    "  box-shadow: 0 8px 20px rgba(31, 31, 29, 0.065), inset 0 1px 0 rgba(255, 255, 255, 0.96) !important;",
    "}",
    "",
    ":root[data-theme=\"light\"] .eterx-agents-primary-button:hover,",
    ":root[data-theme=\"light\"] .eterx-agent-open-button:hover {",
    "  background: #F3F2EF !important;",
    "  border-color: rgba(31, 31, 29, 0.22) !important;",
    "}",
    "",
    ":root[data-theme=\"light\"] .eterx-agent-use-button {",
    "  background: #F0EFEB !important;",
    "  color: #1F1F1D !important;",
    "  border-color: rgba(31, 31, 29, 0.12) !important;",
    "}",
    "",
    ":root[data-theme=\"light\"] .eterx-agent-use-button:hover {",
    "  background: #E8E6E2 !important;",
    "  border-color: rgba(31, 31, 29, 0.20) !important;",
    "}",
    "",
    ":root[data-theme=\"light\"] .eterx-agent-icon-button {",
    "  color: #6F6A62 !important;",
    "  background: transparent !important;",
    "}",
    "",
    ":root[data-theme=\"light\"] .eterx-agent-icon-button:hover {",
    "  color: #34332F !important;",
    "  background: #F0EFEB !important;",
    "}",
    "",
    ":root[data-theme=\"light\"] .eterx-agent-icon-button svg {",
    "  color: currentColor !important;",
    "  opacity: 0.95 !important;",
    "}",
    "",
    ":root[data-theme=\"light\"] [class~=\"bg-[linear-gradient(180deg,#0F0F0F_0%,rgba(15,15,15,0.98)_46%,rgba(15,15,15,0.56)_78%,transparent_100%)]\"] {",
    "  background-image: linear-gradient(180deg, #FAFAF8 0%, rgba(250, 250, 248, 0.96) 46%, rgba(250, 250, 248, 0.58) 78%, transparent 100%) !important;",
    "}",
    "",
    ":root[data-theme=\"light\"] .eterx-home-field {",
    "  background: linear-gradient(180deg, transparent 0%, transparent 13%, rgba(77, 183, 196, 0.09) 42%, rgba(72, 154, 190, 0.22) 72%, rgba(52, 180, 158, 0.32) 100%) !important;",
    "}",
    "",
    ":root[data-theme=\"light\"] .eterx-home-plasma {",
    "  opacity: 0.36 !important;",
    "  filter: blur(38px) saturate(1.08) brightness(1.02) !important;",
    "  mix-blend-mode: multiply !important;",
    "}",
    "",
    ":root[data-theme=\"light\"] .eterx-home-plasma-pink {",
    "  background: #D6C8E8 !important;",
    "}",
    "",
    ":root[data-theme=\"light\"] .eterx-home-plasma-emerald {",
    "  background: #73D1B6 !important;",
    "}",
    "",
    ":root[data-theme=\"light\"] .eterx-home-plasma-blue {",
    "  background: #66B7E3 !important;",
    "}",
    "",
    ":root[data-theme=\"light\"] .eterx-home-plasma-lime {",
    "  background: #C5D98E !important;",
    "}",
    "",
    ":root[data-theme=\"light\"] .eterx-home-wave-stage {",
    "  opacity: 0.62 !important;",
    "  filter: saturate(1.08) brightness(1.02) !important;",
    "  mix-blend-mode: multiply !important;",
    "}",
    "",
    ":root[data-theme=\"light\"] .eterx-home-wave-volume-back {",
    "  background:",
    "    radial-gradient(ellipse at 18% 62%, rgba(58, 166, 148, 0.18), transparent 48%),",
    "    radial-gradient(ellipse at 42% 58%, rgba(72, 154, 190, 0.20), transparent 58%),",
    "    radial-gradient(ellipse at 70% 52%, rgba(86, 125, 158, 0.16), transparent 60%) !important;",
    "  opacity: 0.38 !important;",
    "}",
    "",
    ":root[data-theme=\"light\"] .eterx-home-wave-volume-mid {",
    "  background:",
    "    radial-gradient(ellipse at 18% 66%, rgba(58, 166, 148, 0.20), transparent 50%),",
    "    radial-gradient(ellipse at 45% 56%, rgba(56, 170, 202, 0.24), transparent 60%),",
    "    radial-gradient(ellipse at 72% 54%, rgba(86, 125, 158, 0.18), transparent 60%) !important;",
    "  opacity: 0.46 !important;",
    "}",
    "",
    ":root[data-theme=\"light\"] .eterx-home-wave-volume-front {",
    "  background:",
    "    radial-gradient(ellipse at 20% 54%, rgba(58, 166, 148, 0.18), transparent 48%),",
    "    radial-gradient(ellipse at 48% 50%, rgba(77, 183, 196, 0.24), transparent 58%),",
    "    radial-gradient(ellipse at 78% 50%, rgba(90, 132, 166, 0.18), transparent 58%) !important;",
    "  opacity: 0.52 !important;",
    "}",
    "",
    ":root[data-theme=\"light\"] .eterx-home-lobe {",
    "  opacity: 0.40 !important;",
    "  filter: blur(24px) saturate(1.02) !important;",
    "}",
    "",
    ":root[data-theme=\"light\"] .eterx-home-lobe-left {",
    "  background: radial-gradient(ellipse at 50% 50%, rgba(58, 166, 148, 0.24), rgba(77, 183, 196, 0.12) 50%, transparent 76%) !important;",
    "}",
    "",
    ":root[data-theme=\"light\"] .eterx-home-lobe-center {",
    "  background: radial-gradient(ellipse at 50% 54%, rgba(66, 174, 206, 0.26), rgba(86, 125, 158, 0.13) 52%, transparent 76%) !important;",
    "}",
    "",
    ":root[data-theme=\"light\"] .eterx-home-lobe-right {",
    "  background: radial-gradient(ellipse at 50% 52%, rgba(88, 128, 164, 0.22), rgba(134, 164, 108, 0.12) 50%, transparent 76%) !important;",
    "}",
    "",
    ":root[data-theme=\"light\"] .eterx-home-wave-depth {",
    "  background: radial-gradient(ellipse at 50% 100%, rgba(77, 183, 196, 0.18), rgba(232, 230, 226, 0.15) 42%, transparent 72%) !important;",
    "  mix-blend-mode: multiply !important;",
    "}",
    "",
    ":root[data-theme=\"light\"] .eterx-home-greeting {",
    "  background-image: linear-gradient(90deg, #34332F 0%, #34332F 46%, #57534E 78%, #8C887F 100%) !important;",
    "  filter: none !important;",
    "  text-shadow: none !important;",
    "}",
    "",
    ":root[data-theme=\"light\"] .eterx-home-vignette {",
    "  opacity: 0.48 !important;",
    "  filter: none !important;",
    "  background:",
    "    linear-gradient(180deg, #FAFAF8 0%, rgba(250, 250, 248, 0.46) 12%, rgba(250, 250, 248, 0.04) 38%, transparent 100%),",
    "    radial-gradient(122% 104% at 50% 100%, transparent 0%, transparent 72%, rgba(232, 230, 226, 0.26) 90%, rgba(250, 250, 248, 0.82) 100%),",
    "    linear-gradient(90deg, #FAFAF8 0%, rgba(250, 250, 248, 0.15) 8%, transparent 20%, transparent 81%, rgba(250, 250, 248, 0.16) 92%, #FAFAF8 100%) !important;",
    "}",
    "",
    ":root[data-theme=\"light\"] [class~=\"bg-[#242424]\"] {",
    "  background-color: var(--eterx-light-user) !important;",
    "}",
    "",
    ":root[data-theme=\"light\"] [class~=\"from-[#242424]/0\"] {",
    "  --tw-gradient-from: rgba(255, 255, 255, 0) var(--tw-gradient-from-position) !important;",
    "  --tw-gradient-to: rgba(255, 255, 255, 0) var(--tw-gradient-to-position) !important;",
    "  --tw-gradient-stops: var(--tw-gradient-from), var(--tw-gradient-to) !important;",
    "}",
    "",
    ":root[data-theme=\"light\"] [class~=\"via-[#242424]/82\"] {",
    "  --tw-gradient-stops: var(--tw-gradient-from), rgba(255, 255, 255, 0.92) var(--tw-gradient-via-position), var(--tw-gradient-to) !important;",
    "}",
    "",
    ":root[data-theme=\"light\"] [class~=\"to-[#242424]\"] {",
    "  --tw-gradient-to: #FFFFFF var(--tw-gradient-to-position) !important;",
    "}",
    "",
    ":root[data-theme=\"light\"] [class~=\"bg-[#1A1A1A]/80\"],",
    ":root[data-theme=\"light\"] [class~=\"bg-[#1D1D1D]\"] {",
    "  background-color: var(--eterx-light-shell) !important;",
    "}",
    "",
    ":root[data-theme=\"light\"] .eterx-chat-feed {",
    "  color: var(--eterx-light-text);",
    "}",
    "",
    ":root[data-theme=\"light\"] .eterx-chat-feed-user-bubble,",
    ":root[data-theme=\"light\"] .eterx-steering-bubble {",
    "  background: #F2F1EE !important;",
    "  color: #1F1F1D !important;",
    "  border-color: rgba(31, 31, 29, 0.10) !important;",
    "  box-shadow: 0 10px 28px rgba(31, 31, 29, 0.055), inset 0 1px 0 rgba(255, 255, 255, 0.82) !important;",
    "}",
    "",
    ":root[data-theme=\"light\"] .eterx-chat-feed-user-fade {",
    "  background: linear-gradient(180deg, rgba(242, 241, 238, 0), rgba(242, 241, 238, 0.90) 58%, #F2F1EE 100%) !important;",
    "}",
    "",
    ":root[data-theme=\"light\"] .eterx-chat-feed-user-bubble a,",
    ":root[data-theme=\"light\"] .eterx-assistant-answer a,",
    ":root[data-theme=\"light\"] .professional-thought a {",
    "  color: #516B8A !important;",
    "}",
    "",
    ":root[data-theme=\"light\"] .eterx-assistant-answer,",
    ":root[data-theme=\"light\"] .eterx-assistant-answer-body,",
    ":root[data-theme=\"light\"] .eterx-assistant-live-text,",
    ":root[data-theme=\"light\"] .eterx-professional-thought,",
    ":root[data-theme=\"light\"] .eterx-professional-answer {",
    "  color: #1F1F1D !important;",
    "}",
    "",
    ":root[data-theme=\"light\"] .professional-thought p,",
    ":root[data-theme=\"light\"] .professional-thought li,",
    ":root[data-theme=\"light\"] .professional-thought td,",
    ":root[data-theme=\"light\"] .professional-thought em {",
    "  color: #34332F !important;",
    "}",
    "",
    ":root[data-theme=\"light\"] .professional-thought h1,",
    ":root[data-theme=\"light\"] .professional-thought h2,",
    ":root[data-theme=\"light\"] .professional-thought h3,",
    ":root[data-theme=\"light\"] .professional-thought h4,",
    ":root[data-theme=\"light\"] .professional-thought h5,",
    ":root[data-theme=\"light\"] .professional-thought h6,",
    ":root[data-theme=\"light\"] .professional-thought strong {",
    "  color: #1F1F1D !important;",
    "}",
    "",
    ":root[data-theme=\"light\"] .professional-thought code {",
    "  background: #F3F2EF !important;",
    "  color: #516B8A !important;",
    "  border: 1px solid rgba(31, 31, 29, 0.08);",
    "}",
    "",
    ":root[data-theme=\"light\"] .professional-thought blockquote {",
    "  background: #F7F6F3 !important;",
    "  color: #57534E !important;",
    "  border-left-color: rgba(81, 107, 138, 0.42) !important;",
    "}",
    "",
    ":root[data-theme=\"light\"] .professional-thought table,",
    ":root[data-theme=\"light\"] .professional-thought th,",
    ":root[data-theme=\"light\"] .professional-thought td {",
    "  border-color: rgba(31, 31, 29, 0.12) !important;",
    "}",
    "",
    ":root[data-theme=\"light\"] .professional-thought thead {",
    "  background: #F3F2EF !important;",
    "}",
    "",
    ":root[data-theme=\"light\"] .eterx-thought-card {",
    "  background: #FFFFFF !important;",
    "  border-color: rgba(31, 31, 29, 0.10) !important;",
    "  color: #1F1F1D !important;",
    "  box-shadow: none !important;",
    "}",
    "",
    ":root[data-theme=\"light\"] .eterx-action-card,",
    ":root[data-theme=\"light\"] .eterx-live-action-card {",
    "  background: #FAFAF8 !important;",
    "  border-color: rgba(31, 31, 29, 0.105) !important;",
    "  color: #1F1F1D !important;",
    "  box-shadow: none !important;",
    "}",
    "",
    ":root[data-theme=\"light\"] .eterx-thinking-process-stack {",
    "  background: transparent !important;",
    "  gap: 6px !important;",
    "  box-shadow: none !important;",
    "}",
    "",
    ":root[data-theme=\"light\"] .eterx-process-summary-row {",
    "  background: transparent !important;",
    "  box-shadow: none !important;",
    "}",
    "",
    ":root[data-theme=\"light\"] .eterx-worked-summary-line {",
    "  background: rgba(31, 31, 29, 0.12) !important;",
    "}",
    "",
    ":root[data-theme=\"light\"] .eterx-worked-summary-label {",
    "  color: #77736C !important;",
    "}",
    "",
    ":root[data-theme=\"light\"] .eterx-process-summary-chip {",
    "  background: #F0EFEB !important;",
    "  color: #57534E !important;",
    "  outline: 1px solid rgba(31, 31, 29, 0.10) !important;",
    "  border-radius: 999px !important;",
    "  box-shadow: none !important;",
    "}",
    "",
    ":root[data-theme=\"light\"] .eterx-process-summary-chip:hover {",
    "  background: #E8E6E2 !important;",
    "  color: #1F1F1D !important;",
    "}",
    "",
    ":root[data-theme=\"light\"] .eterx-process-summary-icon {",
    "  background: rgba(31, 31, 29, 0.055) !important;",
    "  outline: 1px solid rgba(31, 31, 29, 0.075) !important;",
    "}",
    "",
    ":root[data-theme=\"light\"] .eterx-process-summary-chip svg {",
    "  color: currentColor !important;",
    "}",
    "",
    ":root[data-theme=\"light\"] .eterx-action-chip:hover,",
    ":root[data-theme=\"light\"] .eterx-thought-toggle:hover,",
    ":root[data-theme=\"light\"] .eterx-live-action-chip:hover {",
    "  background: transparent !important;",
    "}",
    "",
    ":root[data-theme=\"light\"] .eterx-action-chip,",
    ":root[data-theme=\"light\"] .eterx-thought-toggle,",
    ":root[data-theme=\"light\"] .eterx-live-action-chip,",
    ":root[data-theme=\"light\"] .eterx-live-action-row {",
    "  background: transparent !important;",
    "}",
    "",
    ":root[data-theme=\"light\"] .eterx-action-card:hover,",
    ":root[data-theme=\"light\"] .eterx-live-action-card:hover {",
    "  border-color: rgba(31, 31, 29, 0.12) !important;",
    "  box-shadow: none !important;",
    "}",
    "",
    ":root[data-theme=\"light\"] .eterx-thought-card:hover {",
    "  border-color: rgba(31, 31, 29, 0.16) !important;",
    "  box-shadow: none !important;",
    "}",
    "",
    ":root[data-theme=\"light\"] .eterx-action-icon {",
    "  color: #77736C !important;",
    "  opacity: 1 !important;",
    "  transform: none !important;",
    "  transition: opacity 150ms ease !important;",
    "}",
    "",
    ":root[data-theme=\"light\"] .eterx-action-icon svg,",
    ":root[data-theme=\"light\"] .eterx-action-icon img {",
    "  color: #77736C !important;",
    "  opacity: 0.96 !important;",
    "  transform: none !important;",
    "}",
    "",
    ":root[data-theme=\"light\"] .eterx-action-icon img {",
    "  filter: brightness(0) saturate(0) opacity(0.84) !important;",
    "}",
    "",
    ":root[data-theme=\"light\"] .eterx-action-icon svg [stroke] {",
    "  stroke: #77736C !important;",
    "}",
    "",
    ":root[data-theme=\"light\"] .eterx-action-icon svg [fill]:not([fill=\"none\"]) {",
    "  fill: #77736C !important;",
    "}",
    "",
    ":root[data-theme=\"light\"] .eterx-action-chip:hover .eterx-action-icon,",
    ":root[data-theme=\"light\"] .eterx-action-chip:hover .eterx-action-icon svg,",
    ":root[data-theme=\"light\"] .eterx-action-chip:hover .eterx-action-icon img {",
    "  color: #77736C !important;",
    "  opacity: 1 !important;",
    "  transform: none !important;",
    "}",
    "",
    ":root[data-theme=\"light\"] .eterx-action-chip:hover .eterx-action-icon img {",
    "  filter: brightness(0) saturate(0) opacity(0.9) !important;",
    "}",
    "",
    ":root[data-theme=\"light\"] .eterx-action-chip:hover .eterx-action-icon svg [stroke] {",
    "  stroke: #77736C !important;",
    "}",
    "",
    ":root[data-theme=\"light\"] .eterx-action-chip:hover .eterx-action-icon svg [fill]:not([fill=\"none\"]) {",
    "  fill: #77736C !important;",
    "}",
    "",
    ":root[data-theme=\"light\"] .eterx-action-file-link {",
    "  color: #1A73E8 !important;",
    "  text-decoration-color: rgba(26, 115, 232, 0.34) !important;",
    "}",
    "",
    ":root[data-theme=\"light\"] .eterx-action-file-link:hover {",
    "  color: #1A73E8 !important;",
    "}",
    "",
    ":root[data-theme=\"light\"] .eterx-action-verb {",
    "  color: #9A9690 !important;",
    "  font-weight: 500 !important;",
    "}",
    "",
    ":root[data-theme=\"light\"] .eterx-action-diff-chip {",
    "  height: auto !important;",
    "  margin: 0 !important;",
    "  padding: 0 !important;",
    "  background: transparent !important;",
    "  border: 0 !important;",
    "  border-radius: 0 !important;",
    "  color: #77736C !important;",
    "  box-shadow: none !important;",
    "}",
    "",
    ":root[data-theme=\"light\"] .eterx-action-diff-chip:hover {",
    "  background: transparent !important;",
    "  border: 0 !important;",
    "  box-shadow: none !important;",
    "  color: #77736C !important;",
    "}",
    "",
    ":root[data-theme=\"light\"] .eterx-action-diff-added {",
    "  color: #0B9F52 !important;",
    "}",
    "",
    ":root[data-theme=\"light\"] .eterx-action-diff-removed {",
    "  color: #D64545 !important;",
    "}",
    "",
    ":root[data-theme=\"light\"] .eterx-action-diff-tooltip {",
    "  background: #FFFFFF !important;",
    "  color: #1F1F1D !important;",
    "  border-color: rgba(31, 31, 29, 0.14) !important;",
    "  box-shadow: 0 12px 28px rgba(31, 31, 29, 0.14), inset 0 1px 0 rgba(255, 255, 255, 0.96) !important;",
    "}",
    "",
    ":root[data-theme=\"light\"] .eterx-action-icon-button {",
    "  background: #F7F6F3 !important;",
    "  border-color: rgba(31, 31, 29, 0.10) !important;",
    "  color: #77736C !important;",
    "}",
    "",
    ":root[data-theme=\"light\"] .eterx-action-icon-button:hover {",
    "  background: #E8E6E2 !important;",
    "  color: #34332F !important;",
    "}",
    "",
    ":root[data-theme=\"light\"] .eterx-action-row-divider,",
    ":root[data-theme=\"light\"] .eterx-live-action-row,",
    ":root[data-theme=\"light\"] .eterx-live-action-card > div + div {",
    "  border-color: rgba(31, 31, 29, 0.08) !important;",
    "  background: transparent !important;",
    "}",
    "",
    ":root[data-theme=\"light\"] svg.animate-spin,",
    ":root[data-theme=\"light\"] [class*=\"animate-spin\"],",
    ":root[data-theme=\"light\"] [class*=\"animate-[spin\"] {",
    "  color: #1F1F1D !important;",
    "}",
    "",
    ":root[data-theme=\"light\"] [class*=\"animate-spin\"][class*=\"border-white\"],",
    ":root[data-theme=\"light\"] [class*=\"animate-[spin\"][class*=\"border-white\"],",
    ":root[data-theme=\"light\"] [class*=\"animate-spin\"][class*=\"border-[#E2765A]\"],",
    ":root[data-theme=\"light\"] [class*=\"animate-spin\"][class*=\"border-blue\"] {",
    "  border-color: rgba(31, 31, 29, 0.16) !important;",
    "}",
    "",
    ":root[data-theme=\"light\"] [class*=\"animate-spin\"][class*=\"border-t-white\"],",
    ":root[data-theme=\"light\"] [class*=\"animate-[spin\"][class*=\"border-t-white\"],",
    ":root[data-theme=\"light\"] [class*=\"animate-spin\"][class*=\"border-t-[#E2765A]\"],",
    ":root[data-theme=\"light\"] [class*=\"animate-spin\"][class*=\"border-t-blue\"] {",
    "  border-top-color: #1F1F1D !important;",
    "}",
    "",
    ":root[data-theme=\"light\"] [class*=\"animate-spin\"][class*=\"border-r-white\"],",
    ":root[data-theme=\"light\"] [class*=\"animate-[spin\"][class*=\"border-r-white\"],",
    ":root[data-theme=\"light\"] [class*=\"animate-spin\"][class*=\"border-r-[#E2765A]\"],",
    ":root[data-theme=\"light\"] [class*=\"animate-spin\"][class*=\"border-r-blue\"] {",
    "  border-right-color: #1F1F1D !important;",
    "}",
    "",
    ":root[data-theme=\"light\"] .eterx-thought-expanded,",
    ":root[data-theme=\"light\"] .eterx-thought-expanded p,",
    ":root[data-theme=\"light\"] .eterx-thought-expanded li {",
    "  color: #57534E !important;",
    "}",
    "",
    ":root[data-theme=\"light\"] .eterx-prompt-preview-dialog {",
    "  background: #FFFFFF !important;",
    "  border-color: rgba(31, 31, 29, 0.14) !important;",
    "  box-shadow: 0 24px 80px rgba(31, 31, 29, 0.16) !important;",
    "}",
    "",
    ":root[data-theme=\"light\"] .eterx-prompt-preview-text {",
    "  color: #1F1F1D !important;",
    "}",
    "",
    ":root[data-theme=\"light\"] .eterx-markdown-code-block,",
    ":root[data-theme=\"light\"] .eterx-markdown-preview {",
    "  background: #FFFFFF !important;",
    "  border-color: rgba(31, 31, 29, 0.12) !important;",
    "  color: #1F1F1D !important;",
    "  box-shadow: 0 14px 34px rgba(31, 31, 29, 0.075) !important;",
    "}",
    "",
    ":root[data-theme=\"light\"] .eterx-markdown-preview-header {",
    "  background: #F3F2EF !important;",
    "  border-bottom-color: rgba(31, 31, 29, 0.10) !important;",
    "}",
    "",
    ":root[data-theme=\"light\"] .eterx-markdown-preview-header span {",
    "  color: #77736C !important;",
    "}",
    "",
    ":root[data-theme=\"light\"] .eterx-markdown-preview-body {",
    "  background: #FFFFFF !important;",
    "}",
    "",
    ":root[data-theme=\"light\"] .eterx-markdown-copy-button {",
    "  background: rgba(255, 255, 255, 0.92) !important;",
    "  border-color: rgba(31, 31, 29, 0.12) !important;",
    "  color: #34332F !important;",
    "  box-shadow: 0 8px 20px rgba(31, 31, 29, 0.10) !important;",
    "}",
    "",
    ":root[data-theme=\"light\"] .eterx-markdown-code-scroll,",
    ":root[data-theme=\"light\"] .eterx-markdown-code-content,",
    ":root[data-theme=\"light\"] .eterx-markdown-code-content pre,",
    ":root[data-theme=\"light\"] .eterx-markdown-code-content code {",
    "  background: #FFFFFF !important;",
    "  color: #1F1F1D !important;",
    "}",
    "",
    ":root[data-theme=\"light\"] .eterx-markdown-code-content span {",
    "  background: transparent !important;",
    "  color: #34332F !important;",
    "}",
    "",
    ":root[data-theme=\"light\"] .eterx-markdown-inline-code {",
    "  background: #F3F2EF !important;",
    "  color: #516B8A !important;",
    "  border: 1px solid rgba(31, 31, 29, 0.08) !important;",
    "}",
    "",
    ":root[data-theme=\"light\"] .eterx-composer-surface {",
    "  background: #FFFFFF !important;",
    "  border-color: rgba(31, 31, 29, 0.16) !important;",
    "  box-shadow: 0 22px 54px rgba(31, 31, 29, 0.10), inset 0 1px 0 rgba(255, 255, 255, 0.96) !important;",
    "  color: #1F1F1D !important;",
    "}",
    "",
    ":root[data-theme=\"light\"] .eterx-composer-textarea-wrap {",
    "  background: transparent !important;",
    "}",
    "",
    ":root[data-theme=\"light\"] .eterx-composer-textarea {",
    "  background: transparent !important;",
    "  color: #1F1F1D !important;",
    "  caret-color: #1F1F1D !important;",
    "  box-shadow: none !important;",
    "}",
    "",
    ":root[data-theme=\"light\"] .eterx-composer-textarea::placeholder {",
    "  color: #8C887F !important;",
    "  opacity: 1 !important;",
    "}",
    "",
    ":root[data-theme=\"light\"] .eterx-composer-overflow-fade-top {",
    "  background: linear-gradient(180deg, rgba(255, 255, 255, 0.98), rgba(255, 255, 255, 0)) !important;",
    "}",
    "",
    ":root[data-theme=\"light\"] .eterx-composer-overflow-fade-bottom {",
    "  background: linear-gradient(0deg, rgba(255, 255, 255, 0.98), rgba(255, 255, 255, 0)) !important;",
    "}",
    "",
    ":root[data-theme=\"light\"] .eterx-chat-controls .eterx-control-button,",
    ":root[data-theme=\"light\"] .eterx-agent-button,",
    ":root[data-theme=\"light\"] .eterx-model-button {",
    "  background: #FFFFFF !important;",
    "  border-color: rgba(31, 31, 29, 0.14) !important;",
    "  color: #1F1F1D !important;",
    "  box-shadow: 0 8px 22px rgba(31, 31, 29, 0.06), inset 0 1px 0 rgba(255, 255, 255, 0.96) !important;",
    "}",
    "",
    ":root[data-theme=\"light\"] .eterx-chat-controls .eterx-control-button:hover,",
    ":root[data-theme=\"light\"] .eterx-agent-button:hover,",
    ":root[data-theme=\"light\"] .eterx-model-button:hover {",
    "  background: #F3F2EF !important;",
    "  border-color: rgba(31, 31, 29, 0.22) !important;",
    "}",
    "",
    ":root[data-theme=\"light\"] .eterx-chat-controls svg,",
    ":root[data-theme=\"light\"] .eterx-agent-button svg,",
    ":root[data-theme=\"light\"] .eterx-model-button svg {",
    "  color: #1F1F1D !important;",
    "}",
    "",
    ":root[data-theme=\"light\"] .eterx-chat-controls .eterx-control-button .eterx-composer-control-icon {",
    "  color: #34332F !important;",
    "  opacity: 0.86 !important;",
    "  filter: brightness(0) saturate(0) opacity(0.86) !important;",
    "}",
    "",
    ":root[data-theme=\"light\"] .eterx-chat-controls .eterx-control-button:hover .eterx-composer-control-icon {",
    "  color: #1F1F1D !important;",
    "  opacity: 0.98 !important;",
    "  filter: brightness(0) saturate(0) opacity(0.98) !important;",
    "}",
    "",
    ":root[data-theme=\"light\"] .eterx-chat-controls .eterx-control-button .eterx-composer-control-icon [stroke] {",
    "  stroke-width: 1.85 !important;",
    "}",
    "",
    ":root[data-theme=\"light\"] [class~=\"shadow-[0_10px_28px_rgba(0,0,0,0.22),inset_0_1px_0_rgba(255,255,255,0.035)]\"] {",
    "  box-shadow: 0 10px 26px rgba(31, 31, 29, 0.07), inset 0 1px 0 rgba(255, 255, 255, 0.82) !important;",
    "}",
    "",
    ":root[data-theme=\"light\"] textarea,",
    ":root[data-theme=\"light\"] input,",
    ":root[data-theme=\"light\"] select {",
    "  color-scheme: light;",
    "}",
    "",
    ":root[data-theme=\"light\"] ::selection {",
    "  background: rgba(81, 107, 138, 0.18);",
    "  color: #1F1F1D;",
    "}",
  ];
}

function printSummary(inventory, generation) {
  const top = inventory.groups.slice(0, 12);
  console.log(`Scanned ${inventory.scanRoots.join(", ")}`);
  console.log(`Found ${inventory.totalOccurrences} color occurrences across ${inventory.totalUniqueTokens} unique tokens.`);
  console.log(`Wrote ${normalizePath(reportJsonPath)} and ${normalizePath(reportMdPath)}.`);
  if (generation) {
    console.log(`Generated ${normalizePath(generatedCssPath)} with ${generation.rules} light-theme override rules.`);
    console.log(`Wrote ${normalizePath(reportMapPath)} for replacement review.`);
    console.log(`Skipped ${generation.skipped} complex tokens; see the JSON inventory for locations.`);
  }
  console.log("");
  console.log("Top tokens:");
  for (const group of top) {
    const first = group.locations[0];
    console.log(`- ${group.token} (${group.count}) first: ${first.file}:${first.line}`);
  }
}

const inventory = buildInventory();
writeReports(inventory);

if (command === "audit") {
  printSummary(inventory);
} else if (command === "generate-light") {
  const generation = generateLightCss(inventory);
  printSummary(inventory, generation);
} else {
  console.error(`Unknown command "${command}". Use "audit" or "generate-light".`);
  process.exitCode = 1;
}
