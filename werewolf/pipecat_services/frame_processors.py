import asyncio
import json
import logging
from typing import Optional, Callable, Any, Dict
from dataclasses import dataclass

from pipecat.frames.frames import (
    BotStoppedSpeakingFrame,
    Frame,
    AudioRawFrame,
    TranscriptionFrame,
    InterimTranscriptionFrame,
    TTSAudioRawFrame,
    DataFrame,
    TextFrame,
    StartFrame,
    EndFrame,
    CancelFrame,
    ErrorFrame,
)
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor

logger = logging.getLogger(__name__)


@dataclass
class TranscriptionCompleteFrame(Frame):
    """Custom frame for when a complete transcription is ready"""

    text: str
    is_final: bool = True


@dataclass
class GameActionFrame(Frame):
    """Custom frame for game actions like votes, target selections"""

    action_type: str  # vote, target_selection, etc.
    data: Dict[str, Any]


@dataclass
class SpeechStateFrame(Frame):
    """Custom frame for speech state changes"""

    is_speaking: bool


class TranscriptionProcessor(FrameProcessor):
    """Process transcription frames and notify callbacks"""

    def __init__(
        self,
        update_user_speaking_cb: Optional[Callable[[bool], None]] = None,
        update_speech_detected_cb: Optional[Callable[[bool], None]] = None,
        update_transcription_cb: Optional[Callable[[str], None]] = None,
        **kwargs,
    ):
        super().__init__(**kwargs)
        self._update_user_speaking_cb = update_user_speaking_cb
        self._update_speech_detected_cb = update_speech_detected_cb
        self._update_transcription_cb = update_transcription_cb

        # Track current transcription state
        self._current_transcription = ""
        self._is_speaking = False

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        """Process incoming frames"""
        await super().process_frame(frame, direction)

        if isinstance(frame, InterimTranscriptionFrame):
            logger.info(f"Interim transcription: {frame.text}")
            self._update_speech_detected_cb(True)
            self._update_user_speaking_cb(True)

        # Handle transcription frames
        if isinstance(frame, TranscriptionFrame):
            await self._handle_transcription_frame(frame)

        # Handle custom speech state frames
        elif isinstance(frame, SpeechStateFrame):
            await self._handle_speech_state_frame(frame)

        # Handle custom transcription complete frames
        elif isinstance(frame, TranscriptionCompleteFrame):
            await self._handle_transcription_complete_frame(frame)

        # Pass frame along
        await self.push_frame(frame, direction)

    async def _handle_transcription_frame(self, frame: TranscriptionFrame):
        """Handle transcription frames from STT"""
        if frame.text:
            self._current_transcription = frame.text

            # Update speaking state if we have text
            if not self._is_speaking:
                self._is_speaking = True
                if self._update_user_speaking_cb:
                    self._update_user_speaking_cb(True)
                if self._update_speech_detected_cb:
                    self._update_speech_detected_cb(True)

            # If this is a final transcription, notify and reset
            if self._update_transcription_cb:
                self._update_transcription_cb(self._current_transcription)

            # Reset speaking state
            self._is_speaking = False
            if self._update_user_speaking_cb:
                self._update_user_speaking_cb(False)

            logger.info(f"Final transcription: {self._current_transcription}")

    async def _handle_speech_state_frame(self, frame: SpeechStateFrame):
        """Handle speech state changes"""
        self._is_speaking = frame.is_speaking

        if self._update_user_speaking_cb:
            self._update_user_speaking_cb(frame.is_speaking)
        if self._update_speech_detected_cb:
            self._update_speech_detected_cb(frame.is_speaking)

        logger.info(f"Speech state changed: {frame.is_speaking}")

    async def _handle_transcription_complete_frame(
        self, frame: TranscriptionCompleteFrame
    ):
        """Handle complete transcription"""
        if self._update_transcription_cb:
            self._update_transcription_cb(frame.text)

        # Reset speaking state
        self._is_speaking = False
        if self._update_user_speaking_cb:
            self._update_user_speaking_cb(False)

        logger.info(f"Transcription complete: {frame.text}")


