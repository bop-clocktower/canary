"""Minimal checkout API for the Schemathesis spike.

Implements POST /v1/checkout per the canary examples/pytest-api-checkout spec.
Intentionally has one subtle bug: qty=0 is accepted (should be rejected).
"""

from fastapi import FastAPI, HTTPException, Request
from pydantic import BaseModel
from typing import List
import uuid

app = FastAPI(title="Checkout API", version="1.0.0")


class Item(BaseModel):
    sku: str
    qty: int


class CheckoutRequest(BaseModel):
    items: List[Item]
    currency: str = "USD"


class CheckoutResponse(BaseModel):
    order_id: str
    total_items: int


@app.post("/v1/checkout", response_model=CheckoutResponse, status_code=201)
def checkout(body: CheckoutRequest, request: Request):
    auth = request.headers.get("Authorization", "")
    if not auth.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing or invalid Authorization header")

    if not body.items:
        raise HTTPException(status_code=400, detail="items must not be empty")

    # BUG: does not validate qty > 0 — Schemathesis should surface this
    # BUG: does not validate currency is a known ISO code

    return CheckoutResponse(
        order_id=str(uuid.uuid4()),
        total_items=len(body.items),
    )
