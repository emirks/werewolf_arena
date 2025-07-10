import asyncio
import logging
from typing import Optional, List, Dict, Any, Tuple, Union
import time
import os
import json
import enum

from livekit import api
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.task import PipelineTask, PipelineParams
from pipecat.pipeline.runner import PipelineRunner
from pipecat.processors.aggregators.openai_llm_context import OpenAILLMContext
from werewolf.soniox_stt_service import SonioxSTTService
from pipecat.audio.vad.silero import SileroVADAnalyzer

from werewolf.livekit_transport import LiveKitTransport, LiveKitParams
from werewolf.utils import Deserializable
from werewolf.lm import LmLog
from werewolf.model import GameView, group_and_format_observations, Player, SEER
from werewolf.config import MAX_DEBATE_TURNS, NUM_PLAYERS
from werewolf.frame_processors import (
    TranscriptionProcessor,
    DataChannelProcessor,
    GameStateProcessor,
    SpeechDetectionProcessor,
)

from .messaging import (
    create_game_event_message,
    create_user_action_message,
    create_announcement_message,
    GameEventType,
    UserActionType
)

logger = logging.getLogger(__name__)


class UserInputTimeout(Exception):
    """Exception raised when user input times out."""

    pass


# JSON serializer that works for nested classes
class JsonEncoder(json.JSONEncoder):

    def default(self, o):
        if isinstance(o, enum.Enum):
            return o.value
        if isinstance(o, set):
            return list(o)
        return o.__dict__


def to_dict(o: Any) -> Union[Dict[str, Any], List[Any], Any]:
    return json.loads(JsonEncoder().encode(o))


