import json
import sys
from importlib.metadata import version
from urllib.parse import unquote

from jsonschema import Draft7Validator
from jsonschema.exceptions import SchemaError
from referencing import Registry, Resource
from referencing.exceptions import PointerToNowhere
from referencing.jsonschema import DRAFT7


TOOL = {"jsonschema": "4.23.0", "referencing": "0.37.0"}
if any(version(name) != expected for name, expected in TOOL.items()):
    raise RuntimeError("Frozen JSON Schema reference oracle dependencies changed")

MAPS = ("properties", "patternProperties", "definitions", "$defs")
SINGLE = ("additionalProperties", "additionalItems", "contains", "propertyNames",
          "not", "if", "then", "else")
ARRAYS = ("allOf", "anyOf", "oneOf")


def children(schema, pointer, definitions=True):
    if not isinstance(schema, dict):
        return
    for keyword in MAPS:
        if not definitions and keyword in ("$defs", "definitions"):
            continue
        for name, value in schema.get(keyword, {}).items():
            yield value, pointer + (keyword, name)
    for keyword in SINGLE:
        if keyword in schema:
            yield schema[keyword], pointer + (keyword,)
    for keyword in ARRAYS:
        for index, value in enumerate(schema.get(keyword, [])):
            yield value, pointer + (keyword, str(index))
    items = schema.get("items")
    if isinstance(items, list):
        for index, value in enumerate(items):
            yield value, pointer + ("items", str(index))
    elif isinstance(items, (dict, bool)):
        yield items, pointer + ("items",)
    for name, value in schema.get("dependencies", {}).items():
        if isinstance(value, (dict, bool)):
            yield value, pointer + ("dependencies", name)


def location(pointer):
    return "#" + "".join("/" + part.replace("~", "~0").replace("/", "~1") for part in pointer)


def measure(schema):
    if not isinstance(schema, dict) or schema.get("$schema") != "http://json-schema.org/draft-07/schema#":
        return {"known": False, "reason": "Unsupported or missing schema dialect."}
    try:
        Draft7Validator.check_schema(schema)
    except SchemaError:
        return {"known": False, "reason": "Native Draft-7 metaschema validation failed."}
    if not isinstance(schema.get("$defs", {}), dict):
        return {"known": False, "reason": "Root definition map is malformed."}
    nodes = {}
    pending = [(schema, ())]
    while pending:
        node, pointer = pending.pop()
        if len(nodes) >= 100000:
            raise RuntimeError("Schema-node budget exceeded")
        if not isinstance(node, (dict, bool)) or (isinstance(node, dict)
                and not isinstance(node.get("$defs", {}), dict)):
            return {"known": False, "reason": "Declared definition is not a supported schema."}
        nodes[pointer] = node
        if pointer and isinstance(node, dict) and ("$id" in node or "$schema" in node):
            return {"known": False, "reason": "Nested resource/dialect scopes require a separate reference profile."}
        pending.extend(children(node, pointer))
    base = schema.get("$id", "https://operational-value.invalid/schema.json")
    resolver = Registry().with_resource(base, Resource(schema, DRAFT7)).resolver(base)
    references = {}
    missing = []

    def resolve(ref, pointer):
        if not isinstance(ref, str) or not (ref == "#" or ref.startswith("#/")):
            return None
        try:
            result = resolver.lookup(ref)
        except PointerToNowhere:
            missing.append({"at": location(pointer), "reference": ref, "kind": "absent-target"})
            return False
        if not isinstance(result.contents, (dict, bool)):
            missing.append({"at": location(pointer), "reference": ref, "kind": "non-schema-target"})
            return False
        try:
            Draft7Validator.check_schema(result.contents)
        except SchemaError:
            missing.append({"at": location(pointer), "reference": ref, "kind": "invalid-target-schema"})
            return False
        fragment = unquote(ref[1:], errors="strict")
        target = tuple(part.replace("~1", "/").replace("~0", "~")
                       for part in fragment[1:].split("/")) if fragment else ()
        return result.contents, target

    for pointer, node in nodes.items():
        if isinstance(node, dict) and "$ref" in node:
            target = resolve(node["$ref"], pointer)
            if target is None:
                return {"known": False, "reason": "External or anchor references are outside the closed local-pointer profile."}
            references[pointer] = target

    reached = set()
    used = set()
    pending = [(schema, ())]
    while pending:
        node, pointer = pending.pop()
        if pointer in reached:
            continue
        if not isinstance(node, (dict, bool)) or (isinstance(node, dict)
                and not isinstance(node.get("$defs", {}), dict)):
            return {"known": False, "reason": "Reachable target is not a supported schema."}
        if pointer and isinstance(node, dict) and ("$id" in node or "$schema" in node):
            return {"known": False, "reason": "Reachable target changes resource/dialect scope."}
        reached.add(pointer)
        if len(reached) > 100000:
            raise RuntimeError("Schema reachability budget exceeded")
        if len(pointer) >= 2 and pointer[0] == "$defs":
            used.add(pointer[1])
        if isinstance(node, dict) and "$ref" in node:
            if pointer not in references:
                target = resolve(node["$ref"], pointer)
                if target is None:
                    return {"known": False, "reason": "Reachable target contains an unsupported reference."}
                references[pointer] = target
            if references[pointer] is not False:
                pending.append(references[pointer])
        else:
            pending.extend(children(node, pointer, definitions=False))
    definitions = sorted(schema.get("$defs", {}))
    return {"known": True, "definitions": definitions,
            "usedDefinitions": sorted(used.intersection(definitions)),
            "unusedDefinitions": sorted(set(definitions) - used),
            "referenceCount": len(references),
            "unresolvedReferences": sorted(missing, key=lambda item: (item["at"], item["reference"])),
            "schemaNodes": len(nodes)}


payload = json.load(sys.stdin)
if not isinstance(payload, list) or len(payload) > 200:
    raise RuntimeError("Schema batch budget exceeded")
json.dump({"tool": TOOL, "facts": [{"id": item["id"], **measure(item["schema"])} for item in payload]},
          sys.stdout, separators=(",", ":"))
