# mcp-chrome-bridge-pro

这是 [mcp-chrome-pro](https://github.com/972579/mcp-chrome-pro) 的 Native Messaging Bridge，基于 [hangwin/mcp-chrome](https://github.com/hangwin/mcp-chrome)，包含 CORS、文件上传、MCP 多客户端会话隔离和 stdio 连接恢复等安全与稳定性修复。

## 安装

需要 Node.js 20+ 和 Chrome/Chromium。本包已发布至 [npm](https://www.npmjs.com/package/mcp-chrome-bridge-pro)，可直接安装：

```bash
npm install -g mcp-chrome-bridge-pro
mcp-chrome-bridge-pro --version
```

全局安装会尝试自动注册 Native Messaging Host。如果自动注册失败或安装脚本被禁用，执行：

```bash
mcp-chrome-bridge-pro register --detect
```

随后下载并解压 [Chrome 扩展压缩包](https://github.com/972579/mcp-chrome-pro/blob/HEAD/releases/chrome-extension/latest/chrome-mcp-server-lastest.zip)，在 `chrome://extensions/` 开启“开发者模式”，点击“加载已解压的扩展程序”，选择包含 `manifest.json` 的目录。

完整说明见 [扩展安装指南](https://github.com/972579/mcp-chrome-pro/blob/HEAD/releases/README.md)。本包包含所需的本仓库 shared 代码，用户无需克隆仓库或安装 pnpm。

本 fork 沿用 `com.chromemcp.nativehost`，注册会将当前用户的 Native Host 指向本包。打开扩展并点击连接后，本地 MCP 服务才会提供浏览器能力。

## MCP 客户端配置

推荐使用 Streamable HTTP，地址为 `http://127.0.0.1:12306/mcp`：

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

只支持 stdio 的客户端在全局安装后可使用：

```json
{
  "mcpServers": {
    "chrome": {
      "command": "mcp-chrome-stdio-pro"
    }
  }
}
```

stdio 是到本地 HTTP 服务的代理，仍需要 Chrome 扩展和 bridge 正常连接。

## 注册与诊断

```bash
# 指定浏览器，也可使用 chromium 或 all
mcp-chrome-bridge-pro register --browser chrome

# 只读诊断
mcp-chrome-bridge-pro doctor

# 修复权限、Node 路径或注册配置
mcp-chrome-bridge-pro doctor --fix
```

支持 macOS、Linux 和 Windows 的 Chrome/Chromium。

## 开发与发布

在仓库根目录使用固定版本的 pnpm：

```bash
corepack pnpm@8.15.9 install --frozen-lockfile
corepack pnpm@8.15.9 --filter chrome-mcp-shared build
corepack pnpm@8.15.9 --filter mcp-chrome-bridge-pro build
```

从 bridge 子目录打包；`prepack` 会自动构建 shared 和 bridge：

```bash
cd app/native-server
corepack pnpm@8.15.9 pack
npm publish ./mcp-chrome-bridge-pro-1.0.0.tgz --access public --registry=https://registry.npmjs.org
```

后续发布需要先更新 `package.json` 版本，并使用对应版本的压缩包文件名。

## 许可证

MIT，保留上游版权声明，详见 [LICENSE](LICENSE)。
