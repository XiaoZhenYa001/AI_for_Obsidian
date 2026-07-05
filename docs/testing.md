# Obsidian 内加载与验收清单

## 1. 安装位置

将项目中的以下文件放到 Obsidian vault 的插件目录：

```text
.obsidian/plugins/ai-second-brain/
├─ manifest.json
├─ main.js
└─ styles.css
```

如果是直接在插件目录开发，则确保这三个文件位于同一目录。

## 2. 加载检查

1. 打开 Obsidian 设置。
2. 进入「Community plugins」。
3. 关闭安全模式。
4. 在已安装插件列表中启用「AI Second Brain」。
5. 打开命令面板，运行 `AI: Run self check`。

通过标准：

- 自检弹窗可以打开。
- 插件运行状态显示通过。
- 能看到 Provider、上下文、模板和知识库分析状态。

## 3. Provider 验收

至少配置一个 Provider：

- OpenAI-compatible：填写 Base URL、API Key、模型名。
- Anthropic Claude：填写 API Key、模型名。
- Ollama：确认本地 Ollama 服务已启动，并填写模型名。

通过标准：

- 设置页可以添加、编辑、删除 Provider。
- 可以设置默认聊天服务和默认编辑服务。
- 侧边栏发送问题后能收到回答。
- 开启流式输出时，回答会逐步显示。
- 点击停止按钮后生成会停止。
- 连续提问时，AI 能参考最近几轮对话。
- 关闭并重新打开侧边栏后，最近会话仍会显示。

## 4. 上下文范围验收

在设置页创建不同上下文范围：

- 当前文件。
- 指定文件。
- 文件夹。
- 标签。
- 路径规则。

通过标准：

- 侧边栏顶部可以切换上下文。
- 切换后能看到授权文件数量。
- 对话引用来源只来自当前授权范围。
- 关闭「允许云端模型」后，云端 Provider 不应读取该范围。

## 5. 本地索引验收

运行命令：

- `AI: Rebuild local text index`
- `AI: Run self check`

通过标准：

- 重建索引命令会提示索引了多少文件和片段。
- 自检弹窗中能看到本地文本索引状态。
- 修改、删除或重命名 Markdown 文件后，相关文件索引会自动失效。
- 不手动重建也可以使用问答；插件会在搜索前自动补齐缺失索引。

## 6. 编辑器操作验收

在编辑器中选中文本，右键执行：

- AI 解释选中文本。
- AI 总结选中文本。
- AI 改写选中文本。
- AI 翻译选中文本。
- AI 扩写选中文本。
- AI 缩写选中文本。

通过标准：

- 解释和总结会追加 AI 说明。
- 改写、翻译、扩写、缩写会先显示差异预览。
- 点击取消不会修改原文。
- 点击应用后替换选区。
- Obsidian 撤销可以回退修改。

## 7. 笔记生成验收

运行命令：

- `AI: Generate content`
- `AI: Generate new note`

通过标准：

- 可以输入提示词并生成 Markdown 预览。
- 可以选择是否使用当前上下文。
- 在编辑器中运行时，可以把生成内容插入当前光标。
- 创建新笔记时，会生成到 `AI Second Brain/` 文件夹。
- 使用上下文时，预览区下方会显示引用来源。

## 8. 知识库分析验收

运行命令：

- `AI: Analyze knowledge health`
- `AI: Generate MOC draft`
- `AI: Generate daily review draft`
- `AI: Generate weekly review draft`

通过标准：

- 健康检查弹窗能显示孤立笔记、缺摘要、补链建议和高频标签。
- 点击报告中的笔记可以打开文件。
- MOC 草稿会生成到 `AI Second Brain/` 文件夹。
- 每日/每周回顾草稿会生成到 `AI Second Brain/` 文件夹。

## 9. 亮暗主题验收

分别切换 Obsidian 亮色和暗色主题。

通过标准：

- 侧边栏、设置页、差异预览、自检弹窗和健康检查弹窗文字可读。
- 边框、背景、引用来源和状态徽标跟随 Obsidian CSS 变量。
- 文本没有明显重叠或溢出。
