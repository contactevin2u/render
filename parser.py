import os, json, re
from typing import Tuple
from openai import OpenAI
from .schemas import ParsedOrder, ParsedEvent

client = OpenAI(api_key=os.getenv("OPENAI_API_KEY"))

schema = {
  "name": "oms_intake",
  "schema": {
    "type": "object",
    "additionalProperties": False,
    "properties": {
      "order": {
        "type": "object",
        "additionalProperties": False,
        "properties": {
          "order_id": {"type": "string"},
          "name": {"type": "string"},
          "phone": {"type": "string"},
          "address": {"type": "string"},
          "type": {"enum": ["RENTAL","INSTALMENT","OUTRIGHT"]},
          "notes": {"type": "string"},
          "items": {
            "type": "array",
            "items": {
              "type": "object",
              "additionalProperties": False,
              "properties": {
                "name": {"type": "string"},
                "qty": {"type": "integer"},
                "unit_price": {"type": "number"},
                "sku": {"type": "string"}
              },
              "required": ["name"]
            }
          }
        },
        "required": ["name","type","items"]
      },
      "event": {
        "type": "object",
        "additionalProperties": False,
        "properties": {
          "type": {"enum": ["RETURN","COLLECT","INSTALMENT_CANCEL","BUYBACK","NONE"]},
          "reference_order_id": {"type": "string"}
        },
        "required": ["type"]
      }
    },
    "required": ["order","event"]
  },
  "strict": True
}

SYSTEM = "You read Malaysian WhatsApp/SMS and output strict JSON matching the provided schema. Normalize phone to +60 if possible. If unknown, omit. Use RM values for unit_price when explicit. No commentary, JSON only."

async def parse_text(text: str) -> Tuple[ParsedOrder, ParsedEvent]:
    # Call Responses API with json_schema format
    resp = client.responses.create(
        model=os.getenv("OPENAI_MODEL","gpt-4o-mini"),
        instructions=SYSTEM,
        input=f"Chat transcript:\n---\n{text}\n---\nReturn JSON only.",
        text={"format":"json_schema","json_schema": schema}
    )
    parsed = None
    try:
        if resp.output_text:
            parsed = json.loads(resp.output_text)
        else:
            maybe = resp.output[0].content[0]
            if getattr(maybe,'type',None) == 'output_text':
                parsed = json.loads(maybe.text)
    except Exception as e:
        raise RuntimeError("Model returned invalid JSON") from e

    order = parsed.get("order", {})
    ev = parsed.get("event", {"type":"NONE"})
    # Minimal coercions
    order.setdefault("items", [])
    if not order.get("type"):
        order["type"] = "OUTRIGHT"
    po = ParsedOrder(**order)
    pe = ParsedEvent(**ev)
    return po, pe
