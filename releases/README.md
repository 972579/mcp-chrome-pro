# mcp-chrome-pro v1.0.0

## 🚀 快速安装

### 1. 安装 bridge

需要 Node.js 20+ 和 Chrome/Chromium 浏览器。通过 [npm](https://www.npmjs.com/package/mcp-chrome-bridge-pro) 安装 bridge：

```bash
npm install -g mcp-chrome-bridge-pro
mcp-chrome-bridge-pro --version
```

安装会尝试自动注册 Native Messaging Host；如果安装脚本被禁用或自动注册失败，执行：

```bash
mcp-chrome-bridge-pro register --detect
```

### 2. 下载并加载扩展

下载 [Chrome 扩展压缩包](https://github.com/972579/mcp-chrome-pro/releases/download/v1.0.0/mcp-chrome-pro-extension-v1.0.0.zip)。

1. 解压下载的 zip 文件
2. 打开 Chrome 浏览器
3. 地址栏输入 `chrome://extensions/`
4. 开启右上角的"开发者模式"开关
5. 点击"加载已解压的扩展程序"
6. 选择解压后包含 `manifest.json` 的文件夹

### 3. 验证安装

- 扩展图标应该出现在浏览器工具栏
- 点击图标打开配置面板
- 点击“连接”，确认连接状态正常

## ⚙️ 配置说明

### Native Server 连接

1. 确认 bridge 已通过 npm 安装并完成注册
2. 在扩展面板点击“连接”，扩展会启动本地 Native Server（默认端口 12306）
3. 将 MCP 客户端连接至 `http://127.0.0.1:12306/mcp`

只支持 stdio 的客户端，在全局安装后可将启动命令配置为 `mcp-chrome-stdio-pro`。该代理同样依赖扩展与本地服务保持连接。

## 🔧 故障排除

### 常见问题

1. **扩展无法加载**
   - 确保已开启开发者模式
   - 检查文件夹结构是否完整

2. **无法连接 Native Server**
   - 运行 `mcp-chrome-bridge-pro doctor` 检查安装和注册状态
   - 如有注册问题，执行 `mcp-chrome-bridge-pro register --detect` 后重新连接
   - 检查端口号是否正确
   - 查看浏览器控制台错误信息

3. **功能异常**
   - 刷新页面重试
   - 重启浏览器
   - 重新加载扩展

## 📞 技术支持

遇到问题请：

1. 查看浏览器控制台错误信息
2. 在 GitHub Issues 中搜索相似问题
3. 提交新的 Issue 并附上详细信息

## ⚠️ 安全提醒

- 此扩展具有较高权限，请确保从可信来源下载
