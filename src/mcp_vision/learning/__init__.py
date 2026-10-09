"""Plip's learning layer: opt-in sessions, contract-v1 events, teacher summaries.

Shared with the web/PWA and the browser extension through the event contract,
so one dashboard reads all three. Nothing here runs without an explicit
session opt-in, and nothing here measures attention, mastery or grades - see
``summary.REFUSED_CLAIMS``.
"""
from __future__ import annotations

from mcp_vision.learning.consent import SessionConsent
from mcp_vision.learning.events import SCHEMA_VERSION, ContractError, LearningEvent, build, contract_summary
from mcp_vision.learning.log import LearningLog
from mcp_vision.learning.session import LearningSession, pseudonym
from mcp_vision.learning.summary import Summary, class_summary, summarise, summarise_log

__all__ = ["SCHEMA_VERSION", "ContractError", "LearningEvent", "LearningLog", "LearningSession", "SessionConsent",
           "Summary", "build", "class_summary", "contract_summary", "pseudonym", "summarise", "summarise_log"]
