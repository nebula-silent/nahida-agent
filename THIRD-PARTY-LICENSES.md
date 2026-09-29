# 第三方开源组件与许可（THIRD-PARTY LICENSES）

本清单列出 nahida 引用的第三方开源组件及其许可，与应用内「关于 → 开源致谢」一致。
条目按用途分组；`来源` 为官方仓库，完整版权声明与许可文本以各仓库 LICENSE / NOTICE 为准。
本清单在 `LICENSE`（MIT）之外另行保留，用于履行各组件许可协议中「保留版权声明」的义务。

> 角色名称、角色形象、Live2D 模型、美术与音声资产等知识产权归原权利方（米哈游 / HoYoverse）所有，
> **不属于**以下任何开源许可的范围；仓库不含此类素材。

## 框架与构建

| 组件 | 许可 | 来源 |
| --- | --- | --- |
| Electron | MIT | https://github.com/electron/electron |
| Vite | MIT | https://github.com/vitejs/vite |
| TypeScript | Apache-2.0 | https://github.com/microsoft/TypeScript |
| Electron Builder | MIT | https://github.com/electron-userland/electron-builder |
| Vitest | MIT | https://github.com/vitest-dev/vitest |
| concurrently | MIT | https://github.com/open-cli-tools/concurrently |
| cross-env | MIT | https://github.com/kentcdodds/cross-env |

## 运行时依赖

| 组件 | 许可 | 来源 |
| --- | --- | --- |
| @ag-ui/client / @ag-ui/core | MIT | https://github.com/ag-ui-protocol/ag-ui |
| @lancedb/lancedb | Apache-2.0 | https://github.com/lancedb/lancedb |
| @langchain/core | MIT | https://github.com/langchain-ai/langchainjs |
| @langchain/langgraph | MIT | https://github.com/langchain-ai/langgraphjs |
| @larksuiteoapi/node-sdk | MIT | https://github.com/larksuite/node-sdk |
| @mdit/plugin-katex | MIT | https://github.com/mdit-plugins/mdit-plugins |
| @modelcontextprotocol/sdk | MIT | https://github.com/modelcontextprotocol/typescript-sdk |
| @node-rs/jieba | MIT | https://github.com/napi-rs/node-rs |
| @nut-tree-fork/nut-js | Apache-2.0 | https://github.com/nut-tree/nut.js |
| @xenova/transformers | Apache-2.0 | https://github.com/xenova/transformers.js |
| chart.js | MIT | https://github.com/chartjs/Chart.js |
| dingtalk-stream | MIT | https://github.com/open-dingtalk/dingtalk-stream-sdk-nodejs |
| docx | MIT | https://github.com/dolanmiu/docx |
| dompurify | MPL-2.0 OR Apache-2.0 | https://github.com/cure53/DOMPurify |
| exceljs | MIT | https://github.com/exceljs/exceljs |
| gray-matter | MIT | https://github.com/jonschlinkert/gray-matter |
| js-yaml | MIT | https://github.com/nodeca/js-yaml |
| katex | MIT | https://github.com/KaTeX/KaTeX |
| llamaindex | MIT | https://github.com/run-llama/LlamaIndexTS |
| markdown-it | MIT | https://github.com/markdown-it/markdown-it |
| nodemailer | MIT-0 | https://github.com/nodemailer/nodemailer |
| pdf-lib | MIT | https://github.com/Hopding/pdf-lib |
| pdfkit | MIT | https://github.com/foliojs/pdfkit |
| playwright | Apache-2.0 | https://github.com/microsoft/playwright |
| qr-image | MIT | https://github.com/alexeyten/qr-image |
| qrcode | MIT | https://github.com/soldair/node-qrcode |
| rss-parser | MIT | https://github.com/bobby-brennan/rss-parser |
| rxjs | Apache-2.0 | https://github.com/reactivex/rxjs |
| sherpa-onnx-node | Apache-2.0 | https://github.com/csukuangfj/sherpa-onnx |
| shiki | MIT | https://github.com/shikijs/shiki |
| silk-wasm | MIT | https://github.com/idranme/silk-wasm |
| turndown | MIT | https://github.com/mixmark-io/turndown |
| wink-bm25-text-search | MIT | https://github.com/winkjs/wink-bm25-text-search |
| ws | MIT | https://github.com/websockets/ws |

## 内嵌字体与图标

| 组件 | 许可 | 来源 |
| --- | --- | --- |
| Lucide | ISC | https://github.com/lucide-icons/lucide |
| 思源宋体 Source Han Serif | SIL OFL 1.1 | https://github.com/adobe-fonts/source-han-serif |

思源宋体为 SIL Open Font License 1.1 授权，允许再分发（含修改）；授权文件见 `assets/fonts/OFL.txt`。

## 本地语音服务（外部部署，非 npm 依赖）

| 组件 | 许可 | 来源 |
| --- | --- | --- |
| GPT-SoVITS | MIT | https://github.com/RVC-Boss/GPT-SoVITS |

本地部署的 TTS 引擎，由用户自行安装与提供模型，仓库不包含其权重。

## 架构参考项目

| 项目 | 许可 | 来源 |
| --- | --- | --- |
| Cyrene-Agent | MIT | https://github.com/Playa-0v0/Cyrene-Agent |
| DeepSeek Orb | MIT | https://github.com/mini-yifan/deepseek-harness-orb |

## 许可类型说明

- **MIT**：允许使用、复制、修改、分发（含商用），须保留版权声明与本许可文本
- **Apache-2.0**：允许同上，须保留版权声明、NOTICE（如有）并标注修改
- **MIT-0**：零条款许可，放弃版权与相关权利
- **MPL-2.0**：文件级弱 copyleft，源码修改须以同许可提供
- **ISC**：与 MIT 等效的宽松许可
- **SIL OFL 1.1**：开源字体许可，允许再分发与修改，禁止单独出售字体文件
