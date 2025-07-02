import asyncio
import logging
from typing import Optional, List, Dict, Any, Tuple
import threading
import time
import os

from livekit import agents, rtc, api
from livekit.agents.voice import room_io
from livekit.plugins import openai
from livekit.agents.stt import SpeechEventType, SpeechEvent
from typing import AsyncIterable

from werewolf.livekit_participant import LiveKitParticipant
from werewolf.lm import LmLog
from werewolf.model import GameView, group_and_format_observations
from werewolf.config import MAX_DEBATE_TURNS, NUM_PLAYERS

logger = logging.getLogger(__name__)


class UserInputTimeout(Exception):
    """Exception raised when user input times out."""
    pass


class HumanPlayer(LiveKitParticipant):
    """Human player that extends LiveKitParticipant with user interaction."""
    
    def __init__(self, name: str, role: str, personality: Optional[str] = ""):
        super().__init__(name)
        self.role = role
        self.personality = personality
        self.observations: List[str] = []
        self.bidding_rationale = ""
        self.gamestate: Optional[GameView] = None
        self.participant_id = None
        
        # For transcription and user input
        self._current_input_future = None
        self._user_speaking = False
        self._last_transcription = ""
        
        # STT event handling
        self._waited_event_type: Optional[SpeechEventType] = None
        self._event_result: Optional[str] = None
        self._event_ready = asyncio.Event()
        self._stt_task: Optional[asyncio.Task] = None
        
        self.livekit_api_key = os.getenv("LIVEKIT_API_KEY")
        self.livekit_api_secret = os.getenv("LIVEKIT_API_SECRET")
        
    def setup_livekit_for_user(self, room_name: str):
        """Setup LiveKit for user input."""        
        token = api.AccessToken(self.livekit_api_key, self.livekit_api_secret)
        self.participant_id = f"user_{self.name}"
        token.with_identity(self.participant_id).with_name(self.name)
        token.with_grants(api.VideoGrants(
            room_join=True,
            room=room_name,
            can_publish=True,
            can_subscribe=True,
            can_publish_data=True
        ))
        
        return token

    async def setup_livekit_agent_for_user(self, ctx: agents.JobContext):
        """Setup and connect to LiveKit room with TTS capabilities."""
        try:
            # will only have stt
            self.stt = openai.STT()
            self.agent_session = agents.AgentSession(
                stt=self.stt,
            )
            self.stt_stream = self.stt.stream()
            
            self.room = ctx.room
            await self.agent_session.start(
                room=ctx.room,
                agent=agents.Agent(),
                room_input_options=room_io.RoomInputOptions(
                    text_enabled=True,
                    audio_enabled=False,
                    video_enabled=False,
                    participant_identity=self.participant_id,
                    # text_input_cb=self._on_user_input,
                ),
            )
            
            # Start background STT processing task
            self._stt_task = asyncio.create_task(self.process_stt_stream(self.stt_stream))
            
            self._connected = True
            logger.info(f"LiveKit agent session setup complete for {self.name}")
            
        except Exception as e:
            logger.error(f"Failed to setup LiveKit agent session for {self.name}: {e}")
            raise

    # def _on_user_input(self, sess: agents.AgentSession, ev: room_io.TextInputEvent):
    #     """Handle user input."""
    #     logger.info(f"User input: {ev.text}")
    #     self.room.local_participant.publish_data(ev.text)
    
    async def cleanup(self):
        """Clean up resources including background STT task."""
        # Cancel the background STT task
        if self._stt_task and not self._stt_task.done():
            self._stt_task.cancel()
            try:
                await self._stt_task
            except asyncio.CancelledError:
                pass
        
        # Close agent session
        if hasattr(self, 'agent_session') and self.agent_session:
            await self.agent_session.aclose()
        
        # Disconnect from room
        await self.disconnect()
        
        logger.info(f"Human player {self.name} cleaned up")
        
    def initialize_game_view(self, round_number, current_players, other_wolf=None) -> None:
        """Initialize the game view for this player."""
        self.gamestate = GameView(round_number, current_players, other_wolf)

    def _add_observation(self, observation: str):
        """Adds an observation for the given round."""
        if not self.gamestate:
            raise ValueError("GameView not initialized. Call initialize_game_view() first.")
        
        self.observations.append(f"Round {self.gamestate.round_number}: {observation}")

    def add_announcement(self, announcement: str):
        """Adds the current game announcement to the player's observations."""
        self._add_observation(f"Moderator Announcement: {announcement}")

    def _get_game_state(self) -> Dict[str, Any]:
        """Gets the current game state from the player's perspective."""
        if not self.gamestate:
            raise ValueError("GameView not initialized. Call initialize_game_view() first.")

        remaining_players = [
            f"{player} (You)" if player == self.name else player
            for player in self.gamestate.current_players
        ]
        formatted_debate = [
            f"{author} (You): {dialogue}"
            if author == self.name
            else f"{author}: {dialogue}"
            for author, dialogue in self.gamestate.debate
        ]

        formatted_observations = group_and_format_observations(self.observations)

        return {
            "name": self.name,
            "role": self.role,
            "round": self.gamestate.round_number,
            "observations": formatted_observations,
            "remaining_players": ", ".join(remaining_players),
            "debate": formatted_debate,
            "bidding_rationale": self.bidding_rationale,
            "debate_turns_left": MAX_DEBATE_TURNS - len(formatted_debate),
            "personality": self.personality,
            "num_players": NUM_PLAYERS,
            "num_villagers": NUM_PLAYERS - 4,
        }

    async def process_stt_stream(self, stream: AsyncIterable[SpeechEvent]):
        """Background task to process STT events and signal when waited events occur."""
        try:
            async for event in stream:
                if event.type == SpeechEventType.FINAL_TRANSCRIPT:
                    logger.info(f"Final transcript: {event.alternatives[0].text}")
                    self._last_transcription = event.alternatives[0].text
                elif event.type == SpeechEventType.INTERIM_TRANSCRIPT:
                    logger.debug(f"Interim transcript: {event.alternatives[0].text}")
                elif event.type == SpeechEventType.START_OF_SPEECH:
                    logger.info("Start of speech")
                    self._user_speaking = True
                elif event.type == SpeechEventType.END_OF_SPEECH:
                    logger.info("End of speech")
                    self._user_speaking = False
                
                # Check if this is the event type someone is waiting for
                if self._waited_event_type is not None and event.type == self._waited_event_type:
                    # Store the result based on event type
                    if event.type in [SpeechEventType.FINAL_TRANSCRIPT, SpeechEventType.INTERIM_TRANSCRIPT]:
                        self._event_result = event.alternatives[0].text if event.alternatives else ""
                    else:
                        self._event_result = str(event.type.value)
                    
                    # Signal that the waited event has occurred
                    self._event_ready.set()
                    logger.info(f"Waited event {self._waited_event_type} occurred with result: {self._event_result}")
                    
        except Exception as e:
            logger.error(f"Error in STT stream processing: {e}")
        finally:
            await stream.aclose()
            
    async def wait_for_stt_event(self, event_type: SpeechEventType, timeout: float = 30.0) -> Optional[str]:
        """Wait for a specific STT event type."""
        # Reset the event and set what we're waiting for
        self._event_ready.clear()
        self._waited_event_type = event_type
        self._event_result = None
        
        try:
            # Wait for the event to occur with timeout
            await asyncio.wait_for(self._event_ready.wait(), timeout=timeout)
            result = self._event_result
            
            # Clear the waited event
            self._waited_event_type = None
            self._event_result = None
            
            return result
            
        except asyncio.TimeoutError:
            logger.warning(f"Timeout waiting for STT event {event_type}")
            # Clear the waited event
            self._waited_event_type = None
            self._event_result = None
            return None

    async def _wait_for_user_input(self, prompt: str, options: Optional[List[str]] = None, 
                                   timeout: float = 30.0) -> str:
        """Wait for user input with optional timeout."""
        logger.info(f"Waiting for user input: {prompt}")
        if options:
            logger.info(f"Available options: {', '.join(options)}")
        
        # In a real implementation, this would listen for data messages from the UI
        # For now, we'll simulate with a basic input mechanism
        # This should be replaced with actual LiveKit data channel communication
        self.room.local_participant.publish_data(prompt)
        
        def get_input():
            return input(f"{self.name} - {prompt}: ")
        
        try:
            # Use asyncio to run the input in a thread with timeout
            loop = asyncio.get_event_loop()
            result = await asyncio.wait_for(
                loop.run_in_executor(None, get_input),
                timeout=timeout
            )
            
            # Validate input against options if provided
            if options and result not in options:
                logger.warning(f"Invalid input '{result}', expected one of: {options}")
                return await self._wait_for_user_input(prompt, options, timeout)
            
            return result
            
        except asyncio.TimeoutError:
            logger.warning(f"User input timeout for {self.name}")
            # Return a default option if available
            if options:
                return options[0]
            raise UserInputTimeout(f"No user input received within {timeout} seconds")

    async def vote(self) -> Tuple[Optional[str], LmLog]:
        """Ask user to vote for a player."""
        if not self.gamestate:
            raise ValueError("GameView not initialized. Call initialize_game_view() first.")
        
        options = [player for player in self.gamestate.current_players if player != self.name]
        
        try:
            game_state = self._get_game_state()
            prompt = f"Round {game_state['round']} - Vote to eliminate a player"
            
            vote = await self._wait_for_user_input(prompt, options, timeout=60.0)
            
            if len(self.gamestate.debate) == MAX_DEBATE_TURNS:
                self._add_observation(f"After the debate, I voted to remove {vote} from the game.")
            
            log = LmLog(
                prompt=f"USER_VOTE: {prompt}",
                raw_resp=vote,
                result={"vote": vote}
            )
            
            return vote, log
            
        except UserInputTimeout:
            # Default to first available option
            default_vote = options[0] if options else None
            log = LmLog(
                prompt="USER_VOTE_TIMEOUT",
                raw_resp="timeout",
                result={"vote": default_vote}
            )
            return default_vote, log

    async def bid(self) -> Tuple[Optional[int], LmLog]:
        """Ask user if they want to speak (bid)."""
        try:
            prompt = "Do you want to speak? (0=No, 1-4=Yes, higher=more eager)"
            bid_str = await self._wait_for_user_input(prompt, ["0", "1", "2", "3", "4"], timeout=15.0)
            bid = int(bid_str)
            
            self.bidding_rationale = f"User chose bid level {bid}"
            
            log = LmLog(
                prompt=f"USER_BID: {prompt}",
                raw_resp=bid_str,
                result={"bid": bid, "reasoning": self.bidding_rationale}
            )
            
            return bid, log
            
        except (UserInputTimeout, ValueError):
            # Default to not speaking
            log = LmLog(
                prompt="USER_BID_TIMEOUT",
                raw_resp="0",
                result={"bid": 0, "reasoning": "Timeout or invalid input"}
            )
            return 0, log

    async def debate(self) -> Tuple[Optional[str], LmLog]:
        """Ask user to speak and wait for speech end event."""
        try:
            prompt = "It's your turn to speak. Start speaking when ready, stop when done."
            
            if self._connected and self._stt_task:
                # Send prompt to UI
                self.room.local_participant.publish_data(prompt)
                logger.info(f"Waiting for user to speak...")
                
                # Wait for start of speech
                await self.wait_for_stt_event(SpeechEventType.START_OF_SPEECH, timeout=60.0)
                logger.info("User started speaking")
                
                # Wait for end of speech
                await self.wait_for_stt_event(SpeechEventType.END_OF_SPEECH, timeout=120.0)
                logger.info("User finished speaking")
                
                # Get the final transcription (it should be in _last_transcription)
                speech = self._last_transcription
                
                if speech:
                    # Use the speak function to broadcast the speech
                    spoken_text, speak_log = await self.speak(speech)
                
            else:
                # Fallback to text input if not connected to LiveKit
                speech = await self._wait_for_user_input(prompt, timeout=120.0)
                
                # Use the speak function to broadcast the speech
                spoken_text, speak_log = await self.speak(speech)
            
            log = LmLog(
                prompt=f"USER_DEBATE: {prompt}",
                raw_resp=speech,
                result={"say": speech}
            )
            
            return speech, log
            
        except UserInputTimeout:
            # Return empty speech
            log = LmLog(
                prompt="USER_DEBATE_TIMEOUT",
                raw_resp="",
                result={"say": ""}
            )
            return "", log

    async def summarize(self) -> Tuple[Optional[str], LmLog]:
        """Summarize doesn't need to do anything for human players."""
        log = LmLog(
            prompt="USER_SUMMARIZE",
            raw_resp="Human player - no summary needed",
            result={"summary": ""}
        )
        return "", log

    # Action methods for specific roles
    async def eliminate(self) -> Tuple[Optional[str], LmLog]:
        """Werewolf chooses a player to eliminate."""
        if not self.gamestate:
            raise ValueError("GameView not initialized. Call initialize_game_view() first.")
        
        options = [
            player for player in self.gamestate.current_players 
            if player != self.name and player != self.gamestate.other_wolf
        ]
        
        try:
            prompt = "Choose a player to eliminate tonight"
            target = await self._wait_for_user_input(prompt, options, timeout=60.0)
            
            log = LmLog(
                prompt=f"USER_ELIMINATE: {prompt}",
                raw_resp=target,
                result={"eliminate": target}
            )
            
            return target, log
            
        except UserInputTimeout:
            default_target = options[0] if options else None
            log = LmLog(
                prompt="USER_ELIMINATE_TIMEOUT",
                raw_resp="timeout",
                result={"eliminate": default_target}
            )
            return default_target, log

    async def unmask(self) -> Tuple[Optional[str], LmLog]:
        """Seer chooses a player to investigate."""
        if not self.gamestate:
            raise ValueError("GameView not initialized. Call initialize_game_view() first.")
        
        # Need to track previously unmasked players (simplified for now)
        options = [
            player for player in self.gamestate.current_players 
            if player != self.name
        ]
        
        try:
            prompt = "Choose a player to investigate tonight"
            target = await self._wait_for_user_input(prompt, options, timeout=60.0)
            
            log = LmLog(
                prompt=f"USER_INVESTIGATE: {prompt}",
                raw_resp=target,
                result={"investigate": target}
            )
            
            return target, log
            
        except UserInputTimeout:
            default_target = options[0] if options else None
            log = LmLog(
                prompt="USER_INVESTIGATE_TIMEOUT",
                raw_resp="timeout",
                result={"investigate": default_target}
            )
            return default_target, log

    async def save(self) -> Tuple[Optional[str], LmLog]:
        """Doctor chooses a player to protect."""
        if not self.gamestate:
            raise ValueError("GameView not initialized. Call initialize_game_view() first.")
        
        options = list(self.gamestate.current_players)
        
        try:
            prompt = "Choose a player to protect tonight"
            target = await self._wait_for_user_input(prompt, options, timeout=60.0)
            
            self._add_observation(f"During the night, I chose to protect {target}")
            
            log = LmLog(
                prompt=f"USER_PROTECT: {prompt}",
                raw_resp=target,
                result={"protect": target}
            )
            
            return target, log
            
        except UserInputTimeout:
            default_target = options[0] if options else None
            if default_target:
                self._add_observation(f"During the night, I chose to protect {default_target}")
            
            log = LmLog(
                prompt="USER_PROTECT_TIMEOUT",
                raw_resp="timeout",
                result={"protect": default_target}
            )
            return default_target, log 