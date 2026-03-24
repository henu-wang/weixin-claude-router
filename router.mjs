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

  for (const char of q) {
    if (char.length > 0 && clean.includes(char)) score += 3;
    if (char.length > 0 && t.includes(char)) score += 1;
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
  let bestTab = null;
  let bestScore = 0;
  for (const tab of tabs) {
    const score = matchScore(query, tab.name);
    if (score > bestScore) { bestScore = score; bestTab = tab; }
  }
  return bestScore > 0 ? bestTab : null;
}

// ============================================================
// 消息解析
// ============================================================
const PREFIX_RE = /^#(\S+)\s+([\s\S]*)$/;

function parseMessage(text, tabs) {
  const match = text.match(PREFIX_RE);
  if (match) {
    const tag = match[1];
    const actualText = match[2].trim();
    const tab = findBestTab(tag, tabs);
    if (tab) return { tab, actualText, method: "指定" };
    const fallback = findBestTab(text, tabs);
    if (fallback) return { tab: fallback, actualText, method: "智能" };
    return { tab: null, tag, actualText, method: "未找到" };
  }

  const best = findBestTab(text, tabs);
  if (best) return { tab: best, actualText: text, method: "智能" };
  return { tab: tabs[0], actualText: text, method: "默认" };
}

// ============================================================
// 帮助
// ============================================================
function helpText() {
  const tabs = getTabs();
  const lines = [
    "微信 → iTerm2 路由器",
    "",
    "三种发送方式:",
    "  #关键词 指令 → 如 #api 查状态",
    "  直接发指令 → 自动匹配最相关标签页",
    "  匹配不到 → 默认发到第1个标签页",
    "",
    "管理命令:",
    "  /new 命令 — 新开标签页执行命令",
    "  /close 关键词 — 关闭匹配的标签页",
    "  /tabs — 查看所有标签页",
    "  /read 关键词 — 读取标签页输出",
    "  /help — 显示帮助",
    "",
    `当前 ${tabs.length} 个标签页:`,
  ];
  for (const t of tabs) {
    lines.push(`  ${t.index}. ${t.name.replace(/\s*\(.*?\)$/, "").trim()}`);
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
      const list = tabs.map(t => `${t.index}. ${t.name.replace(/\s*\(.*?\)$/, "").trim()}`).join("\n");
      return { text: `${tabs.length} 个标签页:\n${list}` };
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
    const tab = parsed.tab;
    if (!tab) return { text: "没有可用的标签页" };

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
