#!/usr/bin/env node
/**
 * verify-pro.mjs — 证明「仓库里这份代码，在别人机器上跑出来的效果和我这台一样」。
 *
 *   --baseline <pristineAiBase> <patchedAiBase> [--out FILE] [--surface desktop|web]
 *       对 pristine 宿主树跑一遍纯内存 dry-apply，把每个目标文件的最终哈希、每条补丁是否真的落刀、
 *       破甲内核哈希写成基线 JSON；同时和一份真实已清洗树逐文件对比（应当 0 差异）。
 *   --check [--baseline FILE] [--ai-base BASE] [--surface ...]
 *       任意机器上，把当前已清洗的宿主树与基线逐条对比：宿主版本 / 内核哈希 / 每条补丁状态 /
 *       每个目标文件 sha256。全绿 → 效果一致。
 *   --repo [--ref v1.1.72-dsh021] [--dir .]
 *       从 GitHub 拉该 ref 的 tarball，与本目录逐文件比 sha256，证明「上传的 = 本地这份源码」。
 *
 * 只读，不写宿主。退出码：0 全通过 / 1 有差异 / 2 用法错误。
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import zlib from "node:zlib";
import https from "node:https";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const core = await import(new URL("../lib/core.js", import.meta.url).href);

const args = process.argv.slice(2);
const flag = (name, dflt = "") => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : dflt;
};
const mode = ["--baseline", "--check", "--repo"].find((m) => args.includes(m));
const surface = flag("--surface", process.env.DSH_SURFACE || "desktop");
process.env.DSH_SURFACE = surface;

const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
// 仓库里存 LF、Windows 工作区是 CRLF：文本文件先归一化再比，二进制（含 NUL）原样比。
const sha256text = (buf) => (buf.includes(0) ? sha256(buf) : sha256(Buffer.from(buf.toString("utf8").replace(/\r\n/g, "\n"), "utf8")));
const relOf = (base, fp) => {
  const rel = path.relative(base, fp);
  return !rel || rel.startsWith("..") || path.isAbsolute(rel) ? "" : rel.split(path.sep).join("/");
};
const octal = (s) => {
  const t = String(s).replace(/\0.*$/, "").trim();
  return t ? parseInt(t, 8) || 0 : 0;
};

function hostVersions(aiBase) {
  const out = {};
  for (const pkg of ["dsh", "dsh-agent-instructions", "dsh-harness-dev-context"]) {
    try {
      out[pkg] = JSON.parse(fs.readFileSync(path.join(aiBase, pkg, "package.json"), "utf8")).version;
    } catch {
      out[pkg] = null;
    }
  }
  return out;
}

function pluginMeta() {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  let commit = "";
  try {
    commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
  } catch {
    /* tarball 解包时没有 .git */
  }
  return { name: pkg.name, version: pkg.version, dshTarget: pkg.dshTarget, repo: pkg.repository?.url || "", commit };
}

/** aiBase 下的目标文件：key → [fp]，并给出 rel → fp 映射。 */
function collect(aiBase, dshHome) {
  const files = core.targetFiles(aiBase, dshHome);
  const resolved = {};
  const relToFp = new Map();
  for (const [key, val] of Object.entries(files)) {
    const list = Array.isArray(val) ? val : val ? [val] : [];
    resolved[key] = list;
    for (const fp of list) {
      const rel = relOf(aiBase, fp);
      if (rel && !relToFp.has(rel)) relToFp.set(rel, fp);
    }
  }
  return { resolved, relToFp };
}

/** 纯内存 dry-apply：每条补丁落刀几条、碰了哪些文件，以及每个文件最终文本。 */
function dryApply(aiBase, dshHome) {
  const { resolved, relToFp } = collect(aiBase, dshHome);
  const after = new Map();
  for (const fp of relToFp.values()) {
    try {
      after.set(fp, fs.readFileSync(fp, "utf8"));
    } catch {
      after.set(fp, null);
    }
  }
  const patches = [];
  for (const p of core.ALL_PATCHES) {
    if (!core.patchAppliesHere(p, surface)) continue;
    const keys = Array.isArray(p.file) ? p.file : [p.file];
    let changed = 0;
    const touched = new Set();
    for (const key of keys) {
      for (const fp of resolved[key] || []) {
        const text = after.get(fp);
        if (text == null) continue;
        let out;
        try {
          out = core.applyReplacementsToText(text, p, fp);
        } catch {
          continue;
        }
        if (out && out.changed) {
          after.set(fp, out.text);
          changed += 1;
          const rel = relOf(aiBase, fp);
          if (rel) touched.add(rel);
        }
      }
    }
    patches.push({ id: p.id, name: p.name, layer: p.layer, changed, files: [...touched].sort() });
  }
  return { after, patches };
}