class DataChannelProcessor(FrameProcessor):
    """Process data channel messages for game actions"""

    def __init__(
        self,
        on_vote_received: Optional[Callable[[str], None]] = None,
        on_target_selection_received: Optional[Callable[[str], None]] = None,
        on_game_action_received: Optional[Callable[[str, Dict[str, Any]], None]] = None,
        **kwargs,
    ):
        super().__init__(**kwargs)
        self._on_vote_received = on_vote_received
        self._on_target_selection_received = on_target_selection_received
        self._on_game_action_received = on_game_action_received

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        """Process incoming frames"""
        await super().process_frame(frame, direction)

        # Handle data frames (from LiveKit data channel)
        if isinstance(frame, DataFrame):
            await self._handle_data_frame(frame)

        # Handle custom game action frames
        elif isinstance(frame, GameActionFrame):
            await self._handle_game_action_frame(frame)

        # Pass frame along
        await self.push_frame(frame, direction)

    async def _handle_data_frame(self, frame: DataFrame):
        """Handle data channel messages"""
        try:
            if isinstance(frame.data, bytes):
                data_str = frame.data.decode("utf-8")
            else:
                data_str = str(frame.data)

            message = json.loads(data_str)
            message_type = message.get("type")

            logger.info(f"Received data message: {message}")

            if message_type == "vote" and self._on_vote_received:
                target = message.get("target")
                if target:
                    self._on_vote_received(target)

            elif (
                message_type == "target_selection"
                and self._on_target_selection_received
            ):
                target = message.get("target")
                if target:
                    self._on_target_selection_received(target)

            # Generic game action handler
            if self._on_game_action_received:
                self._on_game_action_received(message_type, message)

        except (json.JSONDecodeError, Exception) as e:
            logger.error(f"Error processing data frame: {e}")

    async def _handle_game_action_frame(self, frame: GameActionFrame):
        """Handle custom game action frames"""
        if self._on_game_action_received:
            self._on_game_action_received(frame.action_type, frame.data)


class TTSOutputProcessor(FrameProcessor):
    """Process TTS output and send to transport"""

    def __init__(
        self,
        player_name: str = "AI",
        on_speech_start: Optional[Callable[[], None]] = None,
        on_speech_end: Optional[Callable[[], None]] = None,
        **kwargs,
    ):
        super().__init__(**kwargs)
        self.player_name = player_name
        self._on_speech_start = on_speech_start
        self._on_speech_end = on_speech_end
        self._is_speaking = False

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        """Process frames for TTS output"""
        await super().process_frame(frame, direction)

        # Handle text frames that need to be spoken
        if isinstance(frame, TextFrame):
            logger.info(f"{self.player_name} speaking: {frame.text}")
            if self._on_speech_start and not self._is_speaking:
                self._on_speech_start()
                self._is_speaking = True

        # Handle end of speech
        elif isinstance(frame, (BotStoppedSpeakingFrame)) and self._is_speaking:
            if self._on_speech_end:
                self._on_speech_end()
            self._is_speaking = False

        # Pass frame along to transport
        await self.push_frame(frame, direction)


class GameStateProcessor(FrameProcessor):
    """Process game state updates and send to clients"""

    def __init__(
        self,
        send_message_callback: Optional[Callable[[Dict[str, Any]], None]] = None,
        **kwargs,
    ):
        super().__init__(**kwargs)
        self._send_message_callback = send_message_callback

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        """Process game state frames"""
        await super().process_frame(frame, direction)

        # Handle custom game state frames or data frames with game updates
        if isinstance(frame, DataFrame) and hasattr(frame, "game_state"):
            if self._send_message_callback:
                self._send_message_callback(frame.data)

        # Pass frame along
        await self.push_frame(frame, direction)


class SpeechDetectionProcessor(FrameProcessor):
    """Detect speech in audio frames and emit speech state changes"""

    def __init__(
        self, speech_threshold: float = 0.3, silence_duration_ms: int = 1000, **kwargs
    ):
        super().__init__(**kwargs)
        self._speech_threshold = speech_threshold
        self._silence_duration_ms = silence_duration_ms
        self._last_speech_time = 0
        self._is_speaking = False

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        """Process audio frames to detect speech"""
        await super().process_frame(frame, direction)

        if isinstance(frame, AudioRawFrame):
            await self._detect_speech_in_audio(frame)

        # Pass frame along
        await self.push_frame(frame, direction)

    async def _detect_speech_in_audio(self, frame: AudioRawFrame):
        """Simple speech detection based on audio level"""
        try:
            import numpy as np

            # Convert audio data to numpy array
            audio_data = np.frombuffer(frame.audio, dtype=np.int16)

            # Calculate RMS energy
            rms = np.sqrt(np.mean(audio_data.astype(np.float32) ** 2))

            # Normalize to 0-1 range (assuming 16-bit audio)
            normalized_rms = rms / 32768.0

            current_time = asyncio.get_event_loop().time() * 1000  # ms

            # Check if speech detected
            if normalized_rms > self._speech_threshold:
                self._last_speech_time = current_time

                if not self._is_speaking:
                    self._is_speaking = True
                    # Emit speech start frame
                    await self.push_frame(
                        SpeechStateFrame(is_speaking=True), FrameDirection.DOWNSTREAM
                    )

            else:
                # Check if silence duration exceeded
                if (
                    self._is_speaking
                    and current_time - self._last_speech_time
                    > self._silence_duration_ms
                ):

                    self._is_speaking = False
                    # Emit speech end frame
                    await self.push_frame(
                        SpeechStateFrame(is_speaking=False), FrameDirection.DOWNSTREAM
                    )

        except Exception as e:
            logger.error(f"Error in speech detection: {e}")
