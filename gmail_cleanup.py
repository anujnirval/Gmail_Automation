from __future__ import annotations

import argparse
import collections
import dataclasses
import email.utils
import pathlib
import sys
from typing import Any


ROOT = pathlib.Path(__file__).resolve().parent
CREDENTIALS_FILE = ROOT / "credentials.json"
TOKEN_FILE = ROOT / "token.json"
SCOPES = [
    "https://www.googleapis.com/auth/gmail.modify",
    "https://www.googleapis.com/auth/gmail.labels",
]


@dataclasses.dataclass(frozen=True)
class Rule:
    name: str
    query: str
    actions: tuple[Any, ...]


def get_service():
    try:
        import truststore

        truststore.inject_into_ssl()
    except ModuleNotFoundError:
        pass

    try:
        from google.auth.transport.requests import Request
        from google.oauth2.credentials import Credentials
        from google_auth_oauthlib.flow import InstalledAppFlow
        from googleapiclient.discovery import build
    except ModuleNotFoundError as exc:
        raise SystemExit(
            f"Missing dependency: {exc.name}. Install dependencies with "
            "'pip install -r requirements.txt'."
        ) from exc

    creds = None
    if TOKEN_FILE.exists():
        creds = Credentials.from_authorized_user_file(str(TOKEN_FILE), SCOPES)

    if not creds or not creds.valid:
        if creds and creds.expired and creds.refresh_token:
            creds.refresh(Request())
        else:
            if not CREDENTIALS_FILE.exists():
                raise SystemExit(
                    f"Missing {CREDENTIALS_FILE}. Download a Google OAuth desktop "
                    "client JSON file and save it there."
                )
            flow = InstalledAppFlow.from_client_secrets_file(str(CREDENTIALS_FILE), SCOPES)
            creds = flow.run_local_server(port=0)

        TOKEN_FILE.write_text(creds.to_json(), encoding="utf-8")

    return build("gmail", "v1", credentials=creds)


def load_rules(path: pathlib.Path) -> list[Rule]:
    try:
        import yaml
    except ModuleNotFoundError as exc:
        raise SystemExit(
            "Missing dependency: PyYAML. Install dependencies with "
            "'pip install -r requirements.txt'."
        ) from exc

    raw = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    rules = raw.get("rules", [])
    if not isinstance(rules, list):
        raise SystemExit("rules.yml must contain a top-level 'rules' list.")

    parsed = []
    for index, item in enumerate(rules, start=1):
        if not isinstance(item, dict):
            raise SystemExit(f"Rule {index} must be an object.")
        name = item.get("name")
        query = item.get("query")
        actions = item.get("actions")
        if not name or not query or not isinstance(actions, list):
            raise SystemExit(f"Rule {index} requires name, query, and actions list.")
        parsed.append(Rule(name=str(name), query=str(query), actions=tuple(actions)))
    return parsed


def list_message_ids(service, query: str, limit: int) -> list[str]:
    ids: list[str] = []
    request = service.users().messages().list(userId="me", q=query, maxResults=min(limit, 500))

    while request is not None and len(ids) < limit:
        response = request.execute()
        ids.extend(message["id"] for message in response.get("messages", []))
        if len(ids) >= limit:
            break
        request = service.users().messages().list_next(request, response)

    return ids[:limit]


def get_message_metadata(service, message_id: str) -> dict[str, str]:
    response = (
        service.users()
        .messages()
        .get(
            userId="me",
            id=message_id,
            format="metadata",
            metadataHeaders=["From", "Subject", "Date"],
        )
        .execute()
    )
    headers = response.get("payload", {}).get("headers", [])
    return {header["name"].lower(): header.get("value", "") for header in headers}


def analyze(service, limit: int) -> None:
    query = "in:inbox"
    ids = list_message_ids(service, query, limit)
    senders: collections.Counter[str] = collections.Counter()

    for message_id in ids:
        metadata = get_message_metadata(service, message_id)
        sender = email.utils.parseaddr(metadata.get("from", ""))[1] or metadata.get("from", "")
        senders[sender.lower()] += 1

    print(f"Scanned {len(ids)} inbox messages.")
    print("\nTop senders:")
    for sender, count in senders.most_common(25):
        print(f"{count:4}  {sender}")

    buckets = {
        "Promotions older than 30d": "in:inbox category:promotions older_than:30d",
        "Social older than 30d": "in:inbox category:social older_than:30d",
        "Unread older than 30d": "in:inbox is:unread older_than:30d",
        "Large attachments": "in:inbox larger:10M",
    }
    print("\nUseful cleanup buckets:")
    for label, bucket_query in buckets.items():
        count = len(list_message_ids(service, bucket_query, limit))
        suffix = "+" if count == limit else ""
        print(f"{count:4}{suffix}  {label}  [{bucket_query}]")


