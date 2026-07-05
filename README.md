# Obsidian AI 第二大脑插件

这是一个面向 Obsidian 的 AI 插件项目，目标是把本地 Markdown 知识库扩展成一个可对话、可检索、可创作、可整理、可分析的「会思考的第二大脑」。

当前阶段优先完成文档与基础结构设计，再按路线图逐步实现 MVP 功能。

## 文档导航

- [产品需求文档](docs/product-requirements.md)
- [技术架构设计](docs/architecture.md)
- [开发路线图](docs/roadmap.md)
- [实施任务清单](docs/tasks.md)
- [UI 设计规范](docs/ui-guidelines.md)
- [Obsidian 内加载与验收清单](docs/testing.md)

## MVP 目标

第一阶段先完成最小可用版本：

1. 侧边栏 AI 对话
2. 多 AI 服务商配置
3. 可控文件访问范围
4. 基于授权笔记的本地检索与引用溯源
5. 选中文本后的右键 AI 操作
6. AI 修改结果的差异预览与确认应用

## 核心原则

- 用户必须明确知道 AI 能读取哪些笔记。
- 所有文件读取先在本地完成，只有授权内容可发送给 AI。
- AI 生成或修改笔记时，应尽量可预览、可追溯、可撤销。
- UI 应贴近 Obsidian 原生体验，克制、清晰、轻量。
