import { login, start } from "weixin-agent-sdk";
import { execSync, execFileSync } from "child_process";
import fs from "fs";
import path from "path";
import os from "os";

// ============================================================
// AppleScript 执行（写临时文件避免引号转义问题）
// ============================================================
function runAppleScript(script) {
  const tmp = path.join(os.tmpdir(), `iterm_${Date.now()}.scpt`);
  try {
    fs.writeFileSync(tmp, script, "utf-8");
    const result = execFileSync("osascript", [tmp], {
      encoding: "utf-8",
      maxBuffer: 2 * 1024 * 1024,
      timeout: 10000,
    }).trim();
    return result;
  } catch (e) {
    console.error("[iterm] error:", e.message?.slice(0, 200));
    return null;
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
}

// ============================================================
// 标签页别名（持久化到 ~/.iterm-tab-aliases.json）
// ============================================================
const ALIAS_FILE = path.join(os.homedir(), ".iterm-tab-aliases.json");

function loadAliases() {
  try {
    return JSON.parse(fs.readFileSync(ALIAS_FILE, "utf-8"));
  } catch {
    return {};
  }
}

function saveAliases(aliases) {
  fs.writeFileSync(ALIAS_FILE, JSON.stringify(aliases, null, 2), "utf-8");
}

function setAlias(name, tabIndex) {
  const aliases = loadAliases();
  aliases[name.toLowerCase()] = tabIndex;
  saveAliases(aliases);
}

function removeAlias(name) {
  const aliases = loadAliases();
  const key = name.toLowerCase();
  if (key in aliases) {
    delete aliases[key];
    saveAliases(aliases);
    return true;
  }
  return false;
}

// ============================================================
// iTerm2 操作
// ============================================================

function getTabs() {
  const raw = runAppleScript(`
tell application "iTerm2"
  set output to ""
  set idx to 1
  tell first window
    repeat with t in tabs
      repeat with s in sessions of t
        set output to output & idx & "|" & name of s & linefeed
        set idx to idx + 1
      end repeat
    end repeat
  end tell
  return output
end tell
`);
  if (!raw) return [];
  return raw.split("\n").filter(Boolean).map(line => {
    const [idx, ...rest] = line.split("|");
    return { index: parseInt(idx), name: rest.join("|") };
  });
}

function sendToTab(tabName, text) {
  const tabs = getTabs();
  const tab = tabs.find(t => t.name === tabName);
  if (!tab) return false;
  return runAppleScript(`
tell application "iTerm2"
  tell first window
    set idx to 1
    repeat with t in tabs
      repeat with s in sessions of t
        if idx is ${tab.index} then
          tell s to write text ${JSON.stringify(text)}
          return "sent"
        end if
        set idx to idx + 1
      end repeat
    end repeat
  end tell
  return "not_found"
end tell
`) === "sent";
}

function captureTab(tabName, lines = 50) {
  const tabs = getTabs();
  const tab = tabs.find(t => t.name === tabName);
  if (!tab) return "(标签页不存在)";
  const raw = runAppleScript(`
tell application "iTerm2"
  tell first window
    set idx to 1
    repeat with t in tabs
      repeat with s in sessions of t
        if idx is ${tab.index} then
          tell s to return contents
        end if
        set idx to idx + 1
      end repeat
    end repeat
  end tell
  return ""
end tell
`);
  if (!raw) return "(无法读取)";
  return raw.split("\n").slice(-lines).join("\n").trim();
}

function newTab(command) {
  return runAppleScript(`
tell application "iTerm2"
  tell first window
    set newTab to (create tab with default profile)
    tell current session of newTab
      write text ${JSON.stringify(command)}
    end tell
  end tell
  return "created"
end tell
`) === "created";
}

function closeTab(keyword) {
  const tabs = getTabs();
  const tab = findBestTab(keyword, tabs);
  if (!tab) return "not_found";
  return runAppleScript(`
tell application "iTerm2"
  tell first window
    set idx to 1
    repeat with t in tabs
      repeat with s in sessions of t
        if idx is ${tab.index} then
          tell s to close
          return "closed"
        end if
        set idx to idx + 1
      end repeat
    end repeat
  end tell
  return "not_found"
end tell
`);
}

// ============================================================
// 智能匹配
// ============================================================

// 最低匹配分数阈值：低于此分数视为"未匹配"，避免误路由
const MIN_MATCH_SCORE = 15;

function cleanTabName(name) {
  return name.replace(/\s*\(.*?\)\s*$/, "").trim().toLowerCase();
}

function matchScore(query, tabName) {
  const q = query.toLowerCase();
  const t = tabName.toLowerCase();
  const clean = cleanTabName(tabName);
  let score = 0;

  if (q === clean) return 1000;
  if (clean.includes(q)) score += q.length * 10;
  if (t.includes(q)) score += q.length * 8;
  if (q.includes(clean) && clean.length > 0) score += clean.length * 8;

  // 单字符匹配权重降低（中文单字匹配容易误触）
  for (const char of q) {
    if (char.length > 0 && clean.includes(char)) score += 1;
  }

  let maxSubLen = 0;
  for (let i = 0; i < q.length; i++) {
    for (let j = i + 1; j <= q.length; j++) {
      const sub = q.slice(i, j);
      if (clean.includes(sub) && sub.length > maxSubLen) maxSubLen = sub.length;
    }
  }
  score += maxSubLen * 5;

  const qWords = q.split(/[\s,，。！？、#@]+/).filter(w => w.length > 0);
  for (const word of qWords) {
    if (clean.includes(word)) score += word.length * 4;
    if (t.includes(word)) score += word.length * 2;
  }

  const tWords = clean.split(/[\s/\\|_-]+/).filter(w => w.length > 0);
  for (const word of tWords) {
    if (q.includes(word)) score += word.length * 4;
  }

  return score;
}

function findBestTab(query, tabs) {
  if (!query || tabs.length === 0) return null;

  // 优先匹配别名（精确匹配，最高优先级）
  const aliases = loadAliases();
  const qLower = query.toLowerCase().trim();
  // 完整匹配别名
  if (qLower in aliases) {
    const aliasTab = tabs.find(t => t.index === aliases[qLower]);
    if (aliasTab) return aliasTab;
  }
  // query 中包含别名关键词（如 "#社媒 发一条" 中的 "社媒"）
  for (const [alias, idx] of Object.entries(aliases)) {
    if (qLower.includes(alias)) {
      const aliasTab = tabs.find(t => t.index === idx);
      if (aliasTab) return aliasTab;
    }
  }

  let bestTab = null;
  let bestScore = 0;
  for (const tab of tabs) {
    const score = matchScore(query, tab.name);
    if (score > bestScore) { bestScore = score; bestTab = tab; }
  }
  // 必须超过最低阈值才视为有效匹配
  return bestScore >= MIN_MATCH_SCORE ? bestTab : null;
}

// ============================================================
// 元查询检测 — 识别"关于标签页本身"的查询
// ============================================================

const META_PATTERNS = [
  /每个.*标签/,
  /所有.*标签/,
  /标签.*都.*干/,
  /标签.*状态/,
  /标签.*在.*做/,
  /标签.*干.*啥/,
  /标签.*干.*嘛/,
  /在干啥/,
  /在干嘛/,
  /在做什么/,
  /都在.*干/,
  /都在.*做/,
  /汇总/,
  /总览/,
  /概览/,
  /all\s*tabs/i,
  /what.*tabs.*doing/i,
  /status\s*all/i,
  /overview/i,
];

function isMetaQuery(text) {
  return META_PATTERNS.some(p => p.test(text));
}

function summarizeAllTabs(tabs, linesPerTab = 8) {
  if (tabs.length === 0) return "iTerm2 没有打开的标签页。";
  const parts = [`共 ${tabs.length} 个标签页:\n`];
  for (const tab of tabs) {
    const displayName = tab.name.replace(/\s*\(.*?\)$/, "").trim();
    const output = captureTab(tab.name, linesPerTab);
    const lastLine = output.split("\n").filter(Boolean).slice(-3).join("\n") || "(空)";
    parts.push(`━━ ${tab.index}. ${displayName} ━━\n${lastLine}\n`);
  }
  const result = parts.join("\n");
  const maxLen = 2000;
  return result.length > maxLen ? result.slice(0, maxLen) + "\n...(截断)" : result;
}

// ============================================================
// 消息解析
// ============================================================

function parseMessage(text, tabs) {
  // 元查询：问的是标签页本身，不路由到任何标签
  if (isMetaQuery(text)) {
    return { tab: null, actualText: text, method: "元查询" };
  }

  const aliases = loadAliases();

  // 1) 序号开头: "4 发一条" → 标签4，发送"发一条"
  const numMatch = text.match(/^(\d+)\s+([\s\S]+)$/);
  if (numMatch) {
    const idx = parseInt(numMatch[1]);
    const rest = numMatch[2].trim();
    const tab = tabs.find(t => t.index === idx);
    if (tab) return { tab, actualText: rest, method: "序号" };
  }

  // 2) 别名开头: "社媒 发一条" → 匹配别名"社媒"，发送"发一条"
  //    按别名长度降序匹配，避免短别名误吃长别名
  const sortedAliases = Object.entries(aliases).sort((a, b) => b[0].length - a[0].length);
  const textLower = text.toLowerCase();
  for (const [alias, idx] of sortedAliases) {
    // 别名在开头，后面跟空格+内容
    if (textLower.startsWith(alias) && text.length > alias.length) {
      const after = text.slice(alias.length);
      // 别名后必须是空格/标点，不能是别名的一部分
      if (/^[\s,，。！？、:：]/.test(after)) {
        const rest = after.replace(/^[\s,，。！？、:：]+/, "").trim();
        const tab = tabs.find(t => t.index === idx);
        if (tab && rest) return { tab, actualText: rest, method: "别名" };
      }
    }
    // 完整匹配别名（只发别名本身 → 读取该标签输出）
    if (textLower === alias) {
      const tab = tabs.find(t => t.index === idx);
      if (tab) {
        const output = captureTab(tab.name, 15);
        const display = tab.name.replace(/\s*\(.*?\)$/, "").trim();
        const trimmed = output.length > 1500 ? output.slice(-1500) + "\n...(截断)" : output;
        return { tab: null, actualText: text, method: "别名查看", prebuiltReply: `[${display}] 最近输出:\n${trimmed}` };
      }
    }
  }

  // 3) 智能匹配（模糊匹配标签名或别名）
  const best = findBestTab(text, tabs);
  if (best) return { tab: best, actualText: text, method: "智能" };

  // 4) 无法匹配
  return { tab: null, actualText: text, method: "未匹配" };
}

// ============================================================
// 帮助
// ============================================================
function helpText() {
  const tabs = getTabs();
  const aliases = loadAliases();
  const lines = [
    "微信 → iTerm2 路由器",
    "",
    "发送方式:",
    "  别名 指令 → 如: 社媒 发一条",
    "  序号 指令 → 如: 4 发一条",
    "  直接发指令 → 自动匹配最相关标签页",
    "  只发别名 → 查看该标签最近输出",
    "",
    "管理命令:",
    "  /status — 查看所有标签最近输出",
    "  /tabs — 查看所有标签页",
    "  /read 关键词 — 读取某个标签输出",
    "  /read — 读取所有标签输出",
    "  /name 序号 名称 — 给标签命名",
    "  /unname 名称 — 删除别名",
    "  /new 命令 — 新开标签页执行命令",
    "  /close 关键词 — 关闭匹配的标签页",
    "  /help — 显示帮助",
    "",
    `当前 ${tabs.length} 个标签页:`,
  ];
  for (const t of tabs) {
    const display = t.name.replace(/\s*\(.*?\)$/, "").trim();
    const alias = Object.entries(aliases).find(([, idx]) => idx === t.index);
    const aliasStr = alias ? ` [${alias[0]}]` : "";
    lines.push(`  ${t.index}. ${display}${aliasStr}`);
  }
  return lines.join("\n");
}

// ============================================================
// 路由 Agent
// ============================================================
const WAIT_MS = parseInt(process.env.WAIT_MS || "15000");

const routingAgent = {
  async chat(request) {
    const text = (request.text || "").trim();
    if (!text) return { text: helpText() };

    if (text === "/help" || text === "帮助") return { text: helpText() };

    if (text === "/tabs" || text === "标签") {
      const tabs = getTabs();
      const aliases = loadAliases();
      const list = tabs.map(t => {
        const display = t.name.replace(/\s*\(.*?\)$/, "").trim();
        const alias = Object.entries(aliases).find(([, idx]) => idx === t.index);
        const aliasStr = alias ? ` [${alias[0]}]` : "";
        return `${t.index}. ${display}${aliasStr}`;
      }).join("\n");
      return { text: `${tabs.length} 个标签页:\n${list}` };
    }

    // /status — 查看所有标签页最近输出摘要
    if (/^\/status$/i.test(text) || text === "状态") {
      const tabs = getTabs();
      return { text: summarizeAllTabs(tabs) };
    }

    // /read (无参数) — 也当作查看所有标签
    if (text === "/read" || text === "/readall") {
      const tabs = getTabs();
      return { text: summarizeAllTabs(tabs) };
    }

    const newMatch = text.match(/^\/new\s+(.+)$/s);
    if (newMatch) {
      const cmd = newMatch[1].trim();
      const ok = newTab(cmd);
      return { text: ok ? `已新建标签页，执行: ${cmd}` : "新建标签页失败" };
    }

    const closeMatch = text.match(/^\/close\s+#?(.+)$/);
    if (closeMatch) {
      const keyword = closeMatch[1].trim();
      const result = closeTab(keyword);
      return { text: result === "closed" ? `已关闭匹配「${keyword}」的标签页` : `找不到匹配「${keyword}」的标签页` };
    }

    // /name 序号 名称 — 给标签页设别名
    const nameMatch = text.match(/^\/name\s+(\d+)\s+(.+)$/);
    if (nameMatch) {
      const idx = parseInt(nameMatch[1]);
      const alias = nameMatch[2].trim();
      const tabs = getTabs();
      const tab = tabs.find(t => t.index === idx);
      if (!tab) return { text: `标签页 #${idx} 不存在。用 /tabs 查看。` };
      setAlias(alias, idx);
      const display = tab.name.replace(/\s*\(.*?\)$/, "").trim();
      return { text: `✓ 标签页 #${idx} (${display}) 已命名为「${alias}」\n\n之后可用 #${alias} 指令 来路由。` };
    }

    // /unname 名称 — 删除别名
    const unnameMatch = text.match(/^\/unname\s+(.+)$/);
    if (unnameMatch) {
      const alias = unnameMatch[1].trim();
      const ok = removeAlias(alias);
      return { text: ok ? `✓ 已删除别名「${alias}」` : `别名「${alias}」不存在` };
    }

    const readMatch = text.match(/^\/read\s+#?(.+)$/);
    if (readMatch) {
      const keyword = readMatch[1].trim();
      const tabs = getTabs();
      const tab = findBestTab(keyword, tabs);
      if (!tab) return { text: `找不到匹配「${keyword}」的标签页` };
      const output = captureTab(tab.name, 50);
      const clean = tab.name.replace(/\s*\(.*?\)$/, "").trim();
      const maxLen = 2000;
      const trimmed = output.length > maxLen ? output.slice(-maxLen) + "\n...(截断)" : output;
      return { text: `[${clean}] 最近输出:\n${trimmed}` };
    }

    // --- 路由消息 ---
    const tabs = getTabs();
    if (tabs.length === 0) return { text: "iTerm2 没有打开的标签页。用 /new 命令新建。" };

    const parsed = parseMessage(text, tabs);

    // 元查询：返回所有标签摘要
    if (parsed.method === "元查询") {
      console.log(`[router] [元查询] ← ${text.slice(0, 80)}`);
      return { text: summarizeAllTabs(tabs) };
    }

    // 别名查看：只发了别名本身，返回该标签输出
    if (parsed.prebuiltReply) {
      return { text: parsed.prebuiltReply };
    }

    // 未匹配：提示用户
    if (!parsed.tab) {
      const aliases = loadAliases();
      const list = tabs.map(t => {
        const display = t.name.replace(/\s*\(.*?\)$/, "").trim();
        const alias = Object.entries(aliases).find(([, idx]) => idx === t.index);
        return `  ${t.index}. ${display}${alias ? ` [${alias[0]}]` : ""}`;
      }).join("\n");
      return {
        text: [
          "未匹配到标签页，请指定目标:",
          "",
          `当前 ${tabs.length} 个标签页:`,
          list,
          "",
          "用法:",
          "  别名 指令 — 如: 社媒 发一条",
          "  序号 指令 — 如: 4 发一条",
          "  /status — 查看所有标签最近输出",
        ].join("\n"),
      };
    }

    const tab = parsed.tab;
    const displayName = tab.name.replace(/\s*\(.*?\)$/, "").trim();
    console.log(`[router] [${parsed.method}] → [${displayName}] ← ${parsed.actualText.slice(0, 80)}`);

    const sent = sendToTab(tab.name, parsed.actualText);
    if (!sent) return { text: `发送失败，[${displayName}] 可能已关闭。` };

    console.log(`[router] 等 ${WAIT_MS / 1000}s 截取输出...`);
    await new Promise(r => setTimeout(r, WAIT_MS));

    const output = captureTab(tab.name, 40);
    const maxLen = 2000;
    const trimmed = output.length > maxLen ? output.slice(-maxLen) + "\n...(截断)" : output;
    return { text: `[${displayName}] ✓ (${parsed.method})\n\n${trimmed}` };
  },
};

// ============================================================
// 启动
// ============================================================
const ac = new AbortController();
process.on("SIGINT", () => { ac.abort(); process.exit(0); });

console.log("=".repeat(50));
console.log("[router] 微信 → iTerm2 Claude Code 路由器");
console.log("=".repeat(50));
const tabs = getTabs();
console.log(`[router] 发现 ${tabs.length} 个标签页:`);
for (const t of tabs) console.log(`  ${t.index}. ${t.name.replace(/\s*\(.*?\)$/, "").trim()}`);
console.log(`[router] 输出等待: ${WAIT_MS / 1000}s`);
console.log("=".repeat(50));

const accountIndex = path.join(os.homedir(), ".openclaw", "openclaw-weixin", "accounts.json");
let needLogin = true;
try {
  const ids = JSON.parse(fs.readFileSync(accountIndex, "utf-8"));
  if (Array.isArray(ids) && ids.length > 0) {
    console.log(`[router] 检测到已登录账号: ${ids[0]}，跳过扫码`);
    needLogin = false;
  }
} catch {}

if (needLogin) {
  console.log("[router] 未检测到登录凭证，需要扫码...");
  await login();
}
await start(routingAgent, { abortSignal: ac.signal });
