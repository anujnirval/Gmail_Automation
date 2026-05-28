from __future__ import annotations

import dataclasses
import datetime as dt
import email.utils
import json
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from gmail_cleanup import (
    ROOT,
    Rule,
    action_labels,
    get_message_metadata,
    get_service,
    list_message_ids,
    load_rules,
)


RULES_FILE = ROOT / "rules.yml"
HISTORY_FILE = ROOT / "cleanup_history.jsonl"
UNSUBSCRIBE_HISTORY_FILE = ROOT / "unsubscribe_history.jsonl"

app = FastAPI(title="Gmail Cleanup API")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_methods=["*"],
    allow_headers=["*"],
)


class PlanRequest(BaseModel):
    rule_ids: list[str] = Field(default_factory=list)
    limit: int = Field(default=50, ge=1, le=500)
    samples: int = Field(default=5, ge=0, le=20)


class ApplyRequest(BaseModel):
    rule_ids: list[str] = Field(default_factory=list)
    limit: int = Field(default=50, ge=1, le=500)
    confirmation: str


class RuleActionInput(BaseModel):
    type: str
    value: str = ""


class RuleInput(BaseModel):
    id: str | None = None
    name: str = Field(min_length=1)
    query: str = Field(min_length=1)
    actions: list[RuleActionInput] = Field(min_length=1)


class SaveRulesRequest(BaseModel):
    rules: list[RuleInput] = Field(min_length=1)


class LabelTrashRequest(BaseModel):
    label_id: str
    label_name: str
    limit: int = Field(default=100, ge=1, le=500)
    confirmation: str


class UnsubscribeRequest(BaseModel):
    query: str = "in:inbox"
    limit: int = Field(default=200, ge=1, le=500)


class UnsubscribeArchiveRequest(BaseModel):
    company_key: str
    company: str
    from_address: str = ""
    target: str = ""
    latest_message_date: str = ""
    confirmation: str


def rule_id(index: int, rule: Rule) -> str:
    slug = "".join(char.lower() if char.isalnum() else "-" for char in rule.name)
    return f"{index}-{slug.strip('-')}"


def serialize_action(action: Any) -> dict[str, str]:
    if isinstance(action, dict) and "label" in action:
        return {"type": "label", "value": str(action["label"])}
    return {"type": str(action), "value": ""}


def serialize_rule(index: int, rule: Rule) -> dict[str, Any]:
    return {
        "id": rule_id(index, rule),
        "name": rule.name,
        "query": rule.query,
        "actions": [serialize_action(action) for action in rule.actions],
    }


def input_action_to_yaml(action: RuleActionInput) -> Any:
    action_type = action.type.strip()
    if action_type == "label":
        label = action.value.strip()
        if not label:
            raise HTTPException(status_code=400, detail="Label actions require a label name.")
        return {"label": label}
    if action_type in {"archive", "mark_read", "trash"}:
        return action_type
    raise HTTPException(status_code=400, detail=f"Unsupported action type: {action.type}")


def write_rules(rules: list[RuleInput]) -> None:
    try:
        import yaml
    except ModuleNotFoundError as exc:
        raise HTTPException(status_code=500, detail="PyYAML is not installed.") from exc

    payload = {
        "rules": [
            {
                "name": rule.name.strip(),
                "query": rule.query.strip(),
                "actions": [input_action_to_yaml(action) for action in rule.actions],
            }
            for rule in rules
        ]
    }
    RULES_FILE.write_text(
        yaml.safe_dump(payload, sort_keys=False, allow_unicode=False),
        encoding="utf-8",
    )


def rules_by_id() -> dict[str, Rule]:
    rules = load_rules(RULES_FILE)
    return {rule_id(index, rule): rule for index, rule in enumerate(rules, start=1)}


def select_rules(rule_ids: list[str]) -> list[tuple[str, Rule]]:
    available = rules_by_id()
    missing = [item for item in rule_ids if item not in available]
    if missing:
        raise HTTPException(status_code=400, detail=f"Unknown rule id(s): {', '.join(missing)}")
    return [(item, available[item]) for item in rule_ids]


def list_message_ids_for_label(service, label_id: str, limit: int) -> list[str]:
    ids: list[str] = []
    request = service.users().messages().list(
        userId="me",
        labelIds=[label_id],
        maxResults=min(limit, 500),
    )

    while request is not None and len(ids) < limit:
        response = request.execute()
        ids.extend(message["id"] for message in response.get("messages", []))
        if len(ids) >= limit:
            break
        request = service.users().messages().list_next(request, response)

    return ids[:limit]


def parse_unsubscribe_header(value: str) -> list[str]:
    targets = []
    for part in value.split(","):
        cleaned = part.strip()
        if cleaned.startswith("<") and cleaned.endswith(">"):
            cleaned = cleaned[1:-1].strip()
        if cleaned.startswith(("http://", "https://", "mailto:")):
            targets.append(cleaned)
    return targets