def ensure_label(service, name: str) -> str:
    labels_response = service.users().labels().list(userId="me").execute()
    for label in labels_response.get("labels", []):
        if label.get("name", "").casefold() == name.casefold():
            return label["id"]

    try:
        created = (
            service.users()
            .labels()
            .create(userId="me", body={"name": name, "labelListVisibility": "labelShow"})
            .execute()
        )
        return created["id"]
    except Exception as exc:
        if getattr(getattr(exc, "resp", None), "status", None) != 409:
            raise
        labels_response = service.users().labels().list(userId="me").execute()
        for label in labels_response.get("labels", []):
            if label.get("name", "").casefold() == name.casefold():
                return label["id"]
        raise


def action_labels(service, actions: tuple[Any, ...]) -> tuple[list[str], list[str], bool]:
    add_label_ids: list[str] = []
    remove_label_ids: list[str] = []
    trash = False

    for action in actions:
        if action == "archive":
            remove_label_ids.append("INBOX")
        elif action == "mark_read":
            remove_label_ids.append("UNREAD")
        elif action == "trash":
            trash = True
        elif isinstance(action, dict) and "label" in action:
            add_label_ids.append(ensure_label(service, str(action["label"])))
        else:
            raise SystemExit(f"Unsupported action: {action!r}")

    return add_label_ids, remove_label_ids, trash


def print_plan(service, rules: list[Rule], limit: int, samples: int = 0) -> dict[str, list[str]]:
    planned: dict[str, list[str]] = {}
    for rule in rules:
        ids = list_message_ids(service, rule.query, limit)
        planned[rule.name] = ids
        print(f"{rule.name}: {len(ids)} message(s)")
        print(f"  query: {rule.query}")
        print(f"  actions: {format_actions(rule.actions)}")
        for message_id in ids[:samples]:
            metadata = get_message_metadata(service, message_id)
            sender = metadata.get("from", "").replace("\n", " ")
            subject = metadata.get("subject", "").replace("\n", " ")
            date = metadata.get("date", "").replace("\n", " ")
            print(f"  sample: {date} | {sender} | {subject}")
    return planned


def format_actions(actions: tuple[Any, ...]) -> str:
    formatted = []
    for action in actions:
        if isinstance(action, dict):
            formatted.append(", ".join(f"{key}={value}" for key, value in action.items()))
        else:
            formatted.append(str(action))
    return "; ".join(formatted)


def apply_rules(service, rules: list[Rule], limit: int, confirm: bool) -> None:
    if not confirm:
        raise SystemExit("Refusing to modify Gmail without --confirm.")

    for rule in rules:
        ids = list_message_ids(service, rule.query, limit)
        if not ids:
            print(f"{rule.name}: no matches")
            continue

        add_label_ids, remove_label_ids, trash = action_labels(service, rule.actions)
        if trash:
            for message_id in ids:
                service.users().messages().trash(userId="me", id=message_id).execute()
        else:
            service.users().messages().batchModify(
                userId="me",
                body={
                    "ids": ids,
                    "addLabelIds": add_label_ids,
                    "removeLabelIds": remove_label_ids,
                },
            ).execute()

        print(f"{rule.name}: applied to {len(ids)} message(s)")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Analyze and clean a Gmail inbox.")
    subparsers = parser.add_subparsers(dest="command", required=True)

    analyze_parser = subparsers.add_parser("analyze", help="Summarize inbox clutter.")
    analyze_parser.add_argument("--limit", type=int, default=500)

    for command in ("plan", "apply"):
        command_parser = subparsers.add_parser(command)
        command_parser.add_argument("--rules", type=pathlib.Path, default=ROOT / "rules.yml")
        command_parser.add_argument("--limit", type=int, default=200)
        if command == "plan":
            command_parser.add_argument("--samples", type=int, default=0)
        if command == "apply":
            command_parser.add_argument("--confirm", action="store_true")

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    service = get_service()

    if args.command == "analyze":
        analyze(service, args.limit)
        return 0

    rules = load_rules(args.rules)
    if args.command == "plan":
        print_plan(service, rules, args.limit, args.samples)
        return 0

    if args.command == "apply":
        apply_rules(service, rules, args.limit, args.confirm)
        return 0

    parser.error(f"Unknown command: {args.command}")
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
