# Seed-Based Trace Deduplication for Conversations

## The Problem

When MCP clients have built-in Langfuse hooks (Cursor, Claude Code), both the client hook and the MCP server may write a trace for the same message → duplicate traces, doubled message counts, corrupted conversation retrieval.

**WRONG:** No `seed` provided → both sides generate random trace IDs → two traces per message.

## Solution: Use seed for deterministic trace IDs

```
conversation_add_message(
    conversation_id="conv-uuid", agent_id="my_agent",
    input="What is our Q3 revenue?",
    output="Q3 revenue was $4.2M, up 15% from Q2.",
    seed="conv-uuid:my_agent:What is our Q3 revenue?"
)
```

Both sides hash the same seed string to produce the same trace ID. Langfuse treats the second write as an upsert → exactly one trace.

## Trace ID Rules

1. **`seed`** — if provided, hashed to produce a deterministic trace ID
2. **Not provided** — a random trace ID is generated

## Choosing a Good Seed

The seed should be deterministic and unique per message:

```
seed = f"{conversation_id}:{agent_id}:{input_text}"
-- or, if message order matters:
seed = f"{conversation_id}:{agent_id}:{message_index}"
```

## When to Use Each

| Scenario | Use |
|----------|-----|
| Client hook + MCP server both write to Langfuse | `seed` |
| Only the MCP server writes (no client hook) | Neither (random is fine) |
| Replaying messages idempotently | `seed` |

## session_id on conversation_create

Optional `session_id` serves a similar dedup purpose for the conversation container. If provided, the same session_id reconnects to an existing Langfuse session.
