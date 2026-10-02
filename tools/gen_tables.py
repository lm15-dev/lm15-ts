#!/usr/bin/env python3
"""Generate src/generated/tables.ts from lm15-contract tables/providers.json.

The contract file is the reference's provider tables as data (its
tables/README.md): registry rows with their whole access policies, the
managed-login declared providers, the compat presets with their base-URL and
alias tables, the router's built-in rules and litellm prefixes, and the
managed-login service labels. This port reads them from the generated module;
nothing here re-derives a value (playbooks/port.md rule 2).

    python3 tools/gen_tables.py [--contract ../lm15-contract] [--check]

`--check` writes nothing and exits 1 when the committed file is stale (CI runs
it against the contract checkout at CONTRACT_PIN). Stdlib only.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "src" / "generated" / "tables.ts"
SCHEMA = 1
IDENT = re.compile(r"^[A-Za-z_$][A-Za-z0-9_$]*$")


def camel(name: str) -> str:
    head, *rest = name.split("_")
    return head + "".join(part[:1].upper() + part[1:] for part in rest)


def key(name: str) -> str:
    return name if IDENT.match(name) else json.dumps(name)


def lit(value) -> str:
    """A TypeScript literal for a JSON value whose keys are already final."""
    if isinstance(value, dict):
        return "{" + ", ".join(f"{key(k)}: {lit(v)}" for k, v in value.items()) + "}" if value else "{}"
    if isinstance(value, list):
        return "[" + ", ".join(lit(v) for v in value) + "]"
    return json.dumps(value, ensure_ascii=False)


def drop_null(obj: dict) -> dict:
    return {k: v for k, v in obj.items() if v is not None}


def setting(s: dict) -> dict:
    return drop_null({"name": s["name"], "env": s["env"], "default": s["default"]})


def host(h: dict | None) -> dict | None:
    if h is None:
        return None
    out = {}
    for k, v in h.items():
        if k == "settings":
            v = [setting(s) for s in v]
        out[camel(k)] = v  # paths keep their endpoint-name keys; required_headers stay pairs
    return drop_null(out)


def access(a: dict) -> dict:
    out = {}
    for k, v in a.items():
        if k == "supports":
            v = {camel(sk): sv for sk, sv in v.items()}
        elif k == "host":
            v = host(v)
        elif k == "backend_settings":
            v = [setting(s) for s in v]
        out[camel(k)] = v  # backend_options keep their option names
    return drop_null(out)


def compat(c: dict) -> dict:
    out = {}
    for k, v in c.items():
        if k == "model_overrides":
            v = [[prefix, {camel(knob): kv for knob, kv in knobs.items()}] for prefix, knobs in v]
        out[camel(k)] = v
    return out


def row(r: dict) -> dict:
    c = r["compat"]
    return drop_null({
        "id": r["id"],
        "dialect": r["dialect"],
        "kind": r["kind"],
        "compat": c if c is None or isinstance(c, str) else compat(c),
        "access": access(r["access"]),
        "aliases": r["aliases"],
        "placeholderKey": r["placeholder_key"],
        "consoleUrl": r["console_url"],
        "note": r["note"],
    })


def render(tables: dict, digest: str) -> str:
    if tables.get("schema") != SCHEMA:
        raise SystemExit(f"tables/providers.json schema {tables.get('schema')!r}; this generator reads {SCHEMA}")
    c = tables["compat"]
    sections = [
        ("PROVIDER_ROWS", "readonly ProviderRow[]", [row(r) for r in tables["providers"]],
         "Registry rows in declaration order (presentation order)."),
        ("DECLARED_LOGIN_ROWS", "readonly ProviderRow[]", [row(r) for r in tables["declared_login"]],
         "Managed-login declared providers (AUTH-26: no registry row, no wire receipt)."),
        ("OPENAI_CHAT_PRESET_TABLE", "Readonly<Record<string, OpenAIChatCompat>>",
         {k: compat(v) for k, v in c["chat"].items()}, "Chat Completions server presets: the knobs each sets."),
        ("OPENAI_CHAT_BASE_URL_TABLE", "Readonly<Record<string, string>>", c["chat_base_urls"], None),
        ("OPENAI_RESPONSES_PRESET_TABLE", "Readonly<Record<string, OpenAIResponsesCompat>>",
         {k: compat(v) for k, v in c["responses"].items()}, "Responses server presets."),
        ("OPENAI_RESPONSES_BASE_URL_TABLE", "Readonly<Record<string, string>>", c["responses_base_urls"], None),
        ("ANTHROPIC_PRESET_TABLE", "Readonly<Record<string, AnthropicCompat>>",
         {k: compat(v) for k, v in c["anthropic"].items()}, "Anthropic Messages server presets."),
        ("ANTHROPIC_BASE_URL_TABLE", "Readonly<Record<string, string>>", c["anthropic_base_urls"], None),
        ("PRESET_ALIAS_TABLE", "Readonly<Record<string, string>>", c["preset_aliases"],
         "Preset spelling aliases, read after lowercasing and mapping `-`, `.` and spaces to `_`."),
        ("DEFAULT_RULE_TABLE", "readonly RuleRow[]", tables["routing"]["default_rules"],
         "The router's built-in prefix rules, first match wins."),
        ("LITELLM_PREFIX_TABLE", "Readonly<Record<string, string>>", tables["routing"]["litellm_prefixes"],
         "litellm `provider/` spellings for the OpenAI-SDK/litellm door."),
        ("SERVICE_LABEL_TABLE", "Readonly<Record<string, string>>", tables["login"]["service_labels"],
         "AUTH-12 service labels."),
    ]
    out = [
        "// Generated by tools/gen_tables.py from lm15-contract tables/providers.json — do not edit.",
        f"// Contract tables sha256 {digest}. Regenerate: python3 tools/gen_tables.py",
        "// The receipts behind each value are cited at the reference's own table",
        "// (lm15-python lm15/registry.py, access.py, compat.py, router.py).",
        "",
        'import type { AccessPolicy } from "../auth/policy.ts";',
        'import type { AnthropicCompat, OpenAIChatCompat, OpenAIResponsesCompat } from "../compat.ts";',
        "",
        "export type TableDialect = \"openai-responses\" | \"openai-chat\" | \"anthropic\" | \"gemini\" | \"typesafe\";",
        "",
        "export interface ProviderRow {",
        "  readonly id: string;",
        "  readonly dialect: TableDialect;",
        "  readonly kind: \"adapter-owned\" | \"bound\" | \"hosted\";",
        "  readonly compat?: string | OpenAIChatCompat | OpenAIResponsesCompat | AnthropicCompat;",
        "  readonly access: AccessPolicy;",
        "  readonly aliases: readonly string[];",
        "  readonly placeholderKey?: string;",
        "  readonly consoleUrl?: string;",
        "  readonly note: string;",
        "}",
        "",
        "export interface RuleRow {",
        "  readonly prefix: string;",
        "  readonly provider: string;",
        "  readonly note: string;",
        "}",
        "",
        "function deepFreeze<T>(value: T): T {",
        "  if (value !== null && typeof value === \"object\" && !Object.isFrozen(value)) {",
        "    for (const v of Object.values(value)) deepFreeze(v);",
        "    Object.freeze(value);",
        "  }",
        "  return value;",
        "}",
    ]
    for name, type_, value, doc in sections:
        out.append("")
        if doc:
            out.append(f"/** {doc} */")
        if isinstance(value, list):
            body = "[\n" + "".join(f"  {lit(v)},\n" for v in value) + "]"
        else:
            body = "{\n" + "".join(f"  {key(k)}: {lit(v)},\n" for k, v in value.items()) + "}"
        out.append(f"export const {name}: {type_} = deepFreeze({body});")
    return "\n".join(out) + "\n"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--contract", type=Path, default=ROOT.parent / "lm15-contract")
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args(argv)
    source = (args.contract / "tables" / "providers.json").read_bytes()
    text = render(json.loads(source.decode("utf-8")), hashlib.sha256(source).hexdigest())
    if args.check:
        current = OUT.read_text(encoding="utf-8") if OUT.is_file() else None
        if current != text:
            print(f"{OUT.relative_to(ROOT)} is stale for this contract checkout: run python3 tools/gen_tables.py")
            return 1
        print(f"{OUT.relative_to(ROOT)}: current")
        return 0
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(text, encoding="utf-8", newline="\n")
    print(f"wrote {OUT.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
