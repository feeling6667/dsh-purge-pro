#!/usr/bin/env node
/**
 * dsh-purge 0.2.1 适配版 —— 安装到本机 DSH（桌面端 / Web 端）
 *
 * 用法（在 D:\dsh-purge-0.2.1 目录下）：
 *   node install.mjs desktop          # 装到桌面端 profile
 *   node install.mjs web              # 装到 Web profile
 *   node install.mjs both             # 两个都装
 *   node install.mjs desktop --dry-run  # 只看会改什么，不落盘
 *
 * 做的事：
 *   1. 定位 $DSH_HOME
 *   2. 把本目录复制到 $DSH_HOME/plugins/dsh-purge
 *   3. 备份并改写 $DSH_HOME/profiles/<surface>/package.json：
 *        dependencies["dsh-purge"] = "file:../../plugins/dsh-purge"   ← 关键：切断 GitHub 上游
 *        dsh.profile.bundles 里确保有 "dsh-purge"
 *   4. 在 profile 目录跑 pnpm install
 *   5. 校验装进去的版本是 1.1.72-dsh021
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const SRC = path.dirname(fileURLToPath(import.meta.url));
const PKG_NAME = "dsh-purge";
const DEP_SPEC = "file:../../plugins/dsh-purge";
const WANT_VERSION = "1.1.72-dsh021";

const argv = process.argv.slice(2);
const dryRun = argv.includes("--dry-run");
const target = (argv.find((a) => !a.startsWith("-")) || "desktop").toLowerCase();

const log = (m) => console.log(m);
const ok = (m) => console.log("  [OK]   " + m);
const warn = (m) => console.log("  [注意] " + m);
const die = (m) => { console.error("\n  [失败] " + m + "\n"); process.exit(1); };

function existsDir(p) { try { return fs.statSync(p).isDirectory(); } catch { return false; } }
function existsFile(p) { try { return fs.statSync(p).isFile(); } catch { return false; } }
function stamp() { return new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14); }

/* ---------- 1. 定位 DSH_HOME ---------- */
function resolveDshHome() {
  const cands = [];
  if (process.env.DSH_HOME && process.env.DSH_HOME.trim()) cands.push(process.env.DSH_HOME.trim());
  cands.push(path.join(os.homedir(), ".dsh"));
  cands.push(path.join(SRC, "..", ".dsh"));
  for (const c of cands) {
    const n = path.normalize(c);
    if (existsDir(path.join(n, "profiles"))) return n;
  }
  die("找不到 $DSH_HOME（要一个有 profiles/ 子目录的 .dsh）。\n" +
      "  候选：\n" + cands.map((c) => "    " + c).join("\n") +
      "\n  可用环境变量指定：set DSH_HOME=D:\\path\\to\\.dsh");
}

/* ---------- 2. 定位可用的 node / pnpm ---------- */
function resolvePnpm(dshHome) {
  const rt = path.join(dshHome, "dsh-runtimes");
  const found = [];
  if (existsDir(rt)) {
    for (const d of fs.readdirSync(rt)) {
      const base = path.join(rt, d, "dependencies");
      const node = path.join(base, "node", "bin", "node.exe");
      const pnpm = path.join(base, "pnpm", "bin", "pnpm.cjs");
      if (existsFile(node) && existsFile(pnpm)) found.push({ node, pnpm });
    }
  }
  if (found.length) return { ...found[0], how: "DSH 自带" };
  // 退回 PATH 上的 pnpm
  const which = spawnSync("pnpm", ["--version"], { shell: true, encoding: "utf8" });
  if (which.status === 0) return { node: process.execPath, pnpm: null, how: "PATH 上的 pnpm" };
  return null;
}

