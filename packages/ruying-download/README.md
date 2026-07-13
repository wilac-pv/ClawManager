# 如影 Code 内部下载页

本目录是无框架、无服务端运行时依赖的静态下载页。生产页面行为和两个安装包地址由测试固定。

## HTTP-only 部署契约

当前页面必须从 HTTP 来源部署，不得发布到 HTTPS 来源。两个已批准的安装包地址只提供 HTTP；HTTPS 页面跳转到 HTTP 安装包时，浏览器可能把下载视为不安全的混合内容并阻止它。不得把地址擅自替换成证书链尚未获得浏览器信任的 HTTPS 地址。

固定地址如下：

- macOS Apple Silicon：`http://app-platform.oss-cn-baoding-gwmcloud-d01-a.res.cloud.gwm.cn/ai-coding/ruying-code/ruying-code-desktop-mac-arm64.dmg`
- Windows x64：`http://app-platform.oss-cn-baoding-gwmcloud-d01-a.res.cloud.gwm.cn/ai-coding/ruying-code/ruying-code-desktop-win-x64.exe`

页面初始加载只允许同源 HTML、CSS、JavaScript 和 `assets/app-icon.png`，不得请求分析、身份或业务接口。

## 切换到 HTTPS

只有在两个安装包都获得浏览器可信的 HTTPS 地址，或部署方提供同源 HTTPS 代理后，页面才可以切换到 HTTPS。迁移必须在同一个变更中完成以下事项：

1. 同步更新 `index.html` 中两个卡片直链和 `app.js` 中两个推荐地址。
2. 更新 `content.test.ts`、`app.test.ts` 和 `download-page.e2e.ts` 中的固定 URL、无 JavaScript 降级和网络边界测试。
3. 把 `playwright.config.ts` 的预览协议改为与新部署契约一致。
4. 更新本 README、批准的设计文档和实施计划，并重新执行完整测试与 URL/网络审计。

## 本地验证

```sh
bun test
bunx playwright test --config playwright.config.ts
```
