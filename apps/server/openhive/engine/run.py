"""Engine runner — async orchestrator.

Overview:
  - Start a Run at the Lead node with the user's goal.
  - For each node:
      * Build the tools the node can use (delegate_to + subordinates; skills + mcp
        land in later phases).
      * Stream from the provider. Emit token events as text arrives.
      * If the model calls tools, execute them (delegation recursively runs a
        subordinate node), append tool_result messages, loop.
      * When the node stops without tool calls, emit node_finished.
  - Top-level Lead's final text is the Run's output.

Every event is yielded so the caller (an SSE endpoint) can forward them live.
"""

from __future__ import annotations

import asyncio
import json
import secrets
from typing import Any, AsyncIterator

from openhive.engine.providers import StopDelta, TextDelta, ToolCallDelta, build_messages, stream
from openhive.engine.team import AgentSpec, TeamSpec
from openhive.events import Event, make_event
from openhive.tools import Tool, to_openai_tools

MAX_TOOL_ROUNDS = 8  # guardrail against runaway delegation loops
MAX_DEPTH = 4


def _new_id(prefix: str) -> str:
    return f"{prefix}_{secrets.token_hex(4)}"


async def run_team(team: TeamSpec, goal: str) -> AsyncIterator[Event]:
    run_id = _new_id("run")
    yield make_event("run_started", run_id, team_id=team.id, goal=goal)
    lead = team.lead()
    try:
        final = ""
        async for ev in _run_node(
            run_id=run_id,
            team=team,
            node=lead,
            task=goal,
            parent_history=None,
            depth=0,
        ):
            if ev.kind == "node_finished" and ev.depth == 0:
                final = ev.data.get("output", "") or ""
            yield ev
        yield make_event("run_finished", run_id, output=final)
    except Exception as exc:  # noqa: BLE001
        yield make_event("run_error", run_id, error=str(exc))


async def _run_node(
    *,
    run_id: str,
    team: TeamSpec,
    node: AgentSpec,
    task: str,
    parent_history: list[dict[str, Any]] | None,
    depth: int,
) -> AsyncIterator[Event]:
    yield make_event("node_started", run_id, depth=depth, node_id=node.id, role=node.role, task=task)

    # Tools available to this node: delegation to direct reports (if any).
    subordinates = team.subordinates(node.id)
    tools: list[Tool] = []
    if subordinates and depth < MAX_DEPTH:
        tools.append(_delegate_tool(team, node))

    # Conversation for this node. Starts from parent context when subdelegated so the
    # worker has some grounding, else just the fresh task.
    history: list[dict[str, Any]] = []
    if parent_history:
        # Carry the parent's user message as a summary if needed — keep it simple for now.
        pass
    history.append({"role": "user", "content": task})

    rounds = 0
    final_text = ""
    while True:
        rounds += 1
        if rounds > MAX_TOOL_ROUNDS:
            break

        async for ev in _stream_turn(
            run_id=run_id,
            team=team,
            node=node,
            history=history,
            tools=tools,
            depth=depth,
        ):
            # _stream_turn yields events, but also communicates the turn's result
            # through a final "_turn_done" marker stashed in event.data.
            if ev.kind == "token":
                yield ev
            elif ev.kind == "tool_called":
                yield ev
            elif ev.kind == "tool_result":
                yield ev
            elif ev.kind == "delegation_opened" or ev.kind == "delegation_closed":
                yield ev
            elif ev.kind == "node_finished" and ev.data.get("_turn_marker") is True:
                # internal marker from _stream_turn signalling end of turn
                final_text = ev.data.get("output", "")
                stop_reason = ev.data.get("stop_reason")
                if stop_reason == "tool_calls":
                    # tool_results were appended to history inside _stream_turn; loop.
                    break
                # Done — emit real node_finished and exit.
                yield make_event(
                    "node_finished",
                    run_id,
                    depth=depth,
                    node_id=node.id,
                    output=final_text,
                )
                return
            else:
                yield ev

        if rounds > MAX_TOOL_ROUNDS:
            break


