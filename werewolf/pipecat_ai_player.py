import asyncio
import logging
from typing import Optional, Dict, Any
import time
import os
import json

from livekit import api
from pipecat.transports.services.livekit import LiveKitTransport, LiveKitParams
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.task import PipelineTask, PipelineParams
from pipecat.pipeline.runner import PipelineRunner
from pipecat.processors.aggregators.openai_llm_context import OpenAILLMContext
from pipecat.services.openai import OpenAITTSService, OpenAILLMService
from pipecat.frames.frames import TTSSpeakFrame

from werewolf.utils import Deserializable
from werewolf.frame_processors import (
    TTSOutputProcessor, 
    GameStateProcessor,
    DataChannelProcessor
)
import re

logger = logging.getLogger(__name__)


class PipecatAIPlayer(Deserializable):
    """AI player that uses Pipecat pipeline with LiveKit transport and TTS capabilities."""
    
    def __init__(self, name: str, role: str, personality: Optional[str] = ""):
        # # Initialize parent Player class properly
        # super().__init__(name, role, "ai", personality)
        self.name = name
        self.role = role
        self.personality = personality
        
        # Add Seer-specific attribute if needed
        if self.role == "Seer":
            self.previously_unmasked: Dict[str, str] = {}
        
        self.participant_id = None
        
        # Pipecat components
        self._transport: Optional[LiveKitTransport] = None
        self._pipeline: Optional[Pipeline] = None
        self._pipeline_task: Optional[PipelineTask] = None
        self._pipeline_runner: Optional[PipelineRunner] = None
        
        # TTS and LLM services
        self._tts_service: Optional[OpenAITTSService] = None
        self._llm_service: Optional[OpenAILLMService] = None
        self._llm_context: Optional[OpenAILLMContext] = None
        
        # Connection state
        self._connected = False
        
        # Queue for text to be spoken and speech state tracking
        self._speech_queue: asyncio.Queue = asyncio.Queue()
        self._speech_task: Optional[asyncio.Task] = None
        self._is_speaking = asyncio.Event()
        self._current_speech_done = asyncio.Event()
        self._current_speech_done.set()  # Start with speech done state
        
        self.livekit_url = os.getenv("LIVEKIT_URL")
        self.livekit_api_key = os.getenv("LIVEKIT_API_KEY")
        self.livekit_api_secret = os.getenv("LIVEKIT_API_SECRET")

    async def setup_pipecat_pipeline(self, room_name: str):
        """Setup Pipecat pipeline with LiveKit transport for AI output."""
        try:
            logger.info(f"Setting up Pipecat pipeline for AI {self.name}")
            
            # Generate agent token
            agent_token = api.AccessToken(self.livekit_api_key, self.livekit_api_secret)
            self.participant_id = f"ai_{self.name}"
            agent_token.with_identity(self.participant_id).with_name(self.name)
            agent_token.with_grants(api.VideoGrants(
                room_join=True,
                room=room_name,
                can_publish=True,
                can_subscribe=True,
                can_publish_data=True
            ))
            agent_token_jwt = agent_token.to_jwt()
            
            # Create LiveKit transport
            self._transport = LiveKitTransport(
                url=self.livekit_url,
                token=agent_token_jwt,
                room_name=room_name,
                params=LiveKitParams(
                    audio_in_enabled=False,  # AI doesn't need audio input
                    audio_out_enabled=True,  # AI needs to speak
                    vad_analyzer=None,
                    camera_enabled=False,
                    transcription_enabled=False,
                    audio_in_participant_ids=[],
                ),
            )
            
            # Create TTS service
            self._tts_service = OpenAITTSService(
                api_key=os.getenv("OPENAI_API_KEY"),
                voice="alloy",
                model="tts-1",
            )
            
            # Create LLM service and context
            self._llm_service = OpenAILLMService(
                api_key=os.getenv("OPENAI_API_KEY"),
                model="gpt-4o-mini",
            )
            
            self._llm_context = OpenAILLMContext()
            
            # Create frame processors
            tts_output_processor = TTSOutputProcessor(
                player_name=self.name,
                on_speech_start=lambda: self._is_speaking.set(),
                on_speech_end=lambda: [
                    self._is_speaking.clear(),
                    self._current_speech_done.set()
                ]
            )
            
            game_state_processor = GameStateProcessor(
                send_message_callback=self._send_game_message,
            )
            
            data_channel_processor = DataChannelProcessor(
                on_game_action_received=self._on_game_action_received,
            )
            
            # Create pipeline for AI output (TTS -> Transport)
            pipeline_components = [
                self._tts_service,  # Convert text to speech
                game_state_processor,  # Handle game state messages
                # data_channel_processor,  # Handle data channel
                self._transport.output(),  # Send audio to LiveKit
                tts_output_processor,  # Process TTS output
            ]
            
            self._pipeline = Pipeline(pipeline_components)
            
            # Create pipeline task
            self._pipeline_task = PipelineTask(
                self._pipeline,
                params=PipelineParams(
                    allow_interruptions=True,
                    enable_metrics=True,
                )
            )
            
            # Create and start pipeline runner
            self._pipeline_runner = PipelineRunner(
                name=f"ai_player_{self.name}_pipeline",
                handle_sigint=False,
            )
            
            # Start the pipeline in background
            asyncio.create_task(self._pipeline_runner.run(self._pipeline_task))
            
            # Start speech processing task
            self._speech_task = asyncio.create_task(self._process_speech_queue())
            
            self._connected = True
            logger.info(f"Pipecat pipeline setup complete for AI {self.name}")
            
        except Exception as e:
            logger.error(f"Failed to setup Pipecat pipeline for AI {self.name}: {e}")
            raise

    async def _process_speech_queue(self):
        """Process queued speech through TTS pipeline."""
        while True:
            try:
                item = await self._speech_queue.get()
                if item is None:  # Shutdown signal
                    break
                    
                text, done_event = item
                logger.info(f"AI {self.name} speaking: {text}")
                
                # Set speaking state
                self._is_speaking.set()
                self._current_speech_done.clear()
                
                try:
                    # Send text frame to TTS pipeline
                    if self._pipeline_task:
                        text_frame = TTSSpeakFrame(text=text)
                        await self._pipeline_task.queue_frame(text_frame)
                        
                    # Wait for speech to complete
                    await self._current_speech_done.wait()
                    
                finally:
                    # Signal that we're done with this speech item
                    if done_event and not done_event.is_set():
                        done_event.set()
                    self._speech_queue.task_done()
                
            except Exception as e:
                logger.error(f"Error processing speech for AI {self.name}: {e}")
                if done_event and not done_event.is_set():
                    done_event.set()
                self._speech_queue.task_done()
                await asyncio.sleep(1)  # Prevent tight loop on errors

    async def speak(self, text: str, wait: bool = True) -> asyncio.Event:
        """Queue text to be spoken by the AI.
        
        Args:
            text: The text to speak
            wait: If True, wait for the speech to complete before returning
            
        Returns:
            An asyncio.Event that will be set when the speech is complete
        """
        if not text or not text.strip():
            event = asyncio.Event()
            event.set()
            return event

        done_event = asyncio.Event()
        await self._speech_queue.put((text, done_event))
        await done_event.wait()
        
        # # Split the text into sentences
        # sentences = re.split(r"[.!?]\s+", text)
        # for sentence in sentences:
        #     sentence = sentence.strip()
        #     if sentence:
        #         done_event = asyncio.Event()
        #         await self._speech_queue.put((sentence, done_event))
        #         await done_event.wait()
        
        return asyncio.Event()

    def _send_game_message(self, data: Dict[str, Any]):
        """Send game message through data channel."""
        asyncio.create_task(self.send_data_message("game_update", data))

    def _on_game_action_received(self, action_type: str, data: Dict[str, Any]):
        """Handle game actions received from other players."""
        logger.info(f"AI {self.name} received game action: {action_type}, data: {data}")

    async def send_data_message(self, message_type: str, data: Dict[str, Any] = None):
        """Send a message through the data channel."""
        if not self._connected or not self._transport:
            logger.warning("Not connected to LiveKit, cannot send data message")
            return
            
        message = {"type": message_type, "player": self.name, "player_type": "ai"}
        if data:
            message.update(data)
            
        try:
            await self._transport.send_message(json.dumps(message))
            logger.info(f"AI {self.name} sent data message: {message}")
        except Exception as e:
            logger.error(f"Error sending data message from AI {self.name}: {e}")

    async def disconnect(self):
        """Disconnect from LiveKit and cleanup pipeline."""
        try:
            # Stop speech processing
            if self._speech_task and not self._speech_task.done():
                await self._speech_queue.put(None)  # Shutdown signal
                await self._speech_task
                
            if self._pipeline_task:
                self._pipeline_task.stop()
                
            if self._pipeline_runner:
                await self._pipeline_runner.stop()
                
            if self._transport:
                await self._transport.cleanup()
                
            self._connected = False
            logger.info(f"AI {self.name} disconnected from LiveKit")
            
        except Exception as e:
            logger.error(f"Error during disconnect for AI {self.name}: {e}")

    def is_connected(self) -> bool:
        """Check if connected to LiveKit."""
        return self._connected

    async def cleanup(self):
        """Clean up resources."""
        await self.disconnect()
        logger.info(f"AI player {self.name} cleaned up")
        
    # def initialize_game_view(self, round_number, current_players, other_wolf=None) -> None:
    #     """Initialize the game view for this player."""
    #     self.gamestate = GameView(round_number, current_players, other_wolf)

    # def _add_observation(self, observation: str):
    #     """Adds an observation for the given round."""
    #     if not self.gamestate:
    #         raise ValueError("GameView not initialized. Call initialize_game_view() first.")
        
    #     self.observations.append(f"Round {self.gamestate.round_number}: {observation}")

    # def add_announcement(self, announcement: str):
    #     """Adds the current game announcement to the player's observations."""
    #     self._add_observation(f"Moderator Announcement: {announcement}")

    # def _get_game_state(self) -> Dict[str, Any]:
    #     """Gets the current game state from the player's perspective."""
    #     if not self.gamestate:
    #         raise ValueError("GameView not initialized. Call initialize_game_view() first.")

    #     remaining_players = [
    #         f"{player} (You)" if player == self.name else player
    #         for player in self.gamestate.current_players
    #     ]
    #     formatted_debate = [
    #         f"{author} (You): {dialogue}"
    #         if author == self.name
    #         else f"{author}: {dialogue}"
    #         for author, dialogue in self.gamestate.debate
    #     ]

    #     formatted_observations = group_and_format_observations(self.observations)

    #     return {
    #         "name": self.name,
    #         "role": self.role,
    #         "round": self.gamestate.round_number,
    #         "observations": formatted_observations,
    #         "remaining_players": ", ".join(remaining_players),
    #         "debate": formatted_debate,
    #         "bidding_rationale": self.bidding_rationale,
    #         "debate_turns_left": MAX_DEBATE_TURNS - len(formatted_debate),
    #         "personality": self.personality,
    #         "num_players": NUM_PLAYERS,
    #         "num_villagers": NUM_PLAYERS - 4,
    #     }

    # # AI-specific game methods (these would use the existing LLM logic from the original Player class)
    # async def vote(self) -> Tuple[Optional[str], LmLog]:
    #     """AI chooses who to vote for using LLM."""
    #     # Use the original Player's vote method but also speak the result
    #     vote_result = await super().vote()
        
    #     # if vote_result[0]:
    #     #     await self.speak(f"I vote to eliminate {vote_result[0]}")
            
    #     return vote_result

    # async def bid(self) -> Tuple[Optional[int], LmLog]:
    #     """AI bids to speak using LLM."""
    #     # Use the original Player's bid method but also speak if bidding high
    #     bid_result = await super().bid()
        
    #     # if bid_result[0] and bid_result[0] > 2:
    #     #     await self.speak("I'd like to speak in the debate")
            
    #     return bid_result

    # async def debate(self) -> Tuple[Optional[str], LmLog]:
    #     """AI generates debate speech using LLM."""
    #     # Use the original Player's debate method and speak the result
    #     debate_result = await super().debate()
        
    #     # if debate_result[0]:
    #     #     await self.speak(debate_result[0])
            
    #     return debate_result

    # async def summarize(self) -> Tuple[Optional[str], LmLog]:
    #     """AI summarizes the debate using LLM."""
    #     # Use the original Player's summarize method
    #     return await super().summarize()

    # # Action methods for specific roles
    # async def eliminate(self) -> Tuple[Optional[str], LmLog]:
    #     """Werewolf AI chooses a player to eliminate using LLM."""
    #     eliminate_result = await super().eliminate()
        
    #     # if eliminate_result[0]:
    #     #     # Don't speak elimination choices (would reveal the werewolf!)
    #     #     logger.info(f"AI Werewolf {self.name} chose to eliminate {eliminate_result[0]}")
            
    #     return eliminate_result

    # async def unmask(self) -> Tuple[Optional[str], LmLog]:
    #     """Seer AI chooses a player to investigate using LLM."""
    #     unmask_result = await super().unmask()
        
    #     # if unmask_result[0]:
    #     #     # Don't speak investigation choices (would reveal the seer!)
    #     #     logger.info(f"AI Seer {self.name} chose to investigate {unmask_result[0]}")
            
    #     return unmask_result

    # async def save(self) -> Tuple[Optional[str], LmLog]:
    #     """Doctor AI chooses a player to protect using LLM."""
    #     save_result = await super().save()
        
    #     # if save_result[0]:
    #     #     # Don't speak protection choices (would reveal the doctor!)
    #     #     logger.info(f"AI Doctor {self.name} chose to protect {save_result[0]}")
            
    #     return save_result
    
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
        """Broadcast game announcement through LiveKit data channel and speak it."""
        await self.send_data_message("announcement", {
            "text": announcement,
            "timestamp": time.time()
        })
        
        # AI can speak announcements
        # await self.speak(announcement)
        
        # Also add to observations as normal
        self.add_announcement(announcement)
        
    # def reveal_and_update(self, player, role):
    #     """Called by the GameMaster when the AI is the Seer to update their state."""
    #     if self.role == SEER:
    #         self._add_observation(
    #             f"During the night, I decided to investigate {player} and learned they are a {role}."
    #         )
    #         self.previously_unmasked[player] = role 