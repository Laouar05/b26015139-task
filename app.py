"""Flask application entry point and REST API for the Task Manager."""
from datetime import datetime

from flask import Flask, render_template, request, jsonify
from sqlalchemy import select

from config import Config
from llm import LLMError, chat_reply, decompose_task, recommend_tasks, validate_task_batch
from models import db, Task


def validate_chat_messages(entries):
    if not isinstance(entries, list) or not 1 <= len(entries) <= 17 or len(entries) % 2 == 0:
        raise ValueError("请提供当前消息和最多 8 轮历史对话。")
    messages = []
    for index, entry in enumerate(entries):
        role, limit = ("user", 2000) if index % 2 == 0 else ("assistant", 4000)
        if not isinstance(entry, dict) or entry.get("role") != role:
            raise ValueError("对话消息须按用户和 AI 的顺序交替排列。")
        content = entry.get("content")
        if not isinstance(content, str) or not 1 <= len(content.strip()) <= limit:
            raise ValueError(f"第 {index + 1} 条消息须为 1 至 {limit} 个字符。")
        content = content.strip()
        try:
            content.encode("utf-8")
        except UnicodeError as exc:
            raise ValueError("聊天消息含有无效字符。") from exc
        messages.append({"role": role, "content": content})
    return messages


def create_app():
    """Application factory: configure the app, bind the DB, register routes."""
    app = Flask(__name__)
    app.config.from_object(Config)

    # Bind the SQLAlchemy extension to this app and ensure tables exist.
    db.init_app(app)
    with app.app_context():
        db.create_all()

    _register_routes(app)
    _register_error_handlers(app)
    return app