def sender_domain(sender: str) -> str:
    address = email.utils.parseaddr(sender)[1].lower()
    if "@" in address:
        return address.rsplit("@", 1)[1]
    return sender.lower()


def company_from_sender(sender: str) -> str:
    name, address = email.utils.parseaddr(sender)
    if name:
        return name.strip().strip('"')
    domain = address.rsplit("@", 1)[-1] if "@" in address else sender
    parts = domain.split(".")
    if len(parts) >= 2:
        return parts[-2].replace("-", " ").title()
    return domain


def parse_email_date(value: str) -> str:
    parsed = email.utils.parsedate_to_datetime(value) if value else None
    if not parsed:
        return ""
    if not parsed.tzinfo:
        parsed = parsed.replace(tzinfo=dt.timezone.utc)
    return parsed.astimezone(dt.timezone.utc).isoformat()


def load_unsubscribe_history() -> dict[str, dict[str, Any]]:
    history: dict[str, dict[str, Any]] = {}
    if not UNSUBSCRIBE_HISTORY_FILE.exists():
        return history
    for line in UNSUBSCRIBE_HISTORY_FILE.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        entry = json.loads(line)
        history[entry["companyKey"]] = entry
    return history


@app.get("/api/health")
def health() -> dict[str, bool]:
    return {
        "credentials": (ROOT / "credentials.json").exists(),
        "token": (ROOT / "token.json").exists(),
        "rules": RULES_FILE.exists(),
    }


@app.get("/api/rules")
def get_rules() -> dict[str, Any]:
    rules = load_rules(RULES_FILE)
    return {"rules": [serialize_rule(index, rule) for index, rule in enumerate(rules, start=1)]}


@app.get("/api/labels")
def get_labels() -> dict[str, Any]:
    service = get_service()
    response = service.users().labels().list(userId="me").execute()
    labels = []
    for label in response.get("labels", []):
        labels.append(
            {
                "id": label["id"],
                "name": label.get("name", ""),
                "type": label.get("type", ""),
                "messagesTotal": label.get("messagesTotal", 0),
                "messagesUnread": label.get("messagesUnread", 0),
            }
        )
    labels.sort(key=lambda item: (item["type"] != "user", item["name"].lower()))
    return {"labels": labels}


@app.post("/api/unsubscribe")
def unsubscribe_candidates(request: UnsubscribeRequest) -> dict[str, Any]:
    service = get_service()
    ids = list_message_ids(service, request.query, request.limit)
    grouped: dict[str, dict[str, Any]] = {}
    history = load_unsubscribe_history()

    for message_id in ids:
        response = (
            service.users()
            .messages()
            .get(
                userId="me",
                id=message_id,
                format="metadata",
                metadataHeaders=[
                    "From",
                    "Subject",
                    "Date",
                    "List-Unsubscribe",
                    "List-Unsubscribe-Post",
                ],
            )
            .execute()
        )
        headers = {
            header["name"].lower(): header.get("value", "")
            for header in response.get("payload", {}).get("headers", [])
        }
        targets = parse_unsubscribe_header(headers.get("list-unsubscribe", ""))
        if not targets:
            continue

        sender = headers.get("from", "")
        key = sender_domain(sender)
        latest_date = parse_email_date(headers.get("date", ""))
        item = grouped.setdefault(
            key,
            {
                "id": key,
                "companyKey": key,
                "company": company_from_sender(sender),
                "from": sender,
                "domains": sorted({key}),
                "targets": [],
                "oneClick": False,
                "count": 0,
                "samples": [],
                "latestMessageDate": "",
                "previouslyUnsubscribed": history.get(key),
                "hasNewAfterUnsubscribe": False,
            },
        )
        item["count"] += 1
        item["targets"] = sorted(set(item["targets"]) | set(targets))
        item["oneClick"] = item["oneClick"] or "one-click" in headers.get("list-unsubscribe-post", "").lower()
        if latest_date and latest_date > item["latestMessageDate"]:
            item["latestMessageDate"] = latest_date
        if history.get(key) and latest_date and latest_date > history[key].get("timestamp", ""):
            item["hasNewAfterUnsubscribe"] = True
        if len(item["samples"]) < 3:
            item["samples"].append(
                {
                    "subject": headers.get("subject", ""),
                    "date": headers.get("date", ""),
                }
            )

    active = []
    archived = []
    for item in grouped.values():
        if item["previouslyUnsubscribed"] and not item["hasNewAfterUnsubscribe"]:
            archived.append(item)
        else:
            active.append(item)

    active.sort(key=lambda item: item["count"], reverse=True)
    archived.sort(key=lambda item: item["previouslyUnsubscribed"].get("timestamp", ""), reverse=True)
    return {"query": request.query, "scanned": len(ids), "candidates": active, "archived": archived}


