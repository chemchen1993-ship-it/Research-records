from __future__ import annotations

import argparse
import hashlib
import html
import json
import os
import re
import secrets
import socket
import sqlite3
import threading
import uuid
from datetime import datetime, timedelta, timezone
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import urlparse


APP_ROOT = Path(__file__).resolve().parent
DATA_DIR = Path(os.environ.get("RESEARCH_RECORDS_DATA_DIR", str(APP_ROOT / "sync_data"))).resolve()
DB_PATH = DATA_DIR / "research_records_sync.db"
SECTION_KEYS = ("objective", "conditions", "procedure", "results", "comments")
DEFAULT_SECTION_HEIGHTS = {
    "objective": 220,
    "conditions": 220,
    "procedure": 260,
    "results": 220,
    "comments": 220,
}
DEFAULT_SECTION_HTML = {key: "<p></p>" for key in SECTION_KEYS}
ENTRY_TYPE_REPORT = "experiment_report"
ENTRY_TYPE_NOTES = "notes"
POLL_INTERVAL_MS = 10000
SESSION_DAYS = 30
EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


def now_utc() -> datetime:
    return datetime.now(timezone.utc).replace(microsecond=0)


def now_iso() -> str:
    return now_utc().isoformat().replace("+00:00", "Z")


def today_string() -> str:
    return datetime.now().strftime("%Y-%m-%d")


def clamp_height(value: Any, key: str) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        parsed = DEFAULT_SECTION_HEIGHTS[key]
    return parsed if parsed >= 140 else DEFAULT_SECTION_HEIGHTS[key]


def normalize_visible_sections(raw_keys: Any) -> list[str]:
    source = raw_keys if isinstance(raw_keys, list) else list(SECTION_KEYS)
    normalized = [key for key in SECTION_KEYS if key in source]
    return normalized or ["objective"]


def normalize_attachment(attachment: Any) -> dict[str, Any] | None:
    if not isinstance(attachment, dict):
        return None
    return {
        "id": str(attachment.get("id") or uuid.uuid4()),
        "name": str(attachment.get("name") or "Unnamed Attachment"),
        "type": str(attachment.get("type") or "application/octet-stream"),
        "size": int(attachment.get("size") or 0),
        "lastModified": int(attachment.get("lastModified") or 0),
        "dataBase64": str(attachment.get("dataBase64") or ""),
    }


def normalize_record_payload(payload: Any) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise ValueError("Record payload must be an object.")
    entry_type = ENTRY_TYPE_NOTES if payload.get("type") == ENTRY_TYPE_NOTES else ENTRY_TYPE_REPORT
    created_at = str(payload.get("createdAt") or now_iso())
    updated_at = str(payload.get("updatedAt") or created_at or now_iso())

    section_contents = {
        key: str((payload.get("sectionContents") or {}).get(key) or DEFAULT_SECTION_HTML[key])
        for key in SECTION_KEYS
    }
    section_heights = {
        key: clamp_height((payload.get("sectionHeights") or {}).get(key), key)
        for key in SECTION_KEYS
    }
    attachments = [
        normalized
        for normalized in (normalize_attachment(item) for item in (payload.get("attachments") or []))
        if normalized is not None
    ]

    return {
        "id": str(payload.get("id") or uuid.uuid4()),
        "type": entry_type,
        "title": str(payload.get("title") or ""),
        "project": str(payload.get("project") or ""),
        "tags": "" if entry_type == ENTRY_TYPE_NOTES else str(payload.get("tags") or ""),
        "experimentDate": "" if entry_type == ENTRY_TYPE_NOTES else str(payload.get("experimentDate") or today_string()),
        "createdAt": created_at,
        "updatedAt": updated_at,
        "visibleSectionKeys": list(SECTION_KEYS) if entry_type == ENTRY_TYPE_NOTES else normalize_visible_sections(payload.get("visibleSectionKeys")),
        "sectionContents": section_contents,
        "sectionHeights": section_heights,
        "noteContent": str(payload.get("noteContent") or "<p></p>"),
        "attachments": attachments,
    }


def strip_html(text: str) -> str:
    without_tags = re.sub(r"<[^>]+>", " ", text or "")
    unescaped = html.unescape(without_tags)
    collapsed = re.sub(r"\s+", " ", unescaped).strip()
    return collapsed


def build_search_summary(record: dict[str, Any]) -> str:
    if record["type"] == ENTRY_TYPE_NOTES:
        return strip_html(record.get("noteContent", ""))
    return " ".join(strip_html(record["sectionContents"].get(key, "")) for key in SECTION_KEYS).strip()


