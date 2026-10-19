import json
import sys
from importlib.metadata import version

from jsonschema import Draft7Validator
from referencing import Registry
from referencing.exceptions import NoSuchResource


def deny_remote(uri):
    raise NoSuchResource(ref=uri)


if version("jsonschema") != "4.23.0":
    raise RuntimeError("The frozen structural schema oracle requires jsonschema 4.23.0")

payload = json.load(sys.stdin)
validators = {}
for identity, schema in payload["schemas"].items():
    if schema.get("$schema") != "http://json-schema.org/draft-07/schema#":
        raise RuntimeError("Unsupported schema dialect")
    Draft7Validator.check_schema(schema)
    validators[identity] = Draft7Validator(schema, registry=Registry(retrieve=deny_remote))

facts = []
for pair in payload["pairs"]:
    source = payload["examples"][pair["blob"]]
    validator = validators[pair["schema"]]
    valid = source["status"] == "parsed" and isinstance(source["data"], dict) and validator.is_valid(source["data"])
    properties = sorted(set(source["data"]) & set(validator.schema["properties"])) if valid else []
    facts.append({**pair, "valid": valid, "properties": properties, "parserStatus": source["status"]})
json.dump({"validator": "jsonschema-4.23.0-draft7-no-format-assertions", "facts": facts}, sys.stdout)
