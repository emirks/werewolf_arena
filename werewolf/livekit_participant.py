import asyncio
import logging
from typing import Optional, Any, Dict
from abc import ABC, abstractmethod
import os
import uuid

import livekit
from livekit import rtc, agents, api
from livekit.agents import tts
from livekit.plugins import openai

from werewolf.lm import LmLog
from werewolf.utils import Deserializable

logger = logging.getLogger(__name__)


class LiveKitParticipant(Deserializable):
    """Base class for LiveKit participants with TTS capability."""
    
    def __init__(self, name: str):
        self.name = name
        self.room: rtc.Room = None
        self.session: agents.AgentSession = None
        self._connected = False
        
        self.livekit_url = os.getenv("LIVEKIT_URL")
        self.livekit_api_key = os.getenv("LIVEKIT_API_KEY")
        self.livekit_api_secret = os.getenv("LIVEKIT_API_SECRET")
        
    async def setup_livekit_session(self, room: rtc.Room, room_name: str):
        """Setup and connect to LiveKit room with TTS capabilities."""
        try:
            self.session = agents.AgentSession(
                tts=openai.TTS(
                    model="gpt-4o-mini-tts"
                )
            )
            
            self.room = room
            await self.session.start(
                room=room,
                agent=agents.Agent(
                    instructions="You are a player in a game of werewolf. You will be given a transcript of the user's speech and you will need to transcribe it into text."
                ),
            )
            self._connected = True
            logger.info(f"LiveKit session setup complete for {self.name}")
            
        except Exception as e:
            logger.error(f"Failed to setup LiveKit session for {self.name}: {e}")
            raise
    
    async def speak(self, text: str) -> tuple[str, LmLog]:
        """Speak the given text using TTS and return it with a log."""
        if not self._connected or not self.session:
            logger.warning(f"{self.name} attempted to speak but not connected to LiveKit")
            # Return a mock log for offline usage
            log = LmLog(
                prompt=f"SPEAK: {text}",
                raw_resp=text,
                result={"say": text}
            )
            return text, log
        
        try:
            await self.session.say(text)
            log = LmLog(
                prompt=f"TTS_SPEAK: {text}",
                raw_resp=text,
                result={"say": text}
            )
            
            logger.info(f"{self.name} spoke: {text}")
            return text, log
            
        except Exception as e:
            logger.error(f"Error speaking for {self.name}: {e}")
            # Return error log
            log = LmLog(
                prompt=f"TTS_SPEAK_ERROR: {text}",
                raw_resp=f"Error: {e}",
                result={"say": text, "error": str(e)}
            )
            return text, log
    
    async def disconnect(self):
        """Disconnect from LiveKit room."""
        if self.room:
            await self.room.disconnect()
        
        if self.session:
            await self.session.aclose()
            self._connected = False
            logger.info(f"{self.name} disconnected from LiveKit")
    
    def is_connected(self) -> bool:
        """Check if connected to LiveKit room."""
        return self._connected 