function runPnpm(pnpmInfo, cwd) {
  const cmd = pnpmInfo.pnpm ? pnpmInfo.node : "pnpm";
  const args = pnpmInfo.pnpm ? [pnpmInfo.pnpm, "install"] : ["install"];
  log(`\n  > ${path.basename(cmd)} ${args.join(" ")}   (cwd: ${cwd})`);
  const r = spawnSync(cmd, args, { cwd, stdio: "inherit", shell: !pnpmInfo.pnpm });
  return r.status === 0;
}

/* ---------- 3. 复制插件 ---------- */
function copyDir(from, to) {
  fs.rmSync(to, { recursive: true, force: true });
  fs.mkdirSync(to, { recursive: true });
  for (const ent of fs.readdirSync(from, { withFileTypes: true })) {
    if (ent.name === "node_modules" || ent.name === ".git") continue;
    const s = path.join(from, ent.name);
    const d = path.join(to, ent.name);
    if (ent.isDirectory()) copyDir(s, d);
    else if (ent.isFile()) fs.copyFileSync(s, d);
  }
}

/* ---------- 4. 改写 profile package.json ---------- */
function patchProfile(profileDir) {
  const pj = path.join(profileDir, "package.json");
  if (!existsFile(pj)) return { skipped: `没有 ${pj}` };
  const raw = fs.readFileSync(pj, "utf8");
  let doc;
  try { doc = JSON.parse(raw); } catch (e) { return { error: `package.json 不是合法 JSON：${e.message}` }; }

  const before = doc?.dependencies?.[PKG_NAME] ?? "(无)";
  doc.dependencies = doc.dependencies || {};
  doc.dependencies[PKG_NAME] = DEP_SPEC;

  doc.dsh = doc.dsh || {};
  doc.dsh.profile = doc.dsh.profile || {};
  const bundles = Array.isArray(doc.dsh.profile.bundles) ? doc.dsh.profile.bundles : [];
  const hadBundle = bundles.includes(PKG_NAME);
  if (!hadBundle) bundles.push(PKG_NAME);
  doc.dsh.profile.bundles = bundles;

  if (dryRun) return { before, hadBundle, dryRun: true, after: JSON.stringify(doc, null, 2) };

  const bak = `${pj}.bak-dsh021-${stamp()}`;
  fs.copyFileSync(pj, bak);
  // 无 BOM 的 UTF-8，2 空格缩进，结尾换行
  fs.writeFileSync(pj, JSON.stringify(doc, null, 2) + "\n", { encoding: "utf8" });
  return { before, hadBundle, bak };
}

/* ---------- 主流程 ---------- */
const dshHome = resolveDshHome();
const surfaces = target === "both" ? ["desktop", "web"] : [target];
if (!["desktop", "web"].includes(target) && target !== "both") {
  die(`surface 只能是 desktop / web / both，收到：${target}`);
}

log("======================================================");
log(" dsh-purge 0.2.1 适配版  安装程序");
log("======================================================");
log(`  插件源目录 : ${SRC}`);
log(`  DSH_HOME   : ${dshHome}`);
log(`  目标 surface: ${surfaces.join(", ")}`);
if (dryRun) log("  模式       : DRY-RUN（只预览，不落盘）");

const srcPkg = JSON.parse(fs.readFileSync(path.join(SRC, "package.json"), "utf8"));
if (srcPkg.name !== PKG_NAME) die(`源目录 package.json 的 name 必须是 ${PKG_NAME}，实际是 ${srcPkg.name}`);
if (srcPkg.version !== WANT_VERSION) warn(`源版本是 ${srcPkg.version}，脚本期望 ${WANT_VERSION}`);
log(`  源版本     : ${srcPkg.version}   dshTarget: ${srcPkg.dshTarget}`);

const pluginDest = path.join(dshHome, "plugins", PKG_NAME);
const samePlace = path.normalize(SRC).toLowerCase() === path.normalize(pluginDest).toLowerCase();

const pnpmInfo = resolvePnpm(dshHome);
if (!dryRun && !pnpmInfo) die("找不到可用的 pnpm。请确认 DSH 装好过（$DSH_HOME/dsh-runtimes 里有 pnpm），或把 pnpm 放进 PATH。");
if (pnpmInfo) log(`  pnpm       : ${pnpmInfo.how}`);

