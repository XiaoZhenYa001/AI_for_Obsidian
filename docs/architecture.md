# 技术架构设计

## 1. 架构目标

本插件采用本地优先、权限明确、模块化扩展的架构。核心目标是让 AI 能力围绕 Obsidian 文件系统工作，同时保证用户对文件访问范围、模型选择、请求内容和笔记修改拥有控制权。

## 2. 总体模块

```text
Obsidian Plugin
├─ UI Layer
│  ├─ Chat Sidebar
│  ├─ Context Switcher
│  ├─ Authorized Files Inspector
│  ├─ Settings Tab
│  ├─ Diff Preview Modal
│  └─ Command/Menu Integration
├─ Application Services
│  ├─ Chat Service
│  ├─ Note Action Service
│  ├─ Context Scope Service
│  ├─ Retrieval Service
│  ├─ Template Service
│  ├─ Diagram Service
│  └─ Knowledge Analysis Service
├─ AI Layer
│  ├─ Provider Registry
│  ├─ OpenAI-Compatible Provider
│  ├─ Anthropic Provider
│  ├─ Ollama Provider
│  └─ Embedding Provider
├─ Data Layer
│  ├─ Settings Store
│  ├─ Context Scope Store
│  ├─ Conversation Store
│  ├─ Vector/Text Index Store
│  └─ Prompt Template Store
├─ Diagram Integration
│  ├─ Diagram Spec Validator
│  ├─ Dagre Layout Engine
│  ├─ Layout Preview Renderer
│  ├─ ExcalidrawAutomate Adapter
│  └─ Mermaid Fallback
└─ Obsidian API Adapter
   ├─ Vault Reader
   ├─ Metadata Cache Reader
   ├─ Editor Adapter
   └─ Workspace Adapter
```

## 3. 推荐目录结构

```text
src/
├─ main.ts
├─ settings/
│  ├─ settings.ts
│  ├─ settings-tab.ts
│  └─ defaults.ts
├─ providers/
│  ├─ types.ts
│  ├─ registry.ts
│  ├─ openai-compatible.ts
│  ├─ anthropic.ts
│  └─ ollama.ts
├─ context/
│  ├─ scope-types.ts
│  ├─ scope-store.ts
│  ├─ scope-resolver.ts
│  └─ context-switcher.ts
├─ retrieval/
│  ├─ chunker.ts
│  ├─ index-store.ts
│  ├─ text-search.ts
│  ├─ vector-search.ts
│  └─ citations.ts
├─ chat/
│  ├─ chat-service.ts
│  ├─ conversation-store.ts
│  ├─ prompt-builder.ts
│  └─ chat-view.ts
├─ actions/
│  ├─ action-types.ts
│  ├─ note-actions.ts
│  ├─ selection-actions.ts
│  └─ markdown-format-actions.ts
├─ templates/
│  ├─ template-types.ts
│  ├─ built-in-templates.ts
│  └─ template-store.ts
├─ diagrams/
│  ├─ types.ts
│  ├─ diagram-spec.ts
│  ├─ layout.ts
│  ├─ diagram-preview.ts
│  ├─ diagram-service.ts
│  ├─ excalidraw-adapter.ts
│  └─ generate-diagram-modal.ts
├─ ui/
│  ├─ components/
│  ├─ diff-preview-modal.ts
│  ├─ notice.ts
│  └─ styles.css
└─ utils/
   ├─ errors.ts
   ├─ markdown.ts
   ├─ tokens.ts
   └─ ids.ts
```

## 4. 数据模型

### 4.1 AI Provider

```ts
type AIProviderConfig = {
  id: string;
  name: string;
  type: "openai-compatible" | "anthropic" | "ollama";
  baseUrl?: string;
  apiKey?: string;
  defaultModel: string;
  temperature: number;
  stream: boolean;
};
```

### 4.2 上下文范围

```ts
type ContextScope = {
  id: string;
  name: string;
  mode: "current-file" | "files" | "folders" | "tags" | "rules";
  files?: string[];
  folders?: string[];
  tags?: string[];
  pathRules?: string[];
  excludeRules?: string[];
  allowCloudModels: boolean;
};
```

### 4.3 检索片段

```ts
type RetrievedChunk = {
  id: string;
  filePath: string;
  heading?: string;
  content: string;
  score: number;
  startLine?: number;
  endLine?: number;
};
```

### 4.4 引用来源

```ts
type Citation = {
  filePath: string;
  title: string;
  excerpt: string;
  startLine?: number;
  endLine?: number;
};
```

### 4.5 对话会话

```ts
type ChatSession = {
  id: string;
  title: string;
  contextScopeId: string;
  purpose: string;
  autoContext: boolean;
  lockedFilePaths: string[];
  lastContextFilePaths: string[];
  messages: ChatMessage[];
  createdAt: string;
  updatedAt: string;
};
```

每个会话独立保存消息、职责、上下文范围、锁定文件和最近确认的文件集合。旧版本的单一聊天记录在加载时迁移为一个历史会话。

