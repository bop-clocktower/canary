"""
LLM Module - Abstract interface and factory for language model providers.

This package provides a singleton client and a high-level response generation
function for use by the core orchestration layer.
"""

import threading
from agent.llm.client import LLMClient

_llm = None
_llm_lock = threading.Lock()

def get_llm():
    """
    Returns the thread-safe singleton LLMClient instance.

    Returns:
        LLMClient: The shared client for making LLM requests.
    """
    global _llm
    if _llm is None:
        with _llm_lock:
            if _llm is None:
                _llm = LLMClient()
    return _llm

def generate_response(prompt: str) -> str:
    """
    Generates a response from the default LLM provider.

    Args:
        prompt: The user prompt to send to the LLM.

    Returns:
        str: The generated response text.
    """

    messages = [
        {
            "role": "system",
            "content": "You are Oracle, a senior test automation engineer."
        },
        {
            "role": "user",
            "content": prompt
        }
    ]

    return get_llm().generate(messages)