async def _stream_turn(
    *,
    run_id: str,
    team: TeamSpec,
    node: AgentSpec,
    history: list[dict[str, Any]],
    tools: list[Tool],
    depth: int,
) -> AsyncIterator[Event]:
    """One provider turn — streams until the model emits a stop event.

    Mutates `history` in place when tool calls are issued so the caller can loop.
    Ends by yielding a sentinel node_finished event whose data carries `_turn_marker=True`
    + `stop_reason` so the outer loop can decide whether to continue.
    """
    messages = build_messages(node.system_prompt, history)
    openai_tools = to_openai_tools(tools) if tools else None

    text_buf: list[str] = []
    # index -> partial tool call
    pending: dict[int, dict[str, Any]] = {}
    stop_reason = "stop"

    async for delta in stream(
        provider_id=node.provider_id,
        model=node.model,
        messages=messages,
        tools=openai_tools,
    ):
        if isinstance(delta, TextDelta):
            text_buf.append(delta.text)
            yield make_event("token", run_id, depth=depth, node_id=node.id, text=delta.text)
        elif isinstance(delta, ToolCallDelta):
            p = pending.setdefault(
                delta.index, {"id": None, "name": None, "arguments": ""}
            )
            if delta.id:
                p["id"] = delta.id
            if delta.name:
                p["name"] = delta.name
            p["arguments"] += delta.arguments_chunk
        elif isinstance(delta, StopDelta):
            stop_reason = delta.reason
            break

    assembled_text = "".join(text_buf).strip()

    # If the model requested tool calls, execute them and extend history.
    if pending:
        # Append assistant message mirroring what the model emitted.
        assistant_msg: dict[str, Any] = {
            "role": "assistant",
            "content": assembled_text or None,
        }
        tool_calls_for_history: list[dict[str, Any]] = []
        for idx in sorted(pending.keys()):
            p = pending[idx]
            call_id = p["id"] or _new_id("call")
            name = p["name"] or "unknown"
            args_str = p["arguments"] or "{}"
            tool_calls_for_history.append(
                {
                    "id": call_id,
                    "type": "function",
                    "function": {"name": name, "arguments": args_str},
                }
            )
        assistant_msg["tool_calls"] = tool_calls_for_history
        history.append(assistant_msg)

        # Execute in sequence (parallel fan-out lives in Phase 0C+1 when we care).
        for idx in sorted(pending.keys()):
            p = pending[idx]
            call_id = tool_calls_for_history[idx]["id"]
            name = tool_calls_for_history[idx]["function"]["name"]
            args_str = tool_calls_for_history[idx]["function"]["arguments"]
            try:
                args = json.loads(args_str) if args_str else {}
            except json.JSONDecodeError:
                args = {}
            yield make_event(
                "tool_called",
                run_id,
                depth=depth,
                node_id=node.id,
                tool_call_id=call_id,
                tool_name=name,
                arguments=args,
            )
            tool = next((t for t in tools if t.name == name), None)
            if tool is None:
                content = f"ERROR: unknown tool '{name}'"
                is_error = True
            else:
                try:
                    # Delegation tool yields sub-events that must pass through.
                    if name == "delegate_to":
                        async for sub_ev in _run_delegation(
                            run_id=run_id,
                            team=team,
                            from_node=node,
                            args=args,
                            tool_call_id=call_id,
                            depth=depth,
                        ):
                            if sub_ev.kind == "delegation_closed":
                                content = sub_ev.data.get("result", "")
                                is_error = bool(sub_ev.data.get("error"))
                            yield sub_ev
                    else:
                        raw = await tool.handler(args)
                        content = raw if isinstance(raw, str) else json.dumps(raw)
                        is_error = False
                except Exception as exc:  # noqa: BLE001
                    content = f"ERROR: {exc}"
                    is_error = True

            yield make_event(
                "tool_result",
                run_id,
                depth=depth,
                node_id=node.id,
                tool_call_id=call_id,
                tool_name=name,
                content=content,
                is_error=is_error,
            )
            history.append(
                {
                    "role": "tool",
                    "tool_call_id": call_id,
                    "content": content,
                }
            )

    yield make_event(
        "node_finished",
        run_id,
        depth=depth,
        node_id=node.id,
        _turn_marker=True,
        output=assembled_text,
        stop_reason=stop_reason,
    )


