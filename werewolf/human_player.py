import asyncio
import logging
from typing import Optional, List, Dict, Any, Tuple
import threading
import time
import os
import json
import aiohttp
import contextvars

from livekit import agents, rtc, api
from livekit.agents.voice import room_io
from livekit.plugins import openai
from livekit.agents.stt import SpeechEventType, SpeechEvent
from typing import AsyncIterable

from werewolf.lm import LmLog
from werewolf.model import GameView, group_and_format_observations, Player, SEER
from werewolf.config import MAX_DEBATE_TURNS, NUM_PLAYERS

logger = logging.getLogger(__name__)


class UserInputTimeout(Exception):
    """Exception raised when user input times out."""
    pass

g_session = None
def new_session() -> aiohttp.ClientSession:
    global g_session
    if g_session is None:
        logger.debug("http_session(): creating a new httpclient ctx")

        http_proxy = None
        connector = aiohttp.TCPConnector(
            limit_per_host=50,
            keepalive_timeout=120,  # the default is only 15s
        )
        g_session = aiohttp.ClientSession(proxy=http_proxy, connector=connector)
    return g_session

class HumanPlayer(Player):
    """Human player that extends Player with data channel communication and overrides LiveKit methods."""
    
    def __init__(self, name: str, role: str, personality: Optional[str] = ""):
        # Initialize parent Player class properly - this calls LiveKitParticipant.__init__ 
        super().__init__(name, role, "human", personality)
        
        # Add Seer-specific attribute if needed
        if self.role == SEER:
            self.previously_unmasked: Dict[str, str] = {}
        
        self.participant_id = None
        
        # Data channel message storage
        self._current_vote: Optional[str] = None
        self._current_target_selection: Optional[str] = None
        self._pending_responses: Dict[str, asyncio.Event] = {}
        self._response_data: Dict[str, Any] = {}
        
        # STT event handling
        self._user_speaking = False
        self._last_transcription = ""
        self._speech_detected_in_window = False
        self._stt_task: Optional[asyncio.Task] = None
        
        # Override LiveKit connection state for human players
        self._connected = False
        self.room: Optional[rtc.Room] = None
        self.session = None  # Override the LiveKitParticipant session
        
        self.livekit_url = os.getenv("LIVEKIT_URL")
        self.livekit_api_key = os.getenv("LIVEKIT_API_KEY")
        self.livekit_api_secret = os.getenv("LIVEKIT_API_SECRET")
        
    # def setup_livekit_for_user(self, room_name: str):
    #     """Setup LiveKit for user input."""        
    #     token = api.AccessToken(self.livekit_api_key, self.livekit_api_secret)
    #     self.participant_id = f"user_{self.name}"
    #     token.with_identity(self.participant_id).with_name(self.name)
    #     token.with_grants(api.VideoGrants(
    #         room_join=True,
    #         room=room_name,
    #         can_publish=True,
    #         can_subscribe=True,
    #         can_publish_data=True
    #     ))
        
    #     return token

    async def setup_livekit_agent_for_user(self, room: rtc.Room, room_name: str):
        """Setup and connect to LiveKit room with TTS capabilities."""
        try:
            logger.info(f"Setting up LiveKit agent for {self.name}")
            self.room = room
            agent_token = api.AccessToken(self.livekit_api_key, self.livekit_api_secret)
            agent_token.with_identity(f"agent_for_{self.name}").with_name(self.name)
            agent_token.with_grants(api.VideoGrants(
                room_join=True,
                room=room_name,
                can_publish=True,
                can_subscribe=True,
                can_publish_data=True
            ))
            agent_token_jwt = agent_token.to_jwt()
            logger.info(f"Connecting to LiveKit room {room.name} with token {agent_token_jwt}")
            await room.connect(self.livekit_url, agent_token_jwt)
            logger.info(f"Connected to LiveKit room {room.name}")

            # Setup STT with realtime streaming enabled
            self.stt = openai.STT(
                use_realtime=True,
                language="en",
                model="gpt-4o-mini-transcribe"
            )
            self.stt._session = new_session()
            logger.info(f"Setting up STT for {self.name}")
            
            self.agent_session = agents.AgentSession(
                stt=self.stt,
            )
            logger.info(f"Setting up agent session for {self.name}")
            
            # Create STT stream for realtime transcription
            self.stt_stream = self.stt.stream()
            
            await self.agent_session.start(
                room=room,
                agent=agents.Agent(
                    instructions="You are the transcriptor of a user playing a game of werewolf."
                ),
                room_input_options=room_io.RoomInputOptions(
                    text_enabled=True,
                    audio_enabled=False,
                    video_enabled=False,
                    participant_identity=self.participant_id,
                ),
            )
            logger.info(f"Agent session started for {self.name}")
            # Setup data channel event listener
            self.room.on("data_received", self._on_data_received)
            
            # Start background STT processing task
            self._stt_task = asyncio.create_task(self.process_stt_stream(self.stt_stream))
            logger.info(f"STT task started for {self.name}")
            self._connected = True
            logger.info(f"LiveKit agent session setup complete for {self.name}")
            
        except Exception as e:
            logger.error(f"Failed to setup LiveKit agent session for {self.name}: {e}")
            raise

    def _on_data_received(self, data: rtc.DataPacket):
        """Handle incoming data channel messages."""
        try:
            message = json.loads(data.data.decode('utf-8'))
            message_type = message.get('type')
            
            logger.info(f"Received data message: {message}")
            
            if message_type == 'vote':
                self._current_vote = message.get('target')
                logger.info(f"Vote received: {self._current_vote}")
                
            elif message_type == 'target_selection':
                self._current_target_selection = message.get('target')
                logger.info(f"Target selection received: {self._current_target_selection}")
                
                # Signal any waiting target selection
                if 'target_selection' in self._pending_responses:
                    self._response_data['target_selection'] = self._current_target_selection
                    self._pending_responses['target_selection'].set()
                    
        except (json.JSONDecodeError, Exception) as e:
            logger.error(f"Error processing data message: {e}")

    async def send_data_message(self, message_type: str, data: Dict[str, Any] = None):
        """Send a message through the data channel."""
        if not self._connected or not self.room:
            logger.warning("Not connected to LiveKit room, cannot send data message")
            return
            
        message = {"type": message_type, "player": self.name}
        if data:
            message.update(data)
            
        try:
            await self.room.local_participant.publish_data(json.dumps(message).encode('utf-8'))
            logger.info(f"Sent data message: {message}")
        except Exception as e:
            logger.error(f"Error sending data message: {e}")

    def reset_vote(self):
        """Reset the current vote (called at daytime start)."""
        self._current_vote = None
        logger.info(f"Vote reset for {self.name}")

    async def disconnect(self):
        """Disconnect from LiveKit room."""
        if self.room:
            await self.room.disconnect()
            self._connected = False
            logger.info(f"{self.name} disconnected from LiveKit")

    def is_connected(self) -> bool:
        """Check if connected to LiveKit room."""
        return self._connected

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

    async def process_stt_stream(self, stream):
        """Background task to process STT events."""
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
                    self._speech_detected_in_window = True
                elif event.type == SpeechEventType.END_OF_SPEECH:
                    logger.info("End of speech")
                    self._user_speaking = False
                    
        except Exception as e:
            logger.error(f"Error in STT stream processing: {e}")
        finally:
            if hasattr(stream, 'aclose'):
                await stream.aclose()

    async def wait_for_response(self, response_type: str, timeout: float = 30.0) -> Optional[str]:
        """Wait for a response from the UI."""
        event = asyncio.Event()
        self._pending_responses[response_type] = event
        
        try:
            await asyncio.wait_for(event.wait(), timeout=timeout)
            return self._response_data.get(response_type)
        except asyncio.TimeoutError:
            logger.warning(f"Timeout waiting for {response_type} response")
            return None
        finally:
            self._pending_responses.pop(response_type, None)
            self._response_data.pop(response_type, None)

    async def vote(self) -> Tuple[Optional[str], LmLog]:
        """Check for existing vote or ask user to vote."""
        if not self.gamestate:
            raise ValueError("GameView not initialized. Call initialize_game_view() first.")
        
        options = [player for player in self.gamestate.current_players if player != self.name]
        
        # Check if vote already exists
        if self._current_vote and self._current_vote in options:
            vote = self._current_vote
            logger.info(f"Using existing vote: {vote}")
        else:
            # Ask for vote
            await self.send_data_message("request_vote", {
                "options": options,
                "prompt": f"Round {self.gamestate.round_number} - Vote to eliminate a player"
            })
            
            # Wait for vote response
            vote = await self.wait_for_response("vote", timeout=60.0)
            
            if not vote or vote not in options:
                vote = options[0] if options else None
                logger.warning(f"No valid vote received, defaulting to: {vote}")
        
        if len(self.gamestate.debate) == MAX_DEBATE_TURNS:
            self._add_observation(f"After the debate, I voted to remove {vote} from the game.")
        
        log = LmLog(
            prompt=f"USER_VOTE: Vote to eliminate",
            raw_resp=str(vote),
            result={"vote": vote}
        )
        
        return vote, log

    async def bid(self) -> Tuple[Optional[int], LmLog]:
        """Check for user speech within 5 seconds to determine bid."""
        try:
            # Reset speech detection flag
            self._speech_detected_in_window = False
            
            # Send message that user can speak
            await self.send_data_message("can_speak", {
                "prompt": "You can speak now if you want to join the debate (you have 5 seconds)"
            })
            
            # Wait 5 seconds and check for speech
            await asyncio.sleep(5.0)
            
            if self._speech_detected_in_window:
                bid = 4  # Highest bid if speech detected
                self.bidding_rationale = "User started speaking, indicating desire to participate"
            else:
                bid = 0  # No speech detected
                self.bidding_rationale = "No speech detected, user doesn't want to speak"
            
            log = LmLog(
                prompt=f"USER_BID: Speech detection window",
                raw_resp=str(bid),
                result={"bid": bid, "reasoning": self.bidding_rationale}
            )
            
            return bid, log
            
        except Exception as e:
            logger.error(f"Error in bid detection: {e}")
            log = LmLog(
                prompt="USER_BID_ERROR",
                raw_resp="0",
                result={"bid": 0, "reasoning": "Error in speech detection"}
            )
            return 0, log

    async def debate(self) -> Tuple[Optional[str], LmLog]:
        """Wait for user to stop speaking and get transcription."""
        try:
            await self.send_data_message("debate_turn", {
                "prompt": "It's your turn to speak. Continue speaking and we'll get your message when you're done."
            })
            
            # Wait for user to stop speaking (since they should already be speaking after bid)
            while self._user_speaking:
                await asyncio.sleep(0.1)
            
            # Wait a bit more to ensure we get the final transcription
            await asyncio.sleep(1.0)
            
            speech = self._last_transcription or ""
            self._add_observation(f"I said: {speech}")
            
            log = LmLog(
                prompt=f"USER_DEBATE: Transcription capture",
                raw_resp=speech,
                result={"say": speech}
            )
            
            return speech, log
            
        except Exception as e:
            logger.error(f"Error in debate: {e}")
            log = LmLog(
                prompt="USER_DEBATE_ERROR",
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
        
        await self.send_data_message("request_target_selection", {
            "action": "eliminate",
            "options": options,
            "prompt": "Choose a player to eliminate tonight"
        })
        
        target = await self.wait_for_response("target_selection", timeout=60.0)
        
        if not target or target not in options:
            target = options[0] if options else None
            logger.warning(f"No valid elimination target received, defaulting to: {target}")
        
        log = LmLog(
            prompt=f"USER_ELIMINATE: Choose elimination target",
            raw_resp=str(target),
            result={"eliminate": target}
        )
        
        return target, log

    async def unmask(self) -> Tuple[Optional[str], LmLog]:
        """Seer chooses a player to investigate."""
        if not self.gamestate:
            raise ValueError("GameView not initialized. Call initialize_game_view() first.")
        
        options = [
            player for player in self.gamestate.current_players 
            if player != self.name
        ]
        
        await self.send_data_message("request_target_selection", {
            "action": "investigate",
            "options": options,
            "prompt": "Choose a player to investigate tonight"
        })
        
        target = await self.wait_for_response("target_selection", timeout=60.0)
        
        if not target or target not in options:
            target = options[0] if options else None
            logger.warning(f"No valid investigation target received, defaulting to: {target}")
        
        log = LmLog(
            prompt=f"USER_INVESTIGATE: Choose investigation target",
            raw_resp=str(target),
            result={"investigate": target}
        )
        
        return target, log

    async def save(self) -> Tuple[Optional[str], LmLog]:
        """Doctor chooses a player to protect."""
        if not self.gamestate:
            raise ValueError("GameView not initialized. Call initialize_game_view() first.")
        
        options = list(self.gamestate.current_players)
        
        await self.send_data_message("request_target_selection", {
            "action": "protect",
            "options": options,
            "prompt": "Choose a player to protect tonight"
        })
        
        target = await self.wait_for_response("target_selection", timeout=60.0)
        
        if not target or target not in options:
            target = options[0] if options else None
            logger.warning(f"No valid protection target received, defaulting to: {target}")
        
        if target:
            self._add_observation(f"During the night, I chose to protect {target}")
        
        log = LmLog(
            prompt=f"USER_PROTECT: Choose protection target",
            raw_resp=str(target),
            result={"protect": target}
        )
        
        return target, log
    
    async def send_game_state_update(self, update_type: str, data: Dict[str, Any] = None):
        """Send game state update through LiveKit data channel."""
        game_state = self._get_game_state()
        
        update_data = {
            "update_type": update_type,
            "game_state": game_state
        }
        
        if data:
            update_data.update(data)
        
        await self.send_data_message("game_state_update", update_data)
    
    async def broadcast_announcement(self, announcement: str):
        """Broadcast game announcement through LiveKit data channel."""
        await self.send_data_message("announcement", {
            "text": announcement,
            "timestamp": time.time()
        })
        
        # Also add to observations as normal
        self.add_announcement(announcement)
        
    def reveal_and_update(self, player, role):
        """Called by the GameMaster when the Human is the Seer to update their state."""
        if self.role == SEER:
            self._add_observation(
                f"During the night, I decided to investigate {player} and learned they are a {role}."
            )
            self.previously_unmasked[player] = role 