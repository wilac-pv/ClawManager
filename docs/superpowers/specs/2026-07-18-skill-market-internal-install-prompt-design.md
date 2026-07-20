# Skill 市场内网安装 Prompt 设计

## 问题与根因

SkillHub 镜像包已经发布到公司内网 OSS，目录 API 返回的 `package.url` 和
SHA-256 也指向已校验的镜像对象。但共享 `installPrompt(detail)` 当前复制：

- `detail.publicDetailUrl`，SkillHub 数据中仍是 `https://skillhub.cn/...`；
- `detail.sourceUrl`，可能是 `https://clawhub.ai/...` 等原始外网来源；
- 不复制实际的内网 `detail.package.url`。

因此模型收到 Prompt 后容易沿外网详情或来源重新下载，绕过已经镜像和校验的
内网包。

## 目标行为

复制和手动降级展示的安装 Prompt 必须：

- 完全不包含 `sourceUrl`、SkillHub 外网详情或其他原始来源地址；
- 包含当前如影 Skill 市场的内网详情 URL；
- 包含目录 API 返回的内网 ZIP URL；
- 包含版本和 SHA-256；
- 明确要求只使用上述内网地址下载，并在安装前校验 SHA-256。

示例：

```text
请安装并使用这个 Skill：Example
内网详情：http://10.246.13.226:4211/ai-coding/ruying-code/skill-market/skills/skillhub/example
内网下载：https://oss.internal.example/market/packages/<sha256>.zip
版本：1.0.0
SHA-256：<sha256>
要求：仅使用上述内网地址下载，并在安装前校验 SHA-256。
```

桌面端安装按钮、下载 ZIP 按钮、来源溯源展示、目录 API 和已发布 OSS 对象不变。

## 方案选择

采用 Web Prompt 层修复，不修改或回填已发布详情对象。

备选方案一是修正服务端 SkillHub `publicDetailUrl` 并重写所有内容寻址详情引用；
它会影响数万条已镜像记录和目录指针，不适合本次 Prompt 问题。备选方案二是让
Prompt 指向返回 JSON 的 `/download` API；它需要安装端额外解析响应，不如直接
提供目录中已经校验的内网 ZIP URL。

## 组件边界

`packages/app/src/skill-market/detail.tsx` 保留纯 Prompt 格式化职责，但格式化函数
必须显式接收内网详情 URL 和内网下载 URL，不得再默认读取
`detail.publicDetailUrl` 或 `detail.sourceUrl`。显式参数使调用方无法无意中恢复外网
地址。

Web 类型的 `SkillMarketActions` 分离两个职责：

- `prompt(detail)` 同步生成最终 Prompt；
- `copyPrompt(value)` 只负责把已生成文本写入剪贴板。

共享详情组件只生成一次 Prompt，并把同一字符串同时用于自动复制和复制失败后的
只读文本域，避免两条路径内容不一致。

`packages/skill-market-web/src/app.tsx` 负责 Web 运行时地址：

- 内网详情 URL 使用 `window.location.origin`、Vite `BASE_URL`、来源和经过 URL
  编码的 Skill ID 生成；
- 内网下载 URL 使用目录详情中的 `detail.package.url`；
- 不向 Prompt 构造器传递 `sourceUrl` 或原始 `publicDetailUrl`。

## 数据流

1. Web 从同源目录 API 读取 Skill 详情。
2. 用户点击“复制安装 Prompt”。
3. 共享详情组件调用 Web action 的 `prompt(detail)`。
4. Web action 生成当前站点下的内网详情 URL，并与 `detail.package.url` 一起交给
   Prompt 格式化器。
5. 组件把生成结果交给 `copyPrompt(value)`。
6. 若浏览器复制失败，组件展示完全相同的只读 Prompt。

该流程不访问外网，不触发新的包下载，也不改变正在进行的 SkillHub 全量镜像。

## 错误处理

- Skill ID 必须使用 `encodeURIComponent` 进入路径。
- Prompt 构造器不提供外网字段的隐式回退。
- 剪贴板失败继续使用现有错误反馈和手动复制文本域。
- 下载按钮继续通过目录 `/download` 接口解析当前包，不受 Prompt 改动影响。
- 若目录详情本身不可用，现有详情加载错误处理继续阻止复制操作。

## 测试

1. Prompt 单元测试验证内网详情、内网 ZIP、版本和 SHA-256 均存在。
2. Prompt 单元测试使用含 `skillhub.cn` 和 `clawhub.ai` 的详情夹具，断言结果不含
   这两个域名、不含 `sourceUrl`，并包含“仅使用上述内网地址”的要求。
3. 详情组件测试验证自动复制和失败后的只读文本域使用同一个 action 生成结果。
4. Web 测试验证详情 URL基于当前 origin、`BASE_URL`、source 和编码后的 ID 生成。
5. 运行 App/Web 单元测试、浏览器测试、类型检查和生产构建。

## 发布与回滚

该改动只需发布新的 Web 内容寻址 release，不需要 API 发布、数据库迁移或 SkillHub
重新镜像。发布后在生产详情页复制报告中的 Skill，确认剪贴板中不存在
`skillhub.cn`、`clawhub.ai`，且内网 ZIP 的 SHA-256 与目录 `/download` 响应一致。

保留发布前的 Web release；若复制、手动降级或下载行为回归，原子恢复
`/srv/ruying-skill-market/web/current` 并回滚 Web OSS `current.json` 指针。
