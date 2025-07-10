"""
Simplified messaging system for werewolf game
"""
from typing import Dict, Any, Optional, List
import json
import enum
import time

class MessageType(enum.Enum):
    GAME_EVENT = "game_event"
    USER_ACTION = "user_action" 
    ANNOUNCEMENT = "announcement"

class GameEventType(enum.Enum):
    PHASE_CHANGE = "phase_change"
    DEBATE_UPDATE = "debate_update"
    VOTING_UPDATE = "voting_update"
    PLAYER_UPDATE = "player_update"
    GAME_STATE = "game_state"

class UserActionType(enum.Enum):
    CAN_SPEAK = "can_speak"
    REQUEST_VOTE = "request_vote"
    REQUEST_TARGET = "request_target"

def create_game_event_message(
    event_type: GameEventType, 
    data: Dict[str, Any],
    game_state: Optional[Dict[str, Any]] = None
) -> Dict[str, Any]:
    """Create a standardized game event message"""
    message = {
        "type": MessageType.GAME_EVENT.value,
        "event": event_type.value,
        "data": data,
        "timestamp": int(time.time() * 1000)  # milliseconds
    }
    if game_state:
        message["game_state"] = game_state
    return message

def create_user_action_message(
    action_type: UserActionType,
    data: Dict[str, Any],
    timeout: Optional[int] = None
) -> Dict[str, Any]:
    """Create a standardized user action message"""
    message = {
        "type": MessageType.USER_ACTION.value,
        "action": action_type.value,
        "data": data,
        "timestamp": int(time.time() * 1000)
    }
    if timeout:
        message["timeout"] = timeout
    return message

def create_announcement_message(text: str) -> Dict[str, Any]:
    """Create a standardized announcement message"""
    return {
        "type": MessageType.ANNOUNCEMENT.value,
        "text": text,
        "timestamp": int(time.time() * 1000)
    } 