@app.post("/api/unsubscribe/archive")
def archive_unsubscribe(request: UnsubscribeArchiveRequest) -> dict[str, Any]:
    if request.confirmation != "UNSUBSCRIBED":
        raise HTTPException(status_code=400, detail="Type UNSUBSCRIBED to confirm.")

    entry = {
        "timestamp": dt.datetime.now(dt.timezone.utc).isoformat(),
        "companyKey": request.company_key,
        "company": request.company,
        "fromAddress": request.from_address,
        "target": request.target,
        "latestMessageDate": request.latest_message_date,
    }
    with UNSUBSCRIBE_HISTORY_FILE.open("a", encoding="utf-8") as file:
        file.write(json.dumps(entry) + "\n")
    return {"archived": entry}


@app.get("/api/labels/{label_id}/sample")
def label_sample(label_id: str, limit: int = 10) -> dict[str, Any]:
    service = get_service()
    ids = list_message_ids_for_label(service, label_id, max(1, min(limit, 50)))
    samples = []
    for message_id in ids:
        metadata = get_message_metadata(service, message_id)
        samples.append(
            {
                "id": message_id,
                "from": metadata.get("from", ""),
                "subject": metadata.get("subject", ""),
                "date": metadata.get("date", ""),
            }
        )
    return {"samples": samples}


@app.post("/api/labels/trash")
def trash_label_messages(request: LabelTrashRequest) -> dict[str, Any]:
    if request.confirmation != "TRASH":
        raise HTTPException(status_code=400, detail="Type TRASH to confirm.")

    service = get_service()
    ids = list_message_ids_for_label(service, request.label_id, request.limit)
    for message_id in ids:
        service.users().messages().trash(userId="me", id=message_id).execute()

    entry = {
        "timestamp": dt.datetime.now(dt.timezone.utc).isoformat(),
        "limit": request.limit,
        "labelTrash": {
            "id": request.label_id,
            "name": request.label_name,
            "count": len(ids),
        },
    }
    with HISTORY_FILE.open("a", encoding="utf-8") as file:
        file.write(json.dumps(entry) + "\n")

    return {"trashed": len(ids), "history": entry}


@app.put("/api/rules")
def save_rules(request: SaveRulesRequest) -> dict[str, Any]:
    write_rules(request.rules)
    rules = load_rules(RULES_FILE)
    return {"rules": [serialize_rule(index, rule) for index, rule in enumerate(rules, start=1)]}


@app.post("/api/plan")
def plan(request: PlanRequest) -> dict[str, Any]:
    selected = select_rules(request.rule_ids)
    service = get_service()
    results = []

    for rule_key, rule in selected:
        ids = list_message_ids(service, rule.query, request.limit + 1)
        limited_ids = ids[: request.limit]
        samples = []
        for message_id in limited_ids[: request.samples]:
            metadata = get_message_metadata(service, message_id)
            samples.append(
                {
                    "id": message_id,
                    "from": metadata.get("from", ""),
                    "subject": metadata.get("subject", ""),
                    "date": metadata.get("date", ""),
                }
            )

        results.append(
            {
                "id": rule_key,
                "name": rule.name,
                "query": rule.query,
                "actions": [serialize_action(action) for action in rule.actions],
                "count": len(limited_ids),
                "limitReached": len(ids) > request.limit,
                "samples": samples,
            }
        )

    return {"limit": request.limit, "samples": request.samples, "results": results}


@app.post("/api/apply")
def apply(request: ApplyRequest) -> dict[str, Any]:
    if request.confirmation != "APPLY":
        raise HTTPException(status_code=400, detail="Type APPLY to confirm.")

    selected = select_rules(request.rule_ids)
    service = get_service()
    applied = []

    for rule_key, rule in selected:
        ids = list_message_ids(service, rule.query, request.limit)
        if ids:
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

        applied.append({"id": rule_key, "name": rule.name, "count": len(ids)})

    entry = {
        "timestamp": dt.datetime.now(dt.timezone.utc).isoformat(),
        "limit": request.limit,
        "rules": applied,
    }
    with HISTORY_FILE.open("a", encoding="utf-8") as file:
        file.write(json.dumps(entry) + "\n")

    return {"applied": applied, "history": entry}


@app.get("/api/history")
def history() -> dict[str, Any]:
    if not HISTORY_FILE.exists():
        return {"runs": []}

    runs = []
    for line in HISTORY_FILE.read_text(encoding="utf-8").splitlines():
        if line.strip():
            runs.append(json.loads(line))
    runs.reverse()
    return {"runs": runs[:25]}