let failed = 0;

for (const surface of surfaces) {
  const profileDir = path.join(dshHome, "profiles", surface);
  log("\n------------------------------------------------------");
  log(` surface: ${surface}`);
  log("------------------------------------------------------");

  if (!existsDir(profileDir)) { warn(`没有 ${profileDir}，跳过`); continue; }

  /* 1) 放插件 */
  if (samePlace) {
    ok(`插件已在位：${pluginDest}`);
  } else if (dryRun) {
    log(`  [预览] 复制 ${SRC}  ->  ${pluginDest}`);
  } else {
    copyDir(SRC, pluginDest);
    ok(`插件已放：${pluginDest}`);
  }

  /* 2) 改 profile package.json */
  const res = patchProfile(profileDir);
  if (res.error) { warn(res.error); failed += 1; continue; }
  if (res.skipped) { warn(res.skipped); continue; }
  if (res.dryRun) {
    log(`  [预览] dependencies["${PKG_NAME}"]  ${res.before}  ->  ${DEP_SPEC}`);
    log(`  [预览] bundles 里${res.hadBundle ? "已有" : "追加"} "${PKG_NAME}"`);
  } else {
    ok(`package.json 已改：dependencies["${PKG_NAME}"]  ${res.before}  ->  ${DEP_SPEC}`);
    ok(`原文件已备份：${path.basename(res.bak)}`);
    if (!res.hadBundle) ok(`bundles 已追加 "${PKG_NAME}"`);
  }

  /* 3) pnpm install */
  if (dryRun) { log("  [预览] 在该目录跑 pnpm install"); continue; }
  if (!runPnpm(pnpmInfo, profileDir)) { warn("pnpm install 失败，见上面输出"); failed += 1; continue; }
  ok("pnpm install 完成");

  /* 4) 校验 */
  const installedPj = path.join(profileDir, "node_modules", PKG_NAME, "package.json");
  if (!existsFile(installedPj)) {
    warn(`没生成 ${installedPj}`);
    failed += 1;
    continue;
  }
  const ip = JSON.parse(fs.readFileSync(installedPj, "utf8"));
  if (ip.version === WANT_VERSION) ok(`已装入版本：${ip.version}（适配版）`);
  else warn(`已装入版本是 ${ip.version}，不是 ${WANT_VERSION} —— 检查 dependencies 是否真的指向 ${DEP_SPEC}`);

  const core = path.join(profileDir, "node_modules", PKG_NAME, "lib", "core.js");
  if (existsFile(core) && fs.readFileSync(core, "utf8").includes("harness-dev-context")) {
    ok("补丁引擎确认是 0.2.1 适配版（含 harness-dev-context 目标键）");
  } else {
    warn("补丁引擎里没有 0.2.1 适配痕迹，可能装成了上游版本");
  }
}

log("\n======================================================");
if (dryRun) {
  log(" DRY-RUN 结束，没有改任何文件。");
} else if (failed === 0) {
  log(" 安装完成。接下来：");
  log("   1. 完全退出 DSH（桌面端：退托盘；Web：关掉 dsh web）");
  log("   2. 重新打开，点会话标题旁的 dsh-purge -> 清洗 -> 应用");
  log("   3. 应用成功会自动重启；重启后新开一轮对话");
  log("");
  log(" 确认装对了：清洗面板里 #32 / #40 / #53 / #77 应用后应为 applied，");
  log(" 而不是「跳过」。升级前它们是跳过的 —— 这正是本次适配修的东西。");
  log("");
  log(" 提醒：不要点插件里的「更新」，那会从 GitHub 拉回上游 1.1.71。");
} else {
  log(` 有 ${failed} 个 surface 没装成功，看上面的 [注意] / [失败]。`);
}
log("======================================================");
process.exit(failed === 0 ? 0 : 1);
