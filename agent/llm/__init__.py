import threading
from agent.llm.client import LLMClient

_llm = None
_llm_lock = threading.Lock()

def get_llm():
    global _llm
    if _llm is None:
        with _llm_lock:
            if _llm is None:
                _llm = LLMClient()
    return _llm

def generate_response(prompt: str) -> str:
    """
    Simple wrapper used by Oracle orchestrator
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