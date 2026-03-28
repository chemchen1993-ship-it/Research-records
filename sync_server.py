from __future__ import annotations

import argparse
import html
import json
import os
import re
import socket
import sqlite3
import threading
import uuid
from datetime import datetime, timezone
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


def now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


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

    def _ensure_schema(self) -> None:
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        with self._connect() as connection:
            connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS records (
                    id TEXT PRIMARY KEY,
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

                CREATE INDEX IF NOT EXISTS idx_records_updated_at
                    ON records(updated_at DESC);

                CREATE TABLE IF NOT EXISTS versions (
                    id TEXT PRIMARY KEY,
                    record_id TEXT NOT NULL,
                    version_no INTEGER NOT NULL,
                    saved_at TEXT NOT NULL,
                    snapshot_json TEXT NOT NULL,
                    FOREIGN KEY(record_id) REFERENCES records(id) ON DELETE CASCADE
                );

                CREATE INDEX IF NOT EXISTS idx_versions_record
                    ON versions(record_id, version_no DESC);
                """
            )

    def list_records(self) -> list[dict[str, Any]]:
        with self._connect() as connection:
            rows = connection.execute(
                """
                SELECT id, type, title, project, tags, experiment_date, created_at, updated_at, search_summary, attachment_count
                FROM records
                ORDER BY updated_at DESC, id DESC
                """
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

    def get_record(self, record_id: str) -> dict[str, Any] | None:
        with self._connect() as connection:
            row = connection.execute("SELECT record_json FROM records WHERE id = ?", (record_id,)).fetchone()
        if row is None:
            return None
        return normalize_record_payload(json.loads(row["record_json"]))

    def get_versions(self, record_id: str) -> list[dict[str, Any]]:
        with self._connect() as connection:
            rows = connection.execute(
                """
                SELECT id, record_id, version_no, saved_at, snapshot_json
                FROM versions
                WHERE record_id = ?
                ORDER BY version_no DESC
                """,
                (record_id,),
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

    def save_record(self, record_payload: Any) -> dict[str, Any]:
        record = normalize_record_payload(record_payload)
        record_json = json.dumps(record, ensure_ascii=False, separators=(",", ":"))
        summary = summary_from_record(record)

        with self._lock, self._connect() as connection:
            current_row = connection.execute(
                "SELECT MAX(version_no) AS max_version FROM versions WHERE record_id = ?",
                (record["id"],),
            ).fetchone()
            next_version = int(current_row["max_version"] or 0) + 1
            connection.execute(
                """
                INSERT INTO records (
                    id, type, title, project, tags, experiment_date, created_at, updated_at, search_summary, attachment_count, record_json
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
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
                INSERT INTO versions (id, record_id, version_no, saved_at, snapshot_json)
                VALUES (?, ?, ?, ?, ?)
                """,
                (f"{record['id']}:{next_version}", record["id"], next_version, record["updatedAt"], record_json),
            )
            connection.commit()

        return {
            "record": record,
            "summary": summary,
            "versionNo": next_version,
        }

    def delete_record(self, record_id: str) -> bool:
        with self._lock, self._connect() as connection:
            cursor = connection.execute("DELETE FROM records WHERE id = ?", (record_id,))
            connection.execute("DELETE FROM versions WHERE record_id = ?", (record_id,))
            connection.commit()
        return cursor.rowcount > 0


STORE = SyncStore(DB_PATH)


class SyncRequestHandler(SimpleHTTPRequestHandler):
    server_version = "ResearchRecordsSync/1.0"

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, directory=str(APP_ROOT), **kwargs)

    def end_headers(self) -> None:
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, format: str, *args: Any) -> None:
        super().log_message(format, *args)

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

        if segments == ["records"]:
            self.send_json({"records": STORE.list_records()})
            return

        if len(segments) == 2 and segments[0] == "records":
            record = STORE.get_record(segments[1])
            if record is None:
                self.send_json_error(HTTPStatus.NOT_FOUND, "Record not found.")
                return
            self.send_json({"record": record})
            return

        if len(segments) == 3 and segments[0] == "records" and segments[2] == "versions":
            self.send_json({"versions": STORE.get_versions(segments[1])})
            return

        self.send_json_error(HTTPStatus.NOT_FOUND, "Unknown API endpoint.")

    def do_POST(self) -> None:
        segments = self.api_segments()
        if segments != ["records"]:
            self.send_json_error(HTTPStatus.NOT_FOUND, "Unknown API endpoint.")
            return

        try:
            payload = self.read_json_body()
            result = STORE.save_record(payload.get("record"))
        except ValueError as error:
            self.send_json_error(HTTPStatus.BAD_REQUEST, str(error))
            return
        except Exception as error:  # pragma: no cover - defensive server response
            self.send_json_error(HTTPStatus.INTERNAL_SERVER_ERROR, f"Failed to save record: {error}")
            return

        self.send_json(result, HTTPStatus.CREATED)

    def do_DELETE(self) -> None:
        segments = self.api_segments()
        if len(segments) != 2 or segments[0] != "records":
            self.send_json_error(HTTPStatus.NOT_FOUND, "Unknown API endpoint.")
            return

        removed = STORE.delete_record(segments[1])
        if not removed:
            self.send_json_error(HTTPStatus.NOT_FOUND, "Record not found.")
            return
        self.send_response(HTTPStatus.NO_CONTENT)
        self.end_headers()


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
    print("Use the same URL on this computer and on the iPad (same Wi-Fi) to share data.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping sync server...")
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
