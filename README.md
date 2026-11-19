# 任务管理器（Python 全栈示例）

一个包含**前端 + 后端 + 数据库**的小型项目，基于 **Flask**、**SQLite** 与原生
**HTML/CSS/JavaScript** 构建，演示了一个完整的增删改查（CRUD）应用。

## 功能特性

- ➕ 添加任务（标题 + 可选描述）
- ✅ 切换完成状态
- ✏️ 编辑 / 🗑️ 删除任务
- 🔍 按 全部 / 进行中 / 已完成 筛选
- 💾 通过 SQLAlchemy 将数据持久化到 SQLite 数据库
- 🎨 简洁的深色响应式界面

## 技术栈

| 层级   | 技术                              |
|--------|-----------------------------------|
| 后端   | Flask（REST API）                 |
| 数据库 | SQLite + Flask-SQLAlchemy（ORM）  |
| 前端   | HTML、CSS、原生 JavaScript        |

## 项目结构

```
task/
├── app.py              # Flask 应用工厂 + REST API 路由
├── models.py           # SQLAlchemy 的 Task 数据模型
├── config.py           # 配置（数据库 URI、密钥）
├── requirements.txt    # 依赖清单
├── templates/
│   └── index.html      # 主页面
├── static/
│   ├── css/style.css   # 样式
│   └── js/app.js       # 前端逻辑（fetch API）
└── task.db             # SQLite 数据库（首次运行自动创建）
```

## 快速开始

### Windows 一键启动

安装 Python 3 后，双击项目根目录的 `start.bat`，或在 PowerShell 中运行 `.\start.bat`。
脚本会创建或复用 `.venv`，安装项目依赖并启动 Flask。首次安装依赖通常需要联网。

看到 Flask 的启动日志后，打开 [http://127.0.0.1:5000](http://127.0.0.1:5000)。
保持启动窗口开启；需要停止服务时按 `Ctrl+C`。

### 手动启动（Windows / macOS / Linux）

1. **创建并激活虚拟环境**（推荐）：

   ```bash
   # Windows
   python -m venv venv
   venv\Scripts\activate

   # macOS / Linux
   python3 -m venv venv
   source venv/bin/activate
   ```

2. **安装依赖**：

   ```bash
   pip install -r requirements.txt
   ```

3. **启动应用**：

   ```bash
   python app.py
   ```

4. 在浏览器中打开 **http://127.0.0.1:5000**

> SQLite 数据库文件（`task.db`）与 `tasks` 表会在首次启动时自动创建，
> 无需手动初始化。

## 今天先做什么？

在任务页填写今天的安排（选填），点击「生成建议」。结果会给出首选任务、最多两件后续任务，以及每件任务的推荐理由和第一步。点击建议里的标题可以定位到原任务。

双击 `start.bat`，看到「是否为本次运行配置 AI？」时，输入 `y` 或「是」，再填写 API 基础地址和 API 密钥。API 地址默认使用 DeepSeek，直接按回车即可采用默认地址。密钥输入时会显示星号。

启动窗口会请求 API 基础地址下的 `/models` 接口，并列出服务返回的模型。输入编号选择模型，也可输入 `M` 手动填写模型 ID。如果无法获取列表，窗口会直接提示手动填写。配置仅本次运行有效。在首个提示或模型列表处按回车即可跳过 AI 配置。

如果已经通过环境变量设置了 `LLM_BASE_URL`、`LLM_MODEL` 和 `LLM_API_KEY`，启动脚本会沿用这些设置并跳过提示。手动运行 `python app.py` 时也可通过这三个变量配置。

服务需兼容 OpenAI Chat Completions。API 基础地址后会自动追加 `/chat/completions`。如果服务的基础地址包括 `/v1`，请保留它。

点击生成时，后端会向配置的模型服务发送未完成任务的 ID、标题、描述（每条最多 1000 个字符）、项目运行机器的当前时间和你填写的安排。推荐只用于展示。模型服务缺失或调用失败时，仍可正常管理任务。

## AI 分解任务

在「AI 分解任务」中填写目标和约束，例如「两周内完成实习汇报，并至少彩排一次」。点击「生成子任务」，模型会给出 2 至 10 项按执行顺序排列的草稿。可修改标题和描述，或移除不需要的项；点击「批量加入任务列表」才会保存。每个子任务都是一条普通待办，可以独立编辑、完成或删除。

该功能复用上方的 AI 配置。生成时只把目标文字发送给模型服务，不发送现有任务；保存草稿时不调用模型。

## REST API

| 方法   | 路径                          | 说明                                |
|--------|-------------------------------|-------------------------------------|
| GET    | `/api/tasks?status=all`       | 获取任务列表（all/active/completed）|
| POST   | `/api/tasks`                  | 新建任务 `{title, description}`     |
| GET    | `/api/tasks/<id>`             | 获取单个任务                        |
| PUT    | `/api/tasks/<id>`             | 更新 标题/描述/完成状态             |
| PATCH  | `/api/tasks/<id>/toggle`      | 切换完成状态                        |
| DELETE | `/api/tasks/<id>`             | 删除任务                            |

## 配置

可选的环境变量：

- `DATABASE_URL` —— 覆盖 SQLite 数据库位置（默认 `sqlite:///task.db`）
- `SECRET_KEY` —— Flask 密钥

## 说明

- 开发服务器以 `debug=True` 运行。生产环境请使用 WSGI 服务器，例如 Gunicorn：
  `gunicorn "app:app"`。
