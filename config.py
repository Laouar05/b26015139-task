"""Application configuration for the Task Manager project."""
import os

basedir = os.path.abspath(os.path.dirname(__file__))


class Config:
    """Base configuration object loaded by the Flask app."""

    # Secret key used by Flask for sessions/cookies. Override via env in production.
    SECRET_KEY = os.environ.get("SECRET_KEY") or "dev-secret-key-change-me"

    # SQLite database stored as task.db in the project root.
    # Can be overridden with the DATABASE_URL environment variable.
    SQLALCHEMY_DATABASE_URI = os.environ.get("DATABASE_URL") or "sqlite:///" + os.path.join(
        basedir, "task.db"
    )
    SQLALCHEMY_TRACK_MODIFICATIONS = False
