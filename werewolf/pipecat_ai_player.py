import asyncio
import logging
from typing import Optional, Dict
import os

from livekit import api
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.task import PipelineTask, PipelineParams
from pipecat.pipeline.runner import PipelineRunner
from pipecat.services.cartesia.tts import CartesiaTTSService
from pipecat.frames.frames import TTSSpeakFrame

from werewolf.pipecat_services.livekit_transport import LiveKitTransport, LiveKitParams
from werewolf.utils import Deserializable
from werewolf.pipecat_services.frame_processors import (
    TTSOutputProcessor,
)
from werewolf.config import NAMES

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

        # TTS services
        self._tts_service: Optional[CartesiaTTSService] = None

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

    def _get_voice_for_name(self, name: str) -> str:
        """Select a consistent Cartesia voice based on the player's name."""
        # Available Cartesia voice IDs for variety
        cartesia_voices = [
            "694f9389-aac1-45b6-b726-9d9369183238",  # Default voice from docs
            "a0e99841-438c-4a64-b679-ae501e7d6091",  # WebSocket example voice
            "95856005-0332-41b0-935f-352e296aa0df",  # Additional voice variation
            "34dbb662-8e98-413c-8c2a-3de3416bdb78",  # Additional voice variation
            "e13cae5c-ec59-4f71-b0a7-2a3c1c7c4c7d",  # Additional voice variation
            "b9de4a89-2f3e-4f5a-8c7d-9e6f1a2b3c4d",  # Additional voice variation
        ]

        # Create a simple hash of the name to get a consistent index
        name_index = NAMES.index(name)
        voice_index = name_index % len(cartesia_voices)

        logger.info(
            f"Selected Cartesia voice '{cartesia_voices[voice_index]}' for AI {name}"
        )
        return cartesia_voices[voice_index]

    async def setup_pipecat_pipeline(self, room_name: str):
        """Setup Pipecat pipeline with LiveKit transport for AI output."""
        try:
            logger.info(f"Setting up Pipecat pipeline for AI {self.name}")

            # Generate agent token
            agent_token = api.AccessToken(self.livekit_api_key, self.livekit_api_secret)
            self.participant_id = f"{self.name}"
            agent_token.with_identity(self.participant_id).with_name(self.name)
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

            # Create Cartesia TTS service
            self._tts_service = CartesiaTTSService(
                api_key=os.getenv("CARTESIA_API_KEY"),
                voice_id=self._get_voice_for_name(self.name),
                model="sonic-2",  # Ultra-low latency model
                sample_rate=16000,  # Match LiveKit sample rate
            )

            # Create frame processors
            tts_output_processor = TTSOutputProcessor(
                player_name=self.name,
                on_speech_start=lambda: self._is_speaking.set(),
                on_speech_end=lambda: [
                    self._is_speaking.clear(),
                    self._current_speech_done.set(),
                ],
            )

            # Create pipeline for AI output (TTS -> Transport)
            pipeline_components = [
                self._tts_service,  # Convert text to speech
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
                ),
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

    async def disconnect(self):
        """Disconnect from LiveKit and cleanup pipeline."""
        try:
            # Stop speech processing
            if self._speech_task and not self._speech_task.done():
                await self._speech_queue.put(None)  # Shutdown signal
                await self._speech_task

            if self._pipeline_runner:
                await self._pipeline_runner.cancel()

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