def summary_from_record(record: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": record["id"],
        "type": record["type"],
        "title": record["title"],
        "project": record["project"],
        "tags": record["tags"],
        "experimentDate": record["experimentDate"],
        "createdAt": record["createdAt"],
        "updatedAt": record["updatedAt"],
        "searchSummary": build_search_summary(record),
        "attachmentCount": len(record.get("attachments", [])),
    }


def normalize_email(value: Any) -> str:
    return str(value or "").strip().lower()


def validate_email(email: str) -> str:
    normalized = normalize_email(email)
    if not normalized or not EMAIL_RE.match(normalized):
        raise ValueError("Enter a valid email address.")
    return normalized


def validate_password(password: Any) -> str:
    value = str(password or "")
    if len(value) < 8:
        raise ValueError("Password must be at least 8 characters.")
    return value


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def hash_password(password: str, salt_hex: str) -> str:
    salt = bytes.fromhex(salt_hex)
    return hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, 120_000).hex()


def public_user(user: sqlite3.Row | dict[str, Any]) -> dict[str, Any]:
    return {
        "id": str(user["id"]),
        "email": str(user["email"]),
        "createdAt": str(user["created_at"] if isinstance(user, sqlite3.Row) else user["createdAt"]),
    }


class SyncStore:
    def __init__(self, db_path: Path) -> None:
        self.db_path = db_path
        self._lock = threading.Lock()
        self._ensure_schema()

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.db_path)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        return connection

    def _ensure_column(self, connection: sqlite3.Connection, table: str, column_name: str, column_sql: str) -> None:
        columns = {
            row["name"]
            for row in connection.execute(f"PRAGMA table_info({table})")
        }
        if column_name not in columns:
            connection.execute(f"ALTER TABLE {table} ADD COLUMN {column_sql}")

    def _ensure_schema(self) -> None:
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        with self._connect() as connection:
            connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS users (
                    id TEXT PRIMARY KEY,
                    email TEXT NOT NULL UNIQUE,
                    password_hash TEXT NOT NULL,
                    password_salt TEXT NOT NULL,
                    created_at TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS sessions (
                    id TEXT PRIMARY KEY,
                    user_id TEXT NOT NULL,
                    token_hash TEXT NOT NULL UNIQUE,
                    created_at TEXT NOT NULL,
                    expires_at TEXT NOT NULL,
                    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
                );

                CREATE INDEX IF NOT EXISTS idx_sessions_token_hash
                    ON sessions(token_hash);

                CREATE TABLE IF NOT EXISTS records (
                    id TEXT PRIMARY KEY,
                    user_id TEXT NOT NULL DEFAULT '',
                    type TEXT NOT NULL,
                    title TEXT NOT NULL,
                    project TEXT NOT NULL,
                    tags TEXT NOT NULL,
                    experiment_date TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    search_summary TEXT NOT NULL,
                    attachment_count INTEGER NOT NULL DEFAULT 0,
                    record_json TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS versions (
                    id TEXT PRIMARY KEY,
                    user_id TEXT NOT NULL DEFAULT '',
                    record_id TEXT NOT NULL,
                    version_no INTEGER NOT NULL,
                    saved_at TEXT NOT NULL,
                    snapshot_json TEXT NOT NULL,
                    FOREIGN KEY(record_id) REFERENCES records(id) ON DELETE CASCADE
                );
                """
            )
            self._ensure_column(connection, "records", "user_id", "user_id TEXT NOT NULL DEFAULT ''")
            self._ensure_column(connection, "versions", "user_id", "user_id TEXT NOT NULL DEFAULT ''")
            connection.execute(
                """
                CREATE INDEX IF NOT EXISTS idx_records_user_updated_at
                    ON records(user_id, updated_at DESC)
                """
            )
            connection.execute(
                """
                CREATE INDEX IF NOT EXISTS idx_versions_user_record
                    ON versions(user_id, record_id, version_no DESC)
                """
            )
            connection.commit()

    def create_user(self, email: Any, password: Any) -> dict[str, Any]:
        normalized_email = validate_email(email)
        password_value = validate_password(password)
        created_at = now_iso()
        user_id = str(uuid.uuid4())
        salt = secrets.token_hex(16)
        password_hash = hash_password(password_value, salt)
        with self._lock, self._connect() as connection:
            try:
                connection.execute(
                    """
                    INSERT INTO users (id, email, password_hash, password_salt, created_at)
                    VALUES (?, ?, ?, ?, ?)
                    """,
                    (user_id, normalized_email, password_hash, salt, created_at),
                )
                connection.commit()
            except sqlite3.IntegrityError as error:
                raise ValueError("That email is already registered.") from error
        return {"id": user_id, "email": normalized_email, "createdAt": created_at}

    def verify_user(self, email: Any, password: Any) -> dict[str, Any]:
        normalized_email = validate_email(email)
        password_value = validate_password(password)
        with self._connect() as connection:
            row = connection.execute(
                "SELECT id, email, password_hash, password_salt, created_at FROM users WHERE email = ?",
                (normalized_email,),
            ).fetchone()
        if row is None:
            raise ValueError("Invalid email or password.")
        expected_hash = hash_password(password_value, row["password_salt"])
        if expected_hash != row["password_hash"]:
            raise ValueError("Invalid email or password.")
        return {
            "id": row["id"],
            "email": row["email"],
            "createdAt": row["created_at"],
        }

    def create_session(self, user_id: str) -> dict[str, Any]:
        raw_token = secrets.token_urlsafe(48)
        created_at = now_utc()
        expires_at = created_at + timedelta(days=SESSION_DAYS)
        with self._lock, self._connect() as connection:
            connection.execute(
                """
                INSERT INTO sessions (id, user_id, token_hash, created_at, expires_at)
                VALUES (?, ?, ?, ?, ?)
                """,
                (
                    str(uuid.uuid4()),
                    user_id,
                    hash_token(raw_token),
                    created_at.isoformat().replace("+00:00", "Z"),
                    expires_at.isoformat().replace("+00:00", "Z"),
                ),
            )
            connection.commit()
        return {
            "token": raw_token,
            "expiresAt": expires_at.isoformat().replace("+00:00", "Z"),
        }

    def delete_session(self, raw_token: str) -> None:
        if not raw_token:
            return
        with self._lock, self._connect() as connection:
            connection.execute("DELETE FROM sessions WHERE token_hash = ?", (hash_token(raw_token),))
            connection.commit()

    def get_user_by_token(self, raw_token: str | None) -> dict[str, Any] | None:
        if not raw_token:
            return None
        token_hash = hash_token(raw_token)
        with self._lock, self._connect() as connection:
            connection.execute("DELETE FROM sessions WHERE expires_at <= ?", (now_iso(),))
            row = connection.execute(
                """
                SELECT users.id, users.email, users.created_at
                FROM sessions
                JOIN users ON users.id = sessions.user_id
                WHERE sessions.token_hash = ? AND sessions.expires_at > ?
                """,
                (token_hash, now_iso()),
            ).fetchone()
            connection.commit()
        if row is None:
            return None
        return {
            "id": row["id"],
            "email": row["email"],
            "createdAt": row["created_at"],
        }

    def list_records(self, user_id: str) -> list[dict[str, Any]]:
        with self._connect() as connection:
            rows = connection.execute(
                """
                SELECT id, type, title, project, tags, experiment_date, created_at, updated_at, search_summary, attachment_count
                FROM records
                WHERE user_id = ?
                ORDER BY updated_at DESC, id DESC
                """,
                (user_id,),
            ).fetchall()
        return [
            {
                "id": row["id"],
                "type": row["type"],
                "title": row["title"],
                "project": row["project"],
                "tags": row["tags"],
                "experimentDate": row["experiment_date"],
                "createdAt": row["created_at"],
                "updatedAt": row["updated_at"],
                "searchSummary": row["search_summary"],
                "attachmentCount": row["attachment_count"],
            }
            for row in rows
        ]

    def get_record(self, user_id: str, record_id: str) -> dict[str, Any] | None:
        with self._connect() as connection:
            row = connection.execute(
                "SELECT record_json FROM records WHERE id = ? AND user_id = ?",
                (record_id, user_id),
            ).fetchone()
        if row is None:
            return None
        return normalize_record_payload(json.loads(row["record_json"]))

    def get_versions(self, user_id: str, record_id: str) -> list[dict[str, Any]]:
        with self._connect() as connection:
            rows = connection.execute(
                """
                SELECT id, record_id, version_no, saved_at, snapshot_json
                FROM versions
                WHERE user_id = ? AND record_id = ?
                ORDER BY version_no DESC
                """,
                (user_id, record_id),
            ).fetchall()
        return [
            {
                "id": row["id"],
                "recordId": row["record_id"],
                "versionNo": row["version_no"],
                "savedAt": row["saved_at"],
                "snapshot": normalize_record_payload(json.loads(row["snapshot_json"])),
            }
            for row in rows
        ]

    def save_record(self, user_id: str, record_payload: Any) -> dict[str, Any]:
        record = normalize_record_payload(record_payload)
        record_json = json.dumps(record, ensure_ascii=False, separators=(",", ":"))
        summary = summary_from_record(record)

        with self._lock, self._connect() as connection:
            owner_row = connection.execute(
                "SELECT user_id FROM records WHERE id = ?",
                (record["id"],),
            ).fetchone()
            if owner_row is not None and owner_row["user_id"] != user_id:
                raise ValueError("That record belongs to another account.")
            current_row = connection.execute(
                "SELECT MAX(version_no) AS max_version FROM versions WHERE record_id = ? AND user_id = ?",
                (record["id"], user_id),
            ).fetchone()
            next_version = int(current_row["max_version"] or 0) + 1
            connection.execute(
                """
                INSERT INTO records (
                    id, user_id, type, title, project, tags, experiment_date, created_at, updated_at, search_summary, attachment_count, record_json
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    user_id = excluded.user_id,
                    type = excluded.type,
                    title = excluded.title,
                    project = excluded.project,
                    tags = excluded.tags,
                    experiment_date = excluded.experiment_date,
                    created_at = excluded.created_at,
                    updated_at = excluded.updated_at,
                    search_summary = excluded.search_summary,
                    attachment_count = excluded.attachment_count,
                    record_json = excluded.record_json
                """,
                (
                    record["id"],
                    user_id,
                    record["type"],
                    record["title"],
                    record["project"],
                    record["tags"],
                    record["experimentDate"],
                    record["createdAt"],
                    record["updatedAt"],
                    summary["searchSummary"],
                    summary["attachmentCount"],
                    record_json,
                ),
            )
            connection.execute(
                """
                INSERT INTO versions (id, user_id, record_id, version_no, saved_at, snapshot_json)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (
                    f"{record['id']}:{next_version}",
                    user_id,
                    record["id"],
                    next_version,
                    record["updatedAt"],
                    record_json,
                ),
            )
            connection.commit()

        return {
            "record": record,
            "summary": summary,
            "versionNo": next_version,
        }

    def delete_record(self, user_id: str, record_id: str) -> bool:
        with self._lock, self._connect() as connection:
            cursor = connection.execute(
                "DELETE FROM records WHERE id = ? AND user_id = ?",
                (record_id, user_id),
            )
            connection.execute(
                "DELETE FROM versions WHERE record_id = ? AND user_id = ?",
                (record_id, user_id),
            )
            connection.commit()
        return cursor.rowcount > 0


STORE = SyncStore(DB_PATH)


class SyncRequestHandler(SimpleHTTPRequestHandler):
    server_version = "ResearchRecordsSync/2.0"

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, directory=str(APP_ROOT), **kwargs)

    def end_headers(self) -> None:
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def send_json(self, payload: Any, status: HTTPStatus = HTTPStatus.OK) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def send_json_error(self, status: HTTPStatus, message: str) -> None:
        self.send_json({"error": message}, status)

    def read_json_body(self) -> Any:
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError as error:
            raise ValueError("Invalid Content-Length header.") from error
        raw = self.rfile.read(length) if length else b"{}"
        try:
            return json.loads(raw.decode("utf-8") or "{}")
        except json.JSONDecodeError as error:
            raise ValueError("Request body must be valid JSON.") from error

    def api_segments(self) -> list[str] | None:
        parsed = urlparse(self.path)
        if not parsed.path.startswith("/api/"):
            return None
        return [segment for segment in parsed.path.split("/") if segment][1:]

    def bearer_token(self) -> str | None:
        header = self.headers.get("Authorization", "")
        if not header.lower().startswith("bearer "):
            return None
        return header.split(" ", 1)[1].strip() or None

    def current_user(self) -> dict[str, Any] | None:
        return STORE.get_user_by_token(self.bearer_token())

    def require_user(self) -> dict[str, Any] | None:
        user = self.current_user()
        if user is None:
            self.send_json_error(HTTPStatus.UNAUTHORIZED, "Sign in first.")
            return None
        return user

    def handle_auth_register(self) -> None:
        try:
            payload = self.read_json_body()
            user = STORE.create_user(payload.get("email"), payload.get("password"))
            session = STORE.create_session(user["id"])
        except ValueError as error:
            self.send_json_error(HTTPStatus.BAD_REQUEST, str(error))
            return
        self.send_json(
            {
                "user": user,
                "session": session,
            },
            HTTPStatus.CREATED,
        )

    def handle_auth_login(self) -> None:
        try:
            payload = self.read_json_body()
            user = STORE.verify_user(payload.get("email"), payload.get("password"))
            session = STORE.create_session(user["id"])
        except ValueError as error:
            self.send_json_error(HTTPStatus.BAD_REQUEST, str(error))
            return
        self.send_json({"user": user, "session": session})

    def handle_auth_logout(self) -> None:
        STORE.delete_session(self.bearer_token() or "")
        self.send_response(HTTPStatus.NO_CONTENT)
        self.end_headers()

    def handle_auth_me(self) -> None:
        user = self.require_user()
        if user is None:
            return
        self.send_json({"user": user})

    def do_GET(self) -> None:
        segments = self.api_segments()
        if segments is None:
            super().do_GET()
            return

        if segments == ["health"]:
            self.send_json(
                {
                    "ok": True,
                    "serverTime": now_iso(),
                    "pollIntervalMs": POLL_INTERVAL_MS,
                    "storagePath": str(DB_PATH),
                }
            )
            return

        if segments == ["auth", "me"]:
            self.handle_auth_me()
            return

        user = self.require_user()
        if user is None:
            return

        if segments == ["records"]:
            self.send_json({"records": STORE.list_records(user["id"])})
            return

        if len(segments) == 2 and segments[0] == "records":
            record = STORE.get_record(user["id"], segments[1])
            if record is None:
                self.send_json_error(HTTPStatus.NOT_FOUND, "Record not found.")
                return
            self.send_json({"record": record})
            return

        if len(segments) == 3 and segments[0] == "records" and segments[2] == "versions":
            self.send_json({"versions": STORE.get_versions(user["id"], segments[1])})
            return

        self.send_json_error(HTTPStatus.NOT_FOUND, "Unknown API endpoint.")

    def do_POST(self) -> None:
        segments = self.api_segments()
        if segments == ["auth", "register"]:
            self.handle_auth_register()
            return
        if segments == ["auth", "login"]:
            self.handle_auth_login()
            return
        if segments == ["auth", "logout"]:
            self.handle_auth_logout()
            return

        user = self.require_user()
        if user is None:
            return

        if segments == ["records"]:
            try:
                payload = self.read_json_body()
                result = STORE.save_record(user["id"], payload.get("record"))
            except ValueError as error:
                self.send_json_error(HTTPStatus.BAD_REQUEST, str(error))
                return
            except Exception as error:  # pragma: no cover
                self.send_json_error(HTTPStatus.INTERNAL_SERVER_ERROR, f"Failed to save record: {error}")
                return
            self.send_json(result, HTTPStatus.CREATED)
            return

        self.send_json_error(HTTPStatus.NOT_FOUND, "Unknown API endpoint.")

    def do_DELETE(self) -> None:
        segments = self.api_segments()
        user = self.require_user()
        if user is None:
            return

        if len(segments) == 2 and segments[0] == "records":
            removed = STORE.delete_record(user["id"], segments[1])
            if not removed:
                self.send_json_error(HTTPStatus.NOT_FOUND, "Record not found.")
                return
            self.send_response(HTTPStatus.NO_CONTENT)
            self.end_headers()
            return

        self.send_json_error(HTTPStatus.NOT_FOUND, "Unknown API endpoint.")


def discover_urls(port: int) -> list[str]:
    urls = [f"http://127.0.0.1:{port}", f"http://localhost:{port}"]
    try:
        hostname = socket.gethostname()
        addresses = {
            info[4][0]
            for info in socket.getaddrinfo(hostname, port, family=socket.AF_INET, type=socket.SOCK_STREAM)
            if info[4][0] and not info[4][0].startswith("127.")
        }
        urls.extend(f"http://{address}:{port}" for address in sorted(addresses))
    except OSError:
        pass
    return list(dict.fromkeys(urls))


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Research Records PWA sync server")
    default_host = os.environ.get("HOST", "0.0.0.0")
    try:
        default_port = int(os.environ.get("PORT", "8735"))
    except ValueError:
        default_port = 8735
    parser.add_argument("--host", default=default_host, help=f"Host interface to bind. Default: {default_host}")
    parser.add_argument("--port", type=int, default=default_port, help=f"Port to bind. Default: {default_port}")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    server = ThreadingHTTPServer((args.host, args.port), SyncRequestHandler)
    urls = discover_urls(args.port)
    print("Research Records sync server is running.")
    print(f"SQLite storage: {DB_PATH}")
    print("Open one of these URLs:")
    for url in urls:
        print(f"  {url}")
    print("Accounts, sessions, and per-user synced records are enabled.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping sync server...")
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
