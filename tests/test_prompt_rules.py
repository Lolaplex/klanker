from klanker.prompt import build_system_prompt
from klanker.sensing import probe_host

def test_prompt_mentions_memory_rules_block():
    text = build_system_prompt(probe_host())
    assert "<memory_rules>" in text
