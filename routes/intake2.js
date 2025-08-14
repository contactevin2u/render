const express = require("express");
const router = express.Router();
const { OpenAI } = require("openai");
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

function coerceNumber(v){ if(v==null)return null; const n=Number(String(v).replace(/[^0-9.]/g,"")); return Number.isFinite(n)?n:null }

async function parseWithOpenAI(text){
  const sys = "You are a strict JSON generator for Malaysian order intake. Return MINIFIED JSON ONLY with fields: {customer:{name,phone?,email?,address?}, order:{type,currency,subtotal?,deposit?,discount?,total?,notes?}, items:[{sku?,product,qty,unit_price?,subtotal?}], schedule?:{start_date?,months?,frequency?,installment_amount?}}. Use currency='MYR'. Coerce Malay/English terms; normalize phone to +60 where possible. Never include markdown fences or extra text.";
  const messages = [{ role:"system", content: sys }, { role:"user", content: text }];
  const resp = await openai.chat.completions.create({
    model: process.env.OPENAI_MODEL || "gpt-4o-mini",
    response_format: { type:"json_object" },
    temperature: 0,
    messages
  });
  let raw = resp.choices?.[0]?.message?.content || "";
  try { return JSON.parse(raw); } catch(e) { raw = raw.replace(/```json|```/g,"").trim(); return JSON.parse(raw); }
}

router.post("/parse", express.json({ limit:"1mb" }), async (req,res) => {
  try {
    const text = (req.body?.text ?? req.body?.message ?? "").toString();
    if(!text.trim()) return res.status(400).json({ error:"text_required" });

    const parsed = await parseWithOpenAI(text);
    const order = parsed.order || {};
    const items = Array.isArray(parsed.items) ? parsed.items : [];

    if(!order.type || !items.length){
      return res.status(422).json({ error:"invalid_structure", details:"order.type and items[] required" });
    }

    order.total = coerceNumber(order.total) ?? null;
    for(const it of items){
      it.qty = coerceNumber(it.qty) ?? 1;
      it.unit_price = coerceNumber(it.unit_price) ?? null;
    }

    return res.json({ status:"ok", structured:{ customer: parsed.customer||{}, order, items, schedule: parsed.schedule||null, notes: parsed.notes||null }});
  } catch(err){
    console.error("intake2/parse error", err);
    return res.status(502).json({ error:"parse_failed", message: err?.message || "unknown" });
  }
});

module.exports = router;