// ---------------- baseline ----------------
async function cmdBaseline() {
  const i = args.indexOf("--baseline");
  const pristine = args[i + 1];
  const patched = args[i + 2];
  if (!pristine || !patched || pristine.startsWith("--") || patched.startsWith("--")) {
    console.error("用法: --baseline <pristineAiBase> <patchedAiBase> [--out FILE] [--surface desktop|web]");
    process.exit(2);
  }
  const dshHome = core.findDshHome();
  const dry = dryApply(pristine, dshHome);
  const out = flag("--out", path.join(ROOT, `verification/baseline-dsh${hostVersions(pristine).dsh || "unknown"}.json`));

  const files = {};
  const mismatched = [];
  for (const [fp, text] of dry.after.entries()) {
    if (text == null) continue;
    const rel = relOf(pristine, fp);
    if (!rel) continue;
    const want = sha256(Buffer.from(text, "utf8"));
    files[rel] = want;
    let got = null;
    try {
      got = sha256(fs.readFileSync(path.join(patched, rel.split("/").join(path.sep))));
    } catch {
      got = null;
    }
    if (got !== want) mismatched.push({ rel, dry: want, real: got });
  }

  const status = await core.patchStatus(patched);
  const patches = dry.patches.map((p) => ({ ...p, status_after: status[p.id] || "undef" }));

  const baseline = {
    schema: 1,
    kind: "dsh-purge-effect-baseline",
    createdAt: new Date().toISOString(),
    plugin: pluginMeta(),
    host: { surface, versions: hostVersions(pristine) },
    kernel_sha256: core.defaultOverrideHash(),
    dryRun: {
      patches: patches.length,
      patchesChanged: patches.filter((p) => p.changed > 0).length,
      files: Object.keys(files).length,
    },
    patches,
    files,
    crossCheck: {
      compared: Object.keys(files).length,
      mismatchedCount: mismatched.length,
      sample: mismatched.slice(0, 5).map((m) => m.rel),
    },
  };

  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(baseline, null, 2) + "\n");

  console.log(`baseline → ${out}`);
  console.log(`  插件        ${baseline.plugin.version} @ ${baseline.plugin.commit.slice(0, 7) || "no-git"}`);
  console.log(`  宿主        dsh ${baseline.host.versions.dsh} (surface=${surface})`);
  console.log(`  内核哈希    ${baseline.kernel_sha256}`);
  console.log(`  补丁        ${baseline.dryRun.patches} 条，落刀 ${baseline.dryRun.patchesChanged} 条`);
  console.log(`  目标文件    ${baseline.dryRun.files} 个`);
  console.log(`  与已清洗树逐文件对照: ${mismatched.length} 处不同`);
  for (const m of mismatched.slice(0, 10)) console.log(`    ✗ ${m.rel} dry=${m.dry.slice(0, 12)} real=${m.real ? m.real.slice(0, 12) : "missing"}`);
  process.exit(mismatched.length === 0 ? 0 : 1);
}

// ---------------- check ----------------
async function cmdCheck() {
  const bf = flag("--baseline", path.join(ROOT, "verification/baseline-dsh0.2.1-rc.2.json"));
  const aiBase = flag("--ai-base", core.findAiBase());
  if (!fs.existsSync(bf)) {
    console.error(`找不到基线文件 ${bf}（先在基准机上跑 --baseline）`);
    process.exit(2);
  }
  if (!aiBase) {
    console.error("找不到宿主 @deepseek-ai 目录，用 --ai-base 指定");
    process.exit(2);
  }
  const base = JSON.parse(fs.readFileSync(bf, "utf8"));
  const ver = hostVersions(aiBase);
  const kernel = core.defaultOverrideHash();
  const status = await core.patchStatus(aiBase);

  const rows = [];
  const push = (item, ok, detail) => rows.push({ item, ok, detail });

  if (ver.dsh) push("宿主版本 dsh", ver.dsh === base.host.versions.dsh, `本机 ${ver.dsh} / 基线 ${base.host.versions.dsh}`);
  else push("宿主版本 dsh", true, `本机未提供版本文件，跳过（基线 ${base.host.versions.dsh}）`);
  push("破甲内核哈希", kernel === base.kernel_sha256, `本机 ${kernel.slice(0, 16)}… / 基线 ${base.kernel_sha256.slice(0, 16)}…`);

  let statusBad = 0;
  const badRows = [];
  for (const p of base.patches) {
    const st = status[p.id] || "undef";
    const ok = p.changed > 0 ? st === "applied" || st === "already" : st !== "pending";
    if (!ok) {
      statusBad += 1;
      if (badRows.length < 10) badRows.push(`✗ #${p.id} ${p.name}: 状态 ${st}，基线期望 ${p.changed > 0 ? "applied" : "非 pending"}`);
    }
  }
  push(`补丁状态 ${base.patches.length} 条`, statusBad === 0, statusBad === 0 ? "全部与基线一致" : `${statusBad} 条不一致`);

  let fileBad = 0;
  const shown = [];
  for (const [rel, want] of Object.entries(base.files)) {
    let got = null;
    try {
      got = sha256(fs.readFileSync(path.join(aiBase, rel.split("/").join(path.sep))));
    } catch {
      got = null;
    }
    if (got !== want) {
      fileBad += 1;
      if (shown.length < 10) shown.push(`✗ ${rel} 本机=${got ? got.slice(0, 12) : "缺失"} 基线=${want.slice(0, 12)}`);
    }
  }
  push(`目标文件 ${Object.keys(base.files).length} 个`, fileBad === 0, fileBad === 0 ? "sha256 全部一致" : `${fileBad} 个不一致`);

  console.log(`基线: ${path.relative(ROOT, bf) || bf}  (${base.plugin.version}, ${base.createdAt})`);
  console.log(`宿主: ${aiBase}`);
  console.log("");
  for (const r of rows) console.log(`  ${r.ok ? "✓" : "✗"} ${r.item.padEnd(22)} ${r.detail}`);
  for (const s of [...badRows, ...shown]) console.log(`    ${s}`);
  const failed = rows.filter((r) => !r.ok).length;
  console.log("");
  console.log(failed === 0 ? "结论: PASS — 效果与基线一致。" : `结论: FAIL — ${failed} 项不一致。`);
  process.exit(failed === 0 ? 0 : 1);
}

