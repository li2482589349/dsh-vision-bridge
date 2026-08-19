# dsh-vision-bridge

给 DeepSeek Harness（dsh）的纯文本模型补上视觉能力：**粘贴任意图片 → 自动分类图片类型 → 自动选择最优识别模式 → 结构化结果交给当前模型**。

- 文档/表单/表格/代码截图 → 纯逐字转录（OCR 模式）
- 插画/设计图 → 结构化证据（总结/全文转录/版面/语义/不确定项）
- 照片 → 视觉描述

实现为"包装适配器"：为纯文本模型生成 `(vision)` 变体（如 `DeepSeek-V4-Flash (vision)`），声明支持图片 → 上传准入放行；在请求时转成识别文本再委托回真实路由 → **历史保留图片缩略图**、回放走缓存不重复付费。

## 安装（目标机一行命令）

```bash
npx -y @deepseek-ai/dsh plugin --profile web add dsh-vision-bridge
```

## 前置：配置一个视觉引擎（只需一次）

插件通过 dsh 自身的 llm 服务（pi-ai 路由）调用视觉引擎，**引擎会自动发现**——目标机只要配了任意一个支持图片的 provider 即可（xiaomi/mimo-v2.5、Gemini、OpenAI 兼容端点等）。

以 xiaomi/mimo-v2.5 为例，在目标机的 `$DSH_HOME/settings.yaml` 添加：

```yaml
llm-pi-ai:
  providers:
    xiaomi:
      apiKeyEnv: XIAOMI_API_KEY
      models:
        - id: mimo-v2.5
          name: MiMo-V2.5
          contextWindow: 1048576
          maxTokens: 131072
```

在 `$DSH_HOME/.credentials.yaml`（或环境变量）添加：

```yaml
XIAOMI_API_KEY: <你的 key>
```

其他引擎（Gemini / OpenAI 兼容 / Anthropic）同理：配好 provider 路由即可，插件自动发现；也可在部署的 `cordis.patch.yml` 里用行配置钉死：

```yaml
- insert:
    - id: vision-bridge
      name: 'dsh-vision-bridge'
      config:
        provider: gemini-api
        model: gemini-2.5-flash
        families:
          - deepseek
          - longcat-2
        mode: auto
```

## 使用

重启 dsh → 模型选择器里选 **`DeepSeek-V4-Flash (vision)`**（或对应变体）→ 粘贴图片即可。

模型也可随时调用 `visb_read_image` 工具按路径读图（支持 `mode` / `prompt` 参数）。

## 配置项（插件行 config，全部可选）

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `provider` / `model` | 自动发现 | 钉死视觉引擎路由 |
| `families` | `['deepseek']` | 哪些 provider 家族的纯文本模型要生成 `(vision)` 变体 |
| `mode` | `auto` | `auto`（自动分类）/ `evidence` / `ocr` / `describe` |
| `prompt` | 内置 | 完全自定义识别提示词 |
| `toolName` | `visb_read_image` | 读图工具名 |
| `autoRead` | `false` | 是否开启 pre-step 兜底转换 |
| `separator` | `\n---\n` | 多图之间的分隔符 |

## 开发

```bash
# 本地验证（mock 主 realm 环境）
node test.mjs
```