# --------- delegation tool factory ---------

def _delegate_tool(team: TeamSpec, node: AgentSpec) -> Tool:
    subs = team.subordinates(node.id)
    assignees = [s.role for s in subs]  # role names shown to the LLM
    # If two subordinates share a role, disambiguate by appending agent id.
    seen: dict[str, int] = {}
    canonical: list[str] = []
    for s in subs:
        n = seen.get(s.role, 0) + 1
        seen[s.role] = n
        canonical.append(s.role if n == 1 and assignees.count(s.role) == 1 else f"{s.role}#{s.id}")

    async def _noop(args: dict[str, Any]) -> str:
        # Real execution happens in _run_delegation (we need engine context).
        return "delegation handled by engine"

    return Tool(
        name="delegate_to",
        description=(
            "Assign a task to a direct subordinate. Use this whenever the work requires "
            "specialist attention. The subordinate will respond with their output."
        ),
        parameters={
            "type": "object",
            "properties": {
                "assignee": {
                    "type": "string",
                    "enum": canonical,
                    "description": "Who should do the task. Must be one of your direct reports.",
                },
                "task": {
                    "type": "string",
                    "description": "Clear instructions for the subordinate. Include context.",
                },
            },
            "required": ["assignee", "task"],
        },
        handler=_noop,
        hint="Delegating…",
    )


async def _run_delegation(
    *,
    run_id: str,
    team: TeamSpec,
    from_node: AgentSpec,
    args: dict[str, Any],
    tool_call_id: str,
    depth: int,
) -> AsyncIterator[Event]:
    assignee_key = str(args.get("assignee", ""))
    task = str(args.get("task", ""))

    # Resolve assignee — first try exact role match among direct reports, then id form.
    subs = team.subordinates(from_node.id)
    target: AgentSpec | None = None
    if "#" in assignee_key:
        role, _, aid = assignee_key.partition("#")
        target = next((s for s in subs if s.id == aid and s.role == role), None)
    if target is None:
        matches = [s for s in subs if s.role == assignee_key]
        target = matches[0] if matches else None

    if target is None:
        yield make_event(
            "delegation_closed",
            run_id,
            depth=depth,
            node_id=from_node.id,
            tool_call_id=tool_call_id,
            error=True,
            result=f"No such subordinate: {assignee_key}",
        )
        return

    yield make_event(
        "delegation_opened",
        run_id,
        depth=depth,
        node_id=from_node.id,
        tool_call_id=tool_call_id,
        assignee_id=target.id,
        assignee_role=target.role,
        task=task,
    )

    # Run the subordinate; its final node_finished is the delegation's result.
    sub_output = ""
    async for ev in _run_node(
        run_id=run_id,
        team=team,
        node=target,
        task=task,
        parent_history=None,
        depth=depth + 1,
    ):
        if ev.kind == "node_finished" and ev.depth == depth + 1 and ev.node_id == target.id:
            sub_output = ev.data.get("output", "")
        yield ev

    yield make_event(
        "delegation_closed",
        run_id,
        depth=depth,
        node_id=from_node.id,
        tool_call_id=tool_call_id,
        assignee_id=target.id,
        assignee_role=target.role,
        result=sub_output,
    )


# Keep module-level asyncio name import neat for callers that want it.
__all__ = ["run_team", "asyncio"]
