# mcp-chrome-pro

这是 [hangwin/mcp-chrome](https://github.com/hangwin/mcp-chrome) 的维护型 fork。项目保留原有 Chrome 扩展、Native Messaging Bridge 和 MCP 工具能力，当前主要目标是修复上游长期未合并的安全与稳定性问题，而不是继续堆叠浏览器自动化功能。

默认 MCP 地址：`http://127.0.0.1:12306/mcp`

## 本 fork 的主要改动

### 1. 收紧本地服务的 CORS 边界

原实现对 Origin 的判断过于宽松，恶意站点可以构造相似前缀访问本地 HTTP 服务。现在改为解析 Origin 后精确匹配：

- 允许没有 Origin 的本机 MCP 客户端。
- 允许正式发布的 Chrome 扩展 Origin。
- 允许开发环境使用 `http://127.0.0.1:<port>`。
- 拒绝 `127.0.0.1.evil.example` 等前缀伪造。
- 拒绝任意扩展 ID、畸形 Origin、带凭据或额外路径的 Origin。

服务仍只监听 `127.0.0.1`。CORS 是浏览器侧边界，不等同于 Endpoint 身份认证；令牌认证和 HTTPS 尚未加入本批改动。

### 2. 加固远程文件上传

`chrome_upload_file` 的工具名称和参数保持不变，但 `fileUrl` 与 `fileName` 会经过更严格的校验。

远程 URL：

- 只接受 `http://` 和 `https://`。
- 解析目标域名的全部 A/AAAA 地址；只要其中一个不是公网地址，整个请求就会被拒绝。
- 拒绝回环、私网、链路本地、CGNAT、保留、文档和组播等 IPv4/IPv6 地址。
- 通过自定义网络 Agent 将请求固定到已经验证的 IP，同时保留原始 hostname 和 TLS SNI，避免 DNS 校验后再解析产生的重绑定窗口。
- 每次重定向都会重新执行协议、DNS 和地址校验，最多允许 5 次跳转。
- 默认不提供访问本机或内网地址的放行开关。

文件名和临时文件：

- `fileName` 必须是单一路径段。
- 拒绝 Unix/Windows 路径穿越、绝对路径、空字节、驱动器路径和 NTFS ADS。
- 下载、读取与清理均执行临时目录边界检查。
- 拒绝通过符号链接逃逸临时目录。
- 异常结束时仍会清理已经创建的临时文件。

### 3. 隔离 HTTP/MCP 会话

上游使用同一个 MCP SDK Server 连接多个 transport，后建立的连接可能影响已有客户端。现在每个 SSE 或 Streamable HTTP 会话都拥有独立的 SDK Server，并把 `{ server, transport }` 作为一个整体管理。

具体变化：

- 多个 MCP 客户端可以并发执行 `initialize`、`tools/list` 和 `tools/call`。
- 新客户端连接不会接管或关闭旧客户端的 transport。
- POST、GET、DELETE `/mcp` 在交给 SDK 前接管原始响应，避免 Fastify 和 SDK 重复写响应头或响应体。
- 已知会话关闭时同时清理 SDK Server、transport 和会话映射。
- 携带未知 `Mcp-Session-Id` 时返回 `404`。
- 缺少初始化请求、缺少 session ID 或请求格式错误时仍返回 `400`，客户端可据此决定是否重新初始化。
- 传统 `/sse` 与 `/messages` 也使用独立 Server，不再共享全局 transport。

### 4. 更可靠的连接诊断

`GET /ping` 不再只证明 HTTP 进程存在，而是执行一次最长 1.5 秒的扩展往返探测：

| 状态             |  HTTP | 响应字段                    |
| ---------------- | ----: | --------------------------- |
| 扩展正常响应     | `200` | `extensionConnected: true`  |
| 扩展未连接或超时 | `503` | `extensionConnected: false` |

工具调用超时时也会明确提示 Chrome 扩展没有及时响应，不再只返回模糊的 timeout。

### 5. stdio 自动恢复与幂等退出

stdio 模式本质上是到本地 Streamable HTTP Endpoint 的代理。本 fork 对它补充了完整的连接生命周期：

- 串行创建和重建 HTTP client，并发请求复用同一连接。
- 每次复用前执行 MCP ping；连接失效时自动重建。
- EOF、closed、`ECONNREFUSED`、`ECONNRESET` 等连接错误只重试一次。
- 参数错误、工具执行失败等业务错误不会被自动重试，避免重复操作浏览器。
- 清理流程幂等，stdin `end` 和 `close` 同时发生也只执行一次。
- 有 session ID 时最多发送一次 DELETE，3 秒后主动中止等待。
- 退出时关闭 HTTP client、MCP server 和 stdio transport。
- 监听 stdin、SIGINT、SIGTERM，并通过不维持进程存活的父进程 watchdog 防止残留孤儿进程。

## 兼容性变化

| 接口                         | 当前行为                                    |
| ---------------------------- | ------------------------------------------- |
| `GET /ping`                  | 增加 `extensionConnected`；断开时返回 `503` |
| `/mcp` 未知会话              | 从 `400` 调整为 `404`                       |
| `chrome_upload_file.fileUrl` | 只允许最终解析到公网地址的 HTTP/HTTPS URL   |
| MCP 工具名称和输入字段       | 保持不变                                    |

## 本地构建

要求 Node.js 20 或更高版本。仓库固定使用 `pnpm@8.15.9`，不要使用其他 pnpm 版本改写 lockfile。

```bash
corepack pnpm@8.15.9 install --frozen-lockfile
corepack pnpm@8.15.9 -r --filter='!@chrome-mcp/wasm-simd' build
```

构建后：

- Chrome 扩展位于 `app/chrome-extension/.output/chrome-mv3`。
- Native Server 位于 `app/native-server/dist`。
- 本地注册 Native Messaging Host 可执行：

```bash
corepack pnpm@8.15.9 --filter mcp-chrome-bridge run register:dev
```

注册命令会修改当前用户的浏览器 Native Messaging 配置。如果机器上已经安装其他版本，请先确认现有 manifest 指向，避免覆盖正在使用的 bridge。

随后在 `chrome://extensions/` 开启开发者模式，选择“加载已解压的扩展程序”，加载 `app/chrome-extension/.output/chrome-mv3`。打开扩展并点击连接后，本地 MCP Endpoint 才会开始提供浏览器能力。

## MCP 客户端配置

推荐直接使用 Streamable HTTP：

```json
{
  "mcpServers": {
    "chrome": {
      "type": "streamableHttp",
      "url": "http://127.0.0.1:12306/mcp"
    }
  }
}
```

只支持 stdio 的客户端可以运行构建后的代理：

```json
{
  "mcpServers": {
    "chrome": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-chrome-pro/app/native-server/dist/mcp/mcp-server-stdio.js"]
    }
  }
}
```

使用 stdio 前，Chrome 扩展和本地 HTTP bridge 仍需正常连接。

## 验证

```bash
# Native Server：类型、lint 和测试
corepack pnpm@8.15.9 --filter mcp-chrome-bridge exec tsc --noEmit
corepack pnpm@8.15.9 --filter mcp-chrome-bridge run lint
corepack pnpm@8.15.9 --filter mcp-chrome-bridge exec jest --runInBand --coverage=false

# Chrome Extension 测试
corepack pnpm@8.15.9 --filter chrome-mcp-server run test

# 全仓构建（不重复构建 wasm-simd）
corepack pnpm@8.15.9 -r --filter='!@chrome-mcp/wasm-simd' build
```

新增回归测试覆盖恶意 Origin、IPv4/IPv6 私网矩阵、混合 DNS 结果、DNS 重绑定、重定向到私网、路径穿越、临时目录逃逸、多客户端会话隔离、GET SSE、DELETE、stdio 单次重试和幂等退出。

## 保留与暂缓

- 原项目已有浏览器工具继续保留，工具清单见 [docs/TOOLS.md](docs/TOOLS.md)。
- 安装或连接问题见 [docs/TROUBLESHOOTING_zh.md](docs/TROUBLESHOOTING_zh.md)。
- Endpoint 令牌认证与 HTTPS、标签页移动/分组、WSL 支持等功能不在当前安全与稳定性批次中。

## 致谢与许可证

感谢 [hangwin/mcp-chrome](https://github.com/hangwin/mcp-chrome) 及其贡献者。本项目继续使用 [MIT License](LICENSE)。
