# WeChat & Feishu → iTerm2 Claude Code Router

[中文](#中文说明) | [English](#english)

---

## English

### What is this?

A bridge that lets you **control your running Claude Code terminal sessions from your phone** — via WeChat or Feishu (Lark) messages.

Instead of walking back to your computer, just send a message from your phone. The router matches your message to the right iTerm2 tab and types it in. After Claude Code processes it, the terminal output is captured and sent back to you.

### Use Cases

- **Remote control while AFK** — Kick off deployments, run tests, or check logs from your couch, bed, or coffee shop
- **Mobile-first AI coding** — Send coding instructions to Claude Code from your phone and get results back
- **Multi-project management** — Run Claude Code in multiple tabs (frontend, backend, DevOps) and route messages to the right one with smart matching
- **Team visibility** — Share a Feishu bot so teammates can trigger specific terminal tasks

### How It Works

```
Phone Message → Smart Router → iTerm2 Tab (Claude Code)
                                     ↓
Phone Reply   ← Capture Output ← Terminal Output
```

1. You run multiple Claude Code sessions in iTerm2 tabs (each tab has a name)
2. Send a message from WeChat or Feishu with a `#keyword` prefix or just naturally
3. The router uses **fuzzy matching** to find the best iTerm2 tab — character-level Chinese matching, substring scoring, word segmentation, and automatic fallback
4. The message is typed into that terminal session via AppleScript
5. After a configurable wait, terminal output is captured and sent back

### Smart Matching Examples

| You send | Matches tab | Method |
|----------|------------|--------|
| `#api check status` | "project api" | keyword |
| `#前端 修个bug` | "项目前端" | keyword |
| `deploy the frontend` | "my-app frontend" | smart (word overlap) |
| `日志查一下` | "系统日志" | smart (character match) |
| `check test results` | "test runner" | smart (substring) |
| `random unrelated text` | first tab | fallback |

### Management Commands

| Command | Description |
|---------|-------------|
| `/help` | Show help and available tabs |
| `/tabs` | List all iTerm2 tabs |
| `/read keyword` | Read recent output from a matched tab |
| `/new <command>` | Open a new iTerm2 tab and run a command |
| `/close keyword` | Close the best-matched tab |

### Setup

#### Prerequisites

- **macOS** with iTerm2
- **Node.js** >= 22

#### WeChat Bridge

Uses [weixin-agent-sdk](https://github.com/wong2/weixin-agent-sdk) — QR code login, no server needed.

```bash
git clone https://github.com/henu-wang/weixin-claude-router.git
cd weixin-claude-router
npm install

# Login to WeChat (scan QR code)
npx weixin-acp login

# Start the WeChat router
node router.mjs
```

#### Feishu (Lark) Bridge

Uses the official [Feishu SDK](https://github.com/larksuite/node-sdk) with WebSocket long connection — no public URL needed.

**1. Create a Feishu app:**
- Go to [Feishu Open Platform](https://open.feishu.cn/app)
- Create a custom app → Enable **Bot** capability
- Add permissions: `im:message`, `im:message:readonly`, `im:message:send_as_bot`
- Subscribe to event: `im.message.receive_v1`
- Set subscription mode: **Long Connection** (WebSocket)
- Publish the app version

**2. Configure and run:**
```bash
# Set your Feishu app credentials (or edit feishu-router.mjs directly)
export FEISHU_APP_ID=cli_your_app_id
export FEISHU_APP_SECRET=your_app_secret

# Start the Feishu router
node feishu-router.mjs
```

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `WAIT_MS` | `15000` | Milliseconds to wait before capturing terminal output |
| `FEISHU_APP_ID` | — | Feishu app ID |
| `FEISHU_APP_SECRET` | — | Feishu app secret |

### Limitations

- **macOS only** — relies on iTerm2 AppleScript API
- **Output capture is time-based** — waits a fixed duration before reading. For long tasks, use `/read` to check later
- **Message length limits** — long outputs are truncated (~2000 chars for WeChat, ~4000 for Feishu)

### License

MIT

---

## 中文说明

### 这是什么？

一个桥接工具，让你**通过手机微信或飞书消息，远程控制电脑上正在运行的 Claude Code 终端**。

不用走回电脑前，直接在手机上发一条消息，路由器会智能匹配到正确的 iTerm2 标签页，把指令输入进去。Claude Code 处理完后，终端输出会被截取并发回你的手机。

### 使用场景

- **离开电脑时远程操控** — 躺在沙发上就能触发部署、跑测试、查日志
- **手机端 AI 编程** — 用手机给 Claude Code 下指令，收到代码结果
- **多项目管理** — 不同标签页跑不同项目（前端、后端、运维），消息智能路由到正确的标签页
- **团队协作** — 飞书机器人可以共享给团队成员，触发特定终端任务

### 工作原理

```
手机消息 → 智能路由器 → iTerm2 标签页 (Claude Code)
                              ↓
手机回复 ← 截取输出  ← 终端输出
```

### 智能匹配

不需要记住精确的标签页名称，路由器会自动做：

- **字符级中文匹配** — 发"前端"就能匹配到"项目前端"
- **子串匹配** — 发"test"匹配到"test runner"
- **分词匹配** — 发"api状态"匹配到"project api"
- **兜底机制** — 完全匹配不到就发到第一个标签页，不会拒绝

### 三种发送方式

| 方式 | 示例 | 说明 |
|------|------|------|
| `#关键词 指令` | `#api 查一下状态` | 指定路由 |
| 直接发指令 | `前端修个bug` | 自动匹配 |
| 无关内容 | `你好` | 默认第一个标签页 |

### 管理命令

| 命令 | 功能 |
|------|------|
| `/help` | 查看帮助和所有标签页 |
| `/tabs` | 列出所有 iTerm2 标签页 |
| `/read 关键词` | 读取匹配标签页的最新输出 |
| `/new 命令` | 新开标签页并执行命令 |
| `/close 关键词` | 关闭匹配的标签页 |

### 安装使用

#### 前置条件

- **macOS** + iTerm2
- **Node.js** >= 22

#### 微信版

```bash
git clone https://github.com/henu-wang/weixin-claude-router.git
cd weixin-claude-router
npm install

# 微信扫码登录
npx weixin-acp login

# 启动路由器
node router.mjs
```

#### 飞书版

**1. 创建飞书应用：**
- 打开 [飞书开放平台](https://open.feishu.cn/app)
- 创建企业自建应用 → 添加**机器人**能力
- 开通权限：`im:message`、`im:message:readonly`、`im:message:send_as_bot`
- 订阅事件：`im.message.receive_v1`（接收消息）
- 订阅方式选择：**长连接**（WebSocket）
- 发布应用版本并审批通过

**2. 配置并运行：**
```bash
export FEISHU_APP_ID=cli_你的应用id
export FEISHU_APP_SECRET=你的应用secret

node feishu-router.mjs
```

### 许可证

MIT