会话使用独立的逻辑索引边界，但底层共享按文件内容生成的本地片段缓存。检索只能查询该会话授权范围内的文件；共享缓存仅用于避免重复读取未变化的文件，不会扩大授权范围。

## 5. 核心流程

### 5.1 对话问答流程

```text
用户输入问题
→ 读取当前会话的职责和上下文范围
→ 解析授权文件列表
→ 本地筛选相关文件并合并锁定文件
→ 用户确认本轮文件集合
→ 检索相关片段
→ 构建 Prompt
→ 调用选定 AI Provider
→ 流式渲染回答
→ 展示引用来源
→ 保存会话记录
```

### 5.2 选中文本改写流程

```text
用户选中文本
→ 选择右键 AI 操作
→ 锁定文件、选区和原始文档状态
→ 根据操作加载 Prompt 模板
→ 调用 AI Provider
→ 生成候选修改
→ 展示差异预览
→ 用户确认并重新校验原始文档状态
→ 应用到编辑器
→ 支持 Obsidian 撤销
```

### 5.3 本地索引流程

```text
用户创建或更新上下文范围
→ 解析授权文件
→ 按 Markdown 结构分块
→ 提取标题、标签、Front Matter
→ 写入本地索引
→ 文件变更时增量更新
```

文件缓存以路径、修改时间和大小识别版本。修改、删除或重命名只使对应文件缓存失效；后续检索按需重新分块，不重复扫描未变化文件。

### 5.4 可编辑图谱生成流程

```text
选中文本、当前笔记、授权范围或 AI 回复
→ 解析并锁定允许使用的来源路径
→ AI 仅生成受约束的 DiagramSpec JSON
→ 本地校验节点、关系与来源路径
→ Dagre 在本地计算稳定布局
→ 本地渲染布局、节点、关系和来源预览
→ ExcalidrawAutomate 创建可编辑绘图
→ 未安装 Excalidraw 时降级为 Mermaid 笔记
→ 用户明确选择后嵌入当前笔记
```

AI 不直接输出 Excalidraw 文件 JSON，也不能指定任意 Vault 路径。图形布局、文件创建和嵌入操作均由本地代码完成；节点的 `sourcePath` 必须来自本次已授权或已引用的 Markdown 文件。

图谱生成弹窗持有独立的 `AbortController`。关闭弹窗、主动停止或修改生成参数时会中止当前请求；仅当前请求可以提交预览结果。创建文件期间按钮进入互斥状态，避免重复创建。

生成后的 `DiagramSpec` 可以在弹窗内本地编辑。节点或关系发生变化后，弹窗生成新的不可变 Spec，并再次调用 Dagre 计算布局；这一过程不经过 Provider。删除节点时同步删除相关边，自环和重复边在写入草稿前被拒绝。

## 6. 文件访问控制设计

文件访问控制应集中在 `ContextScopeService` 中完成。任何需要读取笔记内容的模块，都必须先通过范围解析器获取授权文件列表。

原则：

- UI 选择的是范围，服务层拿到的是解析后的文件列表。
- 检索服务只能读取解析后的文件列表。
- Prompt 构建器只能使用检索服务返回的片段。
- Provider 层不允许自行读取文件。
- 敏感范围可限制为仅本地模型。

## 7. AI Provider 抽象

所有模型服务商应实现统一接口。

```ts
interface AIProvider {
  id: string;
  chat(request: ChatRequest): Promise<ChatResponse>;
  streamChat?(request: ChatRequest): AsyncIterable<ChatStreamEvent>;
  embed?(request: EmbedRequest): Promise<EmbedResponse>;
}
```

Provider 层只负责协议适配，不处理 Obsidian 文件、不处理 UI、不处理业务策略。

## 8. 检索策略

MVP 可先实现本地文本检索，后续扩展向量检索。

阶段策略：

1. 使用文件名、标题、标签、正文片段做关键词检索。
2. 支持 Markdown 标题级分块。
3. 增加 Embedding 生成与本地向量索引。
4. 结合关键词分数和向量分数做混合检索。
5. 引用来源直接来自检索片段。

## 9. UI 层设计

UI 层只负责展示和交互，不直接调用 Provider，也不直接读取大量文件。

主要界面：

- AI 侧边栏。
- 设置页。
- 上下文切换器。
- 已授权文件检查器。
- Prompt 模板管理。
- 差异预览弹窗。
- 知识库健康检查结果页。
- 可编辑图谱生成弹窗。

## 10. 错误处理

常见错误应给出明确提示：

- 未配置 API Key。
- 当前上下文范围为空。
- 当前模型不允许访问云端。
- 请求超时。
- Provider 返回认证错误。
- 检索索引尚未建立。
- AI 返回内容无法应用到编辑器。

## 11. 后续扩展点

- 自动 MOC 生成器。
- 知识库健康检查。
- 周报和日记复盘工作流。
- 多模型任务路由。
- 本地向量索引持久化。
- 基于现有 Excalidraw 画布的增量修改。
- 大型知识库的交互式全局图谱浏览器。
- 对话记忆压缩。
- 批量笔记整理队列。
