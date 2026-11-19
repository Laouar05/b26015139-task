"""Flask application entry point and REST API for the Task Manager."""
from datetime import datetime

from flask import Flask, render_template, request, jsonify
from sqlalchemy import select

from config import Config
from llm import RecommendationError, recommend_tasks
from models import db, Task


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
        except RecommendationError as exc:
            return jsonify({"error": str(exc)}), exc.status
        return jsonify({"recommendations": recommendations})

    @app.route("/api/tasks", methods=["GET"])
    def list_tasks():
        """List tasks. Optional ?status=all|active|completed filter."""
        status = request.args.get("status", "all")
        stmt = select(Task)
        if status == "active":
            stmt = stmt.where(Task.completed.is_(False))
        elif status == "completed":
            stmt = stmt.where(Task.completed.is_(True))
        stmt = stmt.order_by(Task.created_at.desc())
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
