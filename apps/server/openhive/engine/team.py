"""Team snapshot the engine runs against.

This is the wire-format the frontend sends when starting a run. Each request
carries a self-contained team definition so the engine doesn't need to know about
YAML loading / company CRUD yet (those arrive in Phase 0D).
"""

from __future__ import annotations

from pydantic import BaseModel, Field


class AgentSpec(BaseModel):
    id: str
    role: str
    label: str
    provider_id: str
    model: str
    system_prompt: str = ""
    skills: list[str] = Field(default_factory=list)


class EdgeSpec(BaseModel):
    source: str
    target: str


class TeamSpec(BaseModel):
    id: str
    name: str
    agents: list[AgentSpec]
    edges: list[EdgeSpec]

    def find(self, agent_id: str) -> AgentSpec | None:
        return next((a for a in self.agents if a.id == agent_id), None)

    def subordinates(self, agent_id: str) -> list[AgentSpec]:
        targets = [e.target for e in self.edges if e.source == agent_id]
        return [a for a in self.agents if a.id in targets]

    def lead(self) -> AgentSpec:
        """Lead = agent with no incoming edges (and who has outgoing edges if any)."""
        incoming = {e.target for e in self.edges}
        roots = [a for a in self.agents if a.id not in incoming]
        if not roots:
            # Fallback: first agent.
            return self.agents[0]
        # Prefer a root that has subordinates.
        with_reports = [a for a in roots if self.subordinates(a.id)]
        return with_reports[0] if with_reports else roots[0]