class PipecatHumanPlayer(Deserializable):
    """Human player that uses Pipecat pipeline with LiveKit transport."""

    def __init__(self, name: str, role: str, personality: Optional[str] = ""):
        self.name = name
        self.role = role
        self.personality = personality
        self.observations: List[str] = []
        self.bidding_rationale = ""
        self.gamestate: Optional[GameView] = None

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

        # Pipecat components
        self._transport: Optional[LiveKitTransport] = None
        self._pipeline: Optional[Pipeline] = None
        self._pipeline_task: Optional[PipelineTask] = None
        self._pipeline_runner: Optional[PipelineRunner] = None

        # Connection state
        self._connected = False

        self.livekit_url = os.getenv("LIVEKIT_URL")
        self.livekit_api_key = os.getenv("LIVEKIT_API_KEY")
        self.livekit_api_secret = os.getenv("LIVEKIT_API_SECRET")

    async def setup_pipecat_pipeline(self, room_name: str):
        """Setup Pipecat pipeline with LiveKit transport for user input."""
        try:
            logger.info(f"Setting up Pipecat pipeline for {self.name}")

            # Generate agent token
            agent_token = api.AccessToken(self.livekit_api_key, self.livekit_api_secret)
            self.participant_id = f"agent_for_{self.name}"
            agent_token.with_identity(self.participant_id).with_name(
                self.participant_id
            )
            agent_token.with_grants(
                api.VideoGrants(
                    room_join=True,
                    room=room_name,
                    can_publish=True,
                    can_subscribe=True,
                    can_publish_data=True,
                )
            )
            agent_token_jwt = agent_token.to_jwt()

            # Create VAD analyzer
            vad_analyzer = SileroVADAnalyzer()

            # Create LiveKit transport
            self._transport = LiveKitTransport(
                url=self.livekit_url,
                token=agent_token_jwt,
                room_name=room_name,
                params=LiveKitParams(
                    audio_in_enabled=True,
                    audio_out_enabled=False,  # Human player doesn't need audio output
                    vad_analyzer=vad_analyzer,
                    audio_in_passthrough=True,
                    camera_enabled=False,
                    transcription_enabled=True,
                    audio_in_participant_ids=[self.name],
                ),
            )

            # Set up data channel handler
            @self._transport.event_handler("on_data_received")
            async def on_data_received(transport, data: bytes, participant_id: str):
                await self._on_data_received_bytes(data)

            # Create STT service
            stt_service = SonioxSTTService(
                api_key=os.getenv("SONIOX_API_KEY"),
                language="en",
                enable_vad=True,
                sample_rate=16000,
            )

            # Create frame processors
            self.transcription_processor = TranscriptionProcessor(
                update_user_speaking_cb=lambda speaking: setattr(
                    self, "_user_speaking", speaking
                ),
                update_speech_detected_cb=lambda detected: setattr(
                    self, "_speech_detected_in_window", detected
                ),
                update_transcription_cb=lambda text: setattr(
                    self, "_last_transcription", text
                ),
            )

            data_channel_processor = DataChannelProcessor(
                on_vote_received=self._on_vote_received,
                on_target_selection_received=self._on_target_selection_received,
                on_game_action_received=self._on_game_action_received,
            )

            speech_detection_processor = SpeechDetectionProcessor(
                speech_threshold=0.3,
                silence_duration_ms=1000,
            )

            # Create pipeline
            pipeline_components = [
                self._transport.input(),  # Audio input from LiveKit
                # speech_detection_processor,  # Detect speech in audio
                stt_service,  # Convert speech to text
                self.transcription_processor,  # Process transcription results
                # data_channel_processor,  # Handle data channel messages
                self._transport.output(),  # Audio output to LiveKit
            ]

            self._pipeline = Pipeline(pipeline_components)

            # Create pipeline task
            self._pipeline_task = PipelineTask(
                self._pipeline,
                params=PipelineParams(
                    allow_interruptions=True,
                    enable_metrics=True,
                ),
            )

            # Create and start pipeline runner
            self._pipeline_runner = PipelineRunner(
                name=f"human_player_{self.name}_pipeline",
                handle_sigint=False,
            )

            # Start the pipeline in background
            asyncio.create_task(self._pipeline_runner.run(self._pipeline_task))
            
            self.connected_event = asyncio.Event()
            @self._transport.event_handler("on_connected")
            async def on_connected(transport):
                logger.info(f"{self.name} connected to LiveKit")
                self._connected = True
                self.connected_event.set()
            
            @self._transport.event_handler("on_disconnected")
            async def on_disconnected(transport):
                logger.info(f"{self.name} disconnected from LiveKit")
                self._connected = False

            logger.info(f"Pipecat pipeline setup complete for {self.name}")

        except Exception as e:
            logger.error(f"Failed to setup Pipecat pipeline for {self.name}: {e}")
            raise

    async def _on_data_received_bytes(self, data: bytes):
        """Handle incoming data channel messages as bytes."""
        try:
            message = json.loads(data.decode("utf-8"))
            message_type = message.get("type")

            logger.info(f"Received data message: {message}")

            if message_type == "vote":
                target = message.get("target")
                if target:
                    self._on_vote_received(target)

            elif message_type == "target_selection":
                target = message.get("target")
                if target:
                    self._on_target_selection_received(target)

            # Generic game action handler
            self._on_game_action_received(message_type, message)

        except (json.JSONDecodeError, Exception) as e:
            logger.error(f"Error processing data message: {e}")

    def _on_vote_received(self, target: str):
        """Handle vote received from UI."""
        self._current_vote = target
        logger.info(f"Vote received: {target}")

        # Signal any waiting vote response
        if "vote" in self._pending_responses:
            self._response_data["vote"] = target
            self._pending_responses["vote"].set()

    def _on_target_selection_received(self, target: str):
        """Handle target selection received from UI."""
        self._current_target_selection = target
        logger.info(f"Target selection received: {target}")

        # Signal any waiting target selection
        if "target_selection" in self._pending_responses:
            self._response_data["target_selection"] = target
            self._pending_responses["target_selection"].set()

    def _on_game_action_received(self, action_type: str, data: Dict[str, Any]):
        """Handle generic game actions."""
        logger.info(f"Game action received: {action_type}, data: {data}")

    async def send_data_message(self, message: Dict[str, Any]):
        """Send a message through the data channel."""
        if not self._connected or not self._transport:
            logger.warning("Not connected to LiveKit, waiting for connection")
            await self.connected_event.wait()
            if not self._connected or not self._transport:
                logger.error("Still not connected to LiveKit after waiting")
                return

        try:
            await self._transport.send_message(
                json.dumps(message), participant_id=self.name
            )
            logger.info(f"Sent message: {message['type']}")
        except Exception as e:
            logger.error(f"Error sending data message: {e}")

    def reset_vote(self):
        """Reset the current vote (called at daytime start)."""
        self._current_vote = None
        logger.info(f"Vote reset for {self.name}")

    async def disconnect(self):
        """Disconnect from LiveKit and cleanup pipeline."""
        try:
            if self._pipeline_task:
                self._pipeline_task.stop()

            if self._pipeline_runner:
                await self._pipeline_runner.stop()

            if self._transport:
                await self._transport.cleanup()

            self._connected = False
            logger.info(f"{self.name} disconnected from LiveKit")

        except Exception as e:
            logger.error(f"Error during disconnect: {e}")

    def is_connected(self) -> bool:
        """Check if connected to LiveKit."""
        return self._connected

    async def cleanup(self):
        """Clean up resources."""
        await self.disconnect()
        logger.info(f"Human player {self.name} cleaned up")

    def initialize_game_view(
        self, round_number, current_players, other_wolf=None
    ) -> None:
        """Initialize the game view for this player."""
        self.gamestate = GameView(round_number, current_players, other_wolf)

    def _add_observation(self, observation: str):
        """Adds an observation for the given round."""
        if not self.gamestate:
            raise ValueError(
                "GameView not initialized. Call initialize_game_view() first."
            )

        self.observations.append(f"Round {self.gamestate.round_number}: {observation}")

    def add_announcement(self, announcement: str):
        """Adds the current game announcement to the player's observations."""
        self._add_observation(f"Moderator Announcement: {announcement}")

    def _get_game_state(self) -> Dict[str, Any]:
        """Gets the current game state from the player's perspective."""
        if not self.gamestate:
            raise ValueError(
                "GameView not initialized. Call initialize_game_view() first."
            )

        # Create players array in the format expected by frontend
        players = [
            {
                "id": player,
                "name": f"{player} (You)" if player == self.name else player,
                "isAlive": True,  # Assume alive if they're in current_players
                "role": "unknown",  # Role is hidden from other players in most cases
            }
            for player in self.gamestate.current_players
        ]

        formatted_debate = [
            (
                f"{author} (You): {dialogue}"
                if author == self.name
                else f"{author}: {dialogue}"
            )
            for author, dialogue in self.gamestate.debate
        ]

        formatted_observations = group_and_format_observations(self.observations)

        return {
            "name": self.name,
            "role": self.role,
            "round": self.gamestate.round_number,
            "observations": formatted_observations,
            "players": players,  # Changed from remaining_players string to players array
            "debate": formatted_debate,
            "bidding_rationale": self.bidding_rationale,
            "debate_turns_left": MAX_DEBATE_TURNS - len(formatted_debate),
            "personality": self.personality,
            "num_players": NUM_PLAYERS,
            "num_villagers": NUM_PLAYERS - 4,
        }

    async def wait_for_response(
        self, response_type: str, timeout: float = 30.0
    ) -> Optional[str]:
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
            raise ValueError(
                "GameView not initialized. Call initialize_game_view() first."
            )

        options = [
            player for player in self.gamestate.current_players if player != self.name
        ]

        # Check if vote already exists
        if self._current_vote and self._current_vote in options:
            vote = self._current_vote
            logger.info(f"Using existing vote: {vote}")
        else:
            # Request vote from user
            message = create_user_action_message(
                UserActionType.REQUEST_VOTE,
                {
                    "options": options,
                    "prompt": f"Round {self.gamestate.round_number} - Vote to eliminate a player",
                },
                timeout=60
            )
            await self.send_data_message(message)

            # Wait for vote response
            vote = await self.wait_for_response("vote", timeout=60.0)

            if not vote or vote not in options:
                vote = options[0] if options else None
                logger.warning(f"No valid vote received, defaulting to: {vote}")

        if len(self.gamestate.debate) >= MAX_DEBATE_TURNS:
            self._add_observation(
                f"After the debate, I voted to remove {vote} from the game."
            )

        log = LmLog(
            prompt=f"USER_VOTE: Vote to eliminate",
            raw_resp=str(vote),
            result={"vote": vote},
        )

        return vote, log

    async def bid(self) -> Tuple[float, LmLog]:
        """Bid to speak during the debate phase."""
        logger.info(f"Requesting bid from {self.name}")

        # Reset speech detection state
        self._speech_detected = False
        self._user_speaking = False

        # Create an event to signal when speech is detected
        speech_detected_event = asyncio.Event()

        def on_speech_detected(detected: bool):
            if detected and not self._speech_detected:
                self._speech_detected = True
                speech_detected_event.set()

        # Store and update callback
        original_callback = getattr(
            self.transcription_processor, "_update_speech_detected_cb", None
        )
        self.transcription_processor._update_speech_detected_cb = on_speech_detected

        try:
            # Send speaking opportunity message
            message = create_user_action_message(
                UserActionType.CAN_SPEAK,
                {
                    "prompt": "You can speak now if you want to join the debate",
                    "duration": "You have 5 seconds"
                },
                timeout=5
            )
            await self.send_data_message(message)

            logger.info(f"Waiting for speech from {self.name}...")

            try:
                await asyncio.wait_for(speech_detected_event.wait(), timeout=5.0)
                logger.info(f"Player {self.name} detected speech, bidding to speak")
                return 1.0, LmLog(
                    prompt="SPEECH_DETECTED",
                    raw_resp="1",
                    result={
                        "bid": 1.0,
                        "reasoning": "User started speaking, indicating desire to participate",
                    },
                )

            except asyncio.TimeoutError:
                logger.info(f"Player {self.name} did not speak within timeout")
                return 0.0, LmLog(
                    prompt="NO_SPEECH_DETECTED",
                    raw_resp="0",
                    result={
                        "bid": 0.0,
                        "reasoning": "No speech detected within time limit",
                    },
                )

        except Exception as e:
            logger.error(f"Error in bid for {self.name}: {e}", exc_info=True)
            return 0.0, LmLog(
                prompt="BID_ERROR", raw_resp=str(e), result={"error": str(e)}
            )

        finally:
            # Restore callback
            if hasattr(self, "transcription_processor"):
                self.transcription_processor._update_speech_detected_cb = original_callback

            # Send speaking ended message
            try:
                message = create_game_event_message(
                    GameEventType.DEBATE_UPDATE,
                    {"speaking_ended": True}
                )
                await self.send_data_message(message)
            except Exception as e:
                logger.warning(f"Error sending speaking_ended message: {e}")

    async def debate(self) -> Tuple[Optional[str], LmLog]:
        """Wait for user to stop speaking and get transcription."""
        try:
            message = create_user_action_message(
                UserActionType.CAN_SPEAK,
                {
                    "prompt": "It's your turn to speak",
                    "instructions": "Continue speaking and we'll capture your message when you're done"
                }
            )
            await self.send_data_message(message)

            # Wait for user to stop speaking
            while self._user_speaking:
                await asyncio.sleep(0.1)

            # Wait for final transcription
            await asyncio.sleep(1.0)

            speech = self._last_transcription or ""
            self._add_observation(f"I said: {speech}")

            log = LmLog(
                prompt=f"USER_DEBATE: Transcription capture",
                raw_resp=speech,
                result={"say": speech},
            )

            return speech, log

        except Exception as e:
            logger.error(f"Error in debate: {e}")
            log = LmLog(prompt="USER_DEBATE_ERROR", raw_resp="", result={"say": ""})
            return "", log

    async def summarize(self) -> Tuple[Optional[str], LmLog]:
        """Summarize doesn't need to do anything for human players."""
        log = LmLog(
            prompt="USER_SUMMARIZE",
            raw_resp="Human player - no summary needed",
            result={"summary": ""},
        )
        return "", log

    # Action methods for specific roles
    async def eliminate(self) -> Tuple[Optional[str], LmLog]:
        """Werewolf chooses a player to eliminate."""
        if not self.gamestate:
            raise ValueError("GameView not initialized. Call initialize_game_view() first.")

        options = [
            player
            for player in self.gamestate.current_players
            if player != self.name and player != self.gamestate.other_wolf
        ]

        message = create_user_action_message(
            UserActionType.REQUEST_TARGET,
            {
                "action": "eliminate",
                "options": options,
                "prompt": "Choose a player to eliminate tonight",
                "icon": "🔪"
            },
            timeout=60
        )
        await self.send_data_message(message)

        target = await self.wait_for_response("target_selection", timeout=60.0)

        if not target or target not in options:
            target = options[0] if options else None
            logger.warning(f"No valid elimination target received, defaulting to: {target}")

        log = LmLog(
            prompt=f"USER_ELIMINATE: Choose elimination target",
            raw_resp=str(target),
            result={"eliminate": target},
        )

        return target, log

    async def unmask(self) -> Tuple[Optional[str], LmLog]:
        """Seer chooses a player to investigate."""
        if not self.gamestate:
            raise ValueError("GameView not initialized. Call initialize_game_view() first.")

        options = [
            player for player in self.gamestate.current_players if player != self.name
        ]

        message = create_user_action_message(
            UserActionType.REQUEST_TARGET,
            {
                "action": "investigate",
                "options": options,
                "prompt": "Choose a player to investigate tonight",
                "icon": "🔍"
            },
            timeout=60
        )
        await self.send_data_message(message)

        target = await self.wait_for_response("target_selection", timeout=60.0)

        if not target or target not in options:
            target = options[0] if options else None
            logger.warning(f"No valid investigation target received, defaulting to: {target}")

        log = LmLog(
            prompt=f"USER_INVESTIGATE: Choose investigation target",
            raw_resp=str(target),
            result={"investigate": target},
        )

        return target, log

    async def save(self) -> Tuple[Optional[str], LmLog]:
        """Doctor chooses a player to protect."""
        if not self.gamestate:
            raise ValueError("GameView not initialized. Call initialize_game_view() first.")

        options = list(self.gamestate.current_players)

        message = create_user_action_message(
            UserActionType.REQUEST_TARGET,
            {
                "action": "protect",
                "options": options,
                "prompt": "Choose a player to protect tonight",
                "icon": "🛡️"
            },
            timeout=60
        )
        await self.send_data_message(message)

        target = await self.wait_for_response("target_selection", timeout=60.0)

        if not target or target not in options:
            target = options[0] if options else None
            logger.warning(f"No valid protection target received, defaulting to: {target}")

        if target:
            self._add_observation(f"During the night, I chose to protect {target}")

        log = LmLog(
            prompt=f"USER_PROTECT: Choose protection target",
            raw_resp=str(target),
            result={"protect": target},
        )

        return target, log

    async def send_game_state_update(self, event_type: str, data: Dict[str, Any] = None):
        """Send game state update through LiveKit data channel."""
        game_state = self._get_game_state()

        if event_type in ["day_phase_start", "night_phase_start", "voting_phase"]:
            message = create_game_event_message(
                GameEventType.PHASE_CHANGE,
                {"phase": event_type.replace("_phase_start", "").replace("_phase", ""), **(data or {})},
                game_state
            )
        elif event_type == "debate_update":
            message = create_game_event_message(
                GameEventType.DEBATE_UPDATE,
                data or {},
                game_state
            )
        elif "voting" in event_type:
            message = create_game_event_message(
                GameEventType.VOTING_UPDATE,
                {**{"event": event_type}, **(data or {})},
                game_state
            )
        else:
            message = create_game_event_message(
                GameEventType.GAME_STATE,
                {**{"event": event_type}, **(data or {})},
                game_state
            )

        await self.send_data_message(message)

    async def broadcast_announcement(self, announcement: str):
        """Broadcast game announcement through LiveKit data channel."""
        message = create_announcement_message(announcement)
        await self.send_data_message(message)
        # Also add to observations as normal
        self.add_announcement(announcement)

    def reveal_and_update(self, player, role):
        """Called by the GameMaster when the Human is the Seer to update their state."""
        if self.role == SEER:
            self._add_observation(
                f"During the night, I decided to investigate {player} and learned they are a {role}."
            )
            self.previously_unmasked[player] = role

    def to_dict(self) -> Any:
        return to_dict(self)

    @classmethod
    def from_json(cls, data: Dict[Any, Any]):
        name = data["name"]
        role = data["role"]
        model = data.get("model", None)
        o = cls(name=name, role=role, model=model)
        o.gamestate = data.get("gamestate", None)
        o.bidding_rationale = data.get("bidding_rationale", "")
        o.observations = data.get("observations", [])
        return o