def _register_routes(app):
    # ---- HTML page -------------------------------------------------------
    @app.route("/")
    def index():
        return render_template("index.html")

    @app.post("/api/chat")
    def chat():
        if not request.is_json:
            return jsonify({"error": "请输入有效的 JSON 对象。"}), 400
        limit = 768 * 1024
        raw = request.stream.read(limit + 1)
        if len(raw) > limit:
            return jsonify({"error": "对话请求过长。"}), 413
        try:
            data = app.json.loads(raw)
        except (ValueError, RecursionError):
            return jsonify({"error": "请输入有效的 JSON 对象。"}), 400
        if not isinstance(data, dict):
            return jsonify({"error": "请输入有效的 JSON 对象。"}), 400
        try:
            messages = validate_chat_messages(data.get("messages"))
        except ValueError as exc:
            return jsonify({"error": str(exc)}), 400

        task_id = data.get("task_id")
        context = None
        if task_id is not None:
            if type(task_id) is not int or not 0 < task_id <= 2**63 - 1:
                return jsonify({"error": "计划 ID 无效。"}), 400
            task = db.session.get(Task, task_id)
            if task is None:
                return jsonify({"error": "计划不存在或已删除。"}), 404
            context = {
                "title": task.title,
                "description": (task.description or "")[:4000],
                "completed": task.completed,
            }
            db.session.remove()
        try:
            reply = chat_reply(app.config, messages, context)
        except LLMError as exc:
            return jsonify({"error": str(exc)}), exc.status
        return jsonify({"reply": reply})

    # ---- Task API --------------------------------------------------------

    @app.post("/api/recommendations/today")
    def today_recommendations():
        data = request.get_json(silent=True)
        if not isinstance(data, dict):
            return jsonify({"error": "请输入有效的 JSON 对象。"}), 400
        context = data.get("context", "")
        if not isinstance(context, str) or len(context.strip()) > 300:
            return jsonify({"error": "今天的安排最多填写 300 个字符。"}), 400

        stmt = (
            select(Task.id, Task.title, Task.description)
            .where(Task.completed.is_(False))
            .order_by(Task.created_at.desc(), Task.id.desc())
        )
        tasks = [
            {"id": task_id, "title": title, "description": (description or "")[:1000]}
            for task_id, title, description in db.session.execute(stmt)
        ]
        if not tasks:
            return jsonify({"recommendations": []})

        try:
            recommendations = recommend_tasks(
                app.config, tasks, context.strip(), datetime.now().astimezone().isoformat(timespec="minutes")
            )
        except LLMError as exc:
            return jsonify({"error": str(exc)}), exc.status
        return jsonify({"recommendations": recommendations})

    @app.post("/api/tasks/decompose")
    def draft_tasks():
        data = request.get_json(silent=True)
        goal = data.get("goal") if isinstance(data, dict) else None
        if not isinstance(goal, str) or not 1 <= len(goal.strip()) <= 2000:
            return jsonify({"error": "请输入大任务目标（1 至 2000 个字符）。"}), 400
        try:
            goal = goal.strip()
            goal.encode("utf-8")
            tasks = decompose_task(app.config, goal)
        except UnicodeError:
            return jsonify({"error": "大任务目标含有无效字符。"}), 400
        except LLMError as exc:
            return jsonify({"error": str(exc)}), exc.status
        return jsonify({"tasks": tasks})

    @app.post("/api/tasks/batch")
    def create_tasks():
        data = request.get_json(silent=True)
        try:
            entries = validate_task_batch(data.get("tasks") if isinstance(data, dict) else None)
        except ValueError as exc:
            return jsonify({"error": str(exc)}), 400

        tasks = [Task(**entry) for entry in entries]
        db.session.add_all(reversed(tasks))
        db.session.commit()
        return jsonify({"tasks": [task.to_dict() for task in tasks]}), 201

    @app.route("/api/tasks", methods=["GET"])
    def list_tasks():
        """List tasks. Optional ?status=all|active|completed filter."""
        status = request.args.get("status", "all")
        stmt = select(Task)
        if status == "active":
            stmt = stmt.where(Task.completed.is_(False))
        elif status == "completed":
            stmt = stmt.where(Task.completed.is_(True))
        stmt = stmt.order_by(Task.created_at.desc(), Task.id.desc())
        tasks = db.session.scalars(stmt).all()
        return jsonify([t.to_dict() for t in tasks])

    @app.route("/api/tasks", methods=["POST"])
    def create_task():
        """Create a new task from JSON body {title, description?}."""
        data = request.get_json(silent=True) or {}
        title = (data.get("title") or "").strip()
        if not title:
            return jsonify({"error": "标题为必填项"}), 400
        if len(title) > 200:
            return jsonify({"error": "标题过长（最多 200 个字符）"}), 400

        description = (data.get("description") or "").strip()
        task = Task(title=title, description=description)
        db.session.add(task)
        db.session.commit()
        return jsonify(task.to_dict()), 201

    @app.route("/api/tasks/<int:task_id>", methods=["GET"])
    def get_task(task_id):
        task = db.session.get(Task, task_id)
        if task is None:
            return jsonify({"error": "任务不存在"}), 404
        return jsonify(task.to_dict())

    @app.route("/api/tasks/<int:task_id>", methods=["PUT"])
    def update_task(task_id):
        """Update title / description / completed (partial update supported)."""
        task = db.session.get(Task, task_id)
        if task is None:
            return jsonify({"error": "任务不存在"}), 404

        data = request.get_json(silent=True) or {}
        if "title" in data:
            title = (data.get("title") or "").strip()
            if not title:
                return jsonify({"error": "标题不能为空"}), 400
            if len(title) > 200:
                return jsonify({"error": "标题过长（最多 200 个字符）"}), 400
            task.title = title
        if "description" in data:
            task.description = (data.get("description") or "").strip()
        if "completed" in data:
            task.completed = bool(data.get("completed"))

        db.session.commit()
        return jsonify(task.to_dict())

    @app.route("/api/tasks/<int:task_id>/toggle", methods=["PATCH"])
    def toggle_task(task_id):
        """Flip the completed flag."""
        task = db.session.get(Task, task_id)
        if task is None:
            return jsonify({"error": "任务不存在"}), 404
        task.completed = not task.completed
        db.session.commit()
        return jsonify(task.to_dict())

    @app.route("/api/tasks/<int:task_id>", methods=["DELETE"])
    def delete_task(task_id):
        task = db.session.get(Task, task_id)
        if task is None:
            return jsonify({"error": "任务不存在"}), 404
        db.session.delete(task)
        db.session.commit()
        return "", 204


def _register_error_handlers(app):
    def _wants_json():
        return request.path.startswith("/api/")

    @app.errorhandler(404)
    def not_found(_e):
        if _wants_json():
            return jsonify({"error": "资源不存在"}), 404
        return "页面未找到", 404

    @app.errorhandler(405)
    def method_not_allowed(_e):
        if _wants_json():
            return jsonify({"error": "请求方法不允许"}), 405
        return "请求方法不允许", 405

    @app.errorhandler(500)
    def server_error(_e):
        db.session.rollback()
        if _wants_json():
            return jsonify({"error": "服务器内部错误"}), 500
        return "服务器内部错误", 500


app = create_app()


if __name__ == "__main__":
    # Development server. For production use a WSGI server (e.g. gunicorn).
    app.run(debug=True, host="127.0.0.1", port=5000)
