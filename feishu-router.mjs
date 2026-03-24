import * as Lark from "@larksuiteoapi/node-sdk";
import { execSync, execFileSync } from "child_process";
import { writeFileSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// ============================================================
// 飞书应用配置
// ============================================================
const APP_ID = process.env.FEISHU_APP_ID || "";
const APP_SECRET = process.env.FEISHU_APP_SECRET || "";

const client = new Lark.Client({ appId: APP_ID, appSecret: APP_SECRET });

// ============================================================
// AppleScript 执行（写临时文件避免引号转义问题）
// ============================================================
function runAppleScript(script) {
  const tmp = join(tmpdir(), `iterm_${Date.now()}.scpt`);
  try {
    writeFileSync(tmp, script, "utf-8");
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
    try { unlinkSync(tmp); } catch {}
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
  // 用索引方式发送更可靠
  const tabs = getTabs();
  const tab = tabs.find(t => t.name === tabName);
  if (!tab) return false;

  const script = `
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
`;
  return runAppleScript(script) === "sent";
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
  const allLines = raw.split("\n");
  return allLines.slice(-lines).join("\n").trim();
}

function newTab(command) {
  const script = `
tell application "iTerm2"
  tell first window
    set newTab to (create tab with default profile)
    tell current session of newTab
      write text ${JSON.stringify(command)}
    end tell
  end tell
  return "created"
end tell
`;
  return runAppleScript(script) === "created";
}

function closeTab(keyword) {
  // 先智能找到标签页
  const tabs = getTabs();
  const tab = findBestTab(keyword, tabs);
  if (!tab) return "not_found";

  const script = `
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
`;
  return runAppleScript(script);
}

// ============================================================
// 智能匹配（大幅升级版）
// ============================================================

// 清理标签页名称：去掉进程信息 (node) (ssh) 等
function cleanTabName(name) {
  return name.replace(/\s*\(.*?\)\s*$/, "").trim().toLowerCase();
}

// 计算两个字符串的相似度分数
function matchScore(query, tabName) {
  const q = query.toLowerCase();
  const t = tabName.toLowerCase();
  const clean = cleanTabName(tabName);
  let score = 0;

  // 1. 完全匹配（最高分）
  if (q === clean) return 1000;

  // 2. 标签名包含整个查询词
  if (clean.includes(q)) score += q.length * 10;
  if (t.includes(q)) score += q.length * 8;

  // 3. 查询词包含整个标签名
  if (q.includes(clean) && clean.length > 0) score += clean.length * 8;

  // 4. 逐字符匹配（中文友好）— 查询中的每个字符在标签名中出现
  for (const char of q) {
    if (char.length > 0 && clean.includes(char)) score += 3;
    if (char.length > 0 && t.includes(char)) score += 1;
  }

  // 5. 连续子串匹配 — 找最长公共子串
  let maxSubLen = 0;
  for (let i = 0; i < q.length; i++) {
    for (let j = i + 1; j <= q.length; j++) {
      const sub = q.slice(i, j);
      if (clean.includes(sub) && sub.length > maxSubLen) {
        maxSubLen = sub.length;
      }
    }
  }
  score += maxSubLen * 5;

  // 6. 分词匹配（空格、逗号等分割）
  const qWords = q.split(/[\s,，。！？、#@]+/).filter(w => w.length > 0);
  for (const word of qWords) {
    if (clean.includes(word)) score += word.length * 4;
    if (t.includes(word)) score += word.length * 2;
  }

  // 7. 标签名分词在查询中出现
  const tWords = clean.split(/[\s/\\|_-]+/).filter(w => w.length > 0);
  for (const word of tWords) {
    if (q.includes(word)) score += word.length * 4;
  }

  return score;
}

// 找到最佳匹配的标签页
function findBestTab(query, tabs) {
  if (!query || tabs.length === 0) return null;

  let bestTab = null;
  let bestScore = 0;

  for (const tab of tabs) {
    const score = matchScore(query, tab.name);
    if (score > bestScore) {
      bestScore = score;
      bestTab = tab;
    }
  }

  // 只要有任何得分就返回（门槛极低）
  return bestScore > 0 ? bestTab : null;
}

// ============================================================
// 消息解析（更宽松的匹配）
// ============================================================
const PREFIX_RE = /^#(\S+)\s+([\s\S]*)$/;

function parseMessage(text, tabs) {
  // #关键词 指令
  const match = text.match(PREFIX_RE);
  if (match) {
    const tag = match[1];
    const actualText = match[2].trim();
    const tab = findBestTab(tag, tabs);
    if (tab) return { tab, actualText, method: "指定" };
    // tag 匹配不到，把整个文本智能匹配
    const fallback = findBestTab(text, tabs);
    if (fallback) return { tab: fallback, actualText, method: "智能" };
    return { tab: null, tag, actualText, method: "未找到" };
  }

  // 无前缀 → 智能匹配
  const best = findBestTab(text, tabs);
  if (best) return { tab: best, actualText: text, method: "智能" };

  // 完全匹配不到 → 默认第一个标签页
  return { tab: tabs[0], actualText: text, method: "默认" };
}

// ============================================================
// 帮助
// ============================================================
function helpText() {
  const tabs = getTabs();
  const lines = [
    "飞书 → iTerm2 路由器",
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
    const clean = t.name.replace(/\s*\(.*?\)$/, "").trim();
    lines.push(`  ${t.index}. ${clean}`);
  }
  return lines.join("\n");
}

// ============================================================
// 发飞书回复
// ============================================================
async function reply(messageId, text) {
  const maxLen = 4000;
  const trimmed = text.length > maxLen ? text.slice(-maxLen) + "\n...(截断)" : text;
  try {
    await client.im.message.reply({
      path: { message_id: messageId },
      data: {
        content: JSON.stringify({ text: trimmed }),
        msg_type: "text",
      },
    });
  } catch (e) {
    console.error("[feishu] reply error:", e.message);
  }
}

async function sendMsg(chatId, text) {
  const maxLen = 4000;
  const trimmed = text.length > maxLen ? text.slice(-maxLen) + "\n...(截断)" : text;
  try {
    await client.im.message.create({
      params: { receive_id_type: "chat_id" },
      data: {
        receive_id: chatId,
        content: JSON.stringify({ text: trimmed }),
        msg_type: "text",
      },
    });
  } catch (e) {
    console.error("[feishu] send error:", e.message);
  }
}

// ============================================================
// 处理消息
// ============================================================
const WAIT_MS = parseInt(process.env.WAIT_MS || "15000");

async function handleMessage(data) {
  const { message } = data;
  const messageId = message.message_id;
  const chatId = message.chat_id;
  const msgType = message.message_type;

  if (msgType !== "text") {
    await reply(messageId, "只支持文本消息");
    return;
  }

  let text;
  try {
    text = JSON.parse(message.content).text?.trim();
  } catch {
    text = "";
  }

  if (!text) {
    await reply(messageId, helpText());
    return;
  }

  // --- 特殊命令 ---
  if (text === "/help" || text === "帮助") {
    await reply(messageId, helpText());
    return;
  }

  if (text === "/tabs" || text === "标签") {
    const tabs = getTabs();
    const list = tabs.map(t => {
      const clean = t.name.replace(/\s*\(.*?\)$/, "").trim();
      return `${t.index}. ${clean}`;
    }).join("\n");
    await reply(messageId, `${tabs.length} 个标签页:\n${list}`);
    return;
  }

  // /new 命令
  const newMatch = text.match(/^\/new\s+(.+)$/s);
  if (newMatch) {
    const cmd = newMatch[1].trim();
    const ok = newTab(cmd);
    await reply(messageId, ok ? `已新建标签页，执行: ${cmd}` : "新建标签页失败");
    return;
  }

  // /close 命令
  const closeMatch = text.match(/^\/close\s+#?(.+)$/);
  if (closeMatch) {
    const keyword = closeMatch[1].trim();
    const result = closeTab(keyword);
    await reply(messageId, result === "closed" ? `已关闭匹配「${keyword}」的标签页` : `找不到匹配「${keyword}」的标签页`);
    return;
  }

  // /read 命令
  const readMatch = text.match(/^\/read\s+#?(.+)$/);
  if (readMatch) {
    const keyword = readMatch[1].trim();
    const tabs = getTabs();
    const tab = findBestTab(keyword, tabs);
    if (!tab) {
      await reply(messageId, `找不到匹配「${keyword}」的标签页`);
      return;
    }
    const output = captureTab(tab.name, 50);
    const clean = tab.name.replace(/\s*\(.*?\)$/, "").trim();
    await reply(messageId, `[${clean}] 最近输出:\n${output}`);
    return;
  }

  // --- 路由消息 ---
  const tabs = getTabs();
  if (tabs.length === 0) {
    await reply(messageId, "iTerm2 没有打开的标签页。用 /new 命令新建。");
    return;
  }

  const parsed = parseMessage(text, tabs);
  const tab = parsed.tab;

  if (!tab) {
    await reply(messageId, "没有可用的标签页");
    return;
  }

  const displayName = tab.name.replace(/\s*\(.*?\)$/, "").trim();

  console.log(`[feishu] [${parsed.method}] → [${displayName}] ← ${parsed.actualText.slice(0, 80)}`);

  const sent = sendToTab(tab.name, parsed.actualText);
  if (!sent) {
    await reply(messageId, `发送失败，[${displayName}] 可能已关闭。`);
    return;
  }

  // 立即回复确认
  await reply(messageId, `→ [${displayName}] (${parsed.method}) 已发送，${WAIT_MS / 1000}s后返回输出...`);

  // 等待后截取输出
  await new Promise(r => setTimeout(r, WAIT_MS));

  const output = captureTab(tab.name, 40);
  await sendMsg(chatId, `[${displayName}] 输出:\n${output}`);
}

// ============================================================
// 启动
// ============================================================
const wsClient = new Lark.WSClient({
  appId: APP_ID,
  appSecret: APP_SECRET,
  loggerLevel: Lark.LoggerLevel.info,
});

console.log("=".repeat(50));
console.log("[feishu] 飞书 → iTerm2 Claude Code 路由器");
console.log("=".repeat(50));
const tabs = getTabs();
console.log(`[feishu] 发现 ${tabs.length} 个标签页:`);
for (const t of tabs) {
  const clean = t.name.replace(/\s*\(.*?\)$/, "").trim();
  console.log(`  ${t.index}. ${clean}`);
}
console.log(`[feishu] 输出等待: ${WAIT_MS / 1000}s`);
console.log(`[feishu] 匹配逻辑: 字符级中文匹配+子串+分词+默认兜底`);
console.log("=".repeat(50));

wsClient.start({
  eventDispatcher: new Lark.EventDispatcher({}).register({
    "im.message.receive_v1": async (data) => {
      try {
        await handleMessage(data);
      } catch (e) {
        console.error("[feishu] error:", e);
      }
    },
  }),
});

console.log("[feishu] WebSocket 已启动，等待飞书消息...");
