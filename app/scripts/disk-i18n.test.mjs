import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getLang, setLang } from "../src/i18n.js";
import { DISK_ZH, dt } from "../src/disk/i18n.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const diskRoot = path.join(root, "src", "disk");

function sourceFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(file);
    return /\.(?:tsx?|jsx?)$/.test(entry.name) && entry.name !== "i18n.js" ? [file] : [];
  });
}

function literalKeys(source) {
  const keys = [];
  for (const match of source.matchAll(/\bdt\(\s*/g)) {
    const start = match.index + match[0].length;
    if (source[start] !== '"') continue;
    let end = start + 1;
    for (; end < source.length; end++) {
      if (source[end] !== '"') continue;
      let slashes = 0;
      for (let i = end - 1; i > start && source[i] === "\\"; i--) slashes++;
      if (slashes % 2 === 0) break;
    }
    try {
      keys.push(JSON.parse(source.slice(start, end + 1)));
    } catch {
      // A non-literal or unusually formatted call is checked by the production build.
    }
  }
  return keys;
}

function placeholders(text) {
  return [...text.matchAll(/\{([^{}]+)\}/g)].map((match) => match[1]).sort();
}

test("磁盘静态文案均有中文翻译，且插值参数一致", () => {
  const missing = [];
  for (const file of sourceFiles(diskRoot)) {
    for (const key of literalKeys(fs.readFileSync(file, "utf8"))) {
      if (!/[A-Za-z]/.test(key)) continue;
      if (!(key in DISK_ZH)) missing.push(`${path.relative(root, file)}: ${JSON.stringify(key)}`);
    }
  }
  assert.deepEqual(missing, []);

  for (const [english, chinese] of Object.entries(DISK_ZH)) {
    assert.ok(chinese.length > 0, `空翻译: ${english}`);
    assert.deepEqual(placeholders(chinese), placeholders(english), `插值不一致: ${english}`);
  }
});

test("磁盘词典没有重复键", () => {
  const seen = new Map();
  const duplicates = [];
  fs.readFileSync(path.join(diskRoot, "i18n.js"), "utf8").split(/\r?\n/).forEach((line, index) => {
    const match = line.match(/^  (".*"):/);
    if (!match) return;
    const key = JSON.parse(match[1]);
    if (seen.has(key)) duplicates.push(`${key} (${seen.get(key)}, ${index + 1})`);
    else seen.set(key, index + 1);
  });
  assert.deepEqual(duplicates, []);
});

test("磁盘文案跟随全局语言切换并填充参数", () => {
  const original = getLang();
  try {
    setLang("en");
    assert.equal(dt("Overview"), "Overview");
    assert.equal(dt("{n} files", { n: 3 }), "3 files");
    setLang("zh");
    assert.equal(dt("Overview"), "概览");
    assert.equal(dt("{n} files", { n: 3 }), "3 个文件");
  } finally {
    setLang(original);
  }
});
