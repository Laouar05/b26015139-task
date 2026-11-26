"""Database models for the Task Manager project."""
from datetime import datetime, timezone

from flask_sqlalchemy import SQLAlchemy
from sqlalchemy import event, text


db = SQLAlchemy()


def enable_sqlite_foreign_keys(engine):
    @event.listens_for(engine, "connect")
    def enable_foreign_keys(connection, _record):
        connection.execute("PRAGMA foreign_keys=ON")


def utcnow():
    """Timezone-aware UTC timestamp used as a column default."""
    return datetime.now(timezone.utc)


def timestamp_to_iso(value):
    if value is None:
        return None
    # SQLite drops timezone information when storing our UTC timestamps.
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.isoformat()


user_roles = db.Table(
    "user_roles",
    db.Column("user_id", db.Integer, db.ForeignKey("users.id", ondelete="CASCADE"), primary_key=True),
    db.Column("role_id", db.Integer, db.ForeignKey("roles.id", ondelete="CASCADE"), primary_key=True),
    db.Index("ix_user_roles_role_user", "role_id", "user_id"),
)
role_permissions = db.Table(
    "role_permissions",
    db.Column("role_id", db.Integer, db.ForeignKey("roles.id", ondelete="CASCADE"), primary_key=True),
    db.Column("permission_id", db.Integer, db.ForeignKey("permissions.id", ondelete="CASCADE"), primary_key=True),
    db.Index("ix_role_permissions_permission_role", "permission_id", "role_id"),
)


class User(db.Model):
    __tablename__ = "users"
    __table_args__ = (db.CheckConstraint("session_version >= 1", name="ck_user_session_version"),)

    id = db.Column(db.Integer, primary_key=True)
    username = db.Column(db.String(32), unique=True, nullable=False)
    password_hash = db.Column(db.Text, nullable=False)
    is_active = db.Column(db.Boolean, nullable=False, default=True, server_default=text("1"))
    session_version = db.Column(db.Integer, nullable=False, default=1, server_default=text("1"))
    created_at = db.Column(db.DateTime(timezone=True), nullable=False, default=utcnow)
    updated_at = db.Column(db.DateTime(timezone=True), nullable=False, default=utcnow, onupdate=utcnow)
    roles = db.relationship("Role", secondary=user_roles, back_populates="users", lazy="selectin")
    tasks = db.relationship("Task", back_populates="owner", passive_deletes="all")


class Role(db.Model):
    __tablename__ = "roles"

    id = db.Column(db.Integer, primary_key=True)
    code = db.Column(db.String(32), unique=True, nullable=False)
    name = db.Column(db.String(64), nullable=False)
    description = db.Column(db.String(255))
    users = db.relationship("User", secondary=user_roles, back_populates="roles", passive_deletes=True)
    permissions = db.relationship("Permission", secondary=role_permissions, back_populates="roles", lazy="selectin")


class Permission(db.Model):
    __tablename__ = "permissions"

    id = db.Column(db.Integer, primary_key=True)
    code = db.Column(db.String(64), unique=True, nullable=False)
    description = db.Column(db.String(255))
    roles = db.relationship("Role", secondary=role_permissions, back_populates="permissions", passive_deletes=True)


class Task(db.Model):
    __tablename__ = "tasks"
    __table_args__ = (
        db.Index("ix_tasks_owner_created_id", "owner_id", "created_at", "id"),
        db.Index("ix_tasks_owner_completed_created_id", "owner_id", "completed", "created_at", "id"),
    )

    id = db.Column(db.Integer, primary_key=True)
    owner_id = db.Column(db.Integer, db.ForeignKey("users.id", ondelete="RESTRICT"), nullable=False)
    owner = db.relationship("User", back_populates="tasks")
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
            "owner_id": self.owner_id,
            "title": self.title,
            "description": self.description or "",
            "completed": self.completed,
            "created_at": timestamp_to_iso(self.created_at),
            "updated_at": timestamp_to_iso(self.updated_at),
        }

    def __repr__(self):
        return f"<Task {self.id} {self.title!r} completed={self.completed}>"