// ---------------- repo ----------------
function tarEntries(buf) {
  const out = new Map();
  let off = 0;
  let longName = "";
  while (off + 512 <= buf.length) {
    const hdr = buf.subarray(off, off + 512);
    if (hdr.every((b) => b === 0)) break;
    const name = hdr.subarray(0, 100).toString("utf8").replace(/\0.*$/, "");
    const size = octal(hdr.subarray(124, 136).toString("latin1"));
    const type = String.fromCharCode(hdr[156] || 48);
    const prefix = hdr.subarray(345, 500).toString("utf8").replace(/\0.*$/, "");
    const data = buf.subarray(off + 512, off + 512 + size);
    if (type === "L") longName = data.toString("utf8").replace(/\0.*$/, "");
    else if (type === "0" || type === "\0" || type === "7") {
      out.set(longName || (prefix ? `${prefix}/${name}` : name), data);
      longName = "";
    }
    off += 512 + Math.ceil(size / 512) * 512;
  }
  return out;
}

function get(url, hops = 0) {
  return new Promise((resolve, reject) => {
    if (hops > 5) return reject(new Error("too many redirects"));
    https.get(url, { headers: { "user-agent": "dsh-purge-verify" } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(get(res.headers.location, hops + 1));
      }
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode} ${url}`));
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks)));
    }).on("error", reject);
  });
}

async function cmdRepo() {
  const ref = flag("--ref", "");
  const dir = path.resolve(flag("--dir", ROOT));
  const meta = pluginMeta();
  const repo = (process.env.PURGE_REPO || "feeling6667/dsh-purge-pro").trim();
  // 默认比对当前 HEAD 的 commit：codeload 对 master/tag 这类可变 ref 有 CDN 缓存，会对不上刚推上去的改动。
  const refName = ref || (meta.commit ? meta.commit : "master");
  const url = `https://codeload.github.com/${repo}/tar.gz/${refName}`;
  console.log(`拉取 ${url}`);
  const entries = tarEntries(zlib.gunzipSync(await get(url)));
  const remote = new Map();
  for (const [name, data] of entries) {
    const rel = name.split("/").slice(1).join("/");
    if (!rel) continue;
    remote.set(rel, sha256text(data));
  }
  const local = new Map();
  const skip = new Set([".git", "node_modules"]);
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (skip.has(e.name)) continue;
      const fp = path.join(d, e.name);
      if (e.isDirectory()) walk(fp);
      else if (e.isFile()) local.set(path.relative(dir, fp).split(path.sep).join("/"), sha256text(fs.readFileSync(fp)));
    }
  };
  walk(dir);
  const diff = [...remote.keys()].filter((k) => local.has(k) && local.get(k) !== remote.get(k));
  const onlyRemote = [...remote.keys()].filter((k) => !local.has(k));
  const onlyLocal = [...local.keys()].filter((k) => !remote.has(k));
  console.log(`ref=${refName} 远端=${remote.size} 本地=${local.size}`);
  for (const k of diff.slice(0, 10)) console.log(`  ✗ 内容不同 ${k}`);
  for (const k of onlyRemote.slice(0, 10)) console.log(`  ✗ 远端有本地无 ${k}`);
  for (const k of onlyLocal.slice(0, 10)) console.log(`  · 本地有远端无（未入库，正常） ${k}`);
  const bad = diff.length + onlyRemote.length;
  console.log("");
  console.log(bad === 0
    ? `结论: PASS — 远端 ${refName} 与本地源码逐文件一致（${remote.size} 个文件）。`
    : `结论: FAIL — ${diff.length} 个内容不同、${onlyRemote.length} 个远端多出。`);
  process.exit(bad === 0 ? 0 : 1);
}

if (mode === "--baseline") await cmdBaseline();
else if (mode === "--check") await cmdCheck();
else if (mode === "--repo") await cmdRepo();
else {
  console.log(`用法:
  node scripts/verify-pro.mjs --baseline <pristineAiBase> <patchedAiBase> [--out FILE] [--surface desktop|web]
  node scripts/verify-pro.mjs --check [--baseline FILE] [--ai-base BASE]
  node scripts/verify-pro.mjs --repo [--ref v1.1.72-dsh021] [--dir REL]`);
  process.exit(2);
}
