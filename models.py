"""Database models for the Task Manager project."""
from datetime import datetime, timezone

from flask_sqlalchemy import SQLAlchemy

# Create the SQLAlchemy extension instance (bound to the app in app.py).
db = SQLAlchemy()


def utcnow():
    """Timezone-aware UTC timestamp used as a column default."""
    return datetime.now(timezone.utc)


class Task(db.Model):
    """A single to-do / task item."""

    __tablename__ = "tasks"

    id = db.Column(db.Integer, primary_key=True)
    title = db.Column(db.String(200), nullable=False)
    description = db.Column(db.Text, nullable=True)
    completed = db.Column(db.Boolean, default=False, nullable=False)
    created_at = db.Column(db.DateTime(timezone=True), default=utcnow, nullable=False)
    updated_at = db.Column(
        db.DateTime(timezone=True), default=utcnow, onupdate=utcnow, nullable=False
    )

    def to_dict(self):
        """Serialize the task into a JSON-friendly dictionary."""
        return {
            "id": self.id,
            "title": self.title,
            "description": self.description or "",
            "completed": self.completed,
            "created_at": self.created_at.isoformat() if self.created_at else None,
            "updated_at": self.updated_at.isoformat() if self.updated_at else None,
        }

    def __repr__(self):
        return f"<Task {self.id} {self.title!r} completed={self.completed}>